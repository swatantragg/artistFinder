// Discovery commands. Software searches; every identity, route and relationship decision below is made by a person
// and recorded with who, when, why and the evidence. Nothing is deleted: rejected candidates stay, with the reason.
import { ACTIVE_JOB_STATUSES } from '../constants';
import { findConnections, nid, pathText, savePaths, syncProfileGraph, syncRouteGraph, upsertEdge } from '../graph';
import type { Model } from '../model';
import {
  audit, closeTasks, computePriority, finishTask, getCase, openTasks, outreachBlocked, outreachTaskFor, requirePerm, rule, selectRoute, setField, setStage, syncNextAction, userName,
} from '../ops';
import type { ArtistProfile, Ctx, DiscoveryJob, Route } from '../types';
import { clean } from '../util';
import { normalizeProfileUrl } from './normalize';
import { maybeFinishBulk, personalLimit, queueJob, regroup, searchBlocked, syncDiscoveryState } from './pipeline';
import { clearReopen } from '../status';
import { reviewCount } from './relevance';

type P = Record<string, any>;
interface CommandResult { message: string; caseId?: string; id?: string; data?: unknown }
type Command = (m: Model, ctx: Ctx, p: P) => CommandResult;

const req = (v: unknown, what: string): string => { const s = clean(v); if (!s) throw rule(`${what} is required.`); return s; };
const activeJob = (m: Model, caseId: string) => m.byCase('discoveryJobs', caseId).find(j => ACTIVE_JOB_STATUSES.includes(j.status));
function getProfile(m: Model, id: string): ArtistProfile { const p = m.get('profiles', id); if (!p) throw rule('Candidate profile not found.'); return p; }
const label = (p: ArtistProfile) => `${p.platform} ${p.username ? `@${p.username}` : p.displayName}`;

/** Artists that "Search all unverified" would queue: never searched or failed, not verified, not closed, nothing running. */
export function bulkCandidates(m: Model, caseIds?: string[]): string[] {
  const only = caseIds ? new Set(caseIds.map(id => m.canonical(id))) : null;
  return m.all('cases').filter(c => !c.mergedIntoId && !c.rejectedAt && c.lifecycleStage !== 'Closed' && (c.discoveryStatus === 'Not started' || c.discoveryStatus === 'Failed') && c.verifiedProfileCount === 0 && (!only || only.has(c.id)) && !activeJob(m, c.id)).map(c => c.id);
}

function afterReview(m: Model, ctx: Ctx, caseId: string | null) {
  if (!caseId) return;
  regroup(m, caseId);
  syncDiscoveryState(m, ctx, caseId);
  const open = reviewCount(m, caseId);
  if (!open) {
    for (const t of openTasks(m, caseId)) if (t.step === 'Review discovery candidates') finishTask(m, ctx, t, 'Completed', 'All discovery candidates reviewed', 'Find connection or contact the artist');
    for (const j of m.byCase('discoveryJobs', caseId)) if (j.status === 'NEEDS_REVIEW') m.update('discoveryJobs', j.id, { status: 'COMPLETED' });
    // Reviewing what the search found answers the reopen reasons too (a duplicate is answered in Deduplicate).
    clearReopen(m, ctx, caseId, 'Discovery candidates reviewed', ['new_song', 'new_collaborator', 'new_lead', 'profile_change', 'stale', 'manual']);
  }
  savePaths(m, ctx, caseId, findConnections(m, caseId, ctx.today));
  syncNextAction(m, caseId);
}

function verifyOne(m: Model, ctx: Ctx, p: ArtistProfile, note: string) {
  if (p.verificationStatus === 'VERIFIED') return false;
  if (p.verificationStatus === 'REJECTED' || p.verificationStatus === 'REPLACED') throw rule(`${label(p)} was ${p.verificationStatus.toLowerCase()}. Reconsider it first.`);
  m.update('profiles', p.id, { verificationStatus: 'VERIFIED', verifiedAt: ctx.now, verifiedBy: ctx.userId, reviewedAt: ctx.now, reviewedBy: ctx.userId, reviewNote: note || null, scoreAtReview: p.evidenceScore, lastCheckedAt: ctx.now });
  if (p.caseId) {
    const c = m.must('cases', p.caseId);
    m.insert('verifiedProfiles', {
      id: m.nextId('VP', 4), caseId: c.id, profileId: p.id, platform: p.platform, url: p.url, username: p.username, displayName: p.displayName, verificationStatus: 'VERIFIED',
      verifiedBy: ctx.userId, verifiedAt: ctx.now, lastCheckedAt: ctx.now, source: p.source, evidence: [...p.matched.slice(0, 4), note].filter(Boolean).join('; '), replacedBy: null,
    });
    const urls = c.profileUrls.includes(p.url) ? c.profileUrls : [...c.profileUrls, p.url];
    m.update('cases', c.id, {
      profileUrls: urls, identityStatus: c.identityStatus === 'Provisional' ? 'Verified' : c.identityStatus,
      identityEvidence: [c.identityEvidence, `${label(p)} verified by ${userName(m, ctx.userId)}`].filter(Boolean).join('; ').slice(0, 600), updatedAt: ctx.now,
    });
    const cur = m.get('cases', c.id)!;
    if (cur.lifecycleStage !== 'Closed') m.update('cases', c.id, { checklist: cur.checklist.map(x => (x.step === 2 && x.status !== 'Complete' ? { ...x, status: 'Complete' as const, note: `Public profile verified: ${label(p)}`, updatedAt: ctx.now, updatedBy: ctx.userId } : x)) });
    if (cur.lifecycleStage === 'Unresearched') {
      setStage(m, ctx, cur, 'Researching', `Identity work started: ${label(p)} verified from discovery`);
      if (!cur.ownerId) setField(m, ctx, m.get('cases', c.id)!, 'ownerId', ctx.userId, 'Owner set to the person who verified the first profile');
    }
  }
  syncProfileGraph(m, ctx, m.get('profiles', p.id)!);
  audit(m, ctx, { caseId: p.caseId, entity: 'ArtistProfile', entityId: p.id, action: 'Candidate verified', to: `${label(p)} · ${p.url}`, reason: note || 'Verified from discovery evidence', evidence: p.matched.slice(0, 4).join('; ') || null, result: 'Saved as a verified profile; future imports reuse it' });
  return true;
}
function rejectOne(m: Model, ctx: Ctx, p: ArtistProfile, reason: string) {
  if (p.verificationStatus === 'REJECTED') return false;
  if (p.verificationStatus === 'VERIFIED') throw rule(`${label(p)} is verified. To replace it, use the profile change decision.`);
  m.update('profiles', p.id, { verificationStatus: 'REJECTED', rejectionReason: reason, reviewedAt: ctx.now, reviewedBy: ctx.userId, scoreAtReview: p.evidenceScore });
  syncProfileGraph(m, ctx, m.get('profiles', p.id)!);
  audit(m, ctx, { caseId: p.caseId, entity: 'ArtistProfile', entityId: p.id, action: 'Candidate rejected', to: `${label(p)} · ${p.url}`, reason, evidence: p.conflicts.slice(0, 3).join('; ') || null, result: 'Kept as rejected so it is not shown again' });
  return true;
}
function groupMembers(m: Model, caseId: string, groupKey: string) {
  const list = m.byCase('profiles', caseId).filter(p => p.groupKey === groupKey && (p.verificationStatus === 'UNREVIEWED' || p.verificationStatus === 'DEFERRED'));
  if (!list.length) throw rule(`Candidate ${groupKey} has nothing left to review.`);
  return list;
}

/** Route from a found connection path: always a Candidate until a person verifies it. */
function routeFromPath(m: Model, ctx: Ctx, pathId: string): Route {
  const path = m.get('connectionPaths', pathId);
  if (!path) throw rule('Connection path not found.');
  const c = getCase(m, path.caseId);
  if (path.status === 'ROUTE_CREATED' && path.routeId) throw rule(`Route ${path.routeId} was already created from this path.`);
  if (path.status === 'REJECTED') throw rule('This path was rejected. Find connections again to reconsider it.');
  const blocked = outreachBlocked(c, ctx.today);
  if (blocked && c.contactPreference !== 'Later') throw rule(`${blocked} No route is created.`);
  const contact = path.targetContactId ? m.get('contacts', path.targetContactId) : null;
  const profile = path.targetProfileId ? m.get('profiles', path.targetProfileId) : null;
  const routes = m.byCase('routes', c.id);
  if (contact && routes.some(r => r.contactId === contact.id)) throw rule(`A route through ${contact.personName} already exists for this case.`);
  if (profile && routes.some(r => r.sourceUrl && normalizeProfileUrl(r.sourceUrl)?.normalized === profile.normalizedUrl)) throw rule('A route to this profile already exists.');
  const person = path.steps.slice(1).find(s => s.kind === 'Artist' || s.kind === 'Person' || s.kind === 'Collaborator');
  const org = path.steps.find(s => s.kind === 'Label' || s.kind === 'Distributor');
  const song = path.steps.find(s => s.kind === 'Song');
  const r = m.insert('routes', {
    id: m.nextId('RT', 4), targetCaseId: c.id, trackId: song ? song.nodeId.slice(5) : null, collaboratorName: person ? person.label : null,
    collaboratorCaseId: person && person.nodeId.startsWith('case:') ? person.nodeId.slice(5) : null, organisation: org ? org.label : null, contactId: contact?.id ?? null,
    sourceUrl: profile?.url ?? null, evidence: `Possible connection path: ${pathText(path.steps)}. ${path.evidence.join(' · ')}`.slice(0, 900), confidence: path.score, state: 'Candidate',
    ranking: path.strength === 'STRONG' ? 1 : path.strength === 'POSSIBLE' ? 2 : 3, lastChecked: ctx.now, rejectionReason: null, ownerId: c.ownerId ?? ctx.userId, origin: 'Find connection',
    path: path.steps, pathId: path.id, createdAt: ctx.now,
  });
  m.update('connectionPaths', path.id, { status: 'ROUTE_CREATED', routeId: r.id, decidedAt: ctx.now, decidedBy: ctx.userId });
  syncRouteGraph(m, ctx, r.id);
  audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: r.id, action: 'Route created', to: pathText(path.steps), reason: 'Created from a possible connection path; a person must verify it before outreach', evidence: path.evidence[0] ?? null, next: 'Verify or reject the route' });
  computePriority(m, m.get('cases', c.id)!, ctx.today);
  return r;
}

export const discoveryCommands: Record<string, Command> = {
  startDiscovery(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const blocked = searchBlocked(m, ctx) ?? ctx.searchBudget?.exhausted ?? personalLimit(m, ctx);
    if (blocked) throw rule(blocked);
    if (c.rejectedAt) throw rule(`${c.canonicalName} was rejected as an artist record (${c.rejectedReason}). Restore it first.`);
    const mode = p.mode === 'refresh' ? 'refresh' : 'full';
    const running = activeJob(m, c.id);
    if (running) throw rule(`Discovery is already running for ${c.canonicalName} (${running.id}, ${running.status.toLowerCase()}).`);
    if (mode === 'full' && c.verifiedProfileCount > 0) throw rule(`${c.canonicalName} is a verified artist (${c.verifiedProfileCount} verified profile${c.verifiedProfileCount === 1 ? '' : 's'}). Full discovery is not repeated: use Refresh search.`);
    const done = m.byCase('discoveryJobs', c.id).filter(j => j.status === 'COMPLETED' || j.status === 'NEEDS_REVIEW');
    if (mode === 'full' && done.length) throw rule(`${c.canonicalName} was already searched (v${done[done.length - 1].version}). Review those results, or use Refresh search to search again.`);
    const job = queueJob(m, ctx, { caseId: c.id, mode, trigger: mode === 'refresh' ? 'Refresh search' : 'Find artist', requestedBy: ctx.userId });
    if (c.lifecycleStage === 'Unresearched') {
      setStage(m, ctx, c, 'Researching', 'Automated discovery started (Find artist)');
      if (!c.ownerId) setField(m, ctx, m.get('cases', c.id)!, 'ownerId', ctx.userId, 'Owner set to the person who started discovery');
    }
    audit(m, ctx, { caseId: c.id, entity: 'DiscoveryJob', entityId: job.id, action: mode === 'refresh' ? 'Refresh search started' : 'Discovery started', to: `v${job.version}`, reason: mode === 'refresh' ? 'Search again; earlier versions are kept' : 'Find artist: software searches, a person verifies', next: 'Review candidates when the search finishes' });
    return { message: `${mode === 'refresh' ? 'Refreshing' : 'Finding'} ${c.canonicalName}: discovery ${job.id} (v${job.version}) is running in the background.`, caseId: c.id, id: job.id };
  },
  retryDiscovery(m, ctx, p) {
    const j = m.get('discoveryJobs', p.jobId);
    if (!j) throw rule('Discovery job not found.');
    if (j.status !== 'FAILED') throw rule('Only a failed search can be retried.');
    const blocked = searchBlocked(m, ctx) ?? ctx.searchBudget?.exhausted;
    if (blocked) throw rule(blocked);
    const c = getCase(m, j.caseId);
    if (activeJob(m, c.id)) throw rule(`Discovery is already running for ${c.canonicalName}.`);
    const job = queueJob(m, ctx, { caseId: c.id, mode: j.mode, trigger: `Retry of ${j.id}`, requestedBy: ctx.userId, focusTrackIds: j.focusTrackIds, focus: j.focus, retryOf: j });
    audit(m, ctx, { caseId: c.id, entity: 'DiscoveryJob', entityId: job.id, action: 'Discovery retried', reason: j.failureReason ?? 'Retry', to: `v${job.version}, attempt ${job.attempt}` });
    return { message: `Retrying discovery for ${c.canonicalName} (${job.id}).`, caseId: c.id, id: job.id };
  },
  startBulkDiscovery(m, ctx, p) {
    requirePerm(m, ctx, 'bulkDiscovery');
    const blocked = searchBlocked(m, ctx) ?? ctx.searchBudget?.exhausted;
    if (blocked) throw rule(blocked);
    const all = bulkCandidates(m, Array.isArray(p.caseIds) ? p.caseIds : undefined);
    if (!all.length) throw rule('Nothing to search: every artist here has been searched, verified or is closed.');
    // Quota-limited search: queue only as many artists as the budget covers (searches already waiting count too).
    const room = ctx.searchBudget ? Math.max(0, ctx.searchBudget.artists - m.all('discoveryJobs').filter(j => ACTIVE_JOB_STATUSES.includes(j.status)).length) : all.length;
    if (!room) throw rule('The search limit leaves no room for another complete artist search in this period. Searches already queued will still run; raise the limit in .env or wait for the reset.');
    const ids = all.slice(0, room);
    const bulkId = m.nextId('BULK', 3);
    for (const id of ids) queueJob(m, ctx, { caseId: id, mode: 'full', trigger: Array.isArray(p.caseIds) ? 'Find all unverified in an import' : 'Search all unverified', requestedBy: ctx.userId, bulkId });
    m.setMeta('discovery.currentBulk', bulkId);
    audit(m, ctx, { caseId: null, entity: 'DiscoveryBulk', entityId: bulkId, action: 'Bulk discovery started', to: `${ids.length} artists`, reason: 'Search all unverified, processed by the background queue', next: 'Review candidates as they finish' });
    return { message: `${ids.length} artist${ids.length === 1 ? '' : 's'} queued${ids.length < all.length ? ` (search limit: ${all.length - ids.length} left for later)` : ''}. Searches run in the background; you can keep working.`, id: bulkId, data: { count: ids.length, skipped: all.length - ids.length } };
  },
  stopBulkDiscovery(m, ctx, p) {
    const bulkId = req(p.bulkId, 'Bulk run');
    const queued = m.all('discoveryJobs').filter(j => j.bulkId === bulkId && j.status === 'QUEUED');
    // Nothing was searched for these artists: they go back to their earlier status (not "failed").
    for (const j of queued) { m.update('discoveryJobs', j.id, { status: 'CANCELLED', outcome: 'stopped', finishedAt: ctx.now }); syncDiscoveryState(m, ctx, j.caseId); }
    audit(m, ctx, { caseId: null, entity: 'DiscoveryBulk', entityId: bulkId, action: 'Bulk discovery stopped', result: `${queued.length} queued searches stopped before they started; finished results are kept` });
    maybeFinishBulk(m, ctx, bulkId);
    return { message: `${queued.length} queued searches stopped. Finished results are kept; the others are back to Not started.` };
  },

  // ---------------------------------------------------------------- human verification
  verifyProfile(m, ctx, p) {
    const pr = getProfile(m, p.profileId);
    if (pr.changeOfProfileId) return discoveryCommands.resolveProfileChange(m, ctx, { profileId: pr.id, decision: 'verify_new', note: p.note });
    const twin = pr.caseId ? m.byCase('profiles', pr.caseId).find(x => x.id !== pr.id && x.platform === pr.platform && x.verificationStatus === 'VERIFIED') : null;
    verifyOne(m, ctx, pr, clean(p.note));
    afterReview(m, ctx, pr.caseId);
    return { message: `${label(pr)} verified and saved.${twin ? ` Note: ${twin.platform} ${twin.username ? `@${twin.username}` : ''} is also verified.` : ''}`, caseId: pr.caseId ?? undefined, id: pr.id };
  },
  rejectProfile(m, ctx, p) {
    const pr = getProfile(m, p.profileId);
    rejectOne(m, ctx, pr, req(p.reason, 'A reason'));
    afterReview(m, ctx, pr.caseId);
    return { message: `${label(pr)} rejected. It stays on record and is not shown again.`, caseId: pr.caseId ?? undefined };
  },
  deferProfile(m, ctx, p) {
    const pr = getProfile(m, p.profileId);
    if (pr.verificationStatus !== 'UNREVIEWED') throw rule('Only an unreviewed candidate can be put aside.');
    m.update('profiles', pr.id, { verificationStatus: 'DEFERRED', reviewedAt: ctx.now, reviewedBy: ctx.userId, reviewNote: clean(p.note) || 'Not sure: review later' });
    audit(m, ctx, { caseId: pr.caseId, entity: 'ArtistProfile', entityId: pr.id, action: 'Candidate deferred', to: label(pr), reason: clean(p.note) || 'Not sure: review later' });
    afterReview(m, ctx, pr.caseId);
    return { message: `${label(pr)} moved to Review later.`, caseId: pr.caseId ?? undefined };
  },
  reconsiderProfile(m, ctx, p) {
    const pr = getProfile(m, p.profileId);
    if (pr.verificationStatus !== 'REJECTED' && pr.verificationStatus !== 'DEFERRED') throw rule('Only a rejected or deferred candidate can be reconsidered.');
    m.update('profiles', pr.id, { verificationStatus: 'UNREVIEWED', reviewNote: `Reconsidered by ${userName(m, ctx.userId)}${pr.rejectionReason ? ` (was rejected: ${pr.rejectionReason})` : ''}` });
    syncProfileGraph(m, ctx, m.get('profiles', pr.id)!);
    audit(m, ctx, { caseId: pr.caseId, entity: 'ArtistProfile', entityId: pr.id, action: 'Candidate reconsidered', to: label(pr), from: pr.verificationStatus, reason: clean(p.reason) || 'New evidence or second look' });
    afterReview(m, ctx, pr.caseId);
    return { message: `${label(pr)} is back in the candidate list.`, caseId: pr.caseId ?? undefined };
  },
  verifyCandidateGroup(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const list = groupMembers(m, c.id, req(p.groupKey, 'Candidate'));
    if (list.some(x => x.changeOfProfileId)) throw rule('This candidate contains a profile change. Decide it on its own card.');
    for (const x of list) verifyOne(m, ctx, x, clean(p.note) || `Verified with candidate ${p.groupKey}`);
    afterReview(m, ctx, c.id);
    return { message: `Candidate ${p.groupKey} verified: ${list.length} profile${list.length === 1 ? '' : 's'} saved.`, caseId: c.id };
  },
  rejectCandidateGroup(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const reason = req(p.reason, 'A reason');
    const list = groupMembers(m, c.id, req(p.groupKey, 'Candidate'));
    for (const x of list) rejectOne(m, ctx, x, reason);
    afterReview(m, ctx, c.id);
    return { message: `Candidate ${p.groupKey} rejected (${list.length} profile${list.length === 1 ? '' : 's'}).`, caseId: c.id };
  },
  deferCandidateGroup(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const list = groupMembers(m, c.id, req(p.groupKey, 'Candidate')).filter(x => x.verificationStatus === 'UNREVIEWED');
    for (const x of list) m.update('profiles', x.id, { verificationStatus: 'DEFERRED', reviewedAt: ctx.now, reviewedBy: ctx.userId, reviewNote: clean(p.note) || 'Not sure: review later' });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistProfile', entityId: c.id, action: 'Candidate deferred', to: `Candidate ${p.groupKey} (${list.length} profiles)`, reason: clean(p.note) || 'Not sure: review later' });
    afterReview(m, ctx, c.id);
    return { message: `Candidate ${p.groupKey} moved to Review later.`, caseId: c.id };
  },
  /** Same-name artists: this candidate is a different person. Rejected here; offered to the matching case if there is one. */
  keepSeparateGroup(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const list = groupMembers(m, c.id, req(p.groupKey, 'Candidate'));
    const other = list.find(x => x.otherCaseId)?.otherCaseId ?? null;
    const otherCase = other ? m.get('cases', m.canonical(other)) : null;
    let offered = 0;
    for (const x of list) {
      rejectOne(m, ctx, x, `Different person with the same name: kept separate${otherCase ? ` (matches ${otherCase.canonicalName}, ${otherCase.backendProfileIds[0] ?? otherCase.id})` : ''}`);
      if (otherCase && !m.profileAt(otherCase.id, null, x.normalizedUrl)) {
        const { id: _id, ...rest } = x;
        void _id;
        const copy = m.insert('profiles', { ...rest, id: m.nextId('PF', 4), caseId: otherCase.id, collaboratorId: null, verificationStatus: 'UNREVIEWED', otherCaseId: null, groupKey: null, groupLabel: null, changeOfProfileId: null, rejectionReason: null, reviewedAt: null, reviewedBy: null, verifiedAt: null, verifiedBy: null, scoreAtReview: null, matched: [`Found while searching ${c.canonicalName}; its songs match this artist`, ...x.matched.filter(t => !t.startsWith('Name'))], conflicts: [], reviewNote: `Offered by a keep-separate decision on ${c.canonicalName}` });
        syncProfileGraph(m, ctx, copy);
        offered++;
      }
    }
    audit(m, ctx, { caseId: c.id, entity: 'ArtistProfile', entityId: c.id, action: 'Candidate kept separate', to: `Candidate ${p.groupKey}`, reason: 'Same name, different person: never merged automatically', result: otherCase ? `${offered} profile(s) offered to ${otherCase.canonicalName} (${otherCase.backendProfileIds[0] ?? otherCase.id})` : null });
    afterReview(m, ctx, c.id);
    if (otherCase) { regroup(m, otherCase.id); syncDiscoveryState(m, ctx, otherCase.id); }
    return { message: `Kept separate.${otherCase ? ` ${offered} profile${offered === 1 ? '' : 's'} offered to ${otherCase.canonicalName} (${otherCase.backendProfileIds[0] ?? otherCase.id}) for review.` : ''}`, caseId: c.id };
  },
  /** A refresh found a likely replacement for a verified profile: a person decides, nothing is overwritten automatically. */
  resolveProfileChange(m, ctx, p) {
    const next = getProfile(m, p.profileId);
    const old = next.changeOfProfileId ? m.get('profiles', next.changeOfProfileId) : null;
    if (!old) throw rule('No profile change to decide.');
    const decision = p.decision;
    if (decision === 'verify_new') {
      verifyOne(m, ctx, next, clean(p.note) || `Replaces ${label(old)}`);
      m.update('profiles', old.id, { verificationStatus: 'REPLACED', reviewNote: `Replaced by ${label(next)} on ${ctx.today}` });
      const newVp = m.byCase('verifiedProfiles', old.caseId ?? '').find(v => v.profileId === next.id && v.verificationStatus === 'VERIFIED');
      for (const v of m.byCase('verifiedProfiles', old.caseId ?? '')) if (v.profileId === old.id && v.verificationStatus === 'VERIFIED') m.update('verifiedProfiles', v.id, { verificationStatus: 'REPLACED', replacedBy: newVp?.id ?? null });
      syncProfileGraph(m, ctx, m.get('profiles', old.id)!);
      audit(m, ctx, { caseId: next.caseId, entity: 'ArtistProfile', entityId: next.id, action: 'Profile changed', from: old.url, to: next.url, reason: clean(p.note) || 'Verified the new profile', result: `${label(old)} kept in history as replaced` });
    } else if (decision === 'keep_old') {
      rejectOne(m, ctx, next, 'Kept the existing verified profile');
      m.update('profiles', old.id, { lastCheckedAt: ctx.now, reviewNote: `Kept after a possible change was found (${label(next)})` });
      audit(m, ctx, { caseId: old.caseId, entity: 'ArtistProfile', entityId: old.id, action: 'Profile change: kept old', to: old.url, reason: clean(p.note) || 'The verified profile stays' });
    } else if (decision === 'reject_new') {
      rejectOne(m, ctx, next, clean(p.reason) || 'Not the same artist');
    } else throw rule('Pick verify new, keep old or reject new.');
    afterReview(m, ctx, next.caseId);
    return { message: decision === 'verify_new' ? `${label(next)} is now the verified profile. ${label(old)} is kept as replaced.` : decision === 'keep_old' ? `Kept ${label(old)}.` : `${label(next)} rejected.`, caseId: next.caseId ?? undefined };
  },
  /** A credited collaborator is a research lead. Only a person can confirm that a real relationship exists. */
  verifyRelationship(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const e = m.get('graphEdges', p.edgeId);
    if (!e) throw rule('Relationship not found.');
    const evidence = req(p.evidence, 'Evidence for the relationship');
    const root = nid.case(c.id);
    const other = [e.sourceId, e.targetId].find(x => x !== root && (x.startsWith('case:') || x.startsWith('person:') || x.startsWith('collab:')));
    if (!other) throw rule('Pick a relationship that involves another person.');
    const name = m.get('graphNodes', other)?.label ?? other;
    upsertEdge(m, ctx, { sourceId: other, targetId: root, type: 'PERSON_CONNECTED_TO_ARTIST', label: 'Relationship verified by human', evidence, source: userName(m, ctx.userId), sourceType: 'Human', status: 'verified', confidence: 95 }, true);
    audit(m, ctx, { caseId: c.id, entity: 'GraphEdge', entityId: e.id, action: 'Graph relationship verified', to: `${name} ↔ ${c.canonicalName}`, reason: 'Relationship verified by a person (not inferred from shared songs)', evidence });
    savePaths(m, ctx, c.id, findConnections(m, c.id, ctx.today));
    return { message: `Relationship between ${name} and ${c.canonicalName} verified by ${userName(m, ctx.userId)}.`, caseId: c.id };
  },

  // ---------------------------------------------------------------- connections and routes
  findConnection(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const found = findConnections(m, c.id, ctx.today);
    const saved = savePaths(m, ctx, c.id, found);
    const usable = saved.all.filter(x => x.status === 'SUGGESTED' && !x.note);
    for (const x of saved.created.filter(y => !y.note)) audit(m, ctx, { caseId: c.id, entity: 'ConnectionPath', entityId: x.id, action: 'Possible connection path found', to: pathText(x.steps), reason: 'Possible evidence path through shared catalogue relationships', evidence: x.evidence[0] ?? null });
    return { message: usable.length ? `Connection found: ${usable.length} possible path${usable.length === 1 ? '' : 's'} to a verified contact.` : found.length ? 'Only paths already tried or blocked were found.' : 'No connection path to a verified contact yet.', caseId: c.id, data: saved.all.map(x => x.id) };
  },
  createRouteFromPath(m, ctx, p) {
    const r = routeFromPath(m, ctx, req(p.pathId, 'Path'));
    return { message: `Route ${r.id} created as a candidate. Verify it to make it available for contact.`, caseId: r.targetCaseId, id: r.id };
  },
  rejectConnectionPath(m, ctx, p) {
    const path = m.get('connectionPaths', p.pathId);
    if (!path) throw rule('Connection path not found.');
    const reason = req(p.reason, 'A reason');
    m.update('connectionPaths', path.id, { status: 'REJECTED', reason, decidedAt: ctx.now, decidedBy: ctx.userId });
    audit(m, ctx, { caseId: path.caseId, entity: 'ConnectionPath', entityId: path.id, action: 'Connection path rejected', to: pathText(path.steps), reason });
    return { message: 'Path rejected. It will not be suggested again.', caseId: path.caseId };
  },
  /** Candidate route → Verified, then selected (Route Ready) so the contact workflow can start. */
  verifyRoute(m, ctx, p) {
    const r = m.get('routes', p.routeId);
    if (!r) throw rule('Route not found.');
    const c = getCase(m, r.targetCaseId);
    if (r.state === 'Rejected' || r.state === 'Exhausted') throw rule(`Route ${r.id} is ${r.state.toLowerCase()}.`);
    if (r.state === 'Candidate') {
      m.update('routes', r.id, { state: 'Verified', lastChecked: ctx.now });
      audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: r.id, action: 'Route verified', field: 'state', from: 'Candidate', to: 'Verified', reason: clean(p.note) || 'Verified by a person', evidence: r.evidence.slice(0, 300) });
    }
    syncRouteGraph(m, ctx, r.id);
    const blocked = outreachBlocked(c, ctx.today);
    if (blocked) return { message: `Route ${r.id} verified. ${blocked}`, caseId: c.id };
    const wasWaiting = c.lifecycleStage === 'Waiting for Evidence';
    const route = m.get('routes', r.id)!;
    selectRoute(m, ctx, c, route, clean(p.note) || 'Verified route selected');
    if (['Unresearched', 'Researching', 'Waiting for Evidence'].includes(c.lifecycleStage)) {
      closeTasks(m, ctx, c.id, ['Research'], `Route ${r.id} verified and selected`);
      setStage(m, ctx, m.get('cases', c.id)!, 'Route Ready', `Route verified: ${route.path ? pathText(route.path) : route.id}`);
    }
    const task = outreachTaskFor(m, ctx, m.get('cases', c.id)!, m.get('routes', r.id)!, `Verified route ${r.id}: ${route.collaboratorName ? `${route.collaboratorName} can be asked for an introduction` : 'direct contact'}`);
    if (wasWaiting) m.insert('reopens', { id: m.nextId('RO', 4), caseId: c.id, date: ctx.now, oldStage: 'Waiting for Evidence', newStage: 'Route Ready', evidence: route.evidence.slice(0, 400), why: `A person verified a possible connection path found by discovery: ${route.path ? pathText(route.path) : route.id}`, routeId: r.id, taskId: task.id, batchId: null, contactId: route.contactId, ownerId: c.ownerId });
    syncRouteGraph(m, ctx, r.id);
    computePriority(m, m.get('cases', c.id)!, ctx.today);
    return { message: `Route ${r.id} verified. ${c.canonicalName} is Route Ready: ${task.step}.`, caseId: c.id, id: r.id };
  },
  setDiscoverySettings(m, ctx, p) {
    requirePerm(m, ctx, 'discoverySettings');
    const changes: string[] = [];
    if (p.staleDays != null) { const n = Math.round(Number(p.staleDays)); if (!(n >= 1 && n <= 3650)) throw rule('Stale threshold must be between 1 and 3650 days.'); m.setMeta('discovery.staleDays', String(n)); changes.push(`stale after ${n} days`); }
    if (p.perPersonDaily != null) { const n = Math.round(Number(p.perPersonDaily)); if (!(n >= 0 && n <= 1000)) throw rule('Searches per person per day must be between 0 (no limit) and 1000.'); m.setMeta('discovery.perPersonDaily', String(n)); changes.push(n ? `${n} Find artist searches per person per day` : 'no daily limit per person'); }
    if (!changes.length) throw rule('Nothing to save.');
    audit(m, ctx, { caseId: null, entity: 'Settings', entityId: 'discovery', action: 'Discovery settings changed', to: changes.join(', ') });
    return { message: `Saved: ${changes.join(', ')}.` };
  },
};

export function activeJobOf(m: Model, caseId: string): DiscoveryJob | undefined { return activeJob(m, caseId); }
