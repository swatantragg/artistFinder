// Background discovery jobs. In-process queue with concurrency control, per-provider limits, retries with backoff,
// a circuit breaker per provider, result caching and visible step-by-step progress. The browser request never waits
// for a search: it queues a job and polls. (Production: swap this class for a Redis/BullMQ worker with the same steps.)
import { ACTIVE_JOB_STATUSES, DISCOVERY_STEPS } from '../constants';
import type { Model } from '../model';
import type { Ctx, DiscoveryJob, JobProvider } from '../types';
import { beginJob, cacheKeyOf, cacheLookup, failJob, finalizeJob, searchBlocked, type Collected, type QueryRun } from './pipeline';
import { ProviderError, pool, sleep, type CrawlResult, type DiscoveryProvider, type ProviderSet, type SearchContext } from './providers';
import { artistQueries, buildFacts, collaboratorQueries, type SearchRequest } from './queries';
import { normalizeProfileUrl } from './normalize';
import { reserveCall } from './budget';

export interface DiscoveryHost {
  /** Run a change inside the engine's serialized transaction and persist it. */
  mutate<T>(fn: (m: Model, ctx: Ctx) => T): Promise<T>;
  /** In-memory progress update; saved with the next write. */
  touch(fn: (m: Model) => void): void;
  read<T>(fn: (m: Model) => T): T;
  ctx(): Ctx;
}
export interface RunnerOptions {
  concurrency: number;          // jobs at the same time
  perProvider: number;          // parallel queries per provider
  retries: number;              // extra attempts per query
  backoffMs: number;
  cacheDays: number;
  pace: (job: DiscoveryJob) => number;   // minimum ms per step (0 = as fast as the providers answer)
}
export const DEFAULT_RUNNER: RunnerOptions = { concurrency: 2, perProvider: 3, retries: 1, backoffMs: 400, cacheDays: 7, pace: () => 0 };

export class DiscoveryRunner {
  private running = new Set<string>();
  private nextCallAt = new Map<string, number>();   // per provider, shared by parallel jobs (requests-per-second limits)
  private stopped = false;
  private waiters: (() => void)[] = [];
  constructor(private host: DiscoveryHost, private providers: () => ProviderSet, private opts: RunnerOptions = DEFAULT_RUNNER) {}

  /** Start queued jobs up to the concurrency limit. Cheap to call after every write. */
  kick() {
    if (this.stopped) return;
    const queued = this.host.read(m => m.all('discoveryJobs').filter(j => j.status === 'QUEUED').sort((a, b) => Number(!!a.bulkId) - Number(!!b.bulkId) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(j => j.id));
    for (const id of queued) {
      if (this.running.size >= this.opts.concurrency) break;
      if (this.running.has(id)) continue;
      this.running.add(id);
      void this.run(id).finally(() => { this.running.delete(id); this.kick(); this.settle(); });
    }
    this.settle();
  }
  /** Run one job immediately (seeding and tests). */
  async runNow(jobId: string) { this.running.add(jobId); try { await this.run(jobId); } finally { this.running.delete(jobId); } }
  /** Resolves when nothing is running or queued. */
  idle(): Promise<void> { return new Promise(r => { this.waiters.push(r); this.settle(); }); }
  stop() { this.stopped = true; this.settle(true); }
  get active() { return this.running.size; }

  /** Waits for this provider's next free slot (minIntervalMs apart). */
  private async throttle(p: DiscoveryProvider) {
    const gap = p.limits?.minIntervalMs ?? 0;
    if (!gap) return;
    const now = Date.now(), at = Math.max(now, this.nextCallAt.get(p.id) ?? 0);
    this.nextCallAt.set(p.id, at + gap);
    if (at > now) await sleep(at - now);
  }

  private settle(force = false) {
    if (!force && (this.running.size || this.host.read(m => m.all('discoveryJobs').some(j => j.status === 'QUEUED')))) return;
    const w = this.waiters; this.waiters = []; for (const r of w) r();
  }

  private async run(jobId: string) {
    const set = this.providers();
    const blocked = this.host.read(m => searchBlocked(m, { ...this.host.ctx(), discovery: set.mode }));
    if (blocked) { await this.host.mutate((m, ctx) => { const j = m.get('discoveryJobs', jobId); if (j && j.status === 'QUEUED') failJob(m, ctx, jobId, blocked); }); return; }
    const job = await this.host.mutate((m, ctx) => beginJob(m, ctx, jobId));
    if (!job || this.stopped) return;
    const ctxS: SearchContext = { jobId, caseId: job.caseId, version: job.version, attempt: job.attempt, bulk: !!job.bulkId };
    const stats = new Map<string, JobProvider>(set.providers.map(p => [p.id, { id: p.id, label: p.label, kind: p.kind, status: 'skipped' as JobProvider['status'], queries: 0, results: 0, cached: 0, error: null }]));
    const failures = new Map<string, number>();
    const limitHit = new Map<string, string>();     // provider → why its quota stopped it
    const usedInJob = new Map<string, number>();    // provider → queries given to it in this job (per-artist cap)
    const runs: QueryRun[] = [];
    const crawls = new Map<string, CrawlResult>();
    let counters = { queries: 0, results: 0 };
    const progress = (step: number, detail: string | null, state: 'running' | 'done' | 'skipped' = 'running') => this.stopped ? undefined : this.host.touch(m => {
      const j = m.get('discoveryJobs', jobId);
      if (!j || !ACTIVE_JOB_STATUSES.includes(j.status)) return;
      m.update('discoveryJobs', jobId, {
        step, status: step >= 5 ? 'PROCESSING' : 'SEARCHING', queryCount: counters.queries, resultCount: counters.results,
        steps: j.steps.map((s, i) => (i < step ? { ...s, state: s.state === 'skipped' ? 'skipped' : 'done' } : i === step ? { ...s, state, detail: detail ?? s.detail } : s)),
        providers: [...stats.values()],
      });
    });
    const paced = async <T>(step: number, detail: string | null, fn: () => Promise<T>): Promise<T> => {
      const t = Date.now();
      progress(step, detail);
      const out = await fn();
      const wait = this.opts.pace(job) - (Date.now() - t);
      if (wait > 0) await sleep(wait);
      return out;
    };
    const force = job.mode === 'refresh';
    const today = this.host.ctx().today;
    const execute = async (reqs: SearchRequest[], providers: DiscoveryProvider[]) => {
      for (const p of providers) {
        let mine = reqs.filter(r => p.handles(r));
        // Quota providers get only their most useful queries (requests are already sorted by priority). Web search
        // rarely finds a bare ISRC, so a quota-limited web search leaves ISRCs to the music APIs.
        if (p.limits?.perArtist && p.kind === 'web') mine = mine.filter(r => r.kind !== 'isrc');
        if (p.limits?.perArtist) { mine = mine.slice(0, Math.max(0, p.limits.perArtist - (usedInJob.get(p.id) ?? 0))); usedInJob.set(p.id, (usedInJob.get(p.id) ?? 0) + mine.length); }
        if (!mine.length || !p.search) continue;
        await pool(mine, this.opts.perProvider, async req => {
          if (this.stopped) return;
          const st = stats.get(p.id)!;
          const cacheKey = cacheKeyOf(p.id, req.query);
          if ((failures.get(p.id) ?? 0) >= 3) { runs.push({ req, providerId: p.id, providerLabel: p.label, status: 'skipped', hits: [], error: 'Skipped: source unavailable in this run', cacheKey }); return; }
          if (!force && p.kind !== 'internal') {
            const cached = this.host.read(m => cacheLookup(m, cacheKey, this.opts.cacheDays, today));
            if (cached) { runs.push({ req, providerId: p.id, providerLabel: p.label, status: 'cached', hits: cached, error: null, cacheKey }); st.cached++; st.results += cached.length; st.status = st.status === 'failed' ? 'partial' : 'ok'; counters = { queries: counters.queries + 1, results: counters.results + cached.length }; return; }
          }
          let lastErr: string | null = null;
          for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
            // Every real call (retries too) is counted before it is made; a reached limit stops this provider.
            const refused = limitHit.get(p.id) ?? (p.limits ? await this.host.mutate((m, ctx) => reserveCall(m, p, ctx.today)) : null);
            if (refused) {
              limitHit.set(p.id, refused);
              st.status = st.status === 'ok' || st.status === 'partial' ? 'partial' : 'limited'; st.error = refused;
              runs.push({ req, providerId: p.id, providerLabel: p.label, status: 'skipped', hits: [], error: refused, cacheKey });
              return;
            }
            await this.throttle(p);
            try {
              const hits = await p.search!(req, ctxS);
              runs.push({ req, providerId: p.id, providerLabel: p.label, status: 'ok', hits, error: null, cacheKey });
              st.queries++; st.results += hits.length; st.status = st.status === 'failed' ? 'partial' : 'ok';
              failures.set(p.id, 0);
              counters = { queries: counters.queries + 1, results: counters.results + hits.length };
              return;
            } catch (e) {
              lastErr = e instanceof Error ? e.message : String(e);
              if (!(e instanceof ProviderError) || !e.transient) break;
              await sleep(this.opts.backoffMs * (attempt + 1) * (ctxS.bulk ? 0.05 : 1));
            }
          }
          failures.set(p.id, (failures.get(p.id) ?? 0) + 1);
          st.queries++; st.error = lastErr; st.status = st.status === 'ok' ? 'partial' : 'failed';
          runs.push({ req, providerId: p.id, providerLabel: p.label, status: 'failed', hits: [], error: lastErr, cacheKey });
          counters = { ...counters, queries: counters.queries + 1 };
        });
      }
    };
    try {
      const facts = this.host.read(m => buildFacts(m, m.canonical(job.caseId), job.focusTrackIds));
      // 1. queries
      const artistReqs = await paced(0, null, async () => artistQueries(facts, job.mode, !!job.bulkId));
      progress(0, `${artistReqs.length} queries from ${facts.stats.songs} songs, ${facts.stats.isrcs} ISRCs, ${facts.stats.labels} label(s), ${facts.stats.collaborators} collaborator(s)`, 'done');
      const web = set.providers.filter(p => p.kind === 'web' || p.kind === 'internal');
      const apis = set.providers.filter(p => p.kind === 'api');
      const crawler = set.providers.find(p => p.kind === 'crawler' && p.crawl);
      // 2. web search, 3. supported APIs
      await paced(1, null, () => execute(artistReqs, web));
      progress(1, `${runs.filter(r => web.some(p => p.id === r.providerId)).length} web queries`, 'done');
      if (apis.length) { await paced(2, null, () => execute(artistReqs, apis)); progress(2, `${apis.map(a => a.label).join(', ')}`, 'done'); }
      else progress(2, 'No music API configured', 'skipped');
      // 4. songs: crawl candidate websites (public pages that allow it) for links and listed songs
      await paced(3, null, async () => {
        if (!crawler) return;
        const sites = new Map<string, string>();
        for (const r of runs) for (const h of r.hits) { const n = normalizeProfileUrl(h.url, h.platform); if (n && (n.platform === 'Website' || n.platform === 'Label website') && !sites.has(n.normalized)) sites.set(n.normalized, n.url); }
        await pool([...sites.entries()].slice(0, 5), 2, async ([norm, url]) => { try { const res = await crawler.crawl!(url, ctxS); if (res) crawls.set(norm, res); } catch { /* a page that fails to load is skipped */ } });
        const st = stats.get(crawler.id)!;
        st.queries = sites.size; st.results = crawls.size; st.status = sites.size ? 'ok' : 'skipped';
      });
      progress(3, `${crawls.size} public page(s) read; songs, ISRCs and labels compared`, 'done');
      // 5. collaborators
      const collabReqs = collaboratorQueries(facts, job.mode, !!job.bulkId);
      await paced(4, null, () => execute(collabReqs, [...web, ...apis]));
      progress(4, collabReqs.length ? `${new Set(collabReqs.map(r => r.subjectName)).size} collaborator(s) looked up` : 'Collaborators already verified or none credited', 'done');
      const collected: Collected = { runs, crawls, providers: [...stats.values()] };
      // No search source answered (outage or quota): the job fails. It never concludes that the artist does not exist.
      const searchProviders = [...stats.values()].filter(p => p.kind === 'web' || p.kind === 'api');
      if (!searchProviders.length) { await this.host.mutate((m, ctx) => failJob(m, ctx, jobId, 'No search provider is configured', collected)); return; }
      if (!searchProviders.some(p => p.status === 'ok' || p.status === 'partial')) {
        const failed = searchProviders.filter(p => p.status === 'failed');
        const why = failed.find(p => p.error)?.error ?? 'no source answered';
        const reasons = [failed.length ? `Search provider unavailable (${failed.map(p => p.label).join(', ')}): ${why}` : null, limitHit.size ? `Search limit reached: ${[...limitHit.values()].join('; ')}` : null].filter(Boolean);
        if (reasons.length) { await this.host.mutate((m, ctx) => failJob(m, ctx, jobId, reasons.join('. '), collected)); return; }
      }
      // 6. graph and 7. candidates (one transaction)
      await paced(5, 'Linking songs, collaborators, profiles and contacts', async () => undefined);
      progress(6, 'Normalizing, grouping and scoring candidates');
      if (this.stopped) return;
      await this.host.mutate((m, ctx) => finalizeJob(m, ctx, jobId, collected));
    } catch (e) {
      if (this.stopped) return;
      const reason = e instanceof Error ? e.message : String(e);
      await this.host.mutate((m, ctx) => (m.get('discoveryJobs', jobId) ? failJob(m, ctx, jobId, `Internal error: ${reason}`, { runs, crawls, providers: [...stats.values()] }) : null)).catch(() => undefined);
    }
  }
}
export { DISCOVERY_STEPS };
