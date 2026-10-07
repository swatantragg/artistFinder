// One entry point for every read and write. The API server wraps it with the PostgreSQL store (Prisma), so business rules
// exist exactly once. Discovery jobs run in the background on the same engine.
import { commands, type CommandResult } from './commands';
import { offProviderSet, type ProviderSet } from './discovery/providers';
import { DEFAULT_RUNNER, DiscoveryRunner, type DiscoveryHost, type RunnerOptions } from './discovery/runner';
import { searchBudget, usageOf } from './discovery/budget';
import { ENGINE_USER, searchBlocked } from './discovery/pipeline';
import { IMPORT_STEPS, processImport, type ImportInput, type ProgressFn, type StepFn } from './importer';
import { decodeText, parseDelimited } from './importmap';
import { staleDaysOf } from './discovery/views';
import { afterCommand, sweepStale } from './status';
import { Model, type Dirty, type Snapshot } from './model';
import { RuleError, audit } from './ops';
import { queries, type QueryName } from './queries';
import { upgradeWorkspace } from './upgrade';
import { emptyModel } from './workspace';
import type { Ctx, ImportBatch, User } from './types';
import { sha256Hex, todayISO } from './util';

export interface Store {
  load(): Promise<Snapshot | null>;
  save(dirty: Dirty): Promise<void>;
  replace(snapshot: Snapshot): Promise<void>;
}

export interface UploadInput {
  filename: string;
  bytes: Uint8Array;
  importType?: 'Full' | 'Incremental';
  exportDate?: string;
  source?: string;
  versionOfId?: string | null;
  /** Parsed workbook (xlsx is parsed by the caller, because SheetJS is large). */
  sheets?: { name: string; rows: unknown[][] }[];
}

/** A background import (v2 §39): the upload returns at once, the browser polls the job for progress. */
export interface ImportJob {
  id: string;                 // IMP-2026-00001
  filename: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  step: string;
  rows: number;
  done: number;
  percent: number;
  batchId: string | null;
  error: string | null;
  userId: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface EngineOptions {
  /** Discovery providers (the server passes the live ones). Without any, discovery is off and says why. */
  providers?: (getModel: () => Model) => ProviderSet;
  runner?: Partial<RunnerOptions>;
  /** Tests only: the workspace to start from (fixtures). The app always starts empty and fills from uploaded files. */
  seed?: () => Promise<Model>;
}

export { IMPORT_STEPS, RuleError };
export type { CommandResult, QueryName, StepFn };

export class Engine {
  m = new Model();
  private chain: Promise<unknown> = Promise.resolve();
  private runner: DiscoveryRunner;
  private providerSet: ProviderSet;
  private jobs = new Map<string, ImportJob>();
  constructor(private store: Store, private opts: EngineOptions = {}) {
    this.providerSet = (opts.providers ?? offProviderSet)(() => this.m);
    this.runner = this.makeRunner();
  }

  private makeRunner() {
    const host: DiscoveryHost = {
      mutate: fn => this.serial(async () => {
        this.m.begin();
        try {
          const res = fn(this.m, this.ctx(ENGINE_USER));
          await this.store.save(this.m.takeDirty());
          this.m.commit();
          return res;
        } catch (e) {
          this.m.rollback();
          throw e;
        }
      }),
      touch: fn => fn(this.m),
      read: fn => fn(this.m),
      ctx: () => this.ctx(ENGINE_USER),
    };
    return new DiscoveryRunner(host, () => this.providerSet, { ...DEFAULT_RUNNER, ...this.opts.runner });
  }

  /** Load the saved workspace, or create an empty one on first run. Interrupted searches are queued again. */
  async init(): Promise<'loaded' | 'created'> {
    const snap = await this.store.load();
    if (snap && (snap.cases?.length || snap.batches?.length || snap.meta?.some(x => x.id === 'workspace'))) {
      this.m.load(snap);
      const upgraded = upgradeWorkspace(this.m, this.ctx(ENGINE_USER));
      if (upgraded.length) { await this.store.save(this.m.takeDirty()); console.log(`Workspace upgraded: ${upgraded.join('; ')}`); }
      const interrupted = this.m.all('discoveryJobs').filter(j => j.status === 'SEARCHING' || j.status === 'PROCESSING');
      if (interrupted.length) {
        for (const j of interrupted) this.m.update('discoveryJobs', j.id, { status: 'QUEUED', step: 0, steps: j.steps.map(s => ({ ...s, state: 'todo' as const, detail: null })) });
        await this.store.save(this.m.takeDirty());
      }
      await this.maintain();
      this.runner.kick();
      return 'loaded';
    }
    await this.reset(this.opts.seed ? 'seed' : 'empty');
    return 'created';
  }
  ctx(userId?: string): Ctx {
    const now = new Date();
    const uid = userId && this.m.get('users', userId) ? userId : ENGINE_USER;
    const today = todayISO(now);
    return { userId: uid, now: now.toISOString(), today, discovery: this.providerSet?.mode, searchBudget: this.providerSet ? searchBudget(this.m, this.providerSet.providers, today) : null };
  }
  get discoveryMode() { return this.providerSet.mode; }

  query(name: string, userId: string | undefined, params: Record<string, unknown> = {}): unknown {
    if (name === 'discoveryConfig') return this.discoveryConfig();
    const fn = (queries as Record<string, (m: Model, ctx: Ctx, p: never) => unknown>)[name];
    if (!fn) throw new RuleError(`Unknown query ${name}.`);
    return fn(this.m, this.ctx(userId), params as never);
  }
  /** Which discovery providers are active (no secrets, only whether they are configured). */
  discoveryConfig() {
    const set = this.providerSet;
    return {
      mode: set.mode, notes: set.notes, providers: set.providers.map(p => ({ id: p.id, label: p.label, kind: p.kind })),
      blocked: searchBlocked(this.m, this.ctx()),
      usage: usageOf(this.m, set.providers, todayISO()), budget: searchBudget(this.m, set.providers, todayISO()),
      staleDays: Number(this.m.getMeta('discovery.staleDays') ?? 90), running: this.runner.active,
    };
  }

  /** Writes run one at a time; a failed rule or a failed save leaves no partial change behind. */
  command(name: string, userId: string | undefined, params: Record<string, unknown> = {}): Promise<CommandResult> {
    const fn = commands[name];
    if (!fn) return Promise.reject(new RuleError(`Unknown action ${name}.`));
    return this.serial(async () => {
      this.m.begin();
      try {
        const ctx = this.ctx(userId);
        const res = fn(this.m, ctx, params);
        // Whatever the command did, the artist's identity status follows (e.g. a completed claim verifies the artist).
        afterCommand(this.m, ctx, name, res?.caseId, ENGINE_USER);
        await this.store.save(this.m.takeDirty());
        this.m.commit();
        return res;
      } catch (e) {
        this.m.rollback();
        throw e;
      }
    }).then(res => { this.runner.kick(); return res; });
  }

  upload(input: UploadInput, userId: string | undefined, onStep?: StepFn, onProgress?: ProgressFn): Promise<ImportBatch> {
    return this.serial(async () => {
      let imp: ImportInput = { filename: input.filename, checksum: sha256Hex(input.bytes), importType: input.importType, exportDate: input.exportDate, source: input.source, versionOfId: input.versionOfId ?? null };
      if (input.sheets) imp = { ...imp, sheets: input.sheets, encoding: 'XLSX workbook' };
      else {
        const { text, encoding } = decodeText(input.bytes);
        const { rows, delimiter } = parseDelimited(text);
        imp = { ...imp, table: rows, encoding: delimiter === ',' ? encoding : `${encoding}, ${delimiter}-separated` };
      }
      this.m.begin();
      try {
        const batch = await processImport(this.m, this.ctx(userId), imp, onStep, onProgress);
        await this.store.save(this.m.takeDirty());
        this.m.commit();
        return batch;
      } catch (e) {
        this.m.rollback();
        throw e;
      }
    }).then(b => { this.runner.kick(); return b; });
  }

  /**
   * Background import (v2 §39): returns a job at once; processing runs in the engine's write queue and yields between
   * row batches, so the browser stays responsive and can poll `importJob(id)` for progress.
   */
  startImport(input: UploadInput, userId: string | undefined): ImportJob {
    const now = new Date();
    const id = `IMP-${now.getFullYear()}-${String(this.m.count('batches') + this.jobs.size + 1).padStart(5, '0')}`;
    const job: ImportJob = { id, filename: input.filename, status: 'QUEUED', step: 'Waiting', rows: 0, done: 0, percent: 0, batchId: null, error: null, userId: userId ?? ENGINE_USER, startedAt: now.toISOString(), finishedAt: null };
    this.jobs.set(id, job);
    const yieldNow = () => new Promise<void>(r => setTimeout(r, 0));
    void this.upload(input, userId, async step => { job.status = 'PROCESSING'; job.step = step; await yieldNow(); }, async (done, total) => {
      job.status = 'PROCESSING'; job.rows = total; job.done = done; job.percent = total ? Math.min(99, Math.round((done / total) * 100)) : 0;
      await yieldNow();
    }).then(batch => {
      Object.assign(job, { status: batch.status === 'Failed' ? 'FAILED' : 'COMPLETED', step: 'Complete', batchId: batch.id, rows: batch.rowCount || job.rows, done: batch.rowCount || job.rows, percent: 100, error: batch.status === 'Failed' ? batch.summary.errors[0] ?? 'Import failed' : null, finishedAt: new Date().toISOString() });
    }).catch(e => {
      Object.assign(job, { status: 'FAILED', error: e instanceof Error ? e.message : String(e), finishedAt: new Date().toISOString() });
    });
    return job;
  }
  importJob(id: string): ImportJob | null { return this.jobs.get(id) ?? null; }

  /** Housekeeping that time alone triggers: verified profiles that became stale reopen their artist. */
  maintain(): Promise<number> {
    return this.serial(async () => {
      this.m.begin();
      try {
        const n = sweepStale(this.m, this.ctx(ENGINE_USER), staleDaysOf(this.m));
        await this.store.save(this.m.takeDirty());
        this.m.commit();
        return n;
      } catch (e) {
        this.m.rollback();
        throw e;
      }
    });
  }

  /** Add a person to the workspace (the account itself lives in the auth store). `by` = who added them; else they signed up. */
  addUser(user: User, by?: string): Promise<User> {
    return this.write(by ?? null, (m, ctx) => {
      if (m.get('users', user.id)) throw new RuleError('This user already exists.');
      const u = m.insert('users', user);
      audit(m, by ? ctx : { ...ctx, userId: user.id }, { caseId: null, entity: 'User', entityId: user.id, action: by ? 'Person added' : 'Signed up', to: user.role });
      return u;
    });
  }

  /** A write outside the command registry (accounts): one transaction, recorded under `userId`. */
  write<T>(userId: string | null, fn: (m: Model, ctx: Ctx) => T): Promise<T> {
    return this.serial(async () => {
      this.m.begin();
      try {
        const res = fn(this.m, this.ctx(userId ?? ENGINE_USER));
        await this.store.save(this.m.takeDirty());
        this.m.commit();
        return res;
      } catch (e) {
        this.m.rollback();
        throw e;
      }
    });
  }

  /** Start again with an empty workspace (all data is deleted; signed-up people stay). 'seed' loads the test fixtures. */
  reset(kind: 'empty' | 'seed' = 'empty'): Promise<{ cases: number }> {
    return this.serial(async () => {
      if (kind === 'seed' && !this.opts.seed) throw new RuleError('No seed is configured.');
      this.runner.stop();
      const m = kind === 'seed' ? await this.opts.seed!() : emptyModel(this.m.all('users'));
      m.takeDirty();
      await this.store.replace(m.snapshot());
      this.m = m;
      this.runner = this.makeRunner();
      return { cases: m.count('cases') };
    }).then(r => { this.runner.kick(); return r; });
  }

  /** Resolves when no discovery job is running or queued (tests). */
  idle() { return this.runner.idle(); }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

