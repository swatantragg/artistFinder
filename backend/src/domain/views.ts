// v2 read models: the artist is the central object. Artists (one master list, statuses are filters), Verified Artists,
// Deduplicate, the management dashboard and song provenance. Lists are filtered and paged on the server.
import { ACTIVE_JOB_STATUSES, ARTIST_STATUSES, ARTIST_STATUS_INFO, GOONGOONALO_INFO, GOONGOONALO_STATUSES, OPEN_TASK_STATUSES, type ArtistStatus, type GoongoonaloStatus } from './constants';
import { duplicateEvidence } from './dedupe';
import type { Model } from './model';
import { userName } from './ops';
import { isVerified, reopenReasons } from './status';
import type { ArtistCase, Ctx } from './types';
import { matchTier, sameId, searchKey, searchQuery, TIER } from './search';
import { addDays, nameKey, normIsrc } from './util';

// ------------------------------------------------------------------ cached aggregates
const cache = new WeakMap<Model, { v: number; songs: Map<string, number>; jobs: Map<string, string | null> }>();
export function artistAggregates(m: Model) { return aggregates(m); }
function aggregates(m: Model) {
  const hit = cache.get(m);
  if (hit && hit.v === m.version) return hit;
  const sets = new Map<string, Set<string>>();
  for (const cr of m.data.credits.values()) {
    if (!cr.caseId || cr.status !== 'Active') continue;
    const id = m.canonical(cr.caseId);
    let s = sets.get(id); if (!s) { s = new Set(); sets.set(id, s); }
    s.add(cr.trackId);
  }
  const songs = new Map<string, number>();
  for (const [k, s] of sets) songs.set(k, s.size);
  const jobs = new Map<string, string | null>();
  for (const j of m.data.discoveryJobs.values()) if (j.finishedAt && j.status !== 'CANCELLED' && (jobs.get(j.caseId) ?? '') < j.finishedAt) jobs.set(j.caseId, j.finishedAt);
  const out = { v: m.version, songs, jobs };
  cache.set(m, out);
  return out;
}
const live = (m: Model) => m.all('cases').filter(c => !c.mergedIntoId);

/** Distinct people credited with the artist on its songs (not the artist itself). */
export function collaboratorCount(m: Model, caseId: string): number {
  const fam = new Set(m.family(caseId));
  const people = new Set<string>();
  for (const tid of m.trackIdsOfCase(caseId)) for (const cr of m.creditsOfTrack(tid)) if (cr.status === 'Active' && !(cr.caseId && fam.has(cr.caseId))) people.add(cr.caseId ? m.canonical(cr.caseId) : `n:${nameKey(cr.personName)}`);
  return people.size;
}

// ------------------------------------------------------------------ search across everything an operator may type
/**
 * Artist name or alias, Artist ID or backend ID, ISRC, song title, album, label, profile URL or platform username.
 * Returns the matching artists with what matched (shown under the name).
 */
export interface ArtistHit { why: string; rank: number }
/**
 * Find artists by ID, name, alias, ISRC, profile, song, album or label. Case, spaces and punctuation never matter
 * (search.ts). Each artist gets its best match: rank 0 = an ID or ISRC, 1-6 = the name (exact … similar spelling),
 * 11-16 = an alias, 20 = a profile, 31+ = a song, 41+ = an album, 51+ = a label. `catalogue: false` skips songs, albums
 * and labels (the top search bar lists songs on their own).
 */
export function searchArtists(m: Model, raw: string, opts: { catalogue?: boolean } = {}): Map<string, ArtistHit> {
  const q = searchQuery(raw);
  const out = new Map<string, ArtistHit>();
  if (!q.key) return out;
  const hit = (caseId: string | null | undefined, why: string, rank: number) => {
    if (!caseId) return;
    const id = m.canonical(caseId);
    const cur = out.get(id);
    if (!cur || rank < cur.rank) out.set(id, { why, rank });
  };
  const viaTrack = (tid: string, why: string, rank: number) => { for (const cr of m.creditsOfTrack(tid)) if (cr.caseId && cr.status === 'Active') hit(cr.caseId, why, rank); };
  for (const c of m.data.cases.values()) {
    if (c.mergedIntoId) continue;
    if (sameId(q, c.id) || c.backendProfileIds.some(b => sameId(q, b))) { hit(c.id, 'ID', 0); continue; }
    const t = matchTier(q, c.canonicalName);
    if (t) { hit(c.id, '', t); if (t === TIER.EXACT) continue; }
    for (const a of c.aliases) { const at = matchTier(q, a); if (at) hit(c.id, `Alias: ${a}`, 10 + at); }
  }
  const isrc = normIsrc(raw);
  if (isrc.length >= 10) { const tid = m.idx.trackByIsrc.get(isrc); if (tid) viaTrack(tid, `ISRC ${isrc}`, 0); }
  if (q.key.length >= 3) {
    for (const p of m.data.profiles.values()) if (p.caseId && (searchKey(p.normalizedUrl).includes(q.key) || (p.username && matchTier(q, p.username, { similar: false })))) hit(p.caseId, `Profile: ${p.platform}${p.username ? ` @${p.username}` : ''}`, 20);
    for (const u of m.data.cases.values()) if (!u.mergedIntoId && u.profileUrls.some(x => searchKey(x).includes(q.key))) hit(u.id, 'Profile link', 20);
    if (opts.catalogue !== false) {
      const releases = new Map<string, number>();
      for (const r of m.data.releases.values()) { const t = matchTier(q, r.title, { similar: false }); if (t) releases.set(r.id, t); }
      let n = 0;
      for (const t of m.data.tracks.values()) {
        if (n > 600) break;
        const st = matchTier(q, t.title, { similar: false });
        if (st) { viaTrack(t.id, `Song: ${t.title}`, 30 + st); n++; continue; }
        const rt = t.releaseId ? releases.get(t.releaseId) : 0;
        if (rt) { viaTrack(t.id, `Album: ${m.get('releases', t.releaseId!)?.title ?? ''}`, 40 + rt); n++; continue; }
        const lt = t.label ? matchTier(q, t.label, { similar: false }) : 0;
        if (lt) { viaTrack(t.id, `Label: ${t.label}`, 50 + lt); n++; }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ Artists (the operational workspace)
export interface ArtistRow {
  id: string; name: string; aliases: string[]; sourceIds: string[]; kind: string; songs: number; collaborators: number;
  artistStatus: ArtistStatus; discoveryStatus: string; goongoonaloStatus: GoongoonaloStatus; lastDiscovery: string | null; lastEvidence: string | null; lastEvidenceNote: string | null;
  action: { id: string; label: string } | null; matched: string | null; owner: string; reopenReasons: number; verifiedPlatforms: string[];
}
/** The one thing to do next for this artist (shown as the row's action). */
export function actionFor(m: Model, c: ArtistCase): { id: string; label: string } | null {
  switch (c.artistStatus) {
    case 'NEW': return { id: 'findArtist', label: 'Find artist' };
    case 'SEARCHING': return { id: 'viewDiscovery', label: 'View progress' };
    case 'NEEDS_REVIEW': return { id: 'reviewCandidates', label: 'Review candidates' };
    case 'REOPENED': return { id: 'reviewChanges', label: 'Review changes' };
    case 'PENDING': return c.discoveryStatus === 'Failed' ? { id: 'retrySearch', label: 'Retry search' } : c.discoveryStatus === 'Not started' ? { id: 'findArtist', label: 'Find artist' } : { id: 'openArtist', label: 'Add evidence' };
    case 'VERIFIED': {
      if (c.goongoonaloStatus === 'PENDING') return { id: 'setGoongoonalo', label: 'Decide Goongoonalo status' };
      const t = m.byCase('tasks', c.id).filter(x => OPEN_TASK_STATUSES.includes(x.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
      return t ? { id: 'openArtist', label: t.step } : null;
    }
    default: return null;
  }
}
function artistRow(m: Model, c: ArtistCase, songs: Map<string, number>, jobs: Map<string, string | null>, matched: string | null): ArtistRow {
  return {
    id: c.id, name: c.canonicalName, aliases: c.aliases, sourceIds: c.backendProfileIds, kind: c.kind, songs: songs.get(c.id) ?? 0, collaborators: 0,
    artistStatus: c.artistStatus, discoveryStatus: c.discoveryStatus, goongoonaloStatus: c.goongoonaloStatus, lastDiscovery: jobs.get(c.id) ?? null,
    lastEvidence: c.lastEvidenceChange, lastEvidenceNote: c.lastEvidenceNote, action: actionFor(m, c), matched, owner: userName(m, c.ownerId),
    reopenReasons: reopenReasons(c).length, verifiedPlatforms: [...new Set(m.byCase('verifiedProfiles', c.id).filter(v => v.verificationStatus === 'VERIFIED').map(v => v.platform))],
  };
}
export interface ArtistFilters { status?: string; kind?: string; q?: string; goongoonalo?: string; stage?: string; sort?: string; dir?: 'asc' | 'desc'; page?: number; pageSize?: number }

export const v2Views = {
  artists(m: Model, _ctx: Ctx, f: ArtistFilters = {}) {
    const { songs, jobs } = aggregates(m);
    const kind = f.kind === 'Collaborator' ? 'Collaborator' : f.kind === 'all' ? null : 'Artist';
    const found = f.q ? searchArtists(m, f.q) : null;
    const pool = live(m).filter(c => (!kind || c.kind === kind) && (!found || found.has(c.id)) && (!f.goongoonalo || c.goongoonaloStatus === f.goongoonalo) && (!f.stage || c.lifecycleStage === f.stage));
    const counts = Object.fromEntries(['ALL', ...ARTIST_STATUSES].map(s => [s, 0])) as Record<string, number>;
    for (const c of pool) { counts.ALL++; counts[c.artistStatus]++; }
    let list = pool.filter(c => !f.status || f.status === 'ALL' || c.artistStatus === f.status);
    const dir = f.dir === 'asc' ? 1 : -1;
    const key = f.sort ?? (found ? 'match' : 'attention');
    // What needs a person first: candidates to review, reopened artists, running searches, new artists … then most songs.
    const ATTENTION: Record<ArtistStatus, number> = { NEEDS_REVIEW: 0, REOPENED: 1, SEARCHING: 2, NEW: 3, PENDING: 4, VERIFIED: 5, REJECTED: 6 };
    // Best match first: the ID, the exact name, a name containing the words, an alias or ISRC, a profile, then songs/albums/labels.
    const rank = (c: ArtistCase) => found?.get(c.id)?.rank ?? 99;
    if (key === 'match') list.sort((a, b) => rank(a) - rank(b) || (songs.get(b.id) ?? 0) - (songs.get(a.id) ?? 0) || a.id.localeCompare(b.id));
    else if (key === 'attention') list.sort((a, b) => ATTENTION[a.artistStatus] - ATTENTION[b.artistStatus] || (songs.get(b.id) ?? 0) - (songs.get(a.id) ?? 0) || a.canonicalName.localeCompare(b.canonicalName));
    else list.sort((a, b) => {
      let d = 0;
      switch (key) {
        case 'name': d = a.canonicalName.localeCompare(b.canonicalName); break;
        case 'id': d = a.id.localeCompare(b.id, undefined, { numeric: true }); break;
        case 'songs': d = (songs.get(a.id) ?? 0) - (songs.get(b.id) ?? 0); break;
        case 'lastDiscovery': d = (jobs.get(a.id) ?? '').localeCompare(jobs.get(b.id) ?? ''); break;
        case 'lastEvidence': d = (a.lastEvidenceChange ?? '').localeCompare(b.lastEvidenceChange ?? ''); break;
        default: d = 0;
      }
      return d * dir || a.id.localeCompare(b.id);
    });
    const pageSize = Math.min(100, f.pageSize ?? 25), page = Math.max(1, f.page ?? 1);
    const rows = list.slice((page - 1) * pageSize, page * pageSize).map(c => ({ ...artistRow(m, c, songs, jobs, found?.get(c.id)?.why || null), collaborators: collaboratorCount(m, c.id) }));
    const kinds = { Artist: 0, Collaborator: 0 };
    for (const c of live(m)) if (!found || found.has(c.id)) kinds[c.kind]++;
    return { rows, total: list.length, page, pageSize, counts, kinds, statusInfo: ARTIST_STATUS_INFO };
  },

  verifiedArtists(m: Model, _ctx: Ctx, f: { q?: string; goongoonalo?: string; page?: number; pageSize?: number } = {}) {
    const { songs } = aggregates(m);
    const found = f.q ? searchArtists(m, f.q) : null;
    const pool = live(m).filter(c => isVerified(c) && !c.rejectedAt && (!found || found.has(c.id)));
    const counts = Object.fromEntries(['ALL', ...GOONGOONALO_STATUSES].map(s => [s, 0])) as Record<string, number>;
    for (const c of pool) { counts.ALL++; counts[c.goongoonaloStatus]++; }
    const lastVerified = (c: ArtistCase) => m.byCase('verifiedProfiles', c.id).filter(v => v.verificationStatus === 'VERIFIED').map(v => v.verifiedAt).sort().pop() ?? c.manualVerifiedAt ?? c.firstVerifiedAt;
    const list = pool.filter(c => !f.goongoonalo || f.goongoonalo === 'ALL' || c.goongoonaloStatus === f.goongoonalo)
      .sort((a, b) => (a.goongoonaloStatus === 'PENDING' ? 0 : 1) - (b.goongoonaloStatus === 'PENDING' ? 0 : 1) || (lastVerified(b) ?? '').localeCompare(lastVerified(a) ?? ''));
    const pageSize = Math.min(100, f.pageSize ?? 25), page = Math.max(1, f.page ?? 1);
    const rows = list.slice((page - 1) * pageSize, page * pageSize).map(c => {
      const vps = m.byCase('verifiedProfiles', c.id).filter(v => v.verificationStatus === 'VERIFIED');
      return {
        id: c.id, name: c.canonicalName, sourceIds: c.backendProfileIds, songs: songs.get(c.id) ?? 0, artistStatus: c.artistStatus, goongoonaloStatus: c.goongoonaloStatus,
        goongoonaloAt: c.goongoonaloStatusAt, goongoonaloBy: c.goongoonaloStatusBy ? userName(m, c.goongoonaloStatusBy) : null,
        platforms: vps.map(v => ({ platform: v.platform, username: v.username, url: v.url })), verifiedVia: vps.length ? 'Profiles' : c.claimStatus === 'Completed' ? 'Backend claim' : 'Confirmed by a person',
        lastVerified: lastVerified(c), stage: c.lifecycleStage, claimStatus: c.claimStatus, activationStatus: c.activationStatus, reopen: reopenReasons(c).length,
      };
    });
    return { rows, total: list.length, page, pageSize, counts, info: GOONGOONALO_INFO };
  },

  dedupeQueue(m: Model, _ctx: Ctx, p: { status?: 'open' | 'later' | 'decided'; page?: number; pageSize?: number } = {}) {
    const { songs } = aggregates(m);
    const status = p.status ?? 'open';
    const side = (id: string) => {
      const c = m.get('cases', id)!;
      const tracks = m.trackIdsOfCase(id).map(t => m.get('tracks', t)!).filter(Boolean);
      return {
        id, name: c.canonicalName, aliases: c.aliases, sourceIds: c.backendProfileIds, kind: c.kind, songs: songs.get(m.canonical(id)) ?? 0, language: c.language,
        sample: tracks.slice(0, 3).map(t => ({ title: t.title, isrc: t.isrc, label: t.label })), labels: [...new Set(tracks.map(t => t.label).filter(Boolean))].slice(0, 3),
        artistStatus: c.artistStatus, verifiedPlatforms: [...new Set(m.byCase('verifiedProfiles', id).filter(v => v.verificationStatus === 'VERIFIED').map(v => v.platform))], mergedIntoId: c.mergedIntoId,
      };
    };
    const wanted = m.all('conflicts').filter(x => status === 'open' ? x.status === 'Open' : status === 'later' ? x.status === 'Deferred' : x.status === 'Decided');
    const items = wanted.map(x => {
      const ids = x.caseIds.filter(id => m.get('cases', id));
      const [a, ...rest] = ids.map(id => m.get('cases', id)!);
      const pairs = rest.filter(o => !o.mergedIntoId || status === 'decided').map(o => ({ other: o.id, ...duplicateEvidence(m, a, o) })).sort((u, v) => v.score - u.score);
      const d = x.decisionId ? m.get('decisions', x.decisionId) : null;
      return {
        id: x.id, kind: x.kind, reason: x.reason, status: x.status, createdAt: x.createdAt, cases: ids.map(side), score: pairs[0]?.score ?? 0, pairs,
        decision: d ? { id: d.id, decision: d.decision, by: userName(m, d.reviewerId), at: d.date, reason: d.reason, reversedAt: d.reversedAt, canonicalId: d.canonicalId } : null,
      };
    }).sort((u, v) => status === 'decided' ? (v.decision?.at ?? '').localeCompare(u.decision?.at ?? '') : v.score - u.score || u.createdAt.localeCompare(v.createdAt));
    const pageSize = p.pageSize ?? 20, page = Math.max(1, p.page ?? 1);
    const count = (s: string) => m.all('conflicts').filter(x => x.status === s).length;
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, counts: { open: count('Open'), later: count('Deferred'), decided: count('Decided') } };
  },

  /** Management overview (v2 §11): every number comes from the records and their status-change timestamps. */
  overview(m: Model, ctx: Ctx) {
    const artists = live(m).filter(c => c.kind === 'Artist');
    const st = Object.fromEntries(ARTIST_STATUSES.map(s => [s, 0])) as Record<ArtistStatus, number>;
    const gs = Object.fromEntries(GOONGOONALO_STATUSES.map(s => [s, 0])) as Record<GoongoonaloStatus, number>;
    for (const c of artists) { st[c.artistStatus]++; gs[c.goongoonaloStatus]++; }
    const d = new Date(`${ctx.today}T00:00:00Z`);
    const weekStart = addDays(ctx.today, -((d.getUTCDay() + 6) % 7));     // Monday
    const monthStart = `${ctx.today.slice(0, 7)}-01`;
    const within = (iso: string | null | undefined, from: string) => !!iso && iso.slice(0, 10) >= from && iso.slice(0, 10) <= ctx.today;
    const goongoonaloAdded = (from: string) => new Set(m.all('statusEvents').filter(e => e.kind === 'goongoonalo' && e.to === 'GOONGOONALO' && within(e.at, from) && m.get('cases', e.caseId)?.kind === 'Artist').map(e => e.caseId)).size;
    const period = (from: string) => ({
      added: artists.filter(c => within(c.createdAt, from)).length,
      verified: artists.filter(c => within(c.firstVerifiedAt, from)).length,
      goongoonalo: goongoonaloAdded(from),
    });
    const discovered = artists.filter(c => isVerified(c) || m.byCase('discoveryJobs', c.id).some(j => j.status === 'COMPLETED' || j.status === 'NEEDS_REVIEW')).length;
    const tasks = m.all('tasks').filter(t => OPEN_TASK_STATUSES.includes(t.status) && t.ownerId === ctx.userId).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return {
      today: ctx.today, weekStart, monthStart,
      total: artists.length, collaborators: live(m).filter(c => c.kind === 'Collaborator').length,
      status: st, goongoonalo: gs, duplicates: m.all('conflicts').filter(x => x.status === 'Open').length,
      verifiedAll: artists.filter(c => isVerified(c)).length,
      week: period(weekStart), month: period(monthStart),
      funnel: [
        { label: 'Artists imported', value: artists.length, help: 'Every artist extracted from the uploaded files' },
        { label: 'Discovery started', value: artists.filter(c => c.artistStatus !== 'NEW').length, help: 'Find artist ran or a person worked on the artist' },
        { label: 'Discovery completed', value: discovered, help: 'Candidates found and organised, or already verified' },
        { label: 'Profiles verified', value: artists.filter(c => isVerified(c)).length, help: 'A person verified the identity' },
        { label: 'Goongoonalo artists', value: gs.GOONGOONALO, help: 'Decided by a person' },
      ],
      searching: m.all('discoveryJobs').filter(j => ACTIVE_JOB_STATUSES.includes(j.status)).length,
      myTasks: tasks.slice(0, 6).map(t => ({ id: t.id, caseId: t.caseId, name: m.get('cases', t.caseId)?.canonicalName ?? t.caseId, step: t.step, due: t.dueDate, overdue: t.dueDate < ctx.today })),
      myTaskCount: tasks.length,
      imports: m.all('batches').sort((a, b) => b.id.localeCompare(a.id)).slice(0, 4).map(b => ({ id: b.id, file: b.originalFilename, date: b.uploadDate, status: b.status, rows: b.rowCount, artists: b.summary.artistsFound ?? b.summary.artistCaseIds?.length ?? 0, newArtists: b.summary.artistsCreated })),
    };
  },

  /** Everything known about one song, with the import rows it came from (raw values and how they were read). */
  songDetail(m: Model, _ctx: Ctx, p: { id: string }) {
    const t = m.get('tracks', p.id);
    if (!t) return null;
    const release = t.releaseId ? m.get('releases', t.releaseId) : null;
    const rows = (m.idx.rowsByTrack.get(t.id) ?? []).map(id => m.get('importRows', id)!).filter(Boolean).sort((a, b) => a.batchId.localeCompare(b.batchId));
    return {
      track: t, release,
      credits: m.creditsOfTrack(t.id).map(cr => ({ id: cr.id, name: cr.personName, role: cr.role, caseId: cr.caseId ? m.canonical(cr.caseId) : null, isPrimary: cr.isPrimary, status: cr.status, source: cr.sourceVersion, firstSeen: cr.firstSeen })),
      sources: rows.map(r => ({ batchId: r.batchId, file: m.get('batches', r.batchId)?.originalFilename ?? '', rowNumber: r.rowNumber, status: r.status, reason: r.reason, raw: r.raw, mapped: r.mapped })),
    };
  },
};
