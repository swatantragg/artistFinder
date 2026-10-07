// Read side. Every screen asks for exactly what it shows (paged lists, one dossier tab at a time, aggregated dashboards),
// so the same functions can sit behind an HTTP API without loading every song for every artist.
import {
  CHECKLIST_STEPS, CLAIM_STATUSES, LIFECYCLE_STAGES, OPEN_TASK_STATUSES, STAGE_INFO, type LifecycleStage, type TaskStatus,
} from './constants';
import type { Model } from './model';
import { can, openTasks, stageIndex, userName, viewUser, visibleRole } from './ops';
import type { ArtistCase, Ctx, ImportRow, Route, Task, Track } from './types';
import { bestTier, matchTier, sameId, searchKey, searchQuery, TIER } from './search';
import { addDays, daysBetween, nameKey, normIsrc } from './util';
import { ACTIVE_JOB_STATUSES, contactLabel } from './constants';
import { personalLimit, searchBlocked } from './discovery/pipeline';
import { discoveryViews, staleDaysOf } from './discovery/views';
import { ARTIST_STATUS_INFO, GOONGOONALO_INFO } from './constants';
import { isVerified, reopenReasons } from './status';
import { actionFor, artistAggregates, collaboratorCount, searchArtists, v2Views } from './views';
import { relevantOpen } from './discovery/relevance';

// ------------------------------------------------------------------ cached aggregates (recomputed when the model changes)
const cache = new WeakMap<Model, { v: number; songs: Map<string, number> }>();
function songCounts(m: Model): Map<string, number> {
  const hit = cache.get(m);
  if (hit && hit.v === m.version) return hit.songs;
  const sets = new Map<string, Set<string>>();
  for (const cr of m.data.credits.values()) {
    if (!cr.caseId || cr.status !== 'Active') continue;
    const id = m.canonical(cr.caseId);
    let s = sets.get(id); if (!s) { s = new Set(); sets.set(id, s); }
    s.add(cr.trackId);
  }
  const songs = new Map<string, number>();
  for (const [k, s] of sets) songs.set(k, s.size);
  cache.set(m, { v: m.version, songs });
  return songs;
}
const live = (m: Model) => m.all('cases').filter(c => !c.mergedIntoId);
const openTask = (t: Task) => OPEN_TASK_STATUSES.includes(t.status);

// ------------------------------------------------------------------ actions available on a case (only what makes sense now)
export interface CaseAction { id: string; label: string; primary?: boolean; disabled?: string }
export function caseActions(m: Model, c: ArtistCase, userId: string, blocked: string | null = null): CaseAction[] {
  const a: CaseAction[] = [];
  const s = c.lifecycleStage;
  const routes = m.byCase('routes', c.id);
  const verified = routes.filter(r => r.state === 'Verified' || r.state === 'Selected');
  const dnc = c.contactPreference === 'Do Not Contact' || c.contactPreference === 'Declined';
  const add = (id: string, label: string, primary = false, disabled?: string) => a.push({ id, label, primary, disabled });
  if (c.mergedIntoId) return a;
  // Discovery first: software searches, a person verifies. Manual research stays available as the fallback.
  const jobs = m.byCase('discoveryJobs', c.id);
  const running = jobs.some(j => ACTIVE_JOB_STATUSES.includes(j.status));
  const searched = jobs.some(j => j.status === 'COMPLETED' || j.status === 'NEEDS_REVIEW');
  const discovery = running ? { id: 'viewDiscovery', label: 'View search progress' } : c.discoveryStatus === 'Needs verification' ? { id: 'reviewCandidates', label: 'Review candidates' }
    : c.verifiedProfileCount > 0 || searched ? { id: 'findConnection', label: 'Find connection' } : { id: 'findArtist', label: c.discoveryStatus === 'Failed' ? 'Retry Find artist' : 'Find artist' };
  // Without live search (no provider configured, or the usage limit reached) Find artist is shown disabled and manual research leads.
  const noFind = discovery.id === 'findArtist' ? blocked : null;
  const addDiscovery = (primary: boolean) => add(discovery.id, discovery.label, primary && !noFind, noFind ?? undefined);
  switch (s) {
    case 'Unresearched': addDiscovery(true); add('startResearch', 'Research manually', !!noFind); break;
    case 'Identity Review': add('openIdentityReview', 'Review identity', true); addDiscovery(false); break;
    case 'Researching':
      if (verified.length) add('recordContact', 'Record contact', true, dnc ? 'Contact preference blocks outreach' : undefined);
      else addDiscovery(true);
      add('moveToWaiting', 'Move to Waiting for Evidence');
      break;
    case 'Waiting for Evidence': addDiscovery(true); add('startResearch', 'Re-check manually', !!noFind); break;
    case 'Route Ready': case 'Introduction Pending': case 'Contact Attempted':
      add('recordContact', 'Record contact', true, dnc ? 'Contact preference blocks outreach' : undefined);
      if (s !== 'Route Ready') add('moveToWaiting', 'Move to Waiting for Evidence');
      break;
    case 'Contact Confirmed': add('sendClaimInvitation', 'Send claim invitation', true, dnc ? 'Contact preference blocks outreach' : undefined); add('recordContact', 'Record contact'); break;
    case 'Claim Invited': add('recordClaimSubmission', 'Record claim submission', true); break;
    case 'Claim Submitted': add('sendClaimToReview', 'Send to review', true); break;
    case 'Claim Review':
      if (c.claimStatus === 'Approved') add('verifyBackendClaim', 'Verify backend claim', true, can(m, userId, 'verifyBackendClaim') ? undefined : 'Needs an Admin');
      else add('reviewClaim', 'Review claim', true, can(m, userId, 'reviewClaim') ? undefined : 'Needs an Admin');
      break;
    case 'Claimed': add('verifyAccess', 'Verify access', true); break;
    case 'Activation Pending':
      if (c.activationStatus === 'Access Verified') add('selectFeature', 'Choose feature', true);
      add('recordFirstUse', 'Record first use', c.activationStatus === 'Feature Selected');
      break;
    case 'Activated': add('handoverToArm', 'Handover to ARM', true); break;
    case 'Ongoing ARM': add('recordParticipationCheck', 'Participation check', true); break;
    case 'Closed': add('reopenCase', 'Reopen case', true, c.contactPreference === 'Do Not Contact' ? 'Asked not to be contacted' : undefined); break;
  }
  if (!a.some(x => x.id === discovery.id)) addDiscovery(false);
  if (discovery.id !== 'findConnection' && (c.verifiedProfileCount > 0 || searched)) add('findConnection', 'Find connection');
  if (!running && (c.verifiedProfileCount > 0 || searched)) add('refreshSearch', 'Refresh search');
  if (s !== 'Closed') {
    if (!a.some(x => x.id === 'addResearch') && stageIndex(s) <= stageIndex('Contact Attempted')) add('addResearch', 'Add research (manual)');
    if (stageIndex(s) <= stageIndex('Contact Confirmed')) add('addRoute', 'Add route');
    add('addSong', 'Link a song');
    add('createTask', 'Create task');
    add('setContactPreference', 'Contact preference');
    add('assignOwner', 'Change owner');
    if (stageIndex(s) <= stageIndex('Route Ready') && s !== 'Identity Review') add('flagIdentity', 'Flag possible duplicate');
    add('changeStage', 'Change stage');
    add('closeCase', 'Close case', false, can(m, userId, 'closeCase') ? undefined : 'Needs Lead, Admin or System Owner');
  }
  return a;
}

// ------------------------------------------------------------------ list rows
export interface CaseRow {
  id: string; name: string; aliases: string[]; artistId: string; profileCount: number; songs: number; stage: LifecycleStage; claimStatus: string; activationStatus: string;
  contactPreference: string; ownerId: string | null; ownerName: string; lastEvidenceChange: string | null; lastEvidenceNote: string | null; nextAction: string | null;
  nextActionDate: string | null; priority: string; priorityScore: number; workReason: string; taskStatus: TaskStatus | null; overdue: boolean; reopened: boolean; language: string | null;
  discoveryStatus: string; verifiedProfiles: number;
}
function caseRow(m: Model, c: ArtistCase, today: string, songs: Map<string, number>, reopenedIds: Set<string>): CaseRow {
  const tasks = openTasks(m, c.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return {
    id: c.id, name: c.canonicalName, aliases: c.aliases, artistId: c.backendProfileIds[0] ?? '—', profileCount: c.backendProfileIds.length, songs: songs.get(c.id) ?? 0,
    stage: c.lifecycleStage, claimStatus: c.claimStatus, activationStatus: c.activationStatus, contactPreference: c.contactPreference, ownerId: c.ownerId, ownerName: userName(m, c.ownerId),
    lastEvidenceChange: c.lastEvidenceChange, lastEvidenceNote: c.lastEvidenceNote, nextAction: c.nextAction, nextActionDate: c.nextActionDate, priority: c.priority, priorityScore: c.priorityScore,
    workReason: c.workReason, taskStatus: tasks[0]?.status ?? null, overdue: tasks.some(t => t.dueDate < today), reopened: reopenedIds.has(c.id), language: c.language,
    discoveryStatus: c.discoveryStatus, verifiedProfiles: c.verifiedProfileCount,
  };
}

export interface CaseFilters {
  q?: string; stages?: string[]; workReason?: string; taskStatus?: string; contactPreference?: string; ownerId?: string; priority?: string; due?: string; view?: string; discovery?: string;
  sort?: string; dir?: 'asc' | 'desc'; page?: number; pageSize?: number; ids?: string[];
}
export interface TaskRow {
  id: string; caseId: string; caseName: string; artistId: string; step: string; kind: string; why: string; trigger: string; evidenceChange: string | null; priority: string;
  dueDate: string; status: TaskStatus; ownerId: string | null; ownerName: string; overdue: boolean; stage: LifecycleStage; workReason: string; result: string | null;
  completedAt: string | null; createdAt: string; notes: Task['notes']; evidence: string[]; nextAction: string | null; focusedMinutes: number; channel: string | null; recipient: string | null;
}
function taskRow(m: Model, t: Task, today: string): TaskRow {
  const c = m.get('cases', t.caseId)!;
  return {
    id: t.id, caseId: t.caseId, caseName: c?.canonicalName ?? t.caseId, artistId: c?.backendProfileIds[0] ?? '', step: t.step, kind: t.kind, why: t.why, trigger: t.trigger,
    evidenceChange: t.evidenceChange, priority: t.priority, dueDate: t.dueDate, status: t.status, ownerId: t.ownerId, ownerName: userName(m, t.ownerId),
    overdue: openTask(t) && t.dueDate < today, stage: c?.lifecycleStage ?? 'Closed', workReason: t.workReason, result: t.result, completedAt: t.completedAt, createdAt: t.createdAt,
    notes: t.notes, evidence: t.evidence, nextAction: t.nextAction, focusedMinutes: t.focusedMinutes, channel: t.channel, recipient: t.recipient,
  };
}
function routeView(m: Model, r: Route) {
  const target = m.get('cases', r.targetCaseId);
  const track = r.trackId ? m.get('tracks', r.trackId) : null;
  const contact = r.contactId ? m.get('contacts', r.contactId) : null;
  const chain: { kind: string; label: string; sub?: string }[] = [{ kind: 'artist', label: target?.canonicalName ?? r.targetCaseId }];
  if (track) chain.push({ kind: 'song', label: `“${track.title}”`, sub: track.backendTrackId });
  if (r.collaboratorName) chain.push({ kind: 'person', label: r.collaboratorName, sub: 'collaborator' });
  if (r.organisation) chain.push({ kind: 'org', label: r.organisation, sub: 'organisation' });
  if (contact) chain.push({ kind: 'contact', label: contactLabel(contact.verified, contact.channel), sub: contact.value });
  else if (r.sourceUrl) chain.push({ kind: 'contact', label: 'Profile link', sub: r.sourceUrl });
  return { ...r, targetName: target?.canonicalName ?? '', songTitle: track?.title ?? null, contactName: contact?.personName ?? null, contactValue: contact?.value ?? null, contactVerified: !!contact?.verified, ownerName: userName(m, r.ownerId), chain };
}

export const queries = {
  meta(m: Model, ctx: Ctx) {
    const tasks = m.all('tasks').filter(t => openTask(t) && t.ownerId === ctx.userId && t.dueDate <= ctx.today);
    return {
      users: m.all('users').map(u => viewUser(m, ctx.userId, u)), me: m.get('users', ctx.userId) ?? null, today: ctx.today,
      badges: {
        queue: tasks.length,
        reopened: m.all('reopens').filter(r => daysBetween(r.date, ctx.today) <= 14).length,
        identity: m.all('conflicts').filter(c => c.status !== 'Decided').length,
        exceptions: m.all('importRows').filter(r => r.status === 'Quarantined' && r.exceptionStatus === 'Open').length,
        notifications: m.all('notifications').filter(n => !n.read).length,
        discovery: m.all('cases').filter(c => !c.mergedIntoId && c.discoveryStatus === 'Needs verification').length,
        searching: m.all('discoveryJobs').filter(j => ACTIVE_JOB_STATUSES.includes(j.status)).length,
        dedupe: m.all('conflicts').filter(c => c.status === 'Open').length,
        needsReview: m.all('cases').filter(c => !c.mergedIntoId && c.artistStatus === 'NEEDS_REVIEW').length,
        reopenedArtists: m.all('cases').filter(c => !c.mergedIntoId && c.artistStatus === 'REOPENED').length,
        goongoonaloPending: m.all('cases').filter(c => !c.mergedIntoId && !c.rejectedAt && isVerified(c) && c.goongoonaloStatus === 'PENDING').length,
      },
      permissions: Object.fromEntries(['import', 'identityDecision', 'reviewClaim', 'verifyBackendClaim', 'closeCase', 'reassign', 'resolveException', 'bulkDiscovery', 'discoverySettings', 'manageUsers', 'managePasswords', 'resetWorkspace'].map(p => [p, can(m, ctx.userId, p)])),
      discoveryBlocked: searchBlocked(m, ctx) ?? ctx.searchBudget?.exhausted ?? personalLimit(m, ctx) ?? null,
    };
  },

  dashboard(m: Model, ctx: Ctx) {
    const cases = live(m);
    const byStage = Object.fromEntries(LIFECYCLE_STAGES.map(s => [s, 0])) as Record<LifecycleStage, number>;
    for (const c of cases) byStage[c.lifecycleStage]++;
    const reached = (s: LifecycleStage) => cases.filter(c => c.lifecycleStage !== 'Closed' && stageIndex(c.lifecycleStage) >= stageIndex(s) || (c.lifecycleStage === 'Closed' && c.previousStage && stageIndex(c.previousStage) >= stageIndex(s))).length;
    const claimed = cases.filter(c => c.claimStatus === 'Completed').length;
    const tasks = m.all('tasks').filter(openTask);
    const funnel = [
      { label: 'Identified', value: cases.length },
      { label: 'Researching', value: reached('Researching') },
      { label: 'Route Ready', value: reached('Route Ready') },
      { label: 'Contacted', value: cases.filter(c => m.byCase('attempts', c.id).length > 0).length },
      { label: 'Claim Submitted', value: cases.filter(c => m.familyItems('claimEvents', c.id).some(e => e.type === 'Submitted')).length },
      { label: 'Claim Completed', value: claimed },
      { label: 'Activated', value: cases.filter(c => c.activationStatus === 'Activated').length },
    ];
    return {
      total: cases.length,
      backendProfiles: cases.reduce((n, c) => n + c.backendProfileIds.length, 0),
      kpis: (['Unresearched', 'Researching', 'Waiting for Evidence', 'Route Ready', 'Contact Confirmed', 'Claim Submitted', 'Claimed', 'Activation Pending', 'Activated', 'Ongoing ARM'] as LifecycleStage[]).map(s => ({ stage: s, value: byStage[s] })),
      kpiExtra: { claimsSubmitted: funnel[4].value, claimsCompleted: claimed },
      byStage,
      funnel,
      work: {
        overdue: tasks.filter(t => t.dueDate < ctx.today).length,
        dueToday: tasks.filter(t => t.dueDate === ctx.today).length,
        newLeads: tasks.filter(t => t.workReason === 'New Lead').length,
        claimSupport: tasks.filter(t => ['Claim', 'Claim Review', 'Backend Check'].includes(t.kind)).length,
        identityReviews: m.all('conflicts').filter(c => c.status !== 'Decided').length,
      },
      reopened: queries.reopened(m, ctx).slice(0, 5),
      discovery: (() => {
        const o = discoveryViews.discoveryOverview(m, ctx, { pageSize: 1 });
        return { kpis: o.kpis, staleProfiles: o.staleProfiles, counts: o.counts };
      })(),
      imports: m.all('batches').sort((a, b) => b.id.localeCompare(a.id)).slice(0, 5).map(b => ({ id: b.id, file: b.originalFilename, date: b.uploadDate, source: b.source, rows: b.rowCount, accepted: b.acceptedCount, quarantined: b.quarantinedCount, skipped: b.skippedCount, reopened: b.summary.reopenedCases, status: b.status })),
      activity: queries.auditLog(m, ctx, { pageSize: 12, meaningful: true }).rows,
    };
  },

  listCases(m: Model, ctx: Ctx, f: CaseFilters = {}) {
    const songs = songCounts(m);
    const reopenedIds = new Set(m.all('reopens').map(r => r.caseId));
    const q = searchQuery(f.q);
    const ids = f.ids ? new Set(f.ids) : null;
    let rows = live(m).filter(c => {
      if (ids && !ids.has(c.id)) return false;
      if (f.stages?.length && !f.stages.includes(c.lifecycleStage)) return false;
      if (f.workReason && c.workReason !== f.workReason) return false;
      if (f.contactPreference && c.contactPreference !== f.contactPreference) return false;
      if (f.priority && c.priority !== f.priority) return false;
      if (f.discovery && c.discoveryStatus !== f.discovery) return false;
      if (f.ownerId) { const want = f.ownerId === 'me' ? ctx.userId : f.ownerId === 'none' ? null : f.ownerId; if (c.ownerId !== want) return false; }
      if (q.key && !(sameId(q, c.id) || c.backendProfileIds.some(b => sameId(q, b)) || bestTier(q, [c.canonicalName, ...c.aliases]))) return false;
      if (f.view === 'reopened' && !reopenedIds.has(c.id)) return false;
      return true;
    }).map(c => caseRow(m, c, ctx.today, songs, reopenedIds));
    if (f.taskStatus) rows = rows.filter(r => r.taskStatus === f.taskStatus);
    if (f.due === 'overdue') rows = rows.filter(r => r.overdue);
    if (f.due === 'today') rows = rows.filter(r => r.nextActionDate === ctx.today);
    if (f.due === 'week') rows = rows.filter(r => r.nextActionDate && r.nextActionDate <= addDays(ctx.today, 7));
    const dir = f.dir === 'asc' ? 1 : -1;
    const key = f.sort ?? 'priority';
    const pr = { High: 3, Medium: 2, Low: 1 } as Record<string, number>;
    rows.sort((a, b) => {
      let d = 0;
      switch (key) {
        case 'name': d = a.name.localeCompare(b.name); break;
        case 'artistId': d = a.artistId.localeCompare(b.artistId, undefined, { numeric: true }); break;
        case 'songs': d = a.songs - b.songs; break;
        case 'stage': d = stageIndex(a.stage) - stageIndex(b.stage); break;
        case 'nextActionDate': d = (a.nextActionDate ?? '9999').localeCompare(b.nextActionDate ?? '9999'); break;
        case 'lastEvidenceChange': d = (a.lastEvidenceChange ?? '').localeCompare(b.lastEvidenceChange ?? ''); break;
        case 'owner': d = a.ownerName.localeCompare(b.ownerName); break;
        default: d = (pr[a.priority] - pr[b.priority]) || (a.priorityScore - b.priorityScore);
      }
      return d * dir || a.id.localeCompare(b.id);
    });
    const pageSize = f.pageSize ?? 25, page = Math.max(1, f.page ?? 1);
    return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  },

  caseDetail(m: Model, ctx: Ctx, p: { id: string }) {
    const raw = m.get('cases', p.id);
    if (!raw) return null;
    const c = raw;
    const songs = songCounts(m).get(m.canonical(c.id)) ?? 0;
    const attempts = m.familyItems('attempts', c.id);
    const claimEvents = m.familyItems('claimEvents', c.id);
    const act = m.familyItems('activationEvents', c.id);
    const routes = m.byCase('routes', c.id);
    const done = c.checklist.filter(x => x.status === 'Complete').length;
    const si = stageIndex(c.lifecycleStage);
    const after = (s: LifecycleStage) => c.lifecycleStage !== 'Closed' && si >= stageIndex(s);
    const progress = [
      { label: 'Identified', state: 'done', note: c.firstSeenBatchId ? `Batch ${c.firstSeenBatchId}` : 'By hand' },
      { label: 'Identity Verified', state: isVerified(c) ? 'done' : ['SEARCHING', 'NEEDS_REVIEW', 'REOPENED'].includes(c.artistStatus) || c.lifecycleStage === 'Identity Review' ? 'active' : 'todo', note: ARTIST_STATUS_INFO[c.artistStatus].label },
      { label: 'Research', state: after('Route Ready') || done === 8 ? 'done' : ['Researching', 'Waiting for Evidence'].includes(c.lifecycleStage) || done > 0 ? 'active' : 'todo', note: `${done}/8 steps` },
      { label: 'Route Ready', state: after('Route Ready') ? 'done' : routes.some(r => r.state === 'Verified') ? 'active' : 'todo', note: `${routes.filter(r => r.state === 'Verified' || r.state === 'Selected').length} usable` },
      { label: 'Contact', state: after('Contact Confirmed') ? 'done' : attempts.length ? 'active' : 'todo', note: `${attempts.length} attempts` },
      { label: 'Claim', state: c.claimStatus === 'Completed' ? 'done' : c.claimStatus !== 'Not Invited' ? 'active' : 'todo', note: c.claimStatus },
      { label: 'Activation', state: c.activationStatus === 'Activated' ? 'done' : c.claimStatus === 'Completed' ? 'active' : 'todo', note: c.activationStatus },
      { label: 'ARM', state: c.lifecycleStage === 'Ongoing ARM' ? 'done' : c.lifecycleStage === 'Activated' ? 'active' : 'todo', note: c.arm ? userName(m, c.arm.relationshipOwnerId) : '—' },
    ];
    const firstBatch = c.firstSeenBatchId ? m.get('batches', c.firstSeenBatchId) : null;
    const firstSongs = m.creditsOfCase(c.id).filter(cr => cr.sourceVersion === c.firstSeenBatchId).map(cr => cr.trackId);
    const tasks = openTasks(m, c.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map(t => taskRow(m, t, ctx.today));
    return {
      case: c,
      ownerName: userName(m, c.ownerId),
      artistId: c.backendProfileIds[0] ?? null,
      songs,
      counts: {
        songs, collaborators: queries.caseCollaborators(m, ctx, { id: c.id }).length, routes: routes.length, research: m.familyItems('research', c.id).length, attempts: attempts.length,
        claims: claimEvents.length, activation: act.length, tasks: m.familyItems('tasks', c.id).length, timeline: m.familyItems('audit', c.id).length,
      },
      progress,
      whyExists: firstBatch ? `${c.canonicalName}${c.backendProfileIds[0] ? ` (${c.backendProfileIds[0]})` : ''} appeared in backend export ${firstBatch.id} (${firstBatch.originalFilename}) through ${new Set(firstSongs).size} linked song${new Set(firstSongs).size === 1 ? '' : 's'}.` : 'Created by hand.',
      evidence: [
        `${songs} linked song${songs === 1 ? '' : 's'} across ${new Set(m.trackIdsOfCase(c.id).map(id => m.get('tracks', id)?.label).filter(Boolean)).size} label(s)`,
        `${routes.filter(r => r.state === 'Verified' || r.state === 'Selected').length} usable route(s), ${routes.filter(r => r.state === 'Rejected' || r.state === 'Exhausted').length} tested and closed`,
        `${m.familyItems('research', c.id).length} research record(s), ${attempts.length} contact attempt(s)`,
        c.lastEvidenceNote ? `Latest evidence: ${c.lastEvidenceNote}` : null,
      ].filter(Boolean),
      openTasks: tasks,
      actions: caseActions(m, c, ctx.userId, searchBlocked(m, ctx) ?? ctx.searchBudget?.exhausted ?? personalLimit(m, ctx) ?? null),
      conflicts: m.all('conflicts').filter(x => x.status !== 'Decided' && x.caseIds.includes(c.id)),
      mergedInto: c.mergedIntoId ? { id: c.mergedIntoId, name: m.get('cases', c.mergedIntoId)?.canonicalName ?? '' } : null,
      mergedChildren: (m.idx.mergedChildren.get(c.id) ?? []).map(id => ({ id, name: m.get('cases', id)!.canonicalName, backendIds: m.get('cases', id)!.backendProfileIds })),
      reopen: m.byCase('reopens', c.id).slice(-1)[0] ?? null,
      stageMeaning: STAGE_INFO[c.lifecycleStage].meaning,
      tried: { routesClosed: routes.filter(r => r.state === 'Rejected' || r.state === 'Exhausted').map(r => `${r.collaboratorName ?? r.organisation ?? (r.sourceUrl ? 'profile link' : 'direct')}: ${r.state.toLowerCase()}`), attempts: attempts.length, research: m.familyItems('research', c.id).length },
      routesForForms: routes.filter(r => r.state === 'Verified' || r.state === 'Selected').map(r => routeView(m, r)),
      profileIds: c.backendProfileIds,
      v2: (() => {
        const tracks = m.trackIdsOfCase(c.id).map(id => m.get('tracks', id)!).filter(Boolean);
        const vps = m.byCase('verifiedProfiles', c.id).filter(v => v.verificationStatus === 'VERIFIED');
        const batches = [...new Set(m.creditsOfCase(c.id).map(cr => cr.sourceVersion).filter(Boolean))].map(id => m.get('batches', id)).filter(Boolean).sort((a, b) => a!.id.localeCompare(b!.id));
        const lastJob = m.byCase('discoveryJobs', c.id).filter(j => j.finishedAt && j.status !== 'CANCELLED').sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))[0];
        return {
          kind: c.kind, artistStatus: c.artistStatus, statusInfo: ARTIST_STATUS_INFO[c.artistStatus], goongoonaloStatus: c.goongoonaloStatus, goongoonaloInfo: GOONGOONALO_INFO[c.goongoonaloStatus],
          goongoonaloAt: c.goongoonaloStatusAt, goongoonaloBy: c.goongoonaloStatusBy ? userName(m, c.goongoonaloStatusBy) : null,
          verified: isVerified(c), verifiedVia: vps.length ? `${vps.length} verified profile${vps.length === 1 ? '' : 's'}` : c.claimStatus === 'Completed' ? 'Backend-verified claim' : c.manualVerifiedAt ? `Confirmed by ${userName(m, c.manualVerifiedBy)}` : null,
          firstVerifiedAt: c.firstVerifiedAt, rejected: c.rejectedAt ? { at: c.rejectedAt, reason: c.rejectedReason } : null,
          reopen: c.reopen ? { at: c.reopen.at, by: userName(m, c.reopen.by), previousStatus: c.reopen.previousStatus, reasons: reopenReasons(c) } : null,
          summary: {
            songs: tracks.length, albums: new Set(tracks.map(t => t.releaseId).filter(Boolean)).size, collaborators: collaboratorCount(m, c.id), labels: [...new Set(tracks.map(t => t.label).filter(Boolean))],
            verifiedProfiles: vps.length, possibleRoutes: m.byCase('connectionPaths', c.id).filter(x => x.status === 'SUGGESTED' && !x.note).length + routes.filter(r => r.state === 'Verified' || r.state === 'Selected').length,
          },
          lastDiscovery: lastJob?.finishedAt ?? null, sources: batches.map(b => ({ id: b!.id, file: b!.originalFilename, date: b!.uploadDate })),
          history: m.byCase('statusEvents', c.id).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 30).map(e => ({ ...e, byName: userName(m, e.by) })),
          action: actionFor(m, c), canSetGoongoonalo: isVerified(c) && !c.rejectedAt,
        };
      })(),
      discovery: (() => {
        const jobs = m.byCase('discoveryJobs', c.id).filter(j => j.status !== 'CANCELLED');
        const active = jobs.find(j => ACTIVE_JOB_STATUSES.includes(j.status));
        const last = jobs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const vps = m.byCase('verifiedProfiles', c.id).filter(v => v.verificationStatus === 'VERIFIED');
        return {
          status: c.discoveryStatus, verified: vps.map(v => ({ platform: v.platform, username: v.username, stale: daysBetween(v.lastCheckedAt, ctx.today) > staleDaysOf(m) })),
          open: relevantOpen(m, c.id).length, lastSearchAt: last?.finishedAt ?? null, lastVersion: last?.version ?? 0,
          active: active ? { id: active.id, step: active.step, label: active.steps[Math.min(active.step, active.steps.length - 1)]?.label ?? '', status: active.status } : null,
          paths: m.byCase('connectionPaths', c.id).filter(x => x.status === 'SUGGESTED' && !x.note).length,
        };
      })(),
    };
  },

  caseSongs(m: Model, _ctx: Ctx, p: { id: string }) {
    const tracks = m.trackIdsOfCase(p.id).map(id => m.get('tracks', id)!).filter(Boolean);
    const fam = new Set(m.family(p.id));
    return tracks.sort((a, b) => (b.firstSeen.localeCompare(a.firstSeen)) || a.title.localeCompare(b.title)).map(t => {
      const credits = m.creditsOfTrack(t.id);
      const release = t.releaseId ? m.get('releases', t.releaseId) : null;
      return {
        id: t.id, backendTrackId: t.backendTrackId, title: t.title, version: t.version, isrc: t.isrc, label: t.label, distributor: t.distributor, source: t.source, language: t.language,
        releaseDate: t.releaseDate, release: release ? `${release.title} (${release.backendReleaseId})` : '—', album: release?.title ?? '', flags: t.flags, firstBatchId: t.firstBatchId, lastBatchId: t.lastBatchId, history: t.history,
        sourceFile: m.get('batches', t.firstBatchId)?.originalFilename ?? t.firstBatchId,
        collaborators: credits.filter(cr => cr.status === 'Active' && !(cr.caseId && fam.has(cr.caseId))).map(cr => ({ name: cr.personName, role: cr.role, caseId: cr.caseId ? m.canonical(cr.caseId) : null })),
        roles: credits.filter(cr => cr.caseId && fam.has(cr.caseId) && cr.status === 'Active').map(cr => cr.role),
        credits: credits.map(cr => ({ id: cr.id, name: cr.personName, role: cr.role, caseId: cr.caseId ? m.canonical(cr.caseId) : null, isPrimary: cr.isPrimary, status: cr.status, statusReason: cr.statusReason, source: cr.sourceVersion, self: !!cr.caseId && fam.has(cr.caseId) })),
      };
    });
  },

  /**
   * Who the artist is connected to, and through what: every person credited on the artist's songs, with each shared
   * song, their role on it and the artist's own role (the connection graph shows exactly this).
   */
  artistNetwork(m: Model, _ctx: Ctx, p: { id: string }) {
    const caseId = m.canonical(p.id);
    const c = m.get('cases', caseId);
    if (!c) return null;
    const fam = new Set(m.family(caseId));
    const people = new Map<string, { name: string; caseId: string | null; songs: Map<string, { title: string; album: string; roles: Set<string>; mine: Set<string> }> }>();
    for (const tid of m.trackIdsOfCase(caseId)) {
      const t = m.get('tracks', tid);
      if (!t) continue;
      const credits = m.creditsOfTrack(tid).filter(cr => cr.status === 'Active');
      const mine = credits.filter(cr => cr.caseId && fam.has(cr.caseId)).map(cr => cr.role);
      for (const cr of credits) {
        if (cr.caseId && fam.has(cr.caseId)) continue;
        const key = cr.caseId ? m.canonical(cr.caseId) : `name:${nameKey(cr.personName)}`;
        const x = people.get(key) ?? { name: cr.caseId ? m.get('cases', m.canonical(cr.caseId))?.canonicalName ?? cr.personName : cr.personName, caseId: cr.caseId ? m.canonical(cr.caseId) : null, songs: new Map() };
        const song = x.songs.get(tid) ?? { title: t.title, album: t.releaseId ? m.get('releases', t.releaseId)?.title ?? '' : '', roles: new Set<string>(), mine: new Set<string>(mine) };
        song.roles.add(cr.role);
        x.songs.set(tid, song);
        people.set(key, x);
      }
    }
    const list = [...people.entries()].map(([key, x]) => {
      const cc = x.caseId ? m.get('cases', x.caseId) : null;
      const songs = [...x.songs.entries()].map(([id, s]) => ({ id, title: s.title, album: s.album, roles: [...s.roles], mine: [...s.mine] })).sort((a, b) => a.title.localeCompare(b.title) || a.album.localeCompare(b.album));
      return { key, name: x.name, caseId: x.caseId, kind: cc ? cc.kind : 'Not linked', verified: cc ? isVerified(cc) : false, roles: [...new Set(songs.flatMap(s => s.roles))], songCount: songs.length, songs };
    }).sort((a, b) => b.songCount - a.songCount || a.name.localeCompare(b.name));
    return { center: { id: caseId, name: c.canonicalName, artistId: c.backendProfileIds[0] ?? null, verified: isVerified(c) }, people: list };
  },

  caseCollaborators(m: Model, _ctx: Ctx, p: { id: string }) {
    const fam = new Set(m.family(p.id));
    const map = new Map<string, { name: string; caseId: string | null; roles: Set<string>; songs: { id: string; title: string }[] }>();
    for (const tid of m.trackIdsOfCase(p.id)) {
      const t = m.get('tracks', tid)!;
      for (const cr of m.creditsOfTrack(tid)) {
        if (cr.status !== 'Active' || (cr.caseId && fam.has(cr.caseId))) continue;
        const key = cr.caseId ? m.canonical(cr.caseId) : `name:${nameKey(cr.personName)}`;
        const x = map.get(key) ?? { name: cr.personName, caseId: cr.caseId ? m.canonical(cr.caseId) : null, roles: new Set<string>(), songs: [] };
        x.roles.add(cr.role);
        if (!x.songs.some(s => s.id === tid)) x.songs.push({ id: tid, title: t.title });
        map.set(key, x);
      }
    }
    const routes = m.byCase('routes', p.id);
    return [...map.values()].map(x => {
      const cc = x.caseId ? m.get('cases', x.caseId) : null;
      const contacts = x.caseId ? m.contactsFor(x.caseId) : m.contactsNamed(x.name);
      const verified = contacts.find(k => k.verified);
      const route = routes.find(r => (x.caseId && r.collaboratorCaseId === x.caseId) || (r.collaboratorName && nameKey(r.collaboratorName) === nameKey(x.name)));
      return {
        name: x.name, caseId: x.caseId, roles: [...x.roles], songs: x.songs, identity: cc?.identityStatus ?? 'Unlinked', stage: cc?.lifecycleStage ?? null, artistStatus: cc?.artistStatus ?? null, kind: cc?.kind ?? null,
        contact: verified ? 'Verified contact' : contacts.length ? 'Unverified contact' : 'No contact', contactId: verified?.id ?? contacts[0]?.id ?? null,
        potentialRoute: !!verified, routeId: route?.id ?? null, routeState: route?.state ?? null,
      };
    }).sort((a, b) => Number(b.potentialRoute) - Number(a.potentialRoute) || b.songs.length - a.songs.length || a.name.localeCompare(b.name));
  },

  caseRoutes(m: Model, _ctx: Ctx, p: { id: string }) {
    const order = { Selected: 0, Verified: 1, Candidate: 2, Exhausted: 3, Rejected: 4 } as Record<string, number>;
    return m.byCase('routes', p.id).sort((a, b) => order[a.state] - order[b.state] || a.ranking - b.ranking).map(r => routeView(m, r));
  },
  caseResearch(m: Model, _ctx: Ctx, p: { id: string }) {
    const c = m.get('cases', p.id)!;
    return {
      checklist: c.checklist.map(x => ({ ...x, title: CHECKLIST_STEPS[x.step - 1].title, help: CHECKLIST_STEPS[x.step - 1].help, updatedByName: x.updatedBy ? userName(m, x.updatedBy) : null })),
      activities: m.familyItems('research', p.id).sort((a, b) => b.date.localeCompare(a.date)).map(r => ({ ...r, researcherName: userName(m, r.researcherId) })),
      totalMinutes: m.familyItems('research', p.id).reduce((n, r) => n + r.minutes, 0),
      waiting: c.waiting,
    };
  },
  caseAttempts(m: Model, _ctx: Ctx, p: { id: string }) {
    return m.familyItems('attempts', p.id).sort((a, b) => b.date.localeCompare(a.date)).map(a => ({ ...a, ownerName: userName(m, a.ownerId), routeLabel: a.routeId ? routeView(m, m.get('routes', a.routeId)!).chain.map(x => x.label).join(' → ') : 'Direct' }));
  },
  caseClaims(m: Model, _ctx: Ctx, p: { id: string }) {
    const c = m.get('cases', p.id)!;
    const events = m.familyItems('claimEvents', p.id).sort((a, b) => a.date.localeCompare(b.date)).map(e => ({ ...e, actorName: userName(m, e.actorId), reviewerName: e.reviewerId ? userName(m, e.reviewerId) : null }));
    const last = (t: string) => events.filter(e => e.type === t).pop();
    const stages = ['Not Invited', 'Claim Invited', 'Claim Submitted', 'Claim Review', 'Claim Approved', 'Claim Completed'];
    const reachedIdx = c.claimStatus === 'Completed' ? 5 : c.claimStatus === 'Approved' ? 4 : c.claimStatus === 'In Review' ? 3 : c.claimStatus === 'Submitted' ? 2 : c.claimStatus === 'Invited' ? 1 : 0;
    return {
      claimStatus: c.claimStatus, stages, reachedIdx, events,
      fields: {
        profileId: last('Invited')?.profileId ?? null, claimRequestId: last('Submitted')?.claimRequestId ?? null, recipient: last('Invited')?.recipient ?? null,
        invitedAt: last('Invited')?.date ?? null, submittedAt: last('Submitted')?.date ?? null, reviewer: last('Sent to Review')?.reviewerName ?? null,
        approvedAt: last('Approved')?.date ?? null, backend: last('Backend Verified') ? `${last('Backend Verified')!.evidence} (${last('Backend Verified')!.source})` : null,
      },
    };
  },
  caseActivation(m: Model, _ctx: Ctx, p: { id: string }) {
    const c = m.get('cases', p.id)!;
    const events = m.familyItems('activationEvents', p.id).sort((a, b) => a.date.localeCompare(b.date)).map(e => ({ ...e, operatorName: e.operatorId ? userName(m, e.operatorId) : null, actorName: userName(m, e.actorId) }));
    const feat = events.filter(e => e.type === 'Feature Selected').pop();
    const use = events.filter(e => e.type === 'Meaningful Use').pop();
    return {
      status: c.activationStatus, access: events.some(e => e.type === 'Access Verified') ? 'Verified' : 'Pending', meaningfulUse: use ? 'Verified' : 'Pending',
      loginOnly: events.some(e => e.type === 'Login Only'), feature: feat ? { feature: feat.feature, expectedOutcome: feat.expectedOutcome, operator: feat.operatorName, agreedDate: feat.agreedDate } : null,
      use: use ? { backendRef: use.backendRef, evidence: use.evidence, date: use.date, feature: use.feature } : null,
      arm: c.arm ? { ...c.arm, ownerName: userName(m, c.arm.relationshipOwnerId) } : null, events, claimCompleted: c.claimStatus === 'Completed',
    };
  },
  caseTasks(m: Model, ctx: Ctx, p: { id: string }) {
    return m.familyItems('tasks', p.id).sort((a, b) => Number(openTask(b)) - Number(openTask(a)) || a.dueDate.localeCompare(b.dueDate)).map(t => taskRow(m, t, ctx.today));
  },
  caseTimeline(m: Model, _ctx: Ctx, p: { id: string }) {
    return m.familyItems('audit', p.id).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).map(e => ({ ...e, userName: userName(m, e.userId) }));
  },

  queue(m: Model, ctx: Ctx, p: { scope?: 'mine' | 'team' } = {}) {
    const mine = p.scope !== 'team';
    const tasks = m.all('tasks').filter(t => openTask(t) && (!mine || t.ownerId === ctx.userId)).map(t => taskRow(m, t, ctx.today));
    const sections: Record<string, TaskRow[]> = { overdue: [], dueToday: [], newLeads: [], routeReady: [], identity: [], claimSupport: [], activation: [], reengagement: [], upcoming: [] };
    for (const t of tasks) {
      if (t.overdue) sections.overdue.push(t);
      else if (t.dueDate > ctx.today) sections.upcoming.push(t);
      else if (t.workReason === 'New Lead') sections.newLeads.push(t);
      else if (t.kind === 'Identity') sections.identity.push(t);
      else if (['Claim', 'Claim Review', 'Backend Check'].includes(t.kind)) sections.claimSupport.push(t);
      else if (['Activation', 'ARM'].includes(t.kind)) sections.activation.push(t);
      else if (t.workReason === 'Re-engagement' || t.kind === 'Re-engagement') sections.reengagement.push(t);
      else if (t.stage === 'Route Ready') sections.routeReady.push(t);
      else sections.dueToday.push(t);
    }
    const pr = { High: 0, Medium: 1, Low: 2 } as Record<string, number>;
    for (const k of Object.keys(sections)) sections[k].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || pr[a.priority] - pr[b.priority]);
    const conflicts = m.all('conflicts').filter(c => c.status !== 'Decided').length;
    const songs = songCounts(m);
    const unresearched = live(m).filter(c => c.lifecycleStage === 'Unresearched' && !c.ownerId).sort((a, b) => b.priorityScore - a.priorityScore || a.id.localeCompare(b.id)).slice(0, 5)
      .map(c => ({ id: c.id, name: c.canonicalName, artistId: c.backendProfileIds[0] ?? '', songs: songs.get(c.id) ?? 0, priority: c.priority }));
    return { sections, conflicts, unresearched, total: tasks.length };
  },

  imports(m: Model) {
    return m.all('batches').sort((a, b) => b.id.localeCompare(a.id)).map(b => ({ ...b, uploaderName: userName(m, b.uploaderId) }));
  },
  importBatch(m: Model, _ctx: Ctx, p: { id: string; tab?: string; page?: number }) {
    const b = m.get('batches', p.id);
    if (!b) return null;
    const rows = (m.idx.rowsByBatch.get(b.id) ?? []).map(id => m.get('importRows', id)!).filter(Boolean);
    const tab = p.tab ?? 'Accepted';
    let list: ImportRow[] = [];
    if (tab === 'Accepted' || tab === 'Quarantined' || tab === 'Skipped') list = rows.filter(r => r.status === tab);
    const caseList = (ids: string[]) => ids.map(id => m.get('cases', id)).filter(Boolean).map(c => ({ id: c!.id, name: c!.canonicalName, stage: c!.lifecycleStage, artistId: c!.backendProfileIds[0] ?? '' }));
    const page = Math.max(1, p.page ?? 1), size = 50;
    return {
      batch: { ...b, uploaderName: userName(m, b.uploaderId) },
      counts: { Accepted: rows.filter(r => r.status === 'Accepted').length, Quarantined: rows.filter(r => r.status === 'Quarantined').length, Skipped: rows.filter(r => r.status === 'Skipped').length },
      rows: list.slice((page - 1) * size, page * size).map(r => ({ ...r, caseNames: r.caseIds.map(id => m.get('cases', id)?.canonicalName ?? id), track: r.trackId ? m.get('tracks', r.trackId)?.title ?? null : null })),
      total: list.length, page, pageSize: size,
      newArtists: caseList(b.summary.newArtistIds),
      updated: caseList(b.summary.updatedArtistIds),
      reopened: m.all('reopens').filter(r => r.batchId === b.id).map(r => ({ ...r, caseName: m.get('cases', r.caseId)?.canonicalName ?? r.caseId })),
      tasks: b.summary.taskIds.map(id => m.get('tasks', id)).filter(Boolean).map(t => ({ id: t!.id, step: t!.step, caseId: t!.caseId, caseName: m.get('cases', t!.caseId)?.canonicalName ?? '', due: t!.dueDate, status: t!.status })),
      newCollaborators: caseList(b.summary.newCollaboratorIds ?? []),
      reopenedArtists: (b.summary.reopenedArtistIds ?? []).map(id => m.get('cases', id)).filter(Boolean).map(c => ({ id: c!.id, name: c!.canonicalName, status: c!.artistStatus, reasons: reopenReasons(c!).map(r => r.text) })),
      duplicates: (b.summary.duplicateIds ?? []).map(id => m.get('conflicts', id)).filter(Boolean).map(x => ({ id: x!.id, kind: x!.kind, status: x!.status, names: x!.caseIds.map(id => m.get('cases', id)?.canonicalName ?? id) })),
    };
  },
  exceptions(m: Model, _ctx: Ctx, p: { status?: string } = {}) {
    return m.all('importRows').filter(r => r.status === 'Quarantined' && (!p.status || r.exceptionStatus === p.status))
      .sort((a, b) => b.batchId.localeCompare(a.batchId) || a.rowNumber - b.rowNumber).map(r => ({ ...r, ownerName: userName(m, r.ownerId), file: m.get('batches', r.batchId)?.originalFilename ?? '' }));
  },

  researchOverview(m: Model, _ctx: Ctx) {
    const songs = songCounts(m);
    const working = live(m).filter(c => ['Researching', 'Waiting for Evidence'].includes(c.lifecycleStage)).sort((a, b) => b.priorityScore - a.priorityScore)
      .map(c => ({ id: c.id, name: c.canonicalName, stage: c.lifecycleStage, owner: userName(m, c.ownerId), songs: songs.get(c.id) ?? 0, done: c.checklist.filter(x => x.status === 'Complete').length, blocked: c.checklist.filter(x => x.status === 'Blocked').length, waiting: c.waiting }));
    const activities = m.all('research').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40).map(r => ({ ...r, caseName: m.get('cases', r.caseId)?.canonicalName ?? r.caseId, researcherName: userName(m, r.researcherId) }));
    return { working, activities };
  },
  routesOverview(m: Model, _ctx: Ctx, p: { state?: string } = {}) {
    return m.all('routes').filter(r => !p.state || r.state === p.state).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300).map(r => routeView(m, r));
  },
  contacts(m: Model) {
    return m.all('contacts').sort((a, b) => Number(b.verified) - Number(a.verified) || a.personName.localeCompare(b.personName)).map(k => ({ ...k, verifiedByName: k.verifiedById ? userName(m, k.verifiedById) : null, routes: m.all('routes').filter(r => r.contactId === k.id).length }));
  },
  recentAttempts(m: Model) {
    return m.all('attempts').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100).map(a => ({ ...a, caseName: m.get('cases', a.caseId)?.canonicalName ?? a.caseId, ownerName: userName(m, a.ownerId) }));
  },
  claimsOverview(m: Model, ctx: Ctx) {
    const claimCounts = Object.fromEntries(CLAIM_STATUSES.map(s => [s, 0])) as Record<string, number>;
    for (const c of live(m)) claimCounts[c.claimStatus]++;
    const rows = live(m).filter(c => c.claimStatus !== 'Not Invited' || stageIndex(c.lifecycleStage) >= stageIndex('Contact Confirmed') && c.lifecycleStage !== 'Closed')
      .map(c => { const t = openTasks(m, c.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]; return { id: c.id, name: c.canonicalName, stage: c.lifecycleStage, claimStatus: c.claimStatus, activationStatus: c.activationStatus, owner: userName(m, c.ownerId), next: t?.step ?? c.nextAction, due: t?.dueDate ?? null, overdue: !!t && t.dueDate < ctx.today }; })
      .sort((a, b) => stageIndex(a.stage) - stageIndex(b.stage));
    return { claimCounts, rows };
  },
  reopened(m: Model, _ctx: Ctx) {
    return m.all('reopens').sort((a, b) => b.date.localeCompare(a.date)).map(r => {
      const route = r.routeId ? m.get('routes', r.routeId) : null;
      const task = r.taskId ? m.get('tasks', r.taskId) : null;
      return { ...r, caseName: m.get('cases', r.caseId)?.canonicalName ?? r.caseId, currentStage: m.get('cases', r.caseId)?.lifecycleStage ?? null, ownerName: userName(m, r.ownerId), route: route ? routeView(m, route).chain.map(x => x.label).join(' → ') : null, task: task ? { id: task.id, step: task.step, status: task.status } : null };
    });
  },
  identityQueue(m: Model, _ctx: Ctx) {
    const songs = songCounts(m);
    const side = (id: string) => {
      const c = m.get('cases', id)!;
      const tracks = m.trackIdsOfCase(id).map(t => m.get('tracks', t)!).filter(Boolean);
      const roles = new Set(m.creditsOfCase(id).filter(cr => cr.status === 'Active').map(cr => cr.role));
      return { id, name: c.canonicalName, aliases: c.aliases, backendIds: c.backendProfileIds, songs: songs.get(m.canonical(id)) ?? 0, sample: tracks.slice(0, 4).map(t => `${t.title} (${t.label || 'no label'})`), roles: [...roles], language: c.language, profileUrls: c.profileUrls, identityStatus: c.identityStatus, stage: c.lifecycleStage, evidence: c.identityEvidence, mergedIntoId: c.mergedIntoId };
    };
    const open = m.all('conflicts').filter(c => c.status !== 'Decided').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(c => ({ ...c, cases: c.caseIds.map(side) }));
    const decisions = m.all('decisions').sort((a, b) => b.date.localeCompare(a.date)).map(d => ({ ...d, reviewerName: userName(m, d.reviewerId), names: d.caseIds.map(id => m.get('cases', id)?.canonicalName ?? id), reversedByName: d.reversedBy ? userName(m, d.reversedBy) : null }));
    return { open, decisions };
  },
  reports(m: Model, ctx: Ctx) {
    const d = queries.dashboard(m, ctx);
    const cases = live(m);
    const tasks = m.all('tasks');
    const owners = m.all('users').map(u => ({ name: u.name, role: visibleRole(m, ctx.userId, u), cases: cases.filter(c => c.ownerId === u.id && c.lifecycleStage !== 'Closed').length, openTasks: tasks.filter(t => openTask(t) && t.ownerId === u.id).length, overdue: tasks.filter(t => openTask(t) && t.ownerId === u.id && t.dueDate < ctx.today).length }));
    const waiting = cases.filter(c => c.lifecycleStage === 'Waiting for Evidence');
    const age = (c: ArtistCase) => daysBetween(c.stageSince, ctx.today);
    const ageing = [['0-7 days', 0, 7], ['8-30 days', 8, 30], ['31-90 days', 31, 90], ['90+ days', 91, 1e9]].map(([label, lo, hi]) => ({ label: label as string, value: waiting.filter(c => age(c) >= (lo as number) && age(c) <= (hi as number)).length }));
    const routes = m.all('routes');
    const routeStates = ['Candidate', 'Verified', 'Selected', 'Rejected', 'Exhausted'].map(s => ({ label: s, value: routes.filter(r => r.state === s).length }));
    const attempts = m.all('attempts');
    const results = [...new Set(attempts.map(a => a.result))].map(r => ({ label: r, value: attempts.filter(a => a.result === r).length })).sort((a, b) => b.value - a.value);
    const weeks: { label: string; value: number }[] = [];
    for (let w = 5; w >= 0; w--) { const from = addDays(ctx.today, -7 * (w + 1) + 1), to = addDays(ctx.today, -7 * w); weeks.push({ label: `${from.slice(5)}–${to.slice(5)}`, value: m.all('reopens').filter(r => r.date.slice(0, 10) >= from && r.date.slice(0, 10) <= to).length }); }
    const claimFunnel = [
      { label: 'Invited', value: cases.filter(c => m.familyItems('claimEvents', c.id).some(e => e.type === 'Invited')).length },
      { label: 'Submitted', value: cases.filter(c => m.familyItems('claimEvents', c.id).some(e => e.type === 'Submitted')).length },
      { label: 'Approved', value: cases.filter(c => m.familyItems('claimEvents', c.id).some(e => e.type === 'Approved')).length },
      { label: 'Completed (backend verified)', value: cases.filter(c => c.claimStatus === 'Completed').length },
    ];
    const activationFunnel = [
      { label: 'Claim completed', value: cases.filter(c => c.claimStatus === 'Completed').length },
      { label: 'Access verified', value: cases.filter(c => m.familyItems('activationEvents', c.id).some(e => e.type === 'Access Verified')).length },
      { label: 'Meaningful use', value: cases.filter(c => c.activationStatus === 'Activated').length },
      { label: 'Ongoing ARM', value: cases.filter(c => c.lifecycleStage === 'Ongoing ARM').length },
    ];
    const conversations = attempts.filter(a => ['Interested', 'Needs Help', 'Conversation Confirmed'].includes(a.result)).length;
    const routeSuccess = routes.filter(r => r.state === 'Selected' || r.state === 'Rejected' || r.state === 'Exhausted').length;
    const routeConfirmed = cases.filter(c => m.byCase('attempts', c.id).some(a => a.routeId && ['Interested', 'Needs Help', 'Conversation Confirmed'].includes(a.result))).length;
    return {
      total: d.total, backendProfiles: d.backendProfiles, stageDistribution: LIFECYCLE_STAGES.map(s => ({ label: s, value: d.byStage[s] })), claimFunnel, activationFunnel,
      overdue: tasks.filter(t => openTask(t) && t.dueDate < ctx.today).length, owners, waitingAgeing: ageing, reopenedByWeek: weeks, reopenedTotal: m.count('reopens'),
      newLeads: tasks.filter(t => openTask(t) && t.workReason === 'New Lead').length, routeStates, attemptResults: results, attempts: attempts.length, conversations,
      claimsCompleted: claimFunnel[3].value, activated: activationFunnel[2].value, routeSuccess: { used: routeSuccess, confirmed: routeConfirmed },
      identityConflicts: m.all('conflicts').filter(c => c.status !== 'Decided').length, oldestUnresolvedDays: Math.max(0, ...cases.filter(c => ['Unresearched', 'Researching', 'Waiting for Evidence', 'Identity Review'].includes(c.lifecycleStage)).map(age)),
    };
  },
  auditLog(m: Model, ctx: Ctx, p: { userId?: string; action?: string; q?: string; from?: string; to?: string; page?: number; pageSize?: number; meaningful?: boolean } = {}) {
    const q = searchQuery(p.q);
    let list = m.all('audit');
    if (p.meaningful) list = list.filter(e => !['Task created', 'Case created from import', 'Checklist step', 'Alias added from import'].some(x => e.action.startsWith(x)));
    if (p.userId) list = list.filter(e => e.userId === p.userId);
    if (p.action) list = list.filter(e => e.action === p.action);
    if (p.from) list = list.filter(e => e.at.slice(0, 10) >= p.from!);
    if (p.to) list = list.filter(e => e.at.slice(0, 10) <= p.to!);
    if (q.key) list = list.filter(e => (e.caseId && (sameId(q, e.caseId) || matchTier(q, m.get('cases', e.caseId)?.canonicalName, { similar: false }))) || bestTier(q, [e.action, e.to, e.reason, userName(m, e.userId)], { similar: false }));
    list.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const size = p.pageSize ?? 50, page = Math.max(1, p.page ?? 1);
    // The System Owner shows as Admin to everyone else, in the history too.
    const owner = m.get('users', ctx.userId)?.role === 'System Owner';
    const role = (v: string | null) => (!owner && v === 'System Owner' ? 'Admin' : v);
    return { rows: list.slice((page - 1) * size, page * size).map(e => ({ ...e, from: role(e.from), to: role(e.to), userName: userName(m, e.userId), caseName: e.caseId ? m.get('cases', e.caseId)?.canonicalName ?? e.caseId : null })), total: list.length, page, pageSize: size, actions: [...new Set(m.all('audit').map(e => e.action))].sort() };
  },
  /**
   * The top search bar. Case, spaces and punctuation never matter; best matches first: artists (ID, exact name, name
   * starting with the text, a word starting with it, containing it, all words, similar spelling, then aliases and
   * profiles), then songs (ID, ISRC, title), contacts, tasks and routes.
   */
  search(m: Model, _ctx: Ctx, p: { q: string }) {
    const q = searchQuery(p.q);
    if (q.key.length < 2) return [];
    const out: { type: string; id: string; caseId: string | null; label: string; sub: string }[] = [];
    const { songs: songCount } = artistAggregates(m);
    const artists = [...searchArtists(m, p.q, { catalogue: false })].map(([id, hit]) => ({ c: m.get('cases', id)!, hit })).filter(x => x.c)
      .sort((a, b) => a.hit.rank - b.hit.rank || (songCount.get(b.c.id) ?? 0) - (songCount.get(a.c.id) ?? 0) || a.c.canonicalName.localeCompare(b.c.canonicalName));
    for (const { c, hit } of artists.slice(0, 15)) {
      out.push({ type: 'Artist', id: c.id, caseId: c.id, label: c.canonicalName, sub: [c.backendProfileIds[0] ?? c.id, `${songCount.get(c.id) ?? 0} songs`, hit.why && hit.why !== 'ID' ? hit.why : c.lifecycleStage].filter(Boolean).join(' · ') });
    }
    const isrc = normIsrc(p.q);
    const songHits: { t: Track; tier: number }[] = [];
    for (const t of m.data.tracks.values()) {
      const exactId = sameId(q, t.backendTrackId) || (isrc.length >= 10 && t.isrc === isrc);
      const tier = exactId ? 0 : matchTier(q, t.title, { similar: false });
      if (exactId || (tier && (q.key.length >= 3 || tier === TIER.EXACT))) songHits.push({ t, tier });
    }
    songHits.sort((a, b) => a.tier - b.tier || a.t.title.localeCompare(b.t.title));
    for (const { t } of songHits.slice(0, 10)) {
      const primary = m.creditsOfTrack(t.id).find(cr => cr.isPrimary && cr.caseId);
      out.push({ type: 'Song', id: t.id, caseId: primary?.caseId ? m.canonical(primary.caseId) : null, label: t.title, sub: `${t.backendTrackId}${t.isrc ? ` · ${t.isrc}` : ''}${primary ? ` · ${primary.personName}` : ''}` });
    }
    const contacts = m.all('contacts').map(k => ({ k, tier: bestTier(q, [k.personName], { similar: false }) || (searchKey(k.value).includes(q.key) ? TIER.CONTAINS : 0) })).filter(x => x.tier).sort((a, b) => a.tier - b.tier);
    for (const { k } of contacts.slice(0, 8)) out.push({ type: 'Contact', id: k.id, caseId: k.caseId, label: k.personName, sub: `${k.channel} · ${k.verified ? 'verified' : 'unverified'}` });
    for (const t of m.all('tasks')) if (sameId(q, t.id) || (q.key.length > 3 && openTask(t) && matchTier(q, t.step, { similar: false }))) out.push({ type: 'Task', id: t.id, caseId: t.caseId, label: `${t.id} ${t.step}`, sub: `${m.get('cases', t.caseId)?.canonicalName ?? ''} · ${t.status}` });
    for (const r of m.all('routes')) if (sameId(q, r.id)) out.push({ type: 'Route', id: r.id, caseId: r.targetCaseId, label: r.id, sub: routeView(m, r).chain.map(x => x.label).join(' → ') });
    return out.slice(0, 60);
  },
  notifications(m: Model) {
    const list = m.all('notifications').sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    return { unread: list.filter(n => !n.read).length, items: list.slice(0, 40) };
  },
  ...discoveryViews,
  ...v2Views,
  caseOptions(m: Model, _ctx: Ctx, p: { q: string }) {
    const q = searchQuery(p.q);
    const found = q.key ? searchArtists(m, p.q, { catalogue: false }) : null;
    return live(m).filter(c => !found || found.has(c.id)).sort((a, b) => (found?.get(a.id)?.rank ?? 0) - (found?.get(b.id)?.rank ?? 0) || a.canonicalName.localeCompare(b.canonicalName)).slice(0, 20).map(c => ({ id: c.id, name: c.canonicalName, artistId: c.backendProfileIds[0] ?? '', stage: c.lifecycleStage }));
  },
};
export type Queries = typeof queries;
export type QueryName = keyof Queries;
