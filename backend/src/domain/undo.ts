// Undo and reset for the outreach processes: Contact (routes, contact attempts, messages), Claim (claim events and the
// activation that follows it) and All (both, in time order: what the Claims & routes tab offers).
// A step is everything one command changed at one moment: its audit entries share that timestamp. Undoing it puts those
// fields back (stage, contact preference, claim status, Goongoonalo status, work reason, greetings, route state), cancels
// the tasks it opened, reopens the tasks it closed and marks its records (contact attempt, claim event, message) as undone.
// Nothing is deleted and the undo itself is audited. Reset = undo every step of the process, newest first.
import { CONFIRMING_RESULTS, GOONGOONALO_INFO, GOONGOONALO_STATUSES, MESSAGE_KIND_INFO, OPEN_TASK_STATUSES, type ContactPreference, type GoongoonaloStatus, type LifecycleStage, type TaskStatus } from './constants';
import type { CommandResult } from './commands';
import { syncRouteGraph } from './graph';
import { dmTargets, outreachState } from './messages';
import type { Model } from './model';
import { audit, computePriority, finishTask, getCase, notUndone, rule, setStage, stageIndex, syncNextAction, userName } from './ops';
import { setGoongoonaloStatus } from './status';
import type { ActivationEvent, ArtistCase, AuditEvent, ClaimEvent, ContactAttempt, Ctx, OutreachMessage } from './types';
import { clean } from './util';

export type ProcessKind = 'contact' | 'claim' | 'all';
export interface Step { at: string; label: string; by: string; attempts: ContactAttempt[]; events: ClaimEvent[]; activations: ActivationEvent[]; messages: OutreachMessage[]; replies: OutreachMessage[] }

const audits = (m: Model, c: ArtistCase) => m.familyItems('audit', c.id).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

/** The steps of a process that still count, oldest first. */
export function processSteps(m: Model, c: ArtistCase, kind: ProcessKind): Step[] {
  const map = new Map<string, Step>();
  const step = (at: string, by: string) => { let s = map.get(at); if (!s) { s = { at, label: '', by, attempts: [], events: [], activations: [], messages: [], replies: [] }; map.set(at, s); } return s; };
  if (kind !== 'claim') {
    for (const a of notUndone(m.familyItems('attempts', c.id))) step(a.date, a.ownerId).attempts.push(a);
    for (const x of notUndone(m.familyItems('messages', c.id))) {
      step(x.sentAt, x.sentBy).messages.push(x);
      if (x.outcomeAt) step(x.outcomeAt, x.outcomeBy ?? x.sentBy).replies.push(x);
    }
  }
  if (kind !== 'contact') {
    // Activation continues the claim, so its steps belong to the claim process (undone first, being later).
    const at = new Map(audits(m, c).filter(a => a.entity === 'ClaimEvent' || a.entity === 'ActivationEvent').map(a => [a.entityId, a.at]));
    for (const e of notUndone(m.familyItems('claimEvents', c.id))) step(at.get(e.id) ?? e.date, e.actorId).events.push(e);
    for (const e of notUndone(m.familyItems('activationEvents', c.id))) step(at.get(e.id) ?? e.date, e.actorId).activations.push(e);
  }
  const steps = [...map.values()].sort((a, b) => a.at.localeCompare(b.at));
  for (const s of steps) s.label = labelOf(s);
  return steps;
}
function labelOf(s: Step): string {
  if (s.activations.length) return s.activations.map(e => e.type === 'ARM Handover' ? 'Handed over to ARM' : e.type).join(' · ');
  if (s.events.length) return s.events.map(e => e.type === 'Invited' ? 'Claim invitation sent' : e.type === 'Submitted' ? `Claim submitted${e.claimRequestId ? ` (${e.claimRequestId})` : ''}` : e.type).join(' · ');
  const sent = s.messages.map(x => `${MESSAGE_KIND_INFO[x.kind].label}${x.followUpNo ? ` #${x.followUpNo}` : ''} sent on ${x.platform}`);
  const replies = s.replies.map(x => `Answer: ${x.outcome}`);
  const attempts = s.attempts.filter(a => !s.messages.some(x => x.attemptId === a.id)).map(a => `${a.result} · ${a.channel} → ${a.recipient}`);
  return [...sent, ...replies, ...(replies.length ? [] : attempts)].join(' · ') || 'Contact step';
}

/** Why the last step of a process cannot be undone (or null). */
export function undoBlocked(m: Model, c: ArtistCase, kind: ProcessKind, steps = processSteps(m, c, kind)): string | null {
  const last = steps[steps.length - 1];
  if (!last) return kind === 'claim' ? 'No claim step to undo.' : kind === 'contact' ? 'No contact step to undo.' : 'Nothing to undo yet.';
  if (kind === 'contact' && processSteps(m, c, 'claim').some(s => s.at > last.at)) return 'The claim has started after this step: undo the claim steps first.';
  return null;
}
export function resetBlocked(m: Model, c: ArtistCase, kind: ProcessKind): string | null {
  const steps = processSteps(m, c, kind);
  if (!steps.length) return kind === 'claim' ? 'The claim has not started.' : 'Nothing to reset yet.';
  if (kind === 'contact' && processSteps(m, c, 'claim').length) return 'The claim has started: reset the claim first.';
  return null;
}

const LABEL_TO_G = new Map(GOONGOONALO_STATUSES.map(s => [GOONGOONALO_INFO[s].label, s] as const));
/** Put back everything one step changed. Only fields that still hold the step's result are restored. */
function undoStep(m: Model, ctx: Ctx, c: ArtistCase, kind: ProcessKind, step: Step, reason: string) {
  const list = audits(m, c).filter(a => a.at === step.at);
  const first = (f: (a: AuditEvent) => boolean) => list.find(f);
  const lastOf = (f: (a: AuditEvent) => boolean) => [...list].reverse().find(f);
  const why = `Undone: ${step.label}`;
  const cur = () => m.get('cases', c.id)!;

  // Records first, so the workflow below already ignores them.
  const mark = { undoneAt: ctx.now, undoneBy: ctx.userId, undoReason: reason };
  for (const a of step.attempts) m.update('attempts', a.id, mark);
  for (const e of step.events) m.update('claimEvents', e.id, mark);
  for (const e of step.activations) m.update('activationEvents', e.id, mark);
  for (const x of step.messages) { m.update('messages', x.id, mark); if (x.attemptId && !step.attempts.some(a => a.id === x.attemptId)) m.update('attempts', x.attemptId, mark); }
  for (const x of step.replies) if (!step.messages.includes(x)) m.update('messages', x.id, { outcome: null, outcomeAt: null, outcomeBy: null });

  // Case fields, each back to what it was before the step (when nothing changed it since).
  // Entries written before V2.6.0 could carry the new value as "from" (read after the change): fall back to the usual earlier value.
  const EARLIER: Record<string, Record<string, string>> = {
    contactPreference: { Declined: 'Allowed', 'Do Not Contact': 'Allowed', Allowed: 'Allowed' },
    claimStatus: { Invited: 'Not Invited', Submitted: 'Invited', 'In Review': 'Submitted', Approved: 'In Review', Completed: 'Approved', Rejected: 'In Review' },
    activationStatus: { 'Access Verified': 'Not Started', 'Feature Selected': 'Access Verified', Activated: 'Feature Selected' },
  };
  const field = (name: string) => {
    const after = lastOf(a => a.field === name)?.to ?? null;
    let before = first(a => a.field === name)?.from ?? null;
    if (before && before === after) before = EARLIER[name]?.[after.split(' until ')[0]] ?? before;
    return { before, after, touched: list.some(a => a.field === name) };
  };
  const st = field('lifecycleStage');
  if (st.touched && st.before && cur().lifecycleStage === st.after) {
    if (cur().lifecycleStage === 'Closed') m.update('cases', c.id, { closedReason: null });
    setStage(m, ctx, cur(), st.before as LifecycleStage, why);
  }
  const pref = field('contactPreference');
  if (pref.touched && pref.before && cur().contactPreference === (pref.after ?? '').split(' until ')[0]) {
    const [p, until] = pref.before.split(' until ');
    m.update('cases', c.id, { contactPreference: p as ContactPreference, contactPreferenceUntil: until ?? null, updatedAt: ctx.now });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Contact preference changed', field: 'contactPreference', from: pref.after, to: pref.before, reason: why });
  }
  const claim = field('claimStatus');
  if (claim.touched && claim.before && cur().claimStatus === claim.after) {
    m.update('cases', c.id, { claimStatus: claim.before as ArtistCase['claimStatus'], updatedAt: ctx.now });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Claim status changed', field: 'claimStatus', from: claim.after, to: claim.before, reason: why });
  }
  const g = field('goongoonaloStatus');
  const gBefore = g.before ? LABEL_TO_G.get(g.before) : undefined, gAfter = g.after ? LABEL_TO_G.get(g.after) : undefined;
  if (g.touched && gBefore && cur().goongoonaloStatus === gAfter) setGoongoonaloStatus(m, ctx, cur(), gBefore as GoongoonaloStatus, why, { fromContactPreference: true });
  const act = field('activationStatus');
  if (act.touched && act.before && cur().activationStatus === act.after) {
    m.update('cases', c.id, { activationStatus: act.before as ArtistCase['activationStatus'], updatedAt: ctx.now });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Activation status changed', field: 'activationStatus', from: act.after, to: act.before, reason: why });
  }
  // The ARM record (relationship owner, next participation check) is kept as JSON in the audit.
  const arm = field('arm');
  if (arm.touched && arm.before && JSON.stringify(cur().arm ?? null) === arm.after) {
    m.update('cases', c.id, { arm: JSON.parse(arm.before), updatedAt: ctx.now });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'ARM record changed', field: 'arm', from: arm.after, to: arm.before, reason: why });
  } else if (step.activations.some(e => e.type === 'ARM Handover') && !arm.touched) m.update('cases', c.id, { arm: null, updatedAt: ctx.now });   // handovers before V2.7.0
  for (const name of ['workReason', 'greetings'] as const) {
    const f = field(name);
    if (f.touched && f.before != null && String(cur()[name] ?? '') === String(f.after ?? '')) {
      m.update('cases', c.id, { [name]: f.before, updatedAt: ctx.now } as Partial<ArtistCase>);
      audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: `${name} changed`, field: name, from: f.after, to: f.before, reason: why });
    }
  }
  // Routes the step selected, rejected or exhausted.
  for (const id of new Set(list.filter(a => a.entity === 'Route' && a.field === 'state').map(a => a.entityId))) {
    const r = m.get('routes', id);
    const before = first(a => a.entityId === id && a.field === 'state')?.from, after = lastOf(a => a.entityId === id && a.field === 'state')?.to;
    if (!r || !before || r.state !== after) continue;
    m.update('routes', id, { state: before as typeof r.state, rejectionReason: before === 'Rejected' || before === 'Exhausted' ? r.rejectionReason : null });
    audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: id, action: `Route ${before.toLowerCase()}`, field: 'state', from: after, to: before, reason: why });
    syncRouteGraph(m, ctx, id);
  }
  // Tasks: the ones the step opened are cancelled, the ones it closed are open again.
  for (const a of list.filter(x => x.entity === 'Task' && x.action === 'Task created')) {
    const t = m.get('tasks', a.entityId);
    if (t && OPEN_TASK_STATUSES.includes(t.status)) finishTask(m, ctx, t, 'Cancelled', why);
  }
  for (const a of list.filter(x => x.entity === 'Task' && x.field === 'status' && (x.action === 'Task completed' || x.action === 'Task cancelled'))) {
    const t = m.get('tasks', a.entityId);
    if (!t || t.status !== a.to || list.some(x => x.entity === 'Task' && x.action === 'Task created' && x.entityId === t.id)) continue;
    const back: TaskStatus = a.from && OPEN_TASK_STATUSES.includes(a.from as TaskStatus) ? a.from as TaskStatus : 'Queued';   // older entries: see EARLIER
    m.update('tasks', t.id, { status: back, completedAt: null, result: null });
    audit(m, ctx, { caseId: c.id, entity: 'Task', entityId: t.id, action: 'Task reopened', field: 'status', from: a.to, to: back, reason: why });
  }
  audit(m, ctx, { caseId: c.id, entity: kind === 'claim' ? 'Claim' : kind === 'contact' ? 'Contact' : 'Outreach', entityId: c.id, action: 'Step undone', to: step.label, reason, evidence: `Step of ${step.at.slice(0, 16).replace('T', ' ')} by ${userName(m, step.by)}` });
}

// ------------------------------------------------------------------ the contact process at a glance
export interface ProcessView {
  kind: ProcessKind; steps: { at: string; label: string; by: string }[]; canUndo: string | null; canReset: string | null;
  progress: { label: string; state: 'done' | 'active' | 'todo' }[]; ended: string | null; next: string; nextAction: string | null;
}
/** Where contact with the artist stands: four steps, the next thing to do, and what can be undone. */
export function contactProcess(m: Model, ctx: Ctx, c: ArtistCase): ProcessView {
  const steps = processSteps(m, c, 'contact');
  const attempts = notUndone(m.familyItems('attempts', c.id));
  const hasWay = dmTargets(m, c).length > 0 || m.byCase('routes', c.id).some(r => r.state === 'Verified' || r.state === 'Selected');
  const contacted = attempts.length > 0;
  const answered = attempts.some(a => a.result !== 'No Response');
  const confirmed = attempts.some(a => CONFIRMING_RESULTS.includes(a.result)) && c.lifecycleStage !== 'Closed' && stageIndex(c.lifecycleStage) >= stageIndex('Contact Confirmed');
  const done = [hasWay, contacted, answered, confirmed];
  const ended = c.contactPreference === 'Do Not Contact' ? 'The artist asked not to be contacted. Contact has ended.'
    : c.contactPreference === 'Declined' ? 'The artist is not interested. Contact has ended.' : null;
  const at = ended ? -1 : done.indexOf(false);
  const q = outreachState(m, c, ctx.today).sequence;
  let next: string, nextAction: string | null;
  if (ended) { next = `${ended} If this was a mistake, undo the last step.`; nextAction = steps.length ? 'undo' : null; }
  else if (at === 0) { next = 'Verify the artist’s Instagram, X or Facebook profile (Profiles tab), or add a route through someone who knows them.'; nextAction = 'addRoute'; }
  else if (at === 1) { next = 'Send the first message (Messages) or record a contact you made.'; nextAction = 'messages'; }
  else if (at === 2) { next = q && q.nextDue ? `Waiting for the answer. Record it when they reply; follow-up due ${q.nextDue}.` : 'Waiting for the answer. Record it when they reply.'; nextAction = q ? 'recordReply' : 'recordContact'; }
  else if (at === 3) { next = 'The answer was not a real conversation yet. Try another verified profile or route, then record the contact.'; nextAction = 'recordContact'; }
  else if (c.goongoonaloStatus === 'GOONGOONALO') { next = 'Contact confirmed. The artist is on Goongoonalo, so there is no claim: carry on with Activation (help them use their profile) or member messages.'; nextAction = c.claimStatus === 'Completed' ? 'activation' : 'messages'; }
  else { next = 'Contact confirmed. Next: send the claim invitation (Claims tab).'; nextAction = 'claims'; }
  return {
    kind: 'contact', steps: steps.map(s => ({ at: s.at, label: s.label, by: userName(m, s.by) })),
    canUndo: undoBlocked(m, c, 'contact', steps), canReset: resetBlocked(m, c, 'contact'),
    progress: ['Way to reach', 'Contacted', 'Answer', 'Conversation confirmed'].map((label, i) => ({ label, state: done[i] ? 'done' : i === at ? 'active' : 'todo' })),
    ended, next, nextAction,
  };
}

// ------------------------------------------------------------------ commands
const req = (v: unknown, what: string): string => { const s = clean(v); if (!s) throw rule(`${what} is required.`); return s; };
const kindOf = (v: unknown): ProcessKind => { if (v !== 'contact' && v !== 'claim' && v !== 'all') throw rule('Pick the contact, claim or whole process.'); return v; };
type Command = (m: Model, ctx: Ctx, p: Record<string, any>) => CommandResult;
export const undoCommands: Record<string, Command> = {
  /** Undo the last step of the contact or claim process (a reason is kept). */
  undoStep(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const kind = kindOf(p.process);
    const reason = req(p.reason, 'Why you undo it');
    const steps = processSteps(m, c, kind);
    const blocked = undoBlocked(m, c, kind, steps);
    if (blocked) throw rule(blocked);
    const last = steps[steps.length - 1];
    undoStep(m, ctx, c, kind, last, reason);
    computePriority(m, m.get('cases', c.id)!, ctx.today);
    syncNextAction(m, c.id);
    return { message: `Undone: ${last.label}.`, caseId: c.id };
  },
  /** Undo every step of the process, newest first. Needs the word RESET as confirmation. */
  resetProcess(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const kind = kindOf(p.process);
    const reason = req(p.reason, 'Why you reset it');
    if (clean(p.confirm).toUpperCase() !== 'RESET') throw rule('Type RESET to confirm.');
    const blocked = resetBlocked(m, c, kind);
    if (blocked) throw rule(blocked);
    const steps = processSteps(m, c, kind);
    for (const s of [...steps].reverse()) undoStep(m, ctx, c, kind, s, `Reset: ${reason}`);
    const word = kind === 'claim' ? 'Claim' : kind === 'contact' ? 'Contact' : 'Whole';
    audit(m, ctx, { caseId: c.id, entity: kind === 'claim' ? 'Claim' : kind === 'contact' ? 'Contact' : 'Outreach', entityId: c.id, action: `${word} process reset`, to: `${steps.length} step${steps.length === 1 ? '' : 's'} undone`, reason });
    computePriority(m, m.get('cases', c.id)!, ctx.today);
    syncNextAction(m, c.id);
    return { message: `${word} process reset: ${steps.length} step${steps.length === 1 ? '' : 's'} undone. The history keeps them.`, caseId: c.id };
  },
};
