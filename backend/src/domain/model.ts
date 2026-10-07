// In-memory relational store with indexes and change tracking.
// It runs inside the API server and is persisted to PostgreSQL via Prisma (src/server/store.ts).
import type {
  ActivationEvent, ArtistCase, ArtistProfile, AuditEvent, ClaimEvent, Collaborator, ConnectionPath, Contact, ContactAttempt, Credit, DiscoveryEvidence,
  DiscoveryJob, DiscoveryQuery, DiscoveryResult, GraphEdge, GraphNode, IdentityConflict, IdentityDecision, ImportBatch, ImportRow, Meta, Notification,
  Release, ReopenEvent, ResearchActivity, Route, StatusEvent, Task, Track, User, VerifiedProfile,
} from './types';
import { coreKey, nameKey, similarKey } from './util';

export interface Entities {
  users: User; cases: ArtistCase; batches: ImportBatch; importRows: ImportRow; releases: Release; tracks: Track;
  credits: Credit; conflicts: IdentityConflict; decisions: IdentityDecision; contacts: Contact; routes: Route;
  research: ResearchActivity; attempts: ContactAttempt; tasks: Task; claimEvents: ClaimEvent;
  activationEvents: ActivationEvent; reopens: ReopenEvent; audit: AuditEvent; notifications: Notification; meta: Meta;
  collaborators: Collaborator; profiles: ArtistProfile; verifiedProfiles: VerifiedProfile; discoveryJobs: DiscoveryJob; discoveryQueries: DiscoveryQuery;
  discoveryResults: DiscoveryResult; discoveryEvidence: DiscoveryEvidence; graphNodes: GraphNode; graphEdges: GraphEdge; connectionPaths: ConnectionPath;
  statusEvents: StatusEvent;
}
export type CollectionName = keyof Entities;
export const COLLECTIONS: CollectionName[] = [
  'users', 'cases', 'batches', 'importRows', 'releases', 'tracks', 'credits', 'conflicts', 'decisions', 'contacts', 'routes',
  'research', 'attempts', 'tasks', 'claimEvents', 'activationEvents', 'reopens', 'audit', 'notifications', 'meta',
  'collaborators', 'profiles', 'verifiedProfiles', 'discoveryJobs', 'discoveryQueries', 'discoveryResults', 'discoveryEvidence', 'graphNodes', 'graphEdges', 'connectionPaths',
  'statusEvents',
];
/** Collections that hang off a case and get a caseId index. */
const BY_CASE: { c: CollectionName; key: string }[] = [
  { c: 'routes', key: 'targetCaseId' }, { c: 'research', key: 'caseId' }, { c: 'attempts', key: 'caseId' },
  { c: 'tasks', key: 'caseId' }, { c: 'claimEvents', key: 'caseId' }, { c: 'activationEvents', key: 'caseId' },
  { c: 'reopens', key: 'caseId' }, { c: 'audit', key: 'caseId' },
  { c: 'profiles', key: 'caseId' }, { c: 'verifiedProfiles', key: 'caseId' }, { c: 'discoveryJobs', key: 'caseId' }, { c: 'connectionPaths', key: 'caseId' },
  { c: 'statusEvents', key: 'caseId' },
];

export type Snapshot = { [K in CollectionName]?: Entities[K][] };
export interface Dirty { created: Snapshot; updated: Snapshot }

function push(map: Map<string, string[]>, key: string | null | undefined, id: string) {
  if (!key) return;
  const list = map.get(key);
  if (list) { if (!list.includes(id)) list.push(id); } else map.set(key, [id]);
}
/** Append without the duplicate check: for ids that are new by construction (bulk inserts). */
function append(map: Map<string, string[]>, key: string | null | undefined, id: string) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(id); else map.set(key, [id]);
}

export const profileKey = (caseId: string | null, collaboratorId: string | null, normalizedUrl: string) => `${caseId ?? `collab:${collaboratorId}`}|${normalizedUrl}`;

export class Model {
  data = {} as { [K in CollectionName]: Map<string, Entities[K]> };
  private created = {} as Record<CollectionName, Set<string>>;
  private updated = {} as Record<CollectionName, Set<string>>;
  /** Undo log of the open transaction: previous value of every touched row (undefined = row was inserted). */
  private tx: { undo: Map<string, unknown>; created: Record<string, string[]>; updated: Record<string, string[]> } | null = null;
  version = 0;
  idx = {
    byCase: new Map<CollectionName, Map<string, string[]>>(),
    creditsByTrack: new Map<string, string[]>(),
    creditsByCase: new Map<string, string[]>(),
    trackByBackendId: new Map<string, string>(),
    trackByIsrc: new Map<string, string>(),          // first track with this ISRC (same recording = same song)
    rowsByTrack: new Map<string, string[]>(),        // import rows that carried a song (provenance)
    releaseByBackendId: new Map<string, string>(),
    caseByBackendId: new Map<string, string>(),
    casesByName: new Map<string, string[]>(),
    casesBySimilar: new Map<string, string[]>(),
    casesByCore: new Map<string, string[]>(),        // name without words such as "Official" or "Music"
    contactsByCase: new Map<string, string[]>(),
    contactsByName: new Map<string, string[]>(),
    rowsByBatch: new Map<string, string[]>(),
    mergedChildren: new Map<string, string[]>(),
    // discovery + graph
    profileByKey: new Map<string, string>(),        // `${owner}|${normalizedUrl}` -> profile id
    profilesByCollaborator: new Map<string, string[]>(),
    evidenceByProfile: new Map<string, string[]>(),
    queriesByJob: new Map<string, string[]>(),
    resultsByQuery: new Map<string, string[]>(),
    queryCache: new Map<string, string>(),           // provider|query -> latest successful query id
    edgesByNode: new Map<string, string[]>(),
    edgeByKey: new Map<string, string>(),
    collaboratorByKey: new Map<string, string>(),
    pathByKey: new Map<string, string>(),            // `${caseId}|${signature}` -> path id
  };

  constructor() {
    for (const c of COLLECTIONS) { (this.data as Record<string, Map<string, unknown>>)[c] = new Map(); this.created[c] = new Set(); this.updated[c] = new Set(); }
    for (const b of BY_CASE) this.idx.byCase.set(b.c, new Map());
  }

  get<K extends CollectionName>(c: K, id: string | null | undefined): Entities[K] | undefined { return id ? this.data[c].get(id) : undefined; }
  must<K extends CollectionName>(c: K, id: string): Entities[K] {
    const x = this.data[c].get(id);
    if (!x) throw new Error(`${c} ${id} not found`);
    return x;
  }
  all<K extends CollectionName>(c: K): Entities[K][] { return Array.from(this.data[c].values()); }
  count(c: CollectionName): number { return this.data[c].size; }

  insert<K extends CollectionName>(c: K, obj: Entities[K]): Entities[K] {
    const id = (obj as { id: string }).id;
    if (this.data[c].has(id)) throw new Error(`${c} ${id} already exists`);
    this.remember(c, id);
    this.data[c].set(id, obj);
    this.created[c].add(id);
    this.indexOne(c, obj);
    this.version++;
    return obj;
  }
  update<K extends CollectionName>(c: K, id: string, patch: Partial<Entities[K]>): Entities[K] {
    const obj = this.must(c, id);
    this.remember(c, id);
    Object.assign(obj as object, patch);
    if (!this.created[c].has(id)) this.updated[c].add(id);
    if (c === 'cases') this.indexCaseNames(obj as ArtistCase);
    this.version++;
    return obj;
  }
  /** Mark an object changed after mutating it in place (arrays, nested objects). */
  touch(c: CollectionName, id: string) { this.remember(c, id); if (!this.created[c].has(id)) this.updated[c].add(id); this.version++; }

  // ---- transactions: a command either applies completely or not at all
  begin() {
    const copy = (r: Record<CollectionName, Set<string>>) => Object.fromEntries(COLLECTIONS.map(c => [c, [...r[c]]]));
    this.tx = { undo: new Map(), created: copy(this.created), updated: copy(this.updated) };
  }
  commit() { this.tx = null; }
  rollback() {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    for (const [key, prev] of tx.undo) {
      const [c, id] = key.split('\u0000') as [CollectionName, string];
      const map = this.data[c] as Map<string, unknown>;
      if (prev === undefined) map.delete(id); else map.set(id, prev);
    }
    for (const c of COLLECTIONS) { this.created[c] = new Set(tx.created[c]); this.updated[c] = new Set(tx.updated[c]); }
    this.rebuildIndexes();
    this.version++;
  }
  private remember(c: CollectionName, id: string) {
    if (!this.tx) return;
    const key = `${c}\u0000${id}`;
    if (this.tx.undo.has(key)) return;
    const cur = this.data[c].get(id);
    this.tx.undo.set(key, cur === undefined ? undefined : structuredClone(cur));
  }

  byCase<K extends CollectionName>(c: K, caseId: string): Entities[K][] {
    const ids = this.idx.byCase.get(c)?.get(caseId) ?? [];
    return ids.map(id => this.data[c].get(id)!).filter(Boolean);
  }
  /** Case ids that make up one canonical artist: the case itself plus any case merged into it. */
  family(caseId: string): string[] { return [caseId, ...(this.idx.mergedChildren.get(caseId) ?? [])]; }
  canonical(caseId: string): string {
    let id = caseId, guard = 0;
    while (guard++ < 10) { const c = this.data.cases.get(id); if (!c || !c.mergedIntoId) return id; id = c.mergedIntoId; }
    return id;
  }
  familyItems<K extends CollectionName>(c: K, caseId: string): Entities[K][] { return this.family(caseId).flatMap(id => this.byCase(c, id)); }
  creditsOfCase(caseId: string): Credit[] {
    return this.family(caseId).flatMap(id => (this.idx.creditsByCase.get(id) ?? []).map(x => this.data.credits.get(x)!)).filter(Boolean);
  }
  creditsOfTrack(trackId: string): Credit[] { return (this.idx.creditsByTrack.get(trackId) ?? []).map(x => this.data.credits.get(x)!).filter(Boolean); }
  trackIdsOfCase(caseId: string): string[] {
    const out = new Set<string>();
    for (const cr of this.creditsOfCase(caseId)) if (cr.status === 'Active') out.add(cr.trackId);
    return [...out];
  }
  casesNamed(name: string): ArtistCase[] { return (this.idx.casesByName.get(nameKey(name)) ?? []).map(id => this.data.cases.get(id)!).filter(c => c && !c.mergedIntoId); }
  casesSimilar(name: string): ArtistCase[] { return (this.idx.casesBySimilar.get(similarKey(name)) ?? []).map(id => this.data.cases.get(id)!).filter(c => c && !c.mergedIntoId); }
  casesCore(name: string): ArtistCase[] { return (this.idx.casesByCore.get(coreKey(name)) ?? []).map(id => this.data.cases.get(id)!).filter(c => c && !c.mergedIntoId); }
  contactsFor(caseId: string): Contact[] { return this.family(caseId).flatMap(id => (this.idx.contactsByCase.get(id) ?? []).map(x => this.data.contacts.get(x)!)).filter(Boolean); }
  contactsNamed(name: string): Contact[] { return (this.idx.contactsByName.get(nameKey(name)) ?? []).map(id => this.data.contacts.get(id)!).filter(Boolean); }
  edgesOf(nodeId: string): GraphEdge[] { return (this.idx.edgesByNode.get(nodeId) ?? []).map(id => this.data.graphEdges.get(id)!).filter(Boolean); }
  profileAt(caseId: string | null, collaboratorId: string | null, normalizedUrl: string): ArtistProfile | undefined {
    const id = this.idx.profileByKey.get(profileKey(caseId, collaboratorId, normalizedUrl));
    return id ? this.data.profiles.get(id) : undefined;
  }

  nextId(prefix: string, width: number): string {
    const key = `seq:${prefix}`;
    const cur = this.data.meta.get(key);
    const n = cur ? Number(cur.value) + 1 : 1;
    if (cur) this.update('meta', key, { value: String(n) }); else this.insert('meta', { id: key, value: String(n) });
    return prefix + String(n).padStart(width, '0');
  }
  getMeta(key: string): string | null { return this.data.meta.get(key)?.value ?? null; }
  setMeta(key: string, value: string) { if (this.data.meta.has(key)) this.update('meta', key, { value }); else this.insert('meta', { id: key, value }); }

  private indexOne(c: CollectionName, obj: unknown) {
    const o = obj as Record<string, unknown> & { id: string };
    const bc = BY_CASE.find(b => b.c === c);
    if (bc) append(this.idx.byCase.get(c)!, o[bc.key] as string, o.id);
    switch (c) {
      case 'credits': append(this.idx.creditsByTrack, o.trackId as string, o.id); append(this.idx.creditsByCase, o.caseId as string, o.id); break;
      case 'tracks': this.idx.trackByBackendId.set(o.backendTrackId as string, o.id); if (o.isrc && !this.idx.trackByIsrc.has(o.isrc as string)) this.idx.trackByIsrc.set(o.isrc as string, o.id); break;
      case 'releases': this.idx.releaseByBackendId.set(o.backendReleaseId as string, o.id); break;
      case 'cases': this.indexCaseNames(obj as ArtistCase); break;
      case 'contacts': push(this.idx.contactsByCase, o.caseId as string, o.id); push(this.idx.contactsByName, nameKey(o.personName as string), o.id); break;
      case 'importRows': append(this.idx.rowsByBatch, o.batchId as string, o.id); append(this.idx.rowsByTrack, o.trackId as string, o.id); break;
      case 'profiles': {
        const p = obj as ArtistProfile;
        this.idx.profileByKey.set(profileKey(p.caseId, p.collaboratorId, p.normalizedUrl), p.id);
        if (p.collaboratorId) append(this.idx.profilesByCollaborator, p.collaboratorId, p.id);
        break;
      }
      case 'discoveryEvidence': append(this.idx.evidenceByProfile, o.profileId as string, o.id); break;
      case 'discoveryQueries': {
        const q = obj as DiscoveryQuery;
        append(this.idx.queriesByJob, q.jobId, q.id);
        if (q.status === 'ok') this.idx.queryCache.set(q.cacheKey, q.id);
        break;
      }
      case 'discoveryResults': append(this.idx.resultsByQuery, o.queryId as string, o.id); break;
      case 'graphEdges': {
        const e = obj as GraphEdge;
        append(this.idx.edgesByNode, e.sourceId, e.id);
        if (e.targetId !== e.sourceId) append(this.idx.edgesByNode, e.targetId, e.id);
        this.idx.edgeByKey.set(e.key, e.id);
        break;
      }
      case 'collaborators': this.idx.collaboratorByKey.set(o.key as string, o.id); break;
      case 'connectionPaths': this.idx.pathByKey.set(`${o.caseId}|${o.signature}`, o.id); break;
      default: break;
    }
  }
  indexCaseNames(c: ArtistCase) {
    for (const b of c.backendProfileIds) if (!this.idx.caseByBackendId.has(b)) this.idx.caseByBackendId.set(b, c.id);
    for (const n of [c.canonicalName, ...c.aliases]) { push(this.idx.casesByName, nameKey(n), c.id); push(this.idx.casesBySimilar, similarKey(n), c.id); push(this.idx.casesByCore, coreKey(n), c.id); }
  }
  /** Re-link a credit to another case (identity correction). */
  relinkCredit(creditId: string, caseId: string | null) {
    const cr = this.must('credits', creditId);
    if (cr.caseId) { const l = this.idx.creditsByCase.get(cr.caseId); if (l) l.splice(l.indexOf(creditId), 1); }
    cr.caseId = caseId;
    push(this.idx.creditsByCase, caseId, creditId);
    this.touch('credits', creditId);
  }
  rebuildIndexes() {
    for (const k of Object.keys(this.idx) as (keyof Model['idx'])[]) {
      if (k === 'byCase') for (const b of BY_CASE) this.idx.byCase.set(b.c, new Map());
      else (this.idx[k] as Map<string, unknown>).clear();
    }
    for (const c of COLLECTIONS) for (const o of this.data[c].values()) this.indexOne(c, o);
    this.rebuildMerges();
  }
  rebuildMerges() {
    this.idx.mergedChildren.clear();
    for (const c of this.data.cases.values()) if (c.mergedIntoId) push(this.idx.mergedChildren, this.canonical(c.id), c.id);
    this.idx.caseByBackendId.clear();
    // canonical cases win the backend-ID lookup; merged cases keep pointing at their canonical case
    for (const c of this.data.cases.values()) for (const b of c.backendProfileIds) {
      const target = this.canonical(c.id);
      if (!this.idx.caseByBackendId.has(b) || !c.mergedIntoId) this.idx.caseByBackendId.set(b, target);
    }
  }

  load(snap: Snapshot) {
    for (const c of COLLECTIONS) {
      const map = this.data[c] as Map<string, unknown>;
      map.clear();
      for (const o of (snap[c] ?? []) as { id: string }[]) map.set(o.id, o);
      this.created[c].clear(); this.updated[c].clear();
    }
    this.rebuildIndexes();
    this.version++;
  }
  snapshot(): Snapshot {
    const out: Snapshot = {};
    for (const c of COLLECTIONS) (out as Record<string, unknown[]>)[c] = this.all(c);
    return out;
  }
  hasChanges(): boolean { return COLLECTIONS.some(c => this.created[c].size || this.updated[c].size); }
  /** Changes since the last call, split into new rows (bulk insert) and changed rows (update). */
  takeDirty(): Dirty {
    const created: Snapshot = {}, updated: Snapshot = {};
    for (const c of COLLECTIONS) {
      if (this.created[c].size) (created as Record<string, unknown[]>)[c] = [...this.created[c]].map(id => this.data[c].get(id)).filter(Boolean);
      if (this.updated[c].size) (updated as Record<string, unknown[]>)[c] = [...this.updated[c]].map(id => this.data[c].get(id)).filter(Boolean);
      this.created[c].clear(); this.updated[c].clear();
    }
    return { created, updated };
  }
}
