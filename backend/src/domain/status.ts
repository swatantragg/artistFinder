// v2 status model. Two families that are never mixed:
//  - identity / discovery status: derived from what the software found and what people decided
//    (NEW → SEARCHING → NEEDS_REVIEW → VERIFIED, with PENDING, REOPENED and REJECTED), recorded as status events;
//  - Goongoonalo status: only a person changes it, every change is a timestamped status event (weekly/monthly numbers).
// Verification is never thrown away: reopening keeps the verified profiles and adds the reasons to review.
import { ACTIVE_JOB_STATUSES, GOONGOONALO_INFO, GOONGOONALO_STATUSES, OPEN_TASK_STATUSES, type ArtistKind, type ArtistStatus, type GoongoonaloStatus } from './constants';
import type { Model } from './model';
import { OUTREACH_KINDS, audit, closeTasks, finishTask, openTask, openTasks, rule } from './ops';
import type { ArtistCase, Ctx, ReopenInfo, ReopenReason } from './types';
import { daysBetween } from './util';
import { reviewCount } from './discovery/relevance';

export type ReopenKind = ReopenReason['kind'];
export const REVIEW_CHANGES_STEP = 'Review what changed';

/** Identity counts as verified once a person confirmed it: a verified profile, a backend-verified claim or a manual confirmation. */
export function isVerified(c: ArtistCase): boolean {
  return c.verifiedProfileCount > 0 || c.claimStatus === 'Completed' || !!c.manualVerifiedAt;
}
function worked(m: Model, c: ArtistCase): boolean {
  if (m.byCase('discoveryJobs', c.id).some(j => j.status !== 'CANCELLED')) return true;
  // Routes the refresh engine suggests on its own do not count: only searches and people's work move an artist out of NEW.
  if (m.byCase('profiles', c.id).length || m.familyItems('research', c.id).length || m.familyItems('attempts', c.id).length) return true;
  return !['Unresearched', 'Identity Review'].includes(c.lifecycleStage);
}

export function deriveArtistStatus(m: Model, c: ArtistCase): ArtistStatus {
  if (c.rejectedAt) return 'REJECTED';
  if (m.byCase('discoveryJobs', c.id).some(j => ACTIVE_JOB_STATUSES.includes(j.status))) return 'SEARCHING';
  if (reviewCount(m, c.id) > 0) return 'NEEDS_REVIEW';
  if (c.reopen?.reasons.length) return 'REOPENED';
  if (isVerified(c)) return 'VERIFIED';
  return worked(m, c) ? 'PENDING' : 'NEW';
}

export function statusEvent(m: Model, ctx: Ctx, caseId: string, kind: 'identity' | 'goongoonalo', from: string | null, to: string, reason: string | null) {
  m.insert('statusEvents', { id: m.nextId('SE', 6), caseId, kind, from, to, at: ctx.now, by: ctx.userId, reason });
}

const NOTABLE: ArtistStatus[] = ['VERIFIED', 'REOPENED', 'REJECTED'];
/** Recompute the identity status after anything that can change it; records the transition. */
export function syncArtistStatus(m: Model, ctx: Ctx, caseId: string, reason?: string | null) {
  const c = m.get('cases', caseId);
  if (!c || c.mergedIntoId) return;
  const patch: Partial<ArtistCase> = {};
  if (isVerified(c) && !c.firstVerifiedAt) patch.firstVerifiedAt = ctx.now;
  const next = deriveArtistStatus(m, c);
  if (next !== c.artistStatus) {
    patch.artistStatus = next; patch.artistStatusAt = ctx.now;
    statusEvent(m, ctx, c.id, 'identity', c.artistStatus, next, reason ?? null);
    if (NOTABLE.includes(next) || NOTABLE.includes(c.artistStatus)) audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Identity status changed', field: 'artistStatus', from: c.artistStatus, to: next, reason: reason ?? null });
  }
  if (Object.keys(patch).length) m.update('cases', c.id, patch);
}
export function syncArtistStatuses(m: Model, ctx: Ctx, caseIds: Iterable<string>) { for (const id of new Set(caseIds)) syncArtistStatus(m, ctx, m.canonical(id)); }

// ------------------------------------------------------------------ artist vs collaborator
/** Lead or performing artists (or anyone with a backend artist ID) are Artists; credited-only people are Collaborators. */
export function kindOf(m: Model, c: ArtistCase): ArtistKind {
  if (c.backendProfileIds.length) return 'Artist';
  const credits = m.creditsOfCase(c.id).filter(cr => cr.status === 'Active');
  if (!credits.length) return 'Artist';
  return credits.some(cr => cr.isPrimary || cr.role === 'Singer' || cr.role === 'Performer') ? 'Artist' : 'Collaborator';
}
export function syncKind(m: Model, ctx: Ctx, caseId: string) {
  const c = m.get('cases', caseId);
  if (!c || c.mergedIntoId) return;
  const k = kindOf(m, c);
  if (k === c.kind) return;
  m.update('cases', c.id, { kind: k });
  audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Artist type changed', field: 'kind', from: c.kind, to: k, reason: k === 'Artist' ? 'Now credited as a lead or performing artist' : 'Only credited as a collaborator (composer, lyricist, producer …)' });
}

// ------------------------------------------------------------------ reopening (keeps earlier verification)
const reasonsOf = (r: ReopenInfo | null): ReopenReason[] => r?.reasons ?? [];

/** New evidence for an artist a person already worked on: show what changed and ask for a review. NEW artists are not reopened. */
export function reopenArtist(m: Model, ctx: Ctx, caseId: string, kind: ReopenKind, text: string): boolean {
  const c = m.get('cases', m.canonical(caseId));
  if (!c || c.rejectedAt) return false;
  if (kind !== 'manual' && c.artistStatus === 'NEW' && !isVerified(c)) return false;
  const reasons = reasonsOf(c.reopen);
  if (reasons.some(r => r.kind === kind && r.text === text)) return false;
  const next: ReopenInfo = { at: ctx.now, by: ctx.userId, previousStatus: c.reopen?.previousStatus ?? c.artistStatus, reasons: [...reasons, { kind, text, at: ctx.now }].slice(-10) };
  m.update('cases', c.id, { reopen: next });
  audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Artist reopened', reason: text, result: 'Earlier verification and evidence are kept', next: REVIEW_CHANGES_STEP });
  syncArtistStatus(m, ctx, c.id, text);
  const cc = m.get('cases', c.id)!;
  // The next action: review what changed, unless the artist already has one (e.g. a new introduction to make).
  if (cc.ownerId && cc.lifecycleStage !== 'Closed' && !openTasks(m, cc.id).length) openTask(m, ctx, cc, { kind: 'Research', step: REVIEW_CHANGES_STEP, why: text, trigger: 'Artist reopened', priority: 'Medium' });
  return true;
}
/** A person looked at what changed (or the change resolved itself): the artist leaves REOPENED. */
export function clearReopen(m: Model, ctx: Ctx, caseId: string, note: string, kinds?: ReopenKind[]) {
  const c = m.get('cases', caseId);
  if (!c?.reopen) return;
  const left = kinds ? reasonsOf(c.reopen).filter(r => !kinds.includes(r.kind)) : [];
  if (left.length === reasonsOf(c.reopen).length) return;
  m.update('cases', c.id, { reopen: left.length ? { ...c.reopen, reasons: left } : null });
  audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: left.length ? 'Reopen reason resolved' : 'Reopened artist reviewed', reason: note });
  if (!left.length) for (const t of openTasks(m, c.id)) if (t.step === REVIEW_CHANGES_STEP && OPEN_TASK_STATUSES.includes(t.status)) finishTask(m, ctx, t, 'Completed', note);
  syncArtistStatus(m, ctx, c.id, note);
}
export const reopenReasons = (c: ArtistCase) => reasonsOf(c.reopen);

/** Commands that mean a person worked on the artist: they answer reopen reasons about new songs, leads or a manual request. */
const WORK_COMMANDS = new Set(['recordContactAttempt', 'completeTask', 'startResearch', 'addResearch', 'updateChecklist', 'moveToWaiting', 'updateRoute', 'verifyRouteDiscovery', 'verifyRoute', 'createRouteFromPath', 'sendClaimInvitation', 'confirmIdentity']);
/** After every command: the identity status follows, and a person's work answers the reopen. */
export function afterCommand(m: Model, ctx: Ctx, name: string, caseId: string | undefined, engineUser: string) {
  if (!caseId) return;
  const id = m.canonical(caseId);
  const c = m.get('cases', id);
  if (c?.reopen && ctx.userId !== engineUser && WORK_COMMANDS.has(name)) clearReopen(m, ctx, id, `Worked on after the reopen (${name})`, ['new_song', 'new_collaborator', 'new_lead', 'manual']);
  syncArtistStatus(m, ctx, id);
}

/** Verified profiles not checked within the threshold reopen the artist once (a refresh that confirms them clears it). */
export function sweepStale(m: Model, ctx: Ctx, staleDays: number): number {
  let n = 0;
  for (const c of m.all('cases')) {
    if (c.mergedIntoId || c.rejectedAt) continue;
    const stale = m.byCase('verifiedProfiles', c.id).filter(v => v.verificationStatus === 'VERIFIED' && daysBetween(v.lastCheckedAt, ctx.today) > staleDays);
    const has = reasonsOf(c.reopen).some(r => r.kind === 'stale');
    if (stale.length && !has) { if (reopenArtist(m, ctx, c.id, 'stale', `${stale.map(v => `${v.platform}${v.username ? ` @${v.username}` : ''}`).join(', ')} not checked for more than ${staleDays} days`)) n++; }
    else if (!stale.length && has) clearReopen(m, ctx, c.id, 'Verified profiles checked again', ['stale']);
  }
  return n;
}

// ------------------------------------------------------------------ Goongoonalo status (a person decides, never discovery)
export function setGoongoonaloStatus(m: Model, ctx: Ctx, c: ArtistCase, status: GoongoonaloStatus, reason: string | null, opts: { fromContactPreference?: boolean } = {}) {
  if (!GOONGOONALO_STATUSES.includes(status)) throw rule('Pick a valid Goongoonalo status.');
  if (status !== 'DO_NOT_CONTACT' && status !== 'PENDING' && !isVerified(c)) throw rule(`${c.canonicalName} is not verified yet. The Goongoonalo status is decided for verified artists (verify a profile first).`);
  if (c.goongoonaloStatus === status) return false;
  const from = c.goongoonaloStatus;
  m.update('cases', c.id, { goongoonaloStatus: status, goongoonaloStatusAt: ctx.now, goongoonaloStatusBy: ctx.userId, updatedAt: ctx.now });
  statusEvent(m, ctx, c.id, 'goongoonalo', from, status, reason);
  audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Goongoonalo status changed', field: 'goongoonaloStatus', from: GOONGOONALO_INFO[from].label, to: GOONGOONALO_INFO[status].label, reason });
  if (opts.fromContactPreference) return true;
  // Do not contact is the same promise as the contact preference: outreach stays blocked for every future import.
  if (status === 'DO_NOT_CONTACT' && c.contactPreference !== 'Do Not Contact') {
    m.update('cases', c.id, { contactPreference: 'Do Not Contact', contactPreferenceUntil: null });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Contact preference changed', field: 'contactPreference', from: c.contactPreference, to: 'Do Not Contact', reason: reason ?? 'Goongoonalo status: do not contact' });
    closeTasks(m, ctx, c.id, OUTREACH_KINDS, 'Cancelled: do not contact', 'Cancelled');
  } else if (from === 'DO_NOT_CONTACT' && c.contactPreference === 'Do Not Contact') {
    m.update('cases', c.id, { contactPreference: 'Allowed' });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Contact preference changed', field: 'contactPreference', from: 'Do Not Contact', to: 'Allowed', reason: reason ?? `Goongoonalo status: ${GOONGOONALO_INFO[status].label}` });
  }
  return true;
}

/** Counts of status transitions inside a period (dashboard week/month numbers come from real timestamps). */
export function transitionsTo(m: Model, kind: 'identity' | 'goongoonalo', to: string, from: string, until: string): Set<string> {
  const out = new Set<string>();
  for (const e of m.all('statusEvents')) if (e.kind === kind && e.to === to && e.at.slice(0, 10) >= from && e.at.slice(0, 10) <= until) out.add(e.caseId);
  return out;
}
