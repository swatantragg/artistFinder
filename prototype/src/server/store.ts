// PostgreSQL persistence through Prisma. The engine hands over exactly the rows a command created or changed;
// they are written in one database transaction, so the database never holds half a command.
import { Prisma, PrismaClient } from '@prisma/client';
import type { Store } from '../domain/engine';
import { COLLECTIONS, type CollectionName, type Dirty, type Snapshot } from '../domain/model';

const DELEGATE: Record<CollectionName, string> = {
  users: 'user', cases: 'artistCase', batches: 'importBatch', importRows: 'importRow', releases: 'release', tracks: 'track', credits: 'credit',
  conflicts: 'identityConflict', decisions: 'identityDecision', contacts: 'contact', routes: 'route', research: 'researchActivity', attempts: 'contactAttempt',
  tasks: 'task', claimEvents: 'claimEvent', activationEvents: 'activationEvent', reopens: 'reopenEvent', audit: 'auditEvent', notifications: 'notification', meta: 'meta',
  collaborators: 'collaborator', profiles: 'artistProfile', verifiedProfiles: 'verifiedProfile', discoveryJobs: 'discoveryJob', discoveryQueries: 'discoveryQuery',
  discoveryResults: 'discoveryResult', discoveryEvidence: 'discoveryEvidence', graphNodes: 'graphNode', graphEdges: 'graphEdge', connectionPaths: 'connectionPath',
  statusEvents: 'statusEvent',
};
const TABLE: Record<CollectionName, string> = {
  users: 'users', cases: 'artist_cases', batches: 'import_batches', importRows: 'import_rows', releases: 'releases', tracks: 'tracks', credits: 'credits',
  conflicts: 'identity_conflicts', decisions: 'identity_decisions', contacts: 'contacts', routes: 'routes', research: 'research_activities', attempts: 'contact_attempts',
  tasks: 'tasks', claimEvents: 'claim_events', activationEvents: 'activation_events', reopens: 'reopen_events', audit: 'audit_events', notifications: 'notifications', meta: 'meta',
  collaborators: 'collaborators', profiles: 'artist_profiles', verifiedProfiles: 'verified_profiles', discoveryJobs: 'discovery_jobs', discoveryQueries: 'discovery_queries',
  discoveryResults: 'discovery_results', discoveryEvidence: 'discovery_evidence', graphNodes: 'graph_nodes', graphEdges: 'graph_edges', connectionPaths: 'connection_paths',
  statusEvents: 'status_events',
};
/** Nullable JSON columns need Prisma.DbNull instead of a plain null. */
const NULLABLE_JSON: Partial<Record<CollectionName, string[]>> = { cases: ['waiting', 'arm', 'reopen'], importRows: ['raw', 'mapped'], decisions: ['added', 'snapshot'], routes: ['path'], discoveryResults: ['structured'] };
/** Above this many changed rows in one table, one set-based UPDATE replaces a query per row (e.g. re-importing a big export). */
const BULK_UPDATE_FROM = 50;

type Delegate = {
  findMany(a?: unknown): Promise<unknown[]>;
  createMany(a: { data: unknown[] }): Promise<unknown>;
  update(a: { where: { id: string }; data: unknown }): Promise<unknown>;
};
type Tx = Prisma.TransactionClient;
const delegate = (db: PrismaClient | Tx, c: CollectionName) => (db as unknown as Record<string, Delegate>)[DELEGATE[c]];

function toDb(c: CollectionName, row: unknown): Record<string, unknown> {
  const o = { ...(row as Record<string, unknown>) };
  for (const f of NULLABLE_JSON[c] ?? []) if (o[f] == null) o[f] = Prisma.DbNull;
  return o;
}
async function insertAll(tx: Tx, c: CollectionName, rows: unknown[]) {
  for (let i = 0; i < rows.length; i += 2000) await delegate(tx, c).createMany({ data: rows.slice(i, i + 2000).map(r => toDb(c, r)) });
}
/**
 * Set-based update: UPDATE … FROM jsonb_populate_recordset(…) per 1,000 rows. Rows are grouped by their exact set of
 * fields, so a field a row does not carry is never overwritten.
 */
async function updateMany(tx: Tx, c: CollectionName, rows: unknown[]) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows as Record<string, unknown>[]) { const k = Object.keys(r).sort().join(','); groups.set(k, [...(groups.get(k) ?? []), r]); }
  for (const [keys, list] of groups) {
    const cols = keys.split(',').filter(k => k !== 'id');
    const set = cols.map(k => `"${k}" = s."${k}"`).join(', ');
    for (let i = 0; i < list.length; i += 1000) {
      await tx.$executeRawUnsafe(`UPDATE "${TABLE[c]}" AS t SET ${set} FROM jsonb_populate_recordset(NULL::"${TABLE[c]}", $1::jsonb) AS s WHERE t."id" = s."id"`, JSON.stringify(list.slice(i, i + 1000)));
    }
  }
}

export class PrismaStore implements Store {
  constructor(public db = new PrismaClient()) {}

  async load(): Promise<Snapshot | null> {
    const snap: Snapshot = {};
    let any = false;
    for (const c of COLLECTIONS) {
      const rows = await delegate(this.db, c).findMany();
      (snap as Record<string, unknown[]>)[c] = rows;
      if (rows.length) any = true;
    }
    return any ? snap : null;
  }

  async save(dirty: Dirty): Promise<void> {
    const created = COLLECTIONS.filter(c => dirty.created[c]?.length);
    const updated = COLLECTIONS.filter(c => dirty.updated[c]?.length);
    if (!created.length && !updated.length) return;
    await this.db.$transaction(async tx => {
      for (const c of created) await insertAll(tx, c, dirty.created[c]!);
      for (const c of updated) {
        if (dirty.updated[c]!.length >= BULK_UPDATE_FROM) { await updateMany(tx, c, dirty.updated[c]!); continue; }
        for (const row of dirty.updated[c]!) {
          const { id, ...data } = toDb(c, row);
          await delegate(tx, c).update({ where: { id: id as string }, data });
        }
      }
    }, { timeout: 300_000, maxWait: 30_000 });
  }

  async replace(snapshot: Snapshot): Promise<void> {
    await this.db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`TRUNCATE ${COLLECTIONS.map(c => `"${TABLE[c]}"`).join(', ')} CASCADE`);
      for (const c of COLLECTIONS) await insertAll(tx, c, (snapshot[c] ?? []) as unknown[]);
    }, { timeout: 300_000, maxWait: 30_000 });
  }

  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const c of ['cases', 'tracks', 'credits', 'routes', 'tasks', 'batches', 'audit'] as CollectionName[]) {
      out[c] = await (delegate(this.db, c) as unknown as { count(): Promise<number> }).count();
    }
    return out;
  }
}
