// Shared building blocks for commands, imports and the refresh engine.
// Every state change goes through these helpers so it always leaves an audit record.
import {
  CHECKLIST_STEPS, LIFECYCLE_STAGES, OPEN_TASK_STATUSES, type ArtistKind, type LifecycleStage, type Priority, type Role, type TaskKind, type WorkReason,
} from './constants';
import type { Model } from './model';
import type { ArtistCase, AuditEvent, Ctx, NotificationType, Route, Task, User } from './types';
import { addDays, daysBetween } from './util';

export class RuleError extends Error {}
export const rule = (msg: string) => new RuleError(msg);

// ---------------------------------------------------------------------------
// Permissions (role-aware UI; contact data can later be restricted the same way)
// ---------------------------------------------------------------------------
export const PERMISSIONS: Record<string, Role[]> = {
  import: ['System Owner', 'Admin'],
  identityDecision: ['System Owner', 'Admin', 'User'],
  reviewClaim: ['System Owner', 'Admin'],
  verifyBackendClaim: ['System Owner', 'Admin'],
  closeCase: ['System Owner', 'Admin'],
  reassign: ['System Owner', 'Admin', 'User'],
  resolveException: ['System Owner', 'Admin'],
  bulkDiscovery: ['System Owner', 'Admin'],
  discoverySettings: ['System Owner', 'Admin'],
  manageUsers: ['System Owner', 'Admin'],
  managePasswords: ['System Owner'],
  resetWorkspace: ['System Owner'],
};
export function can(m: Model, userId: string, perm: string): boolean {
  const roles = PERMISSIONS[perm];
  if (!roles) return true;
  const u = m.get('users', userId);
  return !!u && roles.includes(u.role);
}
export function requirePerm(m: Model, ctx: Ctx, perm: string) {
  if (!can(m, ctx.userId, perm)) {
    const u = m.get('users', ctx.userId);
    const roles = PERMISSIONS[perm].filter(r => r !== 'System Owner');
    throw rule(`${u ? `${u.name} (${u.role})` : 'This user'} cannot do this. ${roles.length ? `Needed role: ${roles.join(' or ')}.` : 'Only the System Owner can.'}`);
  }
}
/** The System Owner shows as Admin to everyone else: only the owner sees their own role. */
export function visibleRole(m: Model, viewerId: string, u: User): Role {
  return u.role === 'System Owner' && m.get('users', viewerId)?.role !== 'System Owner' ? 'Admin' : u.role;
}
export function viewUser(m: Model, viewerId: string, u: User): User { return { ...u, role: visibleRole(m, viewerId, u) }; }
export function userName(m: Model, id: string | null | undefined): string { return id ? m.get('users', id)?.name ?? id : 'Unassigned'; }

// ---------------------------------------------------------------------------
// Audit + notifications
// ---------------------------------------------------------------------------
type AuditOptional = 'field' | 'from' | 'to' | 'reason' | 'evidence' | 'result' | 'next';
export type AuditInput = Omit<AuditEvent, 'id' | 'at' | 'userId' | AuditOptional> & Partial<Pick<AuditEvent, AuditOptional>> & { at?: string };
export function audit(m: Model, ctx: Ctx, e: AuditInput): AuditEvent {
  return m.insert('audit', {
    id: m.nextId('AU', 6), at: e.at ?? ctx.now, userId: ctx.userId, caseId: e.caseId, entity: e.entity, entityId: e.entityId,
    action: e.action, field: e.field ?? null, from: e.from ?? null, to: e.to ?? null, reason: e.reason ?? null,
    evidence: e.evidence ?? null, result: e.result ?? null, next: e.next ?? null,
  });
}
export function notify(m: Model, ctx: Ctx, type: NotificationType, text: string, caseId: string | null) {
  m.insert('notifications', { id: m.nextId('N', 5), type, text, caseId, at: ctx.now, read: false });
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------
export function getCase(m: Model, id: string): ArtistCase {
  const c = m.get('cases', id);
  if (!c) throw rule(`Case ${id} not found.`);
  if (c.mergedIntoId) throw rule(`${c.canonicalName} (${id}) was merged into ${c.mergedIntoId}. Open that case instead.`);
  return c;
}
export function stageIndex(s: LifecycleStage): number { return LIFECYCLE_STAGES.indexOf(s); }
export function setStage(m: Model, ctx: Ctx, c: ArtistCase, stage: LifecycleStage, reason: string, evidence?: string) {
  if (c.lifecycleStage === stage) { m.update('cases', c.id, { stageReason: reason, updatedAt: ctx.now }); return; }
  const from = c.lifecycleStage;
  m.update('cases', c.id, { previousStage: from, lifecycleStage: stage, stageReason: reason, stageSince: ctx.now, updatedAt: ctx.now });
  audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Lifecycle stage changed', field: 'lifecycleStage', from, to: stage, reason, evidence: evidence ?? null });
}
export function setField<K extends keyof ArtistCase>(m: Model, ctx: Ctx, c: ArtistCase, field: K, value: ArtistCase[K], reason: string) {
  const from = c[field];
  if (JSON.stringify(from) === JSON.stringify(value)) return;
  m.update('cases', c.id, { [field]: value, updatedAt: ctx.now } as Partial<ArtistCase>);
  audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: `${String(field)} changed`, field: String(field), from: from == null ? null : String(from), to: value == null ? null : String(value), reason });
}
export function newChecklist() { return CHECKLIST_STEPS.map((_, i) => ({ step: i + 1, status: 'Not Started' as const, note: '', updatedAt: null, updatedBy: null })); }
export function evidenceChanged(m: Model, ctx: Ctx, c: ArtistCase, note: string) {
  m.update('cases', c.id, { lastEvidenceChange: ctx.now, lastEvidenceNote: note, updatedAt: ctx.now });
}
export function outreachBlocked(c: ArtistCase, today: string): string | null {
  if (c.contactPreference === 'Do Not Contact') return `${c.canonicalName} asked not to be contacted. Outreach is blocked for every future import.`;
  if (c.contactPreference === 'Declined') return `${c.canonicalName} declined. Outreach stays blocked unless the case is reopened.`;
  if (c.contactPreference === 'Later' && c.contactPreferenceUntil && c.contactPreferenceUntil > today) return `${c.canonicalName} asked to be contacted from ${c.contactPreferenceUntil}.`;
  return null;
}

// ---------------------------------------------------------------------------
// Tasks: one open task per case and kind; every change is audited
// ---------------------------------------------------------------------------
export const OUTREACH_KINDS: TaskKind[] = ['Outreach', 'Follow-up', 'Introduction'];
export function openTasks(m: Model, caseId: string): Task[] { return m.byCase('tasks', caseId).filter(t => OPEN_TASK_STATUSES.includes(t.status)); }
export interface TaskSpec {
  kind: TaskKind; step: string; why: string; trigger: string; dueDate?: string; priority?: Priority; ownerId?: string | null;
  workReason?: WorkReason; evidenceChange?: string | null; status?: Task['status']; channel?: Task['channel']; recipient?: string | null;
}
/** Creates a task unless an equivalent open task exists (same case + kind + step). Returns the task (new or existing). */
export function openTask(m: Model, ctx: Ctx, c: ArtistCase, spec: TaskSpec, opts: { failOnDuplicate?: boolean } = {}): Task {
  if (OUTREACH_KINDS.includes(spec.kind)) { const why = outreachBlocked(c, ctx.today); if (why && c.contactPreference !== 'Later') throw rule(why); }
  const dup = openTasks(m, c.id).find(t => t.kind === spec.kind && t.step === spec.step);
  if (dup) {
    if (opts.failOnDuplicate) throw rule(`An equivalent open task already exists (${dup.id}: ${dup.step}).`);
    return dup;
  }
  const t = m.insert('tasks', {
    id: m.nextId('TK', 4), caseId: c.id, ownerId: spec.ownerId === undefined ? c.ownerId : spec.ownerId, kind: spec.kind, step: spec.step,
    trigger: spec.trigger, why: spec.why, evidenceChange: spec.evidenceChange ?? null, dueDate: spec.dueDate ?? ctx.today,
    priority: spec.priority ?? c.priority, status: spec.status ?? 'Queued', workReason: spec.workReason ?? c.workReason,
    action: null, channel: spec.channel ?? null, recipient: spec.recipient ?? null, result: null, evidence: [], notes: [], nextAction: null,
    focusedMinutes: 0, createdAt: ctx.now, startedAt: null, completedAt: null, createdBy: ctx.userId,
  });
  audit(m, ctx, { caseId: c.id, entity: 'Task', entityId: t.id, action: 'Task created', to: t.step, reason: spec.why, next: `Due ${t.dueDate}` });
  syncNextAction(m, c.id);
  return t;
}
export function finishTask(m: Model, ctx: Ctx, t: Task, status: 'Completed' | 'Cancelled', result: string, nextAction?: string | null) {
  m.update('tasks', t.id, { status, result, completedAt: ctx.now, nextAction: nextAction ?? t.nextAction });
  audit(m, ctx, { caseId: t.caseId, entity: 'Task', entityId: t.id, action: status === 'Completed' ? 'Task completed' : 'Task cancelled', field: 'status', from: t.status, to: status, result, next: nextAction ?? null });
  syncNextAction(m, t.caseId);
}
/** Close open tasks of the given kinds (or all) with an outcome, e.g. when a workflow step is done. */
export function closeTasks(m: Model, ctx: Ctx, caseId: string, kinds: TaskKind[] | 'all', result: string, status: 'Completed' | 'Cancelled' = 'Completed') {
  for (const t of openTasks(m, caseId)) if (kinds === 'all' || kinds.includes(t.kind)) finishTask(m, ctx, t, status, result);
}
export function syncNextAction(m: Model, caseId: string) {
  const c = m.get('cases', caseId);
  if (!c) return;
  const open = openTasks(m, caseId).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const next = open[0];
  const patch = next ? { nextAction: next.step, nextActionDate: next.dueDate } : { nextAction: defaultNextAction(c), nextActionDate: null };
  if (c.nextAction !== patch.nextAction || c.nextActionDate !== patch.nextActionDate) m.update('cases', caseId, patch);
}
function defaultNextAction(c: ArtistCase): string | null {
  switch (c.lifecycleStage) {
    case 'Unresearched': return 'Start research';
    case 'Waiting for Evidence': return c.waiting ? `Re-check on ${c.waiting.nextReviewDate} or when new evidence arrives` : 'Wait for new evidence';
    case 'Closed': return null;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Priority: catalogue size, recent releases, fresh leads and stage
// ---------------------------------------------------------------------------
export function computePriority(m: Model, c: ArtistCase, today: string) {
  const tracks = m.trackIdsOfCase(c.id).map(id => m.get('tracks', id)!).filter(Boolean);
  let score = Math.min(30, Math.round(9 * Math.log2(1 + tracks.length)));
  if (tracks.some(t => t.releaseDate && daysBetween(t.releaseDate, today) <= 365 && t.releaseDate <= today)) score += 15;
  if (c.workReason === 'New Lead') score += 25;
  if (m.byCase('routes', c.id).some(r => r.state === 'Verified' || r.state === 'Selected')) score += 15;
  if (['Contact Confirmed', 'Claim Invited', 'Claim Submitted', 'Claim Review', 'Claimed', 'Activation Pending'].includes(c.lifecycleStage)) score += 20;
  if (c.lifecycleStage === 'Identity Review') score += 10;
  score = Math.min(100, score);
  const priority: Priority = score >= 55 ? 'High' : score >= 30 ? 'Medium' : 'Low';
  if (c.priorityScore !== score || c.priority !== priority) m.update('cases', c.id, { priorityScore: score, priority });
}

/** Permanent Artist IDs: A000001 in workspaces created since v2; older workspaces keep their C0001 numbering. */
export function nextArtistId(m: Model): string { return m.getMeta('artistIdFormat') === 'A6' ? m.nextId('A', 6) : m.nextId('C', 4); }
export function newCaseRecord(m: Model, ctx: Ctx, p: { name: string; backendId?: string | null; batchId?: string | null; identityStatus?: ArtistCase['identityStatus']; language?: string | null; profileUrl?: string | null; kind?: ArtistKind }): ArtistCase {
  return m.insert('cases', {
    id: nextArtistId(m), canonicalName: p.name, aliases: [], backendProfileIds: p.backendId ? [p.backendId] : [],
    profileUrls: p.profileUrl ? [p.profileUrl] : [], roles: [], language: p.language ?? null,
    identityStatus: p.identityStatus ?? (p.backendId ? 'Verified' : 'Provisional'), identityEvidence: p.backendId ? `Backend profile ${p.backendId}` : null,
    lifecycleStage: 'Unresearched', previousStage: null, stageReason: p.batchId ? `Appeared in backend export ${p.batchId}` : 'Created by hand',
    stageSince: ctx.now, workReason: 'New Artist', contactPreference: 'Allowed', contactPreferenceUntil: null, ownerId: null,
    nextAction: 'Start research', nextActionDate: null, firstSeen: ctx.now, lastSeen: ctx.now, lastEvidenceChange: ctx.now,
    lastEvidenceNote: p.batchId ? `First seen in ${p.batchId}` : 'Created', firstSeenBatchId: p.batchId ?? null, lastSeenBatchId: p.batchId ?? null,
    claimStatus: 'Not Invited', activationStatus: 'Not Started', priority: 'Low', priorityScore: 0, mergedIntoId: null, closedReason: null,
    waiting: null, checklist: newChecklist(), arm: null, discoveryStatus: 'Not started', discoveryUpdatedAt: null, verifiedProfileCount: 0,
    kind: p.kind ?? 'Artist', artistStatus: 'NEW', artistStatusAt: ctx.now, firstVerifiedAt: null, manualVerifiedAt: null, manualVerifiedBy: null, rejectedAt: null, rejectedReason: null,
    reopen: null, goongoonaloStatus: 'PENDING', goongoonaloStatusAt: null, goongoonaloStatusBy: null, createdAt: ctx.now, updatedAt: ctx.now,
  });
}
export function waitingDefaults(m: Model, c: ArtistCase, ctx: Ctx, blocker: string, futureTrigger: string, nextReviewDate?: string) {
  const tested = m.byCase('routes', c.id).filter(r => r.state === 'Rejected' || r.state === 'Exhausted').map(r => `${routeLabel(m, r.id)}: ${r.state.toLowerCase()}${r.rejectionReason ? ` (${r.rejectionReason})` : ''}`);
  const done = c.checklist.filter(x => x.status === 'Complete').length;
  return { blocker, routesTested: tested, coverage: `${done}/8 checklist steps complete`, lastReview: ctx.today, futureTrigger, nextReviewDate: nextReviewDate ?? addDays(ctx.today, 30) };
}
export function routeLabel(m: Model, routeId: string): string {
  const r = m.get('routes', routeId);
  if (!r) return routeId;
  const via = r.collaboratorName ?? r.organisation ?? (r.sourceUrl ? 'profile link' : 'direct');
  const contact = r.contactId ? m.get('contacts', r.contactId) : null;
  return `${r.id} via ${via}${contact ? ` (${contact.channel})` : ''}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function selectRoute(m: Model, ctx: Ctx, c: ArtistCase, r: Route, why: string) {
  for (const other of m.byCase('routes', c.id)) if (other.state === 'Selected' && other.id !== r.id) {
    m.update('routes', other.id, { state: 'Verified' });
    audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: other.id, action: 'Route unselected', field: 'state', from: 'Selected', to: 'Verified', reason: `${r.id} selected instead` });
  }
  if (r.state !== 'Selected') {
    m.update('routes', r.id, { state: 'Selected', lastChecked: ctx.now, ownerId: r.ownerId ?? c.ownerId });
    audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: r.id, action: 'Route selected', field: 'state', from: r.state, to: 'Selected', reason: why });
  }
}
export function outreachTaskFor(m: Model, ctx: Ctx, c: ArtistCase, r: Route, why: string) {
  const via = r.collaboratorName ?? r.organisation;
  const contact = r.contactId ? m.get('contacts', r.contactId) : null;
  return openTask(m, ctx, c, {
    kind: via ? 'Introduction' : 'Outreach', step: via ? `Contact ${via} for an introduction to ${c.canonicalName}` : `Contact ${c.canonicalName}${contact ? ` via ${contact.channel}` : ''}`,
    why, trigger: `Route ${r.id} selected`, channel: via ? 'Introducer' : (contact?.channel ?? null), recipient: via ?? c.canonicalName,
  });
}
