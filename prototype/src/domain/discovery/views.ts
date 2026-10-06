// Read models for discovery screens: the discovery queue, one artist's discovery (candidates, evidence, history),
// the connection graph, live job progress and the artists named in an import file.
import { ACTIVE_JOB_STATUSES, DISCOVERY_CASE_STATUSES, STRENGTH_LABEL, type DiscoveryStrength } from '../constants';
import { caseGraph } from '../graph';
import type { Model } from '../model';
import { userName } from '../ops';
import type { ArtistProfile, ConnectionPath, Ctx, DiscoveryJob, QueryKind } from '../types';
import { daysBetween, nameKey } from '../util';
import { bulkCandidates } from './commands';
import { outcomeText, searchBlocked } from './pipeline';
import { buildFacts } from './queries';
import { pickRelevant, relevantOpen } from './relevance';

const KIND_LABEL: Record<QueryKind, string> = {
  name: 'Artist search', role: 'Role search', platform: 'Platform search', site: 'Platform search', song: 'Song search', isrc: 'ISRC search',
  label: 'Label search', distributor: 'Distributor search', alias: 'Alias search', collaborator: 'Collaborator search',
};
const RANK: Record<DiscoveryStrength, number> = { STRONG: 3, POSSIBLE: 2, WEAK: 1 };
export const staleDaysOf = (m: Model) => Number(m.getMeta('discovery.staleDays') ?? 90);
const isStale = (lastCheckedAt: string, today: string, days: number) => daysBetween(lastCheckedAt, today) > days;

export function jobView(m: Model, j: DiscoveryJob) {
  return {
    id: j.id, version: j.version, mode: j.mode, status: j.status, trigger: j.trigger, focus: j.focus, bulkId: j.bulkId, requestedBy: userName(m, j.requestedBy),
    step: j.step, steps: j.steps, providers: j.providers, queryCount: j.queryCount, cachedCount: j.cachedCount, resultCount: j.resultCount, profileCount: j.profileCount,
    newProfileCount: j.newProfileCount, groupCount: j.groupCount, pathCount: j.pathCount, outcome: j.outcome, failureReason: j.failureReason, attempt: j.attempt, retryOf: j.retryOf,
    createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, durationMs: j.durationMs,
    verified: m.all('profiles').filter(p => p.firstJobId === j.id && p.verificationStatus === 'VERIFIED').length,
    rejected: m.all('profiles').filter(p => p.firstJobId === j.id && p.verificationStatus === 'REJECTED').length,
    needsReview: relevantOpen(m, j.caseId).filter(p => p.firstJobId === j.id).length,
  };
}
export type JobView = ReturnType<typeof jobView>;

function profileView(m: Model, p: ArtistProfile, caseId: string | null) {
  const kinds = [...new Set(p.foundVia.map(v => KIND_LABEL[v.kind] ?? v.kind))];
  const job = m.get('discoveryJobs', p.firstJobId);
  return {
    id: p.id, platform: p.platform, url: p.url, displayName: p.displayName, username: p.username, title: p.title, description: p.description, location: p.location, language: p.language,
    links: p.links, tracks: p.tracks, followers: p.followers, strength: p.strength, strengthLabel: STRENGTH_LABEL[p.strength], score: p.evidenceScore, matched: p.matched, conflicts: p.conflicts,
    foundThrough: kinds, providers: p.source.split(' · ').filter(Boolean), queries: p.foundVia.slice(0, 12).map(v => ({ provider: v.provider, query: v.query, kind: KIND_LABEL[v.kind] ?? v.kind, version: v.version })),
    status: p.verificationStatus, discoveryStatus: p.discoveryStatus, reviewNote: p.reviewNote, rejectionReason: p.rejectionReason, reviewedBy: p.reviewedBy ? userName(m, p.reviewedBy) : null, reviewedAt: p.reviewedAt,
    verifiedAt: p.verifiedAt, verifiedBy: p.verifiedBy ? userName(m, p.verifiedBy) : null, lastCheckedAt: p.lastCheckedAt, discoveredAt: p.discoveredAt, groupKey: p.groupKey,
    changeOfProfileId: p.changeOfProfileId, version: job?.version ?? p.lastVersion,
    newEvidence: p.verificationStatus === 'REJECTED' && p.scoreAtReview != null && p.evidenceScore - p.scoreAtReview >= 15,
    foundWhileSearching: job && caseId && job.caseId !== caseId ? m.get('cases', job.caseId)?.canonicalName ?? null : null,
    otherCase: p.otherCaseId ? (() => { const o = m.get('cases', m.canonical(p.otherCaseId)); return o ? { id: o.id, name: o.canonicalName, artistId: o.backendProfileIds[0] ?? null } : null; })() : null,
  };
}
export type ProfileView = ReturnType<typeof profileView>;

function pathView(m: Model, x: ConnectionPath) {
  const contact = x.targetContactId ? m.get('contacts', x.targetContactId) : null;
  const route = x.routeId ? m.get('routes', x.routeId) : null;
  return {
    id: x.id, steps: x.steps, strength: x.strength, strengthLabel: x.strength === 'STRONG' ? 'Strong' : x.strength === 'POSSIBLE' ? 'Possible' : 'Weak', score: x.score, edgeCount: x.edgeCount,
    evidence: x.evidence, status: x.status, note: x.note, reason: x.reason, foundAt: x.foundAt, lastFoundAt: x.lastFoundAt, isNew: daysBetween(x.foundAt, x.lastFoundAt) === 0 && x.status === 'SUGGESTED',
    route: route ? { id: route.id, state: route.state } : null, contact: contact ? { name: contact.personName, channel: contact.channel, willingIntroducer: contact.willingIntroducer } : null,
    decidedBy: x.decidedBy ? userName(m, x.decidedBy) : null, targetType: x.targetType,
  };
}

/** Discovery for one artist: verified knowledge, candidates grouped by possible person, history and connections. */
export function discoveryDetail(m: Model, ctx: Ctx, p: { id: string }) {
  const caseId = m.canonical(p.id);
  const c = m.get('cases', caseId);
  if (!c) return null;
  const facts = buildFacts(m, caseId);
  const staleDays = staleDaysOf(m);
  const profiles = m.byCase('profiles', caseId);
  const views = new Map(profiles.map(x => [x.id, profileView(m, x, caseId)]));
  const jobs = m.byCase('discoveryJobs', caseId).filter(j => j.status !== 'CANCELLED').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const active = jobs.find(j => ACTIVE_JOB_STATUSES.includes(j.status)) ?? null;
  const verified = m.byCase('verifiedProfiles', caseId).filter(v => v.verificationStatus === 'VERIFIED').map(v => {
    const prof = v.profileId ? m.get('profiles', v.profileId) : null;
    const change = prof ? profiles.find(x => x.changeOfProfileId === prof.id && x.verificationStatus === 'UNREVIEWED') : null;
    const days = daysBetween(v.lastCheckedAt, ctx.today);
    return {
      id: v.id, profileId: v.profileId, platform: v.platform, url: v.url, username: v.username, displayName: v.displayName, verifiedAt: v.verifiedAt, verifiedBy: userName(m, v.verifiedBy),
      lastCheckedAt: v.lastCheckedAt, daysSinceCheck: days, stale: days > staleDays, source: v.source, evidence: v.evidence,
      notFound: prof?.discoveryStatus === 'NOT_FOUND', change: change ? views.get(change.id)! : null,
    };
  });
  // Only what a person should look at: the artist's own profile links, 50% match or more (else the best two).
  const relevant = pickRelevant(profiles);
  const open = relevant.filter(x => x.verificationStatus === 'UNREVIEWED');
  const candidates = relevant.map(x => ({ id: x.id, platform: x.platform, url: x.url, displayName: x.displayName, username: x.username, score: x.evidenceScore, status: x.verificationStatus, followers: x.followers }));
  const groupKeys = [...new Set(open.map(x => x.groupKey ?? '?'))].sort();
  const groups = groupKeys.map(key => {
    const members = open.filter(x => (x.groupKey ?? '?') === key).sort((a, b) => b.evidenceScore - a.evidenceScore);
    const best = members.reduce((s, x) => (RANK[x.strength] > RANK[s] ? x.strength : s), 'WEAK' as DiscoveryStrength);
    const otherId = members.find(x => x.otherCaseId)?.otherCaseId ?? null;
    const other = otherId ? m.get('cases', m.canonical(otherId)) : null;
    const verifiedInGroup = profiles.filter(x => x.groupKey === key && x.verificationStatus === 'VERIFIED').map(x => views.get(x.id)!);
    return {
      key, label: `Candidate ${key}`, strength: best, strengthLabel: STRENGTH_LABEL[best], bestScore: Math.max(...members.map(x => x.evidenceScore)), displayName: members[0].displayName,
      profiles: members.map(x => views.get(x.id)!), verifiedProfiles: verifiedInGroup,
      matched: [...new Set(members.flatMap(x => x.matched))].slice(0, 10), conflicts: [...new Set(members.flatMap(x => x.conflicts))].slice(0, 8),
      foundThrough: [...new Set(members.flatMap(x => views.get(x.id)!.foundThrough))], providers: [...new Set(members.flatMap(x => views.get(x.id)!.providers))],
      otherCase: other ? { id: other.id, name: other.canonicalName, artistId: other.backendProfileIds[0] ?? null } : null,
      locations: [...new Set(members.map(x => x.location).filter(Boolean))],
    };
  }).sort((a, b) => RANK[b.strength] - RANK[a.strength] || b.bestScore - a.bestScore);
  const changes = profiles.filter(x => x.changeOfProfileId && x.verificationStatus === 'UNREVIEWED').map(x => ({ next: views.get(x.id)!, old: views.get(x.changeOfProfileId!) ?? null }));
  const last = jobs[0] ?? null;
  const lastDone = jobs.find(j => !ACTIVE_JOB_STATUSES.includes(j.status)) ?? null;
  const noResult = lastDone && lastDone.status !== 'FAILED' && !relevant.length && !verified.length ? {
    queries: m.idx.queriesByJob.get(lastDone.id)?.map(id => m.get('discoveryQueries', id)!).filter(Boolean).map(q => ({ query: q.query, provider: q.provider, status: q.status, results: q.resultCount })) ?? [],
    sources: lastDone.providers.filter(x => x.status !== 'skipped').map(x => x.label), durationMs: lastDone.durationMs, finishedAt: lastDone.finishedAt,
  } : null;
  const collaborators = facts.collaborators.slice(0, 10).map(cf => {
    const rec = m.get('collaborators', m.idx.collaboratorByKey.get(cf.caseId ?? cf.key) ?? '');
    const candidates = cf.caseId ? m.byCase('profiles', cf.caseId).filter(x => x.verificationStatus === 'UNREVIEWED').length : rec ? (m.idx.profilesByCollaborator.get(rec.id) ?? []).length : 0;
    return { name: cf.name, caseId: cf.caseId, roles: cf.roles, songs: cf.songs.slice(0, 4), songCount: cf.songs.length, verifiedProfiles: cf.verifiedProfiles, verifiedContacts: cf.verifiedContacts, candidates, record: rec ? rec.status : null, analysed: !!rec };
  });
  const paths = m.byCase('connectionPaths', caseId).slice().sort((a, b) => (a.status === 'REJECTED' ? 1 : 0) - (b.status === 'REJECTED' ? 1 : 0) || Number(!!a.note) - Number(!!b.note) || b.score - a.score).map(x => pathView(m, x));
  return {
    caseId, name: c.canonicalName, artistId: c.backendProfileIds[0] ?? null, artistIds: c.backendProfileIds, stage: c.lifecycleStage, contactPreference: c.contactPreference, owner: userName(m, c.ownerId),
    discoveryStatus: c.discoveryStatus, verifiedArtist: verified.length > 0, lastVerifiedAt: verified.map(v => v.verifiedAt).sort().pop() ?? null,
    catalogue: { ...facts.stats, labelNames: facts.labels, roles: facts.roles, language: c.language, sampleSongs: facts.songs.slice(0, 5).map(s => s.title), isrcSample: facts.songs.filter(s => s.isrc).slice(0, 3).map(s => s.isrc) },
    verified, candidates, groups, multiple: groups.filter(g => g.strength !== 'WEAK').length >= 2, changes,
    deferred: relevant.filter(x => x.verificationStatus === 'DEFERRED').map(x => views.get(x.id)!),
    rejected: profiles.filter(x => x.verificationStatus === 'REJECTED').map(x => views.get(x.id)!),
    replaced: profiles.filter(x => x.verificationStatus === 'REPLACED').map(x => views.get(x.id)!),
    jobs: jobs.map(j => jobView(m, j)), activeJob: active ? jobView(m, active) : null, lastJob: last ? jobView(m, last) : null, noResult,
    collaborators, paths, staleDays, staleCount: verified.filter(v => v.stale).length,
    blocked: searchBlocked(m, ctx), limit: ctx.searchBudget?.exhausted ?? null,
    canFind: !active && !verified.length && !jobs.some(j => j.status === 'COMPLETED' || j.status === 'NEEDS_REVIEW'), canRefresh: !active && (verified.length > 0 || jobs.some(j => j.status !== 'QUEUED')),
  };
}

export const discoveryViews = {
  discoveryDetail,

  discoveryOverview(m: Model, ctx: Ctx, p: { status?: string; q?: string; page?: number; pageSize?: number } = {}) {
    const staleDays = staleDaysOf(m);
    const live = m.all('cases').filter(c => !c.mergedIntoId);
    const staleCases = new Set(m.all('verifiedProfiles').filter(v => v.verificationStatus === 'VERIFIED' && isStale(v.lastCheckedAt, ctx.today, staleDays)).map(v => m.canonical(v.caseId)));
    const kpis = Object.fromEntries(DISCOVERY_CASE_STATUSES.map(s => [s, 0])) as Record<string, number>;
    for (const c of live) kpis[c.discoveryStatus] = (kpis[c.discoveryStatus] ?? 0) + 1;
    const profiles = m.all('profiles');
    const q = nameKey(p.q ?? '');
    const order: Record<string, number> = { Searching: 0, Queued: 1, 'Needs verification': 2, Failed: 3, Verified: 4, 'No candidate': 5, 'Not started': 6 };
    let rows = live.filter(c => (!p.status || (p.status === 'Stale' ? staleCases.has(c.id) : c.discoveryStatus === p.status)) && (!q || nameKey(c.canonicalName).includes(q) || c.backendProfileIds.some(b => b.toLowerCase() === q) || c.id.toLowerCase() === q));
    rows.sort((a, b) => (order[a.discoveryStatus] ?? 9) - (order[b.discoveryStatus] ?? 9) || (b.discoveryUpdatedAt ?? '').localeCompare(a.discoveryUpdatedAt ?? '') || a.canonicalName.localeCompare(b.canonicalName));
    const total = rows.length, pageSize = p.pageSize ?? 25, page = Math.max(1, p.page ?? 1);
    rows = rows.slice((page - 1) * pageSize, page * pageSize);
    const bulkId = m.getMeta('discovery.currentBulk');
    return {
      kpis, staleProfiles: [...m.all('verifiedProfiles')].filter(v => v.verificationStatus === 'VERIFIED' && isStale(v.lastCheckedAt, ctx.today, staleDays)).length, staleCases: staleCases.size, staleDays,
      counts: {
        candidatesFound: profiles.length, verified: profiles.filter(x => x.verificationStatus === 'VERIFIED').length, rejected: profiles.filter(x => x.verificationStatus === 'REJECTED').length,
        open: live.reduce((n, c) => n + relevantOpen(m, c.id).length, 0), connections: m.all('connectionPaths').filter(x => !x.note).length, routesFromConnections: m.all('routes').filter(r => r.origin === 'Find connection').length,
      },
      eligible: bulkCandidates(m).length, blocked: searchBlocked(m, ctx), limit: ctx.searchBudget?.exhausted ?? null, budgetArtists: ctx.searchBudget ? ctx.searchBudget.artists : null,
      bulk: bulkId ? bulkProgress(m, bulkId) : null,
      rows: rows.map(c => {
        const jobs = m.byCase('discoveryJobs', c.id).filter(j => j.status !== 'CANCELLED');
        const active = jobs.find(j => ACTIVE_JOB_STATUSES.includes(j.status));
        const last = jobs.slice().sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))[0];
        const vps = m.byCase('verifiedProfiles', c.id).filter(v => v.verificationStatus === 'VERIFIED');
        return {
          id: c.id, name: c.canonicalName, artistId: c.backendProfileIds[0] ?? '—', status: c.discoveryStatus, stage: c.lifecycleStage, owner: userName(m, c.ownerId),
          candidates: relevantOpen(m, c.id).length, verifiedProfiles: vps.length, platforms: [...new Set(vps.map(v => v.platform))],
          lastSearch: last?.finishedAt ?? last?.createdAt ?? null, version: last?.version ?? 0, stale: staleCases.has(c.id), failure: last?.status === 'FAILED' ? last.failureReason : null, lastJobId: last?.id ?? null,
          active: active ? { id: active.id, step: active.step, label: active.steps[Math.min(active.step, active.steps.length - 1)]?.label ?? '', status: active.status } : null,
        };
      }),
      total, page, pageSize,
    };
  },

  /** Live state for progress bars and completion toasts. */
  discoveryStatus(m: Model, ctx: Ctx) {
    const jobs = m.all('discoveryJobs');
    const active = jobs.filter(j => ACTIVE_JOB_STATUSES.includes(j.status));
    const since = new Date(Date.parse(ctx.now) - 15 * 60000).toISOString();
    const recent = jobs.filter(j => j.finishedAt && j.finishedAt >= since && !j.bulkId).sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')).slice(0, 12).map(j => {
      const c = m.get('cases', j.caseId);
      const relevant = relevantOpen(m, j.caseId);
      const open = relevant.length;
      const newOpen = relevant.filter(x => x.firstJobId === j.id).length;
      return { jobId: j.id, caseId: j.caseId, name: c?.canonicalName ?? j.caseId, status: j.status, finishedAt: j.finishedAt, mode: j.mode, requestedBy: j.requestedBy,
        text: j.status === 'FAILED' ? `${c?.canonicalName} discovery failed: ${j.failureReason}` : `${c?.canonicalName} discovery completed: ${outcomeText(newOpen, open, j.profileCount)}.` };
    });
    const bulkId = m.getMeta('discovery.currentBulk');
    return { active: active.length, running: active.filter(j => j.status !== 'QUEUED').length, queued: active.filter(j => j.status === 'QUEUED').length, activeCaseIds: active.filter(j => !j.bulkId).map(j => j.caseId), recent, bulk: bulkId ? bulkProgress(m, bulkId) : null };
  },

  bulkPreview(m: Model, _ctx: Ctx, p: { caseIds?: string[] } = {}) { return { count: bulkCandidates(m, p.caseIds).length }; },

  discoveryJobQueries(m: Model, _ctx: Ctx, p: { jobId: string }) {
    return (m.idx.queriesByJob.get(p.jobId) ?? []).map(id => m.get('discoveryQueries', id)!).filter(Boolean).map(q => ({ id: q.id, provider: q.provider, query: q.query, kind: KIND_LABEL[q.kind] ?? q.kind, subject: q.subject, status: q.status, results: q.resultCount, error: q.error }));
  },

  caseGraph(m: Model, _ctx: Ctx, p: { id: string; depth?: number; expand?: string[]; pathId?: string }) {
    const c = m.get('cases', m.canonical(p.id));
    if (!c) return null;
    return { ...caseGraph(m, c.id, { depth: p.depth, expand: p.expand, pathId: p.pathId }), caseId: c.id, name: c.canonicalName, contactPreference: c.contactPreference };
  },


  /** Primary artists named in an import file, with what discovery knows about each. */
  importArtists(m: Model, _ctx: Ctx, p: { id: string; page?: number }) {
    const b = m.get('batches', p.id);
    if (!b) return null;
    const ids = (b.summary.artistCaseIds ?? []).map(id => m.canonical(id)).filter((id, i, a) => a.indexOf(id) === i);
    const inFile = new Map<string, number>();
    for (const rid of m.idx.rowsByBatch.get(b.id) ?? []) { const r = m.get('importRows', rid); const id = r?.caseIds[0] ? m.canonical(r.caseIds[0]) : null; if (id) inFile.set(id, (inFile.get(id) ?? 0) + 1); }
    const cases = ids.map(id => m.get('cases', id)!).filter(Boolean);
    const size = 50, page = Math.max(1, p.page ?? 1);
    return {
      total: cases.length, page, pageSize: size,
      counts: { verified: cases.filter(c => c.verifiedProfileCount > 0).length, notStarted: cases.filter(c => c.discoveryStatus === 'Not started').length, needsVerification: cases.filter(c => c.discoveryStatus === 'Needs verification').length, searching: cases.filter(c => c.discoveryStatus === 'Searching' || c.discoveryStatus === 'Queued').length },
      eligible: bulkCandidates(m, ids).length, caseIds: ids,
      rows: cases.slice((page - 1) * size, page * size).map(c => {
        const vps = m.byCase('verifiedProfiles', c.id).filter(v => v.verificationStatus === 'VERIFIED');
        const active = m.byCase('discoveryJobs', c.id).find(j => ACTIVE_JOB_STATUSES.includes(j.status));
        return {
          id: c.id, name: c.canonicalName, artistId: c.backendProfileIds[0] ?? '—', songsInFile: inFile.get(c.id) ?? (b.status === 'Repeat' ? null : 0), songs: m.trackIdsOfCase(c.id).length, stage: c.lifecycleStage, status: c.discoveryStatus,
          verified: vps.map(v => ({ platform: v.platform, username: v.username, url: v.url })), lastVerifiedAt: vps.map(v => v.verifiedAt).sort().pop() ?? null,
          candidates: relevantOpen(m, c.id).length, active: active ? { step: active.step, status: active.status } : null,
        };
      }),
    };
  },
};

function bulkProgress(m: Model, bulkId: string) {
  const jobs = m.all('discoveryJobs').filter(j => j.bulkId === bulkId);
  return {
    id: bulkId, total: jobs.length, queued: jobs.filter(j => j.status === 'QUEUED').length, running: jobs.filter(j => j.status === 'SEARCHING' || j.status === 'PROCESSING').length,
    completed: jobs.filter(j => j.status === 'COMPLETED' || j.status === 'NEEDS_REVIEW').length, needsReview: jobs.filter(j => j.status === 'NEEDS_REVIEW').length,
    failed: jobs.filter(j => j.status === 'FAILED').length, stopped: jobs.filter(j => j.status === 'CANCELLED').length, done: !jobs.some(j => ACTIVE_JOB_STATUSES.includes(j.status)), startedAt: jobs[0]?.createdAt ?? null,
  };
}
