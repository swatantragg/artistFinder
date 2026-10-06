// Applying a finished search to the workspace, in one transaction: query log, result cache, one candidate per profile URL,
// evidence (matches and conflicts), candidate groups, profile-change detection, graph edges and possible connection paths.
// Nothing here verifies an identity: candidates wait for a person.
import { ACTIVE_JOB_STATUSES, DISCOVERY_STEPS, type DiscoveryMode } from '../constants';
import { findConnections, nid, pathText, savePaths, syncProfileGraph, upsertEdge } from '../graph';
import type { Model } from '../model';
import { audit, notify, openTask, userName } from '../ops';
import { reopenArtist, syncArtistStatus } from '../status';
import type { ArtistProfile, Ctx, DiscoveryJob, DiscoveryResult, FoundVia, JobProvider, ProfileTrack } from '../types';
import { daysBetween } from '../util';
import { groupLetter, groupProfiles, locationConflicts, MATCH_THRESHOLD, scoreProfile, type ProfileInput, type Scored } from './evidence';
import { artistProfileUrl, foldText, handleKey, hasPhrase, normalizeProfileUrl, normalizeQuery, profileName, type NormalizedUrl } from './normalize';
import { pendingChanges, relevantOpen, reviewCount } from './relevance';
import { NOT_CONFIGURED, type CrawlResult, type ProviderHit } from './providers';
import { buildFacts, type CaseFacts, type CollabFact, type SearchRequest } from './queries';

export const ENGINE_USER = 'u-engine';

export interface QueryRun { req: SearchRequest; providerId: string; providerLabel: string; status: 'ok' | 'failed' | 'cached' | 'skipped'; hits: ProviderHit[]; error: string | null; cacheKey: string }
export interface Collected { runs: QueryRun[]; crawls: Map<string, CrawlResult>; providers: JobProvider[] }

export const cacheKeyOf = (providerId: string, query: string) => `${providerId}|${normalizeQuery(query)}`;

/** Cached hits for a query, if it ran successfully within the cache window. */
export function cacheLookup(m: Model, key: string, ttlDays: number, today: string): ProviderHit[] | null {
  const qid = m.idx.queryCache.get(key);
  const q = qid ? m.get('discoveryQueries', qid) : undefined;
  if (!q || daysBetween(q.ranAt, today) > ttlDays) return null;
  return (m.idx.resultsByQuery.get(q.id) ?? []).map(id => m.get('discoveryResults', id)!).filter(Boolean).map(r => ({
    url: r.url, title: r.title, snippet: r.snippet, displayName: r.displayName, username: r.username, platform: r.platform,
    description: r.structured?.description, location: r.structured?.location ?? null, language: r.structured?.language ?? null, links: r.structured?.links ?? [], tracks: r.structured?.tracks ?? [], followers: r.structured?.followers ?? null,
  }));
}

/** Find artist needs a live search provider: without one it is switched off with the reason (it never invents results). */
export function searchBlocked(_m: Model, ctx: Ctx): string | null {
  return ctx.discovery === 'off' ? NOT_CONFIGURED : null;
}

export function queueJob(m: Model, ctx: Ctx, p: { caseId: string; mode: DiscoveryMode; trigger: string; requestedBy: string; focusTrackIds?: string[]; focus?: string[]; bulkId?: string | null; retryOf?: DiscoveryJob | null }): DiscoveryJob {
  const jobs = m.byCase('discoveryJobs', p.caseId);
  const version = p.retryOf ? p.retryOf.version : Math.max(0, ...jobs.filter(j => j.status !== 'CANCELLED' && (j.status !== 'FAILED' || j.resultCount > 0)).map(j => j.version)) + 1;
  const job = m.insert('discoveryJobs', {
    id: m.nextId('DJ', 4), caseId: p.caseId, version, mode: p.mode, status: 'QUEUED', trigger: p.trigger, focus: p.focus ?? [], focusTrackIds: p.focusTrackIds ?? [], bulkId: p.bulkId ?? null,
    requestedBy: p.requestedBy, demo: false, step: 0, steps: DISCOVERY_STEPS.map(label => ({ label, state: 'todo' as const, detail: null })), providers: [],
    queryCount: 0, cachedCount: 0, resultCount: 0, profileCount: 0, newProfileCount: 0, groupCount: 0, pathCount: 0, outcome: null, failureReason: null,
    attempt: p.retryOf ? p.retryOf.attempt + 1 : 1, retryOf: p.retryOf?.id ?? null, createdAt: ctx.now, startedAt: null, finishedAt: null, durationMs: null,
  });
  syncDiscoveryState(m, ctx, p.caseId);
  return job;
}

export function beginJob(m: Model, ctx: Ctx, jobId: string): DiscoveryJob | null {
  const j = m.get('discoveryJobs', jobId);
  if (!j || j.status !== 'QUEUED') return null;
  const c = m.get('cases', j.caseId);
  if (!c || c.mergedIntoId) { failJob(m, ctx, jobId, c ? `Case merged into ${c.mergedIntoId}` : 'Case not found'); return null; }
  m.update('discoveryJobs', jobId, { status: 'SEARCHING', startedAt: ctx.now, step: 0, steps: j.steps.map((s, i) => ({ ...s, state: i === 0 ? 'running' : 'todo' })) });
  syncDiscoveryState(m, ctx, j.caseId);
  return m.get('discoveryJobs', jobId)!;
}

/** Recompute the per-artist discovery state (kept separate from the lifecycle stage). */
export function syncDiscoveryState(m: Model, ctx: Ctx, caseId: string) {
  const c = m.get('cases', caseId);
  if (!c) return;
  const jobs = m.byCase('discoveryJobs', caseId).filter(j => j.status !== 'CANCELLED');
  const active = jobs.find(j => ACTIVE_JOB_STATUSES.includes(j.status));
  const verified = m.byCase('verifiedProfiles', caseId).filter(v => v.verificationStatus === 'VERIFIED').length;
  const open = relevantOpen(m, caseId).length + pendingChanges(m, caseId).length;
  const last = jobs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  const status = active ? (active.status === 'QUEUED' ? 'Queued' : 'Searching') : open > 0 ? 'Needs verification' : verified > 0 ? 'Verified' : last?.status === 'FAILED' ? 'Failed' : last ? 'No candidate' : 'Not started';
  if (c.discoveryStatus !== status || c.verifiedProfileCount !== verified) m.update('cases', caseId, { discoveryStatus: status, verifiedProfileCount: verified, discoveryUpdatedAt: ctx.now });
  syncArtistStatus(m, ctx, caseId);
}

// ------------------------------------------------------------------ aggregation
interface Agg {
  owner: { kind: 'artist' } | { kind: 'collaborator'; collab: CollabFact };
  norm: NormalizedUrl; displayName: string; username: string | null; title: string; description: string; location: string | null; language: string | null;
  links: Set<string>; tracks: Map<string, ProfileTrack>; followers: number | null; providers: Set<string>; via: FoundVia[]; crawlNote: string | null;
}
const linkNorm = (u: string) => normalizeProfileUrl(u)?.normalized ?? null;

function attribute(facts: CaseFacts, run: QueryRun, hit: ProviderHit, otherArtist: (name: string) => boolean): Agg['owner'] | null {
  const nameHay = foldText(`${hit.displayName ?? ''} ${hit.title}`);
  const isArtist = hasPhrase(nameHay, facts.name) || facts.aliases.some(a => hasPhrase(nameHay, a));
  const named = facts.collaborators.find(c => hasPhrase(nameHay, c.name));
  if (isArtist && !named) return { kind: 'artist' };
  if (named && !isArtist) return { kind: 'collaborator', collab: named };
  if (isArtist && named) return run.req.subject === 'collaborator' ? { kind: 'collaborator', collab: facts.collaborators.find(c => c.key === run.req.subjectKey) ?? named } : { kind: 'artist' };
  // A page that names another known artist belongs to them (a shared song title is not evidence about this artist).
  if (otherArtist(hit.displayName || hit.title)) return null;
  if (run.req.subject === 'artist') return { kind: 'artist' };   // e.g. a stage name found through a song query: the evidence decides
  const c = facts.collaborators.find(x => x.key === run.req.subjectKey);
  return c && hasPhrase(foldText(`${hit.description ?? ''} ${hit.snippet}`), c.name) ? { kind: 'collaborator', collab: c } : null;
}

function aggregate(m: Model, facts: CaseFacts, job: DiscoveryJob, collected: Collected): { aggs: Map<string, Agg>; attribution: Map<QueryRun, Map<number, string | null>> } {
  const otherArtist = (name: string) => { const cands = m.casesNamed(name.replace(/\s*[·|(].*$/, '').trim()); return cands.length > 0 && !cands.some(c => c.id === facts.caseId || facts.collaborators.some(x => x.caseId === c.id)); };
  const aggs = new Map<string, Agg>();
  const attribution = new Map<QueryRun, Map<number, string | null>>();
  for (const run of collected.runs) {
    if (run.status !== 'ok' && run.status !== 'cached') continue;
    const map = new Map<number, string | null>();
    run.hits.forEach((hit, i) => {
      // Only the artist's own profile links become candidates; a SoundCloud track or an X post still names its account.
      const norm = artistProfileUrl(hit.url, hit.platform);
      const derived = !!norm && normalizeProfileUrl(hit.url, hit.platform)?.normalized !== norm.normalized;
      const owner = norm ? attribute(facts, run, hit, otherArtist) : null;
      if (!norm || !owner) { map.set(i, null); return; }
      const key = `${owner.kind === 'artist' ? 'artist' : owner.collab.key}|${norm.normalized}`;
      map.set(i, key);
      const a = aggs.get(key) ?? {
        owner, norm, displayName: profileName(norm.platform, norm.normalized, derived ? norm.username ?? hit.displayName ?? hit.title : hit.displayName || hit.title), username: derived ? norm.username : hit.username ?? norm.username, title: hit.title, description: hit.description ?? hit.snippet, location: hit.location ?? null, language: hit.language ?? null,
        links: new Set<string>(), tracks: new Map<string, ProfileTrack>(), followers: hit.followers ?? null, providers: new Set<string>(), via: [], crawlNote: null,
      };
      if ((hit.description ?? '').length > a.description.length) a.description = hit.description!;
      a.location ??= hit.location ?? null; a.language ??= hit.language ?? null; a.followers ??= hit.followers ?? null;
      for (const l of hit.links ?? []) { const n = linkNorm(l); if (n && n !== norm.normalized) a.links.add(n); }
      for (const t of hit.tracks ?? []) a.tracks.set(`${t.title}|${t.isrc ?? ''}`, t);
      a.providers.add(run.providerLabel);
      if (!a.via.some(v => v.provider === run.providerLabel && v.query === run.req.query)) a.via.push({ jobId: job.id, version: job.version, provider: run.providerLabel, query: run.req.query, kind: run.req.kind });
      aggs.set(key, a);
    });
    attribution.set(run, map);
  }
  for (const a of aggs.values()) {
    const cr = collected.crawls.get(a.norm.normalized);
    if (!cr) continue;
    if (cr.blocked) { a.crawlNote = cr.blocked; continue; }
    if ((cr.description ?? '').length > a.description.length) a.description = cr.description!;
    for (const l of cr.links ?? []) { const n = linkNorm(l); if (n && n !== a.norm.normalized) a.links.add(n); }
    for (const t of cr.tracks ?? []) a.tracks.set(`${t.title}|${t.isrc ?? ''}`, t);
    a.location ??= cr.location ?? null; a.language ??= cr.language ?? null;
    a.providers.add('Public web crawler');
  }
  return { aggs, attribution };
}
const inputOf = (a: Agg): ProfileInput => ({ normalizedUrl: a.norm.normalized, platform: a.norm.platform, displayName: a.displayName, username: a.username, title: a.title, description: a.description, location: a.location, language: a.language, links: [...a.links], tracks: [...a.tracks.values()] });

/** Two passes: score each profile, then add cross-platform evidence for profiles linked to or from strong ones. */
function scoreAll(facts: CaseFacts, list: Agg[], anchors: Map<string, string>): Map<Agg, Scored> {
  const first = new Map(list.map(a => [a, scoreProfile(inputOf(a), facts)]));
  const strong = new Map<string, string>(anchors);
  for (const [a, s] of first) if (s.strength === 'STRONG') strong.set(a.norm.normalized, a.norm.platform === 'Website' ? `website:${a.norm.host}` : ['Instagram', 'YouTube', 'X', 'SoundCloud'].includes(a.norm.platform) && a.username ? `${a.norm.platform} @${a.username}` : `${a.norm.platform} “${a.displayName}”`);
  const out = new Map<Agg, Scored>();
  for (const a of list) {
    const linked: string[] = [];
    for (const [url, label] of strong) {
      if (url === a.norm.normalized) continue;
      const from = list.find(x => x.norm.normalized === url);
      if ((from && from.links.has(a.norm.normalized)) || a.links.has(url)) linked.push(label);
    }
    out.set(a, linked.length ? scoreProfile(inputOf(a), facts, linked) : first.get(a)!);
  }
  return out;
}

function upsertProfile(m: Model, ctx: Ctx, job: DiscoveryJob, owner: { caseId: string | null; collaboratorId: string | null }, a: Agg, s: Scored, facts: CaseFacts): { p: ArtistProfile; created: boolean } {
  const cur = m.profileAt(owner.caseId, owner.collaboratorId, a.norm.normalized);
  const matched = s.items.filter(x => x.polarity === 'match').map(x => x.detail);
  const conflicts = s.items.filter(x => x.polarity === 'conflict').map(x => x.detail);
  if (a.crawlNote) conflicts.push(`Not crawled: ${a.crawlNote}`);
  const content = {
    platform: a.norm.platform, url: a.norm.url, displayName: a.displayName, username: a.username, title: a.title, description: a.description, location: a.location, language: a.language,
    links: [...a.links], tracks: [...a.tracks.values()].slice(0, 12), followers: a.followers, evidenceScore: s.score, strength: s.strength, matched, conflicts, matchedSongs: s.matchedSongs, otherCaseId: s.otherCaseId,
    lastJobId: job.id, lastVersion: job.version, lastCheckedAt: ctx.now, discoveryStatus: 'FOUND' as const, demo: false,
  };
  let p: ArtistProfile, created = false;
  if (cur) {
    const via = [...cur.foundVia];
    for (const v of a.via) if (!via.some(x => x.jobId === v.jobId && x.provider === v.provider && x.query === v.query)) via.push(v);
    p = m.update('profiles', cur.id, { ...content, platform: cur.platform, foundVia: via.slice(-40), source: [...new Set([...cur.source.split(' · '), ...a.providers])].filter(Boolean).join(' · ') });
    if (p.verificationStatus === 'VERIFIED') for (const v of m.byCase('verifiedProfiles', p.caseId ?? '')) if (v.profileId === p.id && v.verificationStatus === 'VERIFIED') m.update('verifiedProfiles', v.id, { lastCheckedAt: ctx.now });
  } else {
    const rejectedBefore = owner.caseId ? facts.rejected.get(a.norm.normalized) : undefined;
    p = m.insert('profiles', {
      id: m.nextId('PF', 4), caseId: owner.caseId, collaboratorId: owner.collaboratorId, normalizedUrl: a.norm.normalized, ...content, source: [...a.providers].join(' · '), foundVia: a.via,
      verificationStatus: rejectedBefore ? 'REJECTED' : 'UNREVIEWED', groupKey: null, groupLabel: null, changeOfProfileId: null, scoreAtReview: rejectedBefore ? s.score : null, firstJobId: job.id, discoveredAt: ctx.now,
      reviewedAt: rejectedBefore ? ctx.now : null, reviewedBy: null, reviewNote: rejectedBefore ? 'Rejected earlier by a person; kept out of the candidate list' : null, verifiedAt: null, verifiedBy: null, rejectionReason: rejectedBefore ?? null,
    });
    created = true;
  }
  for (const it of s.items) m.insert('discoveryEvidence', { id: m.nextId('EV', 6), caseId: owner.caseId, profileId: p.id, jobId: job.id, version: job.version, kind: it.kind, polarity: it.polarity, detail: it.detail, weight: it.weight, sourceUrl: p.url, createdAt: ctx.now });
  return { p, created };
}

/**
 * Score an artist's stored, undecided candidates again with today's rules (the match % changed in v2.1) and bring the
 * discovery and identity status in line. Decided profiles keep their decision; nothing is deleted.
 */
export function rescoreOpenCandidates(m: Model, ctx: Ctx, caseId: string): number {
  const all = m.byCase('profiles', caseId);
  const open = all.filter(p => p.verificationStatus === 'UNREVIEWED' || p.verificationStatus === 'DEFERRED');
  if (!open.length) return 0;
  const facts = buildFacts(m, caseId);
  const input = (p: ArtistProfile): ProfileInput => ({ normalizedUrl: p.normalizedUrl, platform: p.platform, displayName: p.displayName, username: p.username, title: p.title, description: p.description, location: p.location, language: p.language, links: p.links ?? [], tracks: p.tracks ?? [] });
  const label = (p: ArtistProfile) => (p.platform === 'Website' ? `website:${p.normalizedUrl.split('/')[0]}` : `${p.platform} ${p.username ? `@${p.username}` : p.displayName}`);
  const first = new Map(open.map(p => [p, scoreProfile(input(p), facts)]));
  const strong = new Map<string, string>();
  for (const p of all) if (p.verificationStatus === 'VERIFIED') strong.set(p.normalizedUrl, `verified ${label(p)}`);
  for (const [p, sc] of first) if (sc.strength === 'STRONG') strong.set(p.normalizedUrl, label(p));
  let changed = 0;
  for (const p of open) {
    const linked = [...strong].filter(([url]) => url !== p.normalizedUrl && ((p.links ?? []).includes(url) || all.some(q => q.normalizedUrl === url && (q.links ?? []).includes(p.normalizedUrl)))).map(([, l]) => l);
    const sc = linked.length ? scoreProfile(input(p), facts, linked) : first.get(p)!;
    // links stored before a platform was known (e.g. gaana.com) get their platform
    const platform = artistProfileUrl(p.url, p.platform)?.platform ?? p.platform;
    if (p.evidenceScore === sc.score && p.strength === sc.strength && platform === p.platform) continue;
    m.update('profiles', p.id, { platform, displayName: profileName(platform, p.normalizedUrl, p.displayName), evidenceScore: sc.score, strength: sc.strength, matched: sc.items.filter(x => x.polarity === 'match').map(x => x.detail), conflicts: sc.items.filter(x => x.polarity === 'conflict').map(x => x.detail), matchedSongs: sc.matchedSongs, otherCaseId: sc.otherCaseId });
    changed++;
  }
  regroup(m, caseId);
  syncDiscoveryState(m, ctx, caseId);
  if (!reviewCount(m, caseId)) for (const j of m.byCase('discoveryJobs', caseId)) if (j.status === 'NEEDS_REVIEW') m.update('discoveryJobs', j.id, { status: 'COMPLETED' });
  return changed;
}

/** Regroup an artist's open and verified profiles into candidate people (A, B, C...) and add group-level location conflicts. */
export function regroup(m: Model, caseId: string) {
  const all = m.byCase('profiles', caseId);
  const list = all.filter(p => p.verificationStatus !== 'REJECTED' && p.verificationStatus !== 'REPLACED');
  const fresh = groupProfiles(list);
  const byFresh = new Map<string, ArtistProfile[]>();
  for (const p of list) { const g = fresh.get(p.id)!; byFresh.set(g, [...(byFresh.get(g) ?? []), p]); }
  // Letters stay stable across search versions: a group keeps the letter people have already seen
  // (also letters of rejected groups stay taken); only a new group gets a new letter.
  const taken = new Set(all.filter(p => !list.includes(p)).map(p => p.groupKey).filter((k): k is string => !!k));
  const letterOf = new Map<string, string>();
  for (const [g, ms] of byFresh) {
    const seen = new Map<string, number>();
    for (const p of ms) if (p.groupKey) seen.set(p.groupKey, (seen.get(p.groupKey) ?? 0) + 1);
    const keep = [...seen].filter(([k]) => !taken.has(k)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (keep) { letterOf.set(g, keep); taken.add(keep); }
  }
  let next = 0;
  for (const g of byFresh.keys()) if (!letterOf.has(g)) { while (taken.has(groupLetter(next))) next++; letterOf.set(g, groupLetter(next)); taken.add(groupLetter(next)); }
  const members = new Map<string, ArtistProfile[]>();
  for (const [g, ms] of byFresh) members.set(letterOf.get(g)!, ms);
  for (const [g, ms] of members) {
    const loc = locationConflicts(ms.map(p => ({ id: p.id, platform: p.platform, location: p.location })));
    for (const p of ms) {
      const base = p.conflicts.filter(x => !x.startsWith('Different city'));
      const extra = loc.get(p.id);
      const conflicts = extra ? [...base, extra] : base;
      if (p.groupKey !== g || p.groupLabel !== `Candidate ${g}` || conflicts.join('|') !== p.conflicts.join('|')) m.update('profiles', p.id, { groupKey: g, groupLabel: `Candidate ${g}`, conflicts });
    }
  }
  return members.size;
}

function autoChecklist(m: Model, ctx: Ctx, caseId: string, step: number, status: 'Complete' | 'In Progress', note: string) {
  const c = m.get('cases', caseId);
  if (!c || c.lifecycleStage === 'Closed' || c.mergedIntoId) return;
  const cur = c.checklist[step - 1];
  if (!cur || cur.status === 'Complete' || (cur.status === 'In Progress' && status === 'In Progress' && cur.note === note)) return;
  m.update('cases', caseId, { checklist: c.checklist.map(x => (x.step === step ? { ...x, status, note, updatedAt: ctx.now, updatedBy: ctx.userId } : x)) });
}

// ------------------------------------------------------------------ finish / fail
export function finalizeJob(m: Model, ctx: Ctx, jobId: string, collected: Collected): DiscoveryJob {
  const job = m.must('discoveryJobs', jobId);
  const caseId = m.canonical(job.caseId);
  const c = m.must('cases', caseId);
  const facts = buildFacts(m, caseId, job.focusTrackIds);
  // 1. query log (with the hits kept as a cache)
  const queryIds = new Map<QueryRun, string>();
  for (const run of collected.runs) {
    const row = m.insert('discoveryQueries', { id: m.nextId('DQ', 6), jobId, caseId, provider: run.providerLabel, query: run.req.query, kind: run.req.kind, subject: run.req.subjectName, status: run.status, resultCount: run.hits.length, cacheKey: run.cacheKey, error: run.error, ranAt: ctx.now });
    queryIds.set(run, row.id);
  }
  // 2. one candidate per normalized URL and owner
  const { aggs, attribution } = aggregate(m, facts, job, collected);
  const artistAggs = [...aggs.values()].filter(a => a.owner.kind === 'artist');
  const anchors = new Map<string, string>();
  for (const p of m.byCase('profiles', caseId)) if (p.verificationStatus === 'VERIFIED') anchors.set(p.normalizedUrl, p.platform === 'Website' ? `website:${p.normalizedUrl.split('/')[0]}` : `verified ${p.platform} ${p.username ? `@${p.username}` : p.displayName}`);
  const scored = scoreAll(facts, artistAggs, anchors);
  // Only candidates worth a person's time are stored: a match of 50% or more, or the best two when nothing reaches 50%.
  const ranked = artistAggs.slice().sort((x, y) => scored.get(y)!.score - scored.get(x)!.score);
  const good = ranked.filter(a => scored.get(a)!.score >= MATCH_THRESHOLD);
  const keep = new Set(good.length ? good : ranked.filter(a => scored.get(a)!.score > 0).slice(0, 2));
  const profileOf = new Map<string, string>();
  let created = 0, kept = 0;
  const createdProfiles: ArtistProfile[] = [];
  for (const a of artistAggs) {
    if (!keep.has(a) && !m.profileAt(caseId, null, a.norm.normalized)) continue;
    kept++;
    const { p, created: isNew } = upsertProfile(m, ctx, job, { caseId, collaboratorId: null }, a, scored.get(a)!, facts);
    profileOf.set(`artist|${a.norm.normalized}`, p.id);
    if (isNew) { created++; createdProfiles.push(p); }
  }
  // collaborators: reuse their verified knowledge, attach new candidates to their own case (or a candidate collaborator record)
  const collabAggs = [...aggs.values()].filter(a => a.owner.kind === 'collaborator');
  const byCollab = new Map<string, Agg[]>();
  for (const a of collabAggs) { const k = (a.owner as { collab: CollabFact }).collab.key; byCollab.set(k, [...(byCollab.get(k) ?? []), a]); }
  const relationships: string[] = [];
  for (const cf of facts.collaborators.slice(0, 8)) {
    const key = cf.caseId ?? cf.key;
    const curId = m.idx.collaboratorByKey.get(key);
    const rec = curId ? m.update('collaborators', curId, { roles: cf.roles, songs: cf.songs, lastJobId: jobId, lastSeenAt: ctx.now }) : m.insert('collaborators', { id: m.nextId('CO', 4), key, name: cf.name, caseId: cf.caseId, status: cf.caseId ? 'Linked case' : 'Candidate', roles: cf.roles, songs: cf.songs, firstJobId: jobId, lastJobId: jobId, firstSeenAt: ctx.now, lastSeenAt: ctx.now });
    const list = byCollab.get(cf.key) ?? [];
    if (!list.length) continue;
    // Known collaborators keep their own verified knowledge; only credited people without a case get candidate records.
    const cFacts: CaseFacts | null = cf.caseId ? null : { ...facts, caseId: '', name: cf.name, aliases: [], roles: cf.roles, songs: facts.songs.filter(s => s.collaborators.includes(cf.name)), collaborators: [], otherSameName: [], rejected: new Map(), verifiedUrls: new Map() };
    const sc = cFacts ? scoreAll(cFacts, list, new Map()) : null;
    for (const a of list) {
      if (cf.caseId) {
        const known = m.profileAt(cf.caseId, null, a.norm.normalized);
        if (known) {
          profileOf.set(`${cf.key}|${a.norm.normalized}`, known.id);
          if (known.verificationStatus === 'VERIFIED') { m.update('profiles', known.id, { lastCheckedAt: ctx.now }); for (const v of m.byCase('verifiedProfiles', cf.caseId)) if (v.profileId === known.id) m.update('verifiedProfiles', v.id, { lastCheckedAt: ctx.now }); }
        }
      } else {
        const { p, created: isNew } = upsertProfile(m, ctx, job, { caseId: null, collaboratorId: rec.id }, a, sc!.get(a)!, cFacts!);
        profileOf.set(`${cf.key}|${a.norm.normalized}`, p.id);
        if (isNew) createdProfiles.push(p);
      }
      // A public mention of the artist is a discovered relationship, never proof that they know each other.
      const text = foldText(`${a.description} ${a.title}`);
      const song = facts.songs.find(s => s.collaborators.includes(cf.name) && hasPhrase(text, s.title));
      if (hasPhrase(text, facts.name) || song) {
        const from = cf.caseId ? nid.case(cf.caseId) : `collab:${rec.id}`;
        const { created: edgeNew } = upsertEdge(m, ctx, { sourceId: from, targetId: nid.case(caseId), type: 'PERSON_CONNECTED_TO_ARTIST', label: 'Public mention', sourceUrl: a.norm.url, sourceType: 'Discovery', source: [...a.providers].join(' · '), status: 'discovered', confidence: 55, evidence: `${cf.name}'s ${a.norm.platform} profile publicly mentions ${hasPhrase(text, facts.name) ? c.canonicalName : ''}${song ? `${hasPhrase(text, facts.name) ? ' and ' : ''}“${song.title}”` : ''}. This shows public collaboration, not a personal relationship.` });
        if (edgeNew) relationships.push(cf.name);
      }
    }
  }
  // artist profiles that mention a collaborator are discovered relationships too
  for (const a of artistAggs) {
    const text = foldText(`${a.description} ${a.title}`);
    for (const cf of facts.collaborators.filter(x => x.caseId && hasPhrase(text, x.name)).slice(0, 2)) {
      const { created: edgeNew } = upsertEdge(m, ctx, { sourceId: nid.case(caseId), targetId: nid.case(cf.caseId!), type: 'PERSON_CONNECTED_TO_ARTIST', label: 'Public mention', sourceUrl: a.norm.url, sourceType: 'Discovery', source: [...a.providers].join(' · '), status: 'discovered', confidence: 50, evidence: `${a.displayName} (${a.norm.platform}) mentions ${cf.name}. Public collaboration, not a confirmed relationship.` });
      if (edgeNew) relationships.push(cf.name);
    }
  }
  // 3. results cache rows, linked to the candidate they produced
  for (const run of collected.runs) {
    if (run.status !== 'ok') continue;
    const att = attribution.get(run);
    run.hits.forEach((hit, i) => {
      const norm = normalizeProfileUrl(hit.url, hit.platform);
      if (!norm) return;
      const k = att?.get(i);
      const row: DiscoveryResult = {
        id: m.nextId('DR', 6), caseId, jobId, queryId: queryIds.get(run)!, version: job.version, provider: run.providerLabel, query: run.req.query, url: norm.url, normalizedUrl: norm.normalized, platform: norm.platform,
        title: hit.title, snippet: hit.snippet, displayName: hit.displayName ?? null, username: hit.username ?? norm.username,
        structured: { description: hit.description, location: hit.location ?? null, language: hit.language ?? null, links: hit.links ?? [], tracks: hit.tracks ?? [], followers: hit.followers ?? null },
        profileId: k ? profileOf.get(k) ?? null : null, demo: false, discoveredAt: ctx.now,
      };
      m.insert('discoveryResults', row);
    });
  }
  // 4. a full search that no longer sees a profile marks it "not found" (it is never invalidated automatically)
  const webOk = collected.providers.some(p => p.kind === 'web' && (p.status === 'ok' || p.status === 'partial'));
  const seen = new Set(artistAggs.filter(a => [...a.providers].some(x => x !== 'Internal catalogue')).map(a => a.norm.normalized));
  if (job.mode !== 'targeted' && webOk) for (const p of m.byCase('profiles', caseId)) if (p.discoveryStatus === 'FOUND' && p.lastJobId !== jobId && !seen.has(p.normalizedUrl) && p.verificationStatus !== 'REJECTED' && p.verificationStatus !== 'REPLACED') m.update('profiles', p.id, { discoveryStatus: 'NOT_FOUND' });
  // 5. groups, then profile changes (a verified profile not found again + a candidate on the same platform in the same group)
  const groupCount = regroup(m, caseId);
  for (const v of m.byCase('profiles', caseId).filter(p => p.verificationStatus === 'VERIFIED' && p.discoveryStatus === 'NOT_FOUND')) {
    const repl = m.byCase('profiles', caseId).find(n => n.verificationStatus === 'UNREVIEWED' && n.platform === v.platform && n.strength !== 'WEAK' && !n.changeOfProfileId && (n.groupKey === v.groupKey || (!!v.username && foldText(n.description).includes(` ${handleKey(v.username)} `)) || (!!v.username && n.description.toLowerCase().includes(`@${v.username}`))));
    if (repl) {
      m.update('profiles', repl.id, { changeOfProfileId: v.id });
      audit(m, ctx, { caseId, entity: 'ArtistProfile', entityId: repl.id, action: 'Profile change detected', from: v.url, to: repl.url, reason: `${v.platform}: verified profile not found in search v${job.version}; a likely replacement was found`, evidence: repl.matched.slice(0, 3).join('; '), next: 'A person decides: verify new, keep old or reject new' });
      reopenArtist(m, ctx, caseId, 'profile_change', `${v.platform} ${v.username ? `@${v.username}` : v.url} not found in search v${job.version}; ${repl.username ? `@${repl.username}` : repl.url} found instead`);
    }
  }
  // 6. graph
  for (const id of new Set(profileOf.values())) syncProfileGraph(m, ctx, m.get('profiles', id)!);
  for (const name of new Set(relationships)) audit(m, ctx, { caseId, entity: 'GraphEdge', entityId: caseId, action: 'Graph relationship discovered', to: `${c.canonicalName} ↔ ${name}: public mention`, reason: 'Found during discovery; shows public collaboration, not a personal relationship', evidence: `Job ${jobId}` });
  // 7. possible connection paths
  const paths = savePaths(m, ctx, caseId, findConnections(m, caseId, ctx.today));
  for (const p of paths.created.filter(x => !x.note)) audit(m, ctx, { caseId, entity: 'ConnectionPath', entityId: p.id, action: 'Possible connection path found', to: pathText(p.steps), reason: 'Possible evidence path through shared catalogue relationships', evidence: p.evidence[0] ?? null });
  for (const p of createdProfiles) audit(m, ctx, { caseId: p.caseId, entity: 'ArtistProfile', entityId: p.id, action: 'Candidate found', to: `${p.platform} ${p.username ? `@${p.username}` : p.displayName}`, reason: `${p.strength === 'STRONG' ? 'Strong' : p.strength === 'POSSIBLE' ? 'Possible' : 'Weak'} candidate, evidence score ${p.evidenceScore}${p.verificationStatus === 'REJECTED' ? ' (rejected earlier, kept hidden)' : ''}`, evidence: p.matched.slice(0, 3).join('; ') || null, result: p.caseId === caseId ? null : `Found while searching ${c.canonicalName}` });
  // 8. job + case state
  const open = reviewCount(m, caseId);
  const finished = m.update('discoveryJobs', jobId, {
    status: open > 0 ? 'NEEDS_REVIEW' : 'COMPLETED', outcome: kept || open ? 'candidates' : 'no_candidates', step: DISCOVERY_STEPS.length,
    steps: job.steps.map(s => ({ ...s, state: s.state === 'failed' || s.state === 'skipped' ? s.state : 'done' })), providers: collected.providers,
    queryCount: new Set(collected.runs.filter(r => r.status !== 'skipped').map(r => normalizeQuery(r.req.query))).size, cachedCount: collected.runs.filter(r => r.status === 'cached').length, resultCount: collected.runs.reduce((n, r) => n + r.hits.length, 0),
    profileCount: kept, newProfileCount: created, groupCount, pathCount: paths.all.filter(p => p.status === 'SUGGESTED' && !p.note).length,
    finishedAt: ctx.now, durationMs: job.startedAt ? Date.parse(ctx.now) - Date.parse(job.startedAt) : null,
  });
  if (created > 0) m.update('cases', caseId, { lastEvidenceChange: ctx.now, lastEvidenceNote: `Discovery v${job.version}: ${created} new candidate profile${created === 1 ? '' : 's'}` });
  autoChecklist(m, ctx, caseId, 1, 'Complete', `Done automatically by discovery ${jobId}: prior research, routes and rejections reused`);
  autoChecklist(m, ctx, caseId, 4, 'Complete', `${facts.stats.songs} songs, ${facts.stats.credits} credits and ${facts.stats.collaborators} collaborators analysed automatically (${jobId})`);
  autoChecklist(m, ctx, caseId, 5, 'Complete', `${collected.providers.filter(p => p.status !== 'skipped').length} sources searched, ${kept} candidate profiles (${jobId})`);
  autoChecklist(m, ctx, caseId, 6, finished.pathCount ? 'Complete' : 'In Progress', finished.pathCount ? `${finished.pathCount} possible connection path(s) found (${jobId})` : 'No connection path found yet');
  syncDiscoveryState(m, ctx, caseId);
  const outcome = outcomeText([...relevantOpen(m, caseId), ...pendingChanges(m, caseId)].filter(p => p.firstJobId === jobId && p.verificationStatus === 'UNREVIEWED').length, open, kept);
  audit(m, ctx, { caseId, entity: 'DiscoveryJob', entityId: jobId, action: 'Discovery completed', to: `v${job.version} (${job.mode})`, reason: `Requested by ${userName(m, job.requestedBy)}: ${job.trigger}`, result: `${finished.queryCount} queries (${finished.cachedCount} cached) · ${finished.resultCount} results · ${artistAggs.length} profiles · ${outcome}`, next: open > 0 ? 'Verify or reject the candidates' : null });
  const cc = m.get('cases', caseId)!;
  if (!job.bulkId) {
    notify(m, ctx, 'Discovery', `${c.canonicalName} discovery completed: ${outcome}.`, caseId);
    if (open > 0 && cc.ownerId && cc.lifecycleStage !== 'Closed') openTask(m, ctx, cc, { kind: 'Research', step: 'Review discovery candidates', why: `Discovery ${jobId} found ${open} candidate profile${open === 1 ? '' : 's'}: verify or reject them`, trigger: `Discovery ${jobId}`, priority: 'Medium' });
  } else maybeFinishBulk(m, ctx, job.bulkId);
  return finished;
}

/** "3 new candidates to review", "nothing new; 1 candidate still to review", "no verified candidate found". */
export function outcomeText(newOpen: number, open: number, profiles: number) {
  if (newOpen > 0) return `${newOpen} new candidate${newOpen === 1 ? '' : 's'} to review`;
  if (open > 0) return `nothing new; ${open} candidate${open === 1 ? '' : 's'} still to review`;
  return profiles ? 'nothing new to review' : 'no verified candidate found';
}

export function failJob(m: Model, ctx: Ctx, jobId: string, reason: string, collected?: Collected): DiscoveryJob {
  const job = m.must('discoveryJobs', jobId);
  for (const run of collected?.runs ?? []) m.insert('discoveryQueries', { id: m.nextId('DQ', 6), jobId, caseId: job.caseId, provider: run.providerLabel, query: run.req.query, kind: run.req.kind, subject: run.req.subjectName, status: run.status, resultCount: run.hits.length, cacheKey: run.cacheKey, error: run.error, ranAt: ctx.now });
  const j = m.update('discoveryJobs', jobId, {
    status: 'FAILED', outcome: 'failed', failureReason: reason, providers: collected?.providers ?? job.providers, finishedAt: ctx.now, durationMs: job.startedAt ? Date.parse(ctx.now) - Date.parse(job.startedAt) : null,
    steps: job.steps.map((s, i) => ({ ...s, state: i === job.step ? 'failed' : s.state === 'running' ? 'failed' : s.state })),
    queryCount: collected ? new Set(collected.runs.filter(r => r.status !== 'skipped').map(r => normalizeQuery(r.req.query))).size : job.queryCount,
  });
  const c = m.get('cases', job.caseId);
  syncDiscoveryState(m, ctx, job.caseId);
  audit(m, ctx, { caseId: job.caseId, entity: 'DiscoveryJob', entityId: jobId, action: 'Search failed', reason, result: 'Discovery failed. This does not mean the artist does not exist.', next: 'Retry' });
  if (!job.bulkId && c) notify(m, ctx, 'Discovery', `${c.canonicalName} discovery failed: ${reason}. Retry when the source is back.`, job.caseId);
  if (job.bulkId) maybeFinishBulk(m, ctx, job.bulkId);
  return j;
}

export function maybeFinishBulk(m: Model, ctx: Ctx, bulkId: string) {
  const jobs = m.all('discoveryJobs').filter(j => j.bulkId === bulkId);
  if (jobs.some(j => ACTIVE_JOB_STATUSES.includes(j.status)) || m.getMeta(`bulkDone:${bulkId}`)) return;
  m.setMeta(`bulkDone:${bulkId}`, ctx.now);
  const stopped = jobs.filter(j => j.status === 'CANCELLED').length, searched = jobs.length - stopped;
  const review = jobs.filter(j => j.status === 'NEEDS_REVIEW').length, failed = jobs.filter(j => j.status === 'FAILED').length;
  const result = `${searched} artist${searched === 1 ? '' : 's'} searched, ${review} need verification, ${failed} failed${stopped ? `, ${stopped} stopped before they started (back to Not started)` : ''}`;
  notify(m, ctx, 'Discovery', `Search all unverified ${stopped ? 'stopped' : 'finished'}: ${result}.`, null);
  audit(m, ctx, { caseId: null, entity: 'DiscoveryBulk', entityId: bulkId, action: 'Bulk discovery finished', result });
}
