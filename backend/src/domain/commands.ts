// Commands: the only way state changes. Each validates the business rules (spec §45, §69) and writes audit records.
import {
  CHANNELS, CHECKLIST_STEPS, PEOPLE_ROLES, CONFIRMING_RESULTS, CONTACT_PREFERENCES, FEATURES, GOONGOONALO_INFO, GOONGOONALO_STATUSES, LIFECYCLE_STAGES, OPEN_TASK_STATUSES, PARTICIPATION_CHECK_DAYS,
  type AttemptResult, type Channel, type ChecklistStatus, type ContactPreference, type LifecycleStage, type Priority, type TaskKind, type WorkReason,
} from './constants';
import type { Model } from './model';
import {
  OUTREACH_KINDS, audit, can, closeTasks, computePriority, evidenceChanged, finishTask, getCase, newCaseRecord, notify, openTask, openTasks,
  outreachBlocked, outreachTaskFor, requirePerm, routeLabel, rule, selectRoute, setField, setStage, stageIndex, syncNextAction, userName, waitingDefaults,
} from './ops';
import { applyLeads, leadsForContact, leadsForTracks } from './refresh';
import { discoveryCommands } from './discovery/commands';
import { scanDuplicates } from './dedupe';
import { clearReopen, reopenArtist, setGoongoonaloStatus, syncArtistStatus } from './status';
import { syncContactGraph, syncRouteGraph, syncTrackGraph } from './graph';
import type { ArtistCase, Contact, Ctx, Route, Task } from './types';
import { ISRC_RE, addDays, addWorkingDays, clean, nameKey, normIsrc, similarKey } from './util';

export interface CommandResult { message: string; caseId?: string; id?: string; data?: unknown }
type P = Record<string, any>;
type Command = (m: Model, ctx: Ctx, p: P) => CommandResult;

const req = (v: unknown, what: string): string => { const s = clean(v); if (!s) throw rule(`${what} is required.`); return s; };
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => { if (!list.includes(v as T)) throw rule(`Pick a valid ${what}.`); return v as T; };
/** Who supervisor tasks go to: the first Admin, else the System Owner. */
const supervisor = (m: Model) => (m.all('users').find(u => u.role === 'Admin') ?? m.all('users').find(u => u.role === 'System Owner'))?.id ?? null;
function getTask(m: Model, id: string): Task { const t = m.get('tasks', id); if (!t) throw rule(`Task ${id} not found.`); return t; }
function openTaskOnly(t: Task) { if (!OPEN_TASK_STATUSES.includes(t.status)) throw rule(`Task ${t.id} is already ${t.status.toLowerCase()}.`); }
function getRoute(m: Model, id: string): Route { const r = m.get('routes', id); if (!r) throw rule(`Route ${id} not found.`); return r; }

/** Which stages may be set by hand, and what evidence each needs (spec §45). */
export function stageGate(m: Model, c: ArtistCase, target: LifecycleStage): string | null {
  const ev = (k: 'claimEvents' | 'activationEvents', type: string) => m.familyItems(k, c.id).some(e => e.type === type);
  switch (target) {
    case 'Unresearched': case 'Researching': case 'Closed': return null;
    case 'Identity Review': return null;
    case 'Waiting for Evidence': return 'Use “Move to Waiting for Evidence” so the blocker and next review date are recorded.';
    case 'Route Ready': return m.byCase('routes', c.id).some(r => r.state === 'Selected') ? null : 'Route Ready needs a selected, verified route.';
    case 'Introduction Pending': case 'Contact Attempted': return m.byCase('attempts', c.id).length ? null : 'Record a contact attempt first.';
    case 'Contact Confirmed': return m.byCase('attempts', c.id).some(a => CONFIRMING_RESULTS.includes(a.result)) ? null : 'Contact Confirmed needs a contact attempt where the correct artist or representative was reached.';
    case 'Claim Invited': return ev('claimEvents', 'Invited') ? null : 'Use “Send claim invitation”.';
    case 'Claim Submitted': return ev('claimEvents', 'Submitted') ? null : 'Use “Record claim submission”.';
    case 'Claim Review': return ev('claimEvents', 'Sent to Review') ? null : 'Use “Send to review”.';
    case 'Claimed': return ev('claimEvents', 'Backend Verified') ? null : 'Claim Completed needs backend verification.';
    case 'Activation Pending': return c.claimStatus === 'Completed' ? null : 'Activation starts after a backend-verified claim.';
    case 'Activated': return ev('activationEvents', 'Access Verified') && ev('activationEvents', 'Meaningful Use') ? null : 'Activated needs verified access plus a meaningful feature action with evidence. Login alone is not activation.';
    case 'Ongoing ARM': return c.arm ? null : 'Use “Handover to ARM”.';
    default: return null;
  }
}

function ensureOwner(m: Model, ctx: Ctx, c: ArtistCase) {
  if (!c.ownerId) setField(m, ctx, c, 'ownerId', ctx.userId, 'Owner set to the person who started work');
}

export const commands: Record<string, Command> = {
  // -------------------------------------------------------------------------- cases
  createCase(m, ctx, p) {
    const name = req(p.name, 'Artist name');
    const backendId = clean(p.backendId) || null;
    if (backendId && m.idx.caseByBackendId.has(backendId)) throw rule(`Artist ID ${backendId} already belongs to case ${m.idx.caseByBackendId.get(backendId)}.`);
    const same = m.casesNamed(name), similar = m.casesSimilar(name).filter(x => !same.includes(x));
    const c = newCaseRecord(m, ctx, { name, backendId, language: clean(p.language) || null });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Case created', to: name, reason: clean(p.reason) || 'Created by hand' });
    if (p.ownerId) setField(m, ctx, c, 'ownerId', p.ownerId, 'Owner set at creation');
    const clash = same.length ? same : similar;
    if (clash.length) {
      const conflict = m.insert('conflicts', { id: m.nextId('IC', 4), caseIds: [c.id, ...clash.map(x => x.id)], kind: same.length ? 'Same name' : 'Similar spelling', reason: `New case “${name}” looks like ${clash.map(x => `${x.canonicalName} (${x.id})`).join(', ')}`, status: 'Open', createdAt: ctx.now, createdBy: ctx.userId, decisionId: null });
      setStage(m, ctx, c, 'Identity Review', `Possible duplicate of ${clash.map(x => x.id).join(', ')} (${conflict.id})`);
      m.update('cases', c.id, { identityStatus: 'Under Review' });
      notify(m, ctx, 'Identity conflict', `${name}: possible duplicate of ${clash.map(x => x.canonicalName).join(', ')}. Review before contact.`, c.id);
    }
    computePriority(m, c, ctx.today);
    syncNextAction(m, c.id);
    return { message: clash.length ? `Created ${c.id}. Potential identity conflict requires review.` : `Created case ${c.id}.`, caseId: c.id };
  },

  assignOwner(m, ctx, p) {
    requirePerm(m, ctx, 'reassign');
    const c = getCase(m, p.caseId);
    const owner = req(p.ownerId, 'Owner');
    if (!m.get('users', owner)) throw rule('Unknown user.');
    const prev = c.ownerId;
    setField(m, ctx, c, 'ownerId', owner, clean(p.reason) || 'Reassigned');
    for (const t of openTasks(m, c.id)) if (t.ownerId === prev || !t.ownerId) {
      m.update('tasks', t.id, { ownerId: owner });
      audit(m, ctx, { caseId: c.id, entity: 'Task', entityId: t.id, action: 'Task reassigned with the case', field: 'ownerId', from: userName(m, prev), to: userName(m, owner) });
    }
    for (const r of m.byCase('routes', c.id)) if (r.ownerId === prev) m.update('routes', r.id, { ownerId: owner });
    return { message: `${c.canonicalName} now owned by ${userName(m, owner)}. History, tasks and routes moved with the case.`, caseId: c.id };
  },

  changeStage(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const target = oneOf(p.stage, LIFECYCLE_STAGES, 'lifecycle stage');
    const reason = req(p.reason, 'A reason');
    if (target === 'Closed') return commands.closeCase(m, ctx, { caseId: c.id, reason });
    const gate = stageGate(m, c, target);
    if (gate) throw rule(`Cannot move ${c.canonicalName} to ${target}: ${gate}`);
    if (c.lifecycleStage === 'Identity Review' && m.all('conflicts').some(x => x.status !== 'Decided' && x.caseIds.includes(c.id))) throw rule('Resolve the open identity review first.');
    setStage(m, ctx, c, target, reason);
    computePriority(m, c, ctx.today);
    syncNextAction(m, c.id);
    return { message: `${c.canonicalName} moved to ${target}.`, caseId: c.id };
  },

  setContactPreference(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const pref = oneOf<ContactPreference>(p.preference, CONTACT_PREFERENCES, 'contact preference');
    const reason = req(p.reason, 'A reason');
    const until = pref === 'Later' ? req(p.until, 'A date (required for “Later”)') : null;
    if (until && until <= ctx.today) throw rule('“Later” needs a future date.');
    m.update('cases', c.id, { contactPreference: pref, contactPreferenceUntil: until, updatedAt: ctx.now });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Contact preference changed', field: 'contactPreference', from: c.contactPreference, to: pref + (until ? ` until ${until}` : ''), reason });
    if (pref === 'Do Not Contact' || pref === 'Declined') {
      closeTasks(m, ctx, c.id, OUTREACH_KINDS, `Cancelled: contact preference ${pref}`, 'Cancelled');
      if (stageIndex(c.lifecycleStage) < stageIndex('Claim Invited') && c.lifecycleStage !== 'Closed') {
        m.update('cases', c.id, { closedReason: pref === 'Declined' ? `Declined: ${reason}` : `Do not contact: ${reason}` });
        setStage(m, ctx, c, 'Closed', pref === 'Declined' ? `Artist declined: ${reason}` : `Asked not to be contacted: ${reason}`);
      }
    }
    if (pref === 'Later') for (const t of openTasks(m, c.id)) if (OUTREACH_KINDS.includes(t.kind)) m.update('tasks', t.id, { dueDate: until!, status: 'Waiting' });
    // The Goongoonalo status mirrors a do-not-contact request (and is released when the preference is lifted).
    const fresh = m.get('cases', c.id)!;
    if (pref === 'Do Not Contact') setGoongoonaloStatus(m, ctx, fresh, 'DO_NOT_CONTACT', reason, { fromContactPreference: true });
    else if (fresh.goongoonaloStatus === 'DO_NOT_CONTACT') setGoongoonaloStatus(m, ctx, fresh, 'PENDING', reason, { fromContactPreference: true });
    syncNextAction(m, c.id);
    return { message: `Contact preference set to ${pref}${until ? ` until ${until}` : ''}.${pref === 'Do Not Contact' ? ' Future imports will enrich the dossier but never create outreach.' : ''}`, caseId: c.id };
  },

  closeCase(m, ctx, p) {
    requirePerm(m, ctx, 'closeCase');
    const c = getCase(m, p.caseId);
    const reason = req(p.reason, 'A closure reason');
    if (c.lifecycleStage === 'Closed') throw rule('Already closed.');
    closeTasks(m, ctx, c.id, 'all', `Cancelled: case closed (${reason})`, 'Cancelled');
    m.update('cases', c.id, { closedReason: reason });
    setStage(m, ctx, c, 'Closed', reason);
    syncNextAction(m, c.id);
    return { message: `${c.canonicalName} closed. History is kept.`, caseId: c.id };
  },

  reopenCase(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const reason = req(p.reason, 'A reason');
    if (c.lifecycleStage !== 'Closed') throw rule('Only closed cases can be reopened.');
    if (c.mergedIntoId) throw rule('Merged cases are reopened by reversing the identity decision.');
    if (c.contactPreference === 'Do Not Contact') throw rule('This artist asked not to be contacted. Change the contact preference first (with their consent).');
    const back: LifecycleStage = c.previousStage && c.previousStage !== 'Closed' && stageIndex(c.previousStage) <= stageIndex('Contact Attempted') ? 'Researching' : (c.previousStage ?? 'Researching');
    m.update('cases', c.id, { closedReason: null, contactPreference: c.contactPreference === 'Declined' ? 'Allowed' : c.contactPreference });
    setStage(m, ctx, c, back, `Reopened: ${reason}`);
    ensureOwner(m, ctx, c);
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Research', step: 'Review the reopened case and choose the next step', why: `Reopened: ${reason}`, trigger: 'Case reopened' });
    return { message: `${c.canonicalName} reopened at ${back}.`, caseId: c.id };
  },

  // -------------------------------------------------------------------------- research
  startResearch(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.lifecycleStage === 'Identity Review') throw rule('Potential identity conflict requires review first.');
    if (!['Unresearched', 'Waiting for Evidence', 'Researching'].includes(c.lifecycleStage)) throw rule(`Research starts from Unresearched or Waiting for Evidence (now ${c.lifecycleStage}).`);
    ensureOwner(m, ctx, c);
    closeTasks(m, ctx, c.id, ['Research'], 'Research started');
    if (c.lifecycleStage !== 'Researching') setStage(m, ctx, c, 'Researching', c.lifecycleStage === 'Waiting for Evidence' ? 'Re-check of a waiting case' : 'Research started');
    const cl = c.checklist.map(x => (x.step === 1 && x.status === 'Not Started' ? { ...x, status: 'In Progress' as ChecklistStatus, updatedAt: ctx.now, updatedBy: ctx.userId } : x));
    m.update('cases', c.id, { checklist: cl });
    const t = openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Research', step: 'Work the research checklist', why: 'Find a verified route to the artist', trigger: 'Research started', status: 'In Progress' });
    m.update('tasks', t.id, { startedAt: ctx.now });
    computePriority(m, c, ctx.today);
    return { message: `Research started on ${c.canonicalName}.`, caseId: c.id, id: t.id };
  },

  updateChecklist(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const step = Number(p.step);
    if (!(step >= 1 && step <= CHECKLIST_STEPS.length)) throw rule('Unknown checklist step.');
    const status = oneOf<ChecklistStatus>(p.status, ['Not Started', 'In Progress', 'Complete', 'Blocked'], 'status');
    if (status === 'Blocked' && !clean(p.note)) throw rule('Say what blocks this step.');
    const prev = c.checklist[step - 1];
    const cl = c.checklist.map(x => (x.step === step ? { ...x, status, note: clean(p.note) || x.note, updatedAt: ctx.now, updatedBy: ctx.userId } : x));
    m.update('cases', c.id, { checklist: cl, updatedAt: ctx.now });
    audit(m, ctx, { caseId: c.id, entity: 'Checklist', entityId: `${c.id}:${step}`, action: `Checklist step ${step} updated`, field: CHECKLIST_STEPS[step - 1].title, from: prev.status, to: status, reason: clean(p.note) || null });
    if (c.lifecycleStage === 'Unresearched') commands.startResearch(m, ctx, { caseId: c.id });
    return { message: `Step ${step} (${CHECKLIST_STEPS[step - 1].title}): ${status}.`, caseId: c.id };
  },

  addResearch(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const source = req(p.source, 'Source');
    const result = req(p.result, 'Result');
    const minutes = Math.max(0, Math.min(480, Number(p.minutes) || 0));
    const step = p.checklistStep ? Number(p.checklistStep) : null;
    if (c.lifecycleStage === 'Unresearched') commands.startResearch(m, ctx, { caseId: c.id });
    const r = m.insert('research', {
      id: m.nextId('RS', 4), caseId: c.id, source, query: clean(p.query), url: clean(p.url), result, evidence: clean(p.evidence),
      confidence: Math.max(0, Math.min(100, Number(p.confidence) || 0)), researcherId: ctx.userId, date: ctx.now, minutes, checklistStep: step,
    });
    audit(m, ctx, { caseId: c.id, entity: 'Research', entityId: r.id, action: 'Research recorded', to: `${source}: ${result}`, evidence: [r.url, r.evidence].filter(Boolean).join(' · ') || null, result: `${minutes} min` });
    const cur = m.get('cases', c.id)!;
    if (step && cur.checklist[step - 1]?.status === 'Not Started') m.update('cases', c.id, { checklist: cur.checklist.map(x => (x.step === step ? { ...x, status: 'In Progress', updatedAt: ctx.now, updatedBy: ctx.userId } : x)) });
    const t = openTasks(m, c.id).find(x => x.kind === 'Research');
    if (t) m.update('tasks', t.id, { focusedMinutes: t.focusedMinutes + minutes });
    return { message: 'Research recorded.', caseId: c.id, id: r.id };
  },

  moveToWaiting(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (!['Researching', 'Route Ready', 'Contact Attempted', 'Introduction Pending', 'Unresearched'].includes(c.lifecycleStage)) throw rule(`Waiting is for cases still looking for a route (now ${c.lifecycleStage}).`);
    const blocker = req(p.blocker, 'The blocker');
    const nextReviewDate = req(p.nextReviewDate, 'Next review date');
    const waiting = waitingDefaults(m, c, ctx, blocker, clean(p.futureTrigger) || 'New song, credit or verified collaborator contact', nextReviewDate);
    closeTasks(m, ctx, c.id, ['Research', 'Outreach', 'Follow-up', 'Introduction'], `Moved to Waiting for Evidence: ${blocker}`);
    for (const r of m.byCase('routes', c.id)) if (r.state === 'Selected') m.update('routes', r.id, { state: 'Verified' });
    m.update('cases', c.id, { waiting });
    setStage(m, ctx, c, 'Waiting for Evidence', blocker);
    if (c.workReason === 'New Lead') setField(m, ctx, m.get('cases', c.id)!, 'workReason', 'New Artist', 'Lead used up; waiting for new evidence');
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Research', step: 'Re-check for new evidence', why: `Waiting: ${blocker}`, trigger: 'Review date or new evidence', dueDate: nextReviewDate, status: 'Waiting', priority: 'Low' });
    computePriority(m, c, ctx.today);
    return { message: 'No verified route found. Case moved to Waiting for Evidence. It reopens automatically when new evidence arrives.', caseId: c.id };
  },

  // -------------------------------------------------------------------------- routes + contacts
  addRoute(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const contact = p.contactId ? m.get('contacts', p.contactId) : null;
    const state = p.state === 'Verified' ? 'Verified' : 'Candidate';
    const evidence = req(p.evidence, 'Evidence for the route');
    if (state === 'Verified' && !(contact?.verified || clean(p.sourceUrl))) throw rule('A verified route needs a verified contact or a source URL.');
    if (contact && m.byCase('routes', c.id).some(r => r.contactId === contact.id)) throw rule(`A route through ${contact.personName} already exists for this case.`);
    const track = p.trackId ? m.get('tracks', p.trackId) : null;
    const r = m.insert('routes', {
      id: m.nextId('RT', 4), targetCaseId: c.id, trackId: track?.id ?? null, collaboratorName: clean(p.collaboratorName) || (contact && !contact.organisation && contact.caseId !== c.id ? contact.personName : null),
      collaboratorCaseId: p.collaboratorCaseId ?? (contact && contact.caseId !== c.id ? contact.caseId : null), organisation: clean(p.organisation) || contact?.organisation || null,
      contactId: contact?.id ?? null, sourceUrl: clean(p.sourceUrl) || null, evidence, confidence: Math.max(0, Math.min(100, Number(p.confidence) || 50)), state,
      ranking: contact?.willingIntroducer ? 1 : contact ? 2 : 4, lastChecked: ctx.now, rejectionReason: null, ownerId: c.ownerId ?? ctx.userId, origin: clean(p.origin) || 'Manual', path: null, pathId: null, createdAt: ctx.now,
    });
    audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: r.id, action: 'Route added', to: `${routeLabel(m, r.id)} (${state})`, evidence });
    syncRouteGraph(m, ctx, r.id);
    computePriority(m, c, ctx.today);
    return { message: `Route ${r.id} added as ${state}.`, caseId: c.id, id: r.id };
  },

  updateRoute(m, ctx, p) {
    const r = getRoute(m, p.routeId);
    const c = getCase(m, r.targetCaseId);
    const target = oneOf(p.state, ['Candidate', 'Verified', 'Selected', 'Rejected', 'Exhausted'] as const, 'route state');
    const reason = clean(p.reason);
    if ((target === 'Rejected' || target === 'Exhausted') && !reason) throw rule('Give the reason (it is kept so failed work is not repeated).');
    if (target === 'Verified' && !(r.contactId && m.get('contacts', r.contactId)?.verified) && !reason) throw rule('Say how the route was verified.');
    if (target === 'Selected') {
      if (r.state !== 'Verified' && r.state !== 'Selected') throw rule('Only a verified route can be selected.');
      const blocked = outreachBlocked(c, ctx.today);
      if (blocked) throw rule(blocked);
      selectRoute(m, ctx, c, r, reason || 'Route selected');
      if (['Unresearched', 'Researching', 'Waiting for Evidence'].includes(c.lifecycleStage)) {
        closeTasks(m, ctx, c.id, ['Research'], `Route ${r.id} selected`);
        setStage(m, ctx, c, 'Route Ready', `Route selected: ${routeLabel(m, r.id)}`);
      }
      ensureOwner(m, ctx, m.get('cases', c.id)!);
      outreachTaskFor(m, ctx, m.get('cases', c.id)!, r, `Route ${r.id} selected: ${r.evidence}`);
      syncRouteGraph(m, ctx, r.id);
      computePriority(m, c, ctx.today);
      return { message: `Route ${r.id} selected. Outreach task created.`, caseId: c.id };
    }
    m.update('routes', r.id, { state: target, rejectionReason: target === 'Rejected' || target === 'Exhausted' ? reason : r.rejectionReason, lastChecked: ctx.now });
    audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: r.id, action: `Route ${target.toLowerCase()}`, field: 'state', from: r.state, to: target, reason: reason || null });
    syncRouteGraph(m, ctx, r.id);
    if ((target === 'Rejected' || target === 'Exhausted') && r.state === 'Selected' && ['Route Ready', 'Contact Attempted', 'Introduction Pending'].includes(c.lifecycleStage)) {
      closeTasks(m, ctx, c.id, OUTREACH_KINDS, `Route ${r.id} ${target.toLowerCase()}: ${reason}`, 'Cancelled');
      const others = m.byCase('routes', c.id).filter(x => x.state === 'Verified');
      setStage(m, ctx, c, 'Researching', `Selected route ${target.toLowerCase()}: ${reason}`);
      openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Research', step: others.length ? 'Select another verified route' : 'Research a new route', why: `Route ${r.id} ${target.toLowerCase()}`, trigger: 'Route failed' });
    }
    computePriority(m, c, ctx.today);
    return { message: `Route ${r.id} marked ${target}.`, caseId: c.id };
  },

  addContact(m, ctx, p) {
    const personName = req(p.personName, 'Person or organisation name');
    const channel = oneOf<Channel>(p.channel, CHANNELS, 'channel');
    const value = req(p.value, 'Address, number or handle');
    const role = oneOf(p.role, ['Artist', 'Collaborator', 'Manager', 'Representative', 'Label', 'Distributor'] as const, 'role');
    const caseId = p.caseId || (role === 'Label' || role === 'Distributor' ? null : m.casesNamed(personName)[0]?.id ?? null);
    const k = m.insert('contacts', {
      id: m.nextId('CT', 4), personName, caseId, organisation: role === 'Label' || role === 'Distributor' ? personName : clean(p.organisation) || null, role, channel, value,
      authorityEvidence: clean(p.authorityEvidence), verified: false, verifiedById: null, verifiedAt: null, willingIntroducer: !!p.willingIntroducer, source: clean(p.source) || 'Manual', createdAt: ctx.now,
    });
    audit(m, ctx, { caseId, entity: 'Contact', entityId: k.id, action: 'Contact added', to: `${personName} (${role}, ${channel})`, evidence: k.authorityEvidence || null });
    syncContactGraph(m, ctx, k.id);
    if (p.verified) return { ...commands.verifyContact(m, ctx, { contactId: k.id, evidence: p.verificationEvidence || k.authorityEvidence || 'Verified when added' }), id: k.id };
    return { message: `Contact ${k.id} added (unverified).`, id: k.id, caseId: caseId ?? undefined };
  },

  verifyContact(m, ctx, p) {
    const k = m.get('contacts', p.contactId);
    if (!k) throw rule('Contact not found.');
    if (k.verified) throw rule('Contact is already verified.');
    const evidence = req(p.evidence, 'How the contact identity was corroborated');
    m.update('contacts', k.id, { verified: true, verifiedById: ctx.userId, verifiedAt: ctx.now });
    syncContactGraph(m, ctx, k.id);
    audit(m, ctx, { caseId: k.caseId, entity: 'Contact', entityId: k.id, action: 'Contact verified', field: 'verified', from: 'false', to: 'true', evidence });
    const out = applyLeads(m, ctx, leadsForContact(m, m.get('contacts', k.id) as Contact), { label: `Contact ${k.id} (${k.personName}) verified`, contactId: k.id });
    const msg = `${k.personName} verified.` + (out.reopenedCaseIds.length ? ` ${out.reopenedCaseIds.length} waiting case(s) reopened with a new lead.` : '') + (out.routeIds.length ? ` ${out.routeIds.length} new route(s).` : '');
    return { message: msg, id: k.id, data: out };
  },

  // -------------------------------------------------------------------------- songs + credits found outside an import
  addSong(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const title = req(p.title, 'Song title');
    const role = oneOf(p.role || 'Singer', ['Singer', 'Performer', 'Composer', 'Lyricist', 'Producer', 'Other'] as const, 'role');
    const backendTrackId = clean(p.backendTrackId) || m.nextId('MAN-', 4);
    if (m.idx.trackByBackendId.has(backendTrackId)) throw rule(`Track ${backendTrackId} already exists (“${m.get('tracks', m.idx.trackByBackendId.get(backendTrackId)!)!.title}”). Add a credit to it instead.`);
    const isrc = normIsrc(p.isrc);
    const flags = [...(isrc && !ISRC_RE.test(isrc) ? ['ISRC format invalid'] : []), ...(!isrc ? ['ISRC missing'] : []), 'Added by hand'];
    const t = m.insert('tracks', {
      id: m.nextId('TR', 6), backendTrackId, releaseId: null, title, version: clean(p.version), isrc, label: clean(p.label), distributor: clean(p.distributor), language: clean(p.language) || c.language || '',
      releaseDate: clean(p.releaseDate), source: 'Manual', flags, sig: '', firstSeen: ctx.now, lastSeen: ctx.now, firstBatchId: 'Manual', lastBatchId: 'Manual', history: [],
    });
    m.insert('credits', { id: m.nextId('CR', 6), trackId: t.id, caseId: c.id, personName: c.canonicalName, personBackendId: c.backendProfileIds[0] ?? null, role, isPrimary: true, source: 'Manual', sourceVersion: 'Manual', firstSeen: ctx.now, lastSeen: ctx.now, status: 'Active', statusReason: null });
    audit(m, ctx, { caseId: c.id, entity: 'Track', entityId: t.id, action: 'Song linked by hand', to: `“${title}” (${backendTrackId}) as ${role}`, reason: clean(p.source) || null, evidence: clean(p.source) || null });
    evidenceChanged(m, ctx, c, `Song “${title}” linked by hand`);
    syncTrackGraph(m, ctx, t.id);
    const out = applyLeads(m, ctx, leadsForTracks(m, [t.id]), { label: `Song “${title}” added`, newTracks: new Set([t.id]) });
    computePriority(m, m.get('cases', c.id)!, ctx.today);
    return { message: `“${title}” linked to ${c.canonicalName}.${out.routeIds.length ? ` ${out.routeIds.length} new route(s).` : ''}`, caseId: c.id, id: t.id, data: out };
  },
  addCredit(m, ctx, p) {
    const t = m.get('tracks', p.trackId);
    if (!t) throw rule('Song not found.');
    const role = oneOf(p.role, ['Singer', 'Performer', 'Composer', 'Lyricist', 'Producer', 'Other'] as const, 'role');
    const person = p.personCaseId ? getCase(m, p.personCaseId) : null;
    const name = person?.canonicalName ?? req(p.personName, 'Person');
    const caseId = person?.id ?? null;
    if (m.creditsOfTrack(t.id).some(cr => cr.status === 'Active' && cr.role === role && (caseId ? cr.caseId && m.canonical(cr.caseId) === caseId : !cr.caseId && nameKey(cr.personName) === nameKey(name)))) throw rule(`${name} is already credited as ${role} on “${t.title}”.`);
    const cr = m.insert('credits', { id: m.nextId('CR', 6), trackId: t.id, caseId, personName: name, personBackendId: person?.backendProfileIds[0] ?? null, role, isPrimary: false, source: 'Manual', sourceVersion: 'Manual', firstSeen: ctx.now, lastSeen: ctx.now, status: 'Active', statusReason: null });
    syncTrackGraph(m, ctx, t.id);
    const owners = [...new Set(m.creditsOfTrack(t.id).filter(x => x.caseId).map(x => m.canonical(x.caseId!)))];
    for (const id of owners) audit(m, ctx, { caseId: id, entity: 'Credit', entityId: cr.id, action: 'Credit added by hand', to: `${name} → ${role} on “${t.title}”`, evidence: clean(p.source) || null });
    for (const id of owners) evidenceChanged(m, ctx, m.get('cases', id)!, `${name} credited as ${role} on “${t.title}”`);
    const out = applyLeads(m, ctx, leadsForTracks(m, [t.id]), { label: `Credit for ${name} added` });
    return { message: `${name} credited as ${role} on “${t.title}”.${out.reopenedCaseIds.length ? ` ${out.reopenedCaseIds.length} waiting case(s) reopened.` : ''}${out.routeIds.length ? ` ${out.routeIds.length} new route(s).` : ''}`, caseId: owners[0], id: cr.id, data: out };
  },

  // -------------------------------------------------------------------------- outreach
  recordContactAttempt(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const result = oneOf<AttemptResult>(p.result, ['No Response', 'Wrong Person', 'Bounce', 'Introduction Requested', 'Interested', 'Needs Help', 'Later', 'Declined', 'Do Not Contact', 'Conversation Confirmed'], 'result');
    const channel = oneOf<Channel>(p.channel, CHANNELS, 'channel');
    const recipient = req(p.recipient, 'Recipient');
    const nextAction = req(p.nextAction, 'Next action');
    const blocked = outreachBlocked(c, ctx.today);
    if (blocked && !['Do Not Contact', 'Declined'].includes(result)) throw rule(blocked);
    if (!['Researching', 'Route Ready', 'Introduction Pending', 'Contact Attempted', 'Contact Confirmed'].includes(c.lifecycleStage)) throw rule(`Contact attempts are recorded from Route Ready onwards (now ${c.lifecycleStage}).`);
    let route = p.routeId ? getRoute(m, p.routeId) : null;
    if (route) {
      if (route.targetCaseId !== c.id) throw rule('That route belongs to another case.');
      if (route.state === 'Candidate') throw rule('Verify the route before using it.');
      if (route.state === 'Rejected' || route.state === 'Exhausted') throw rule(`Route ${route.id} is ${route.state.toLowerCase()}. Pick another route.`);
      if (route.state === 'Verified') { selectRoute(m, ctx, c, route, 'Used for contact'); route = m.get('routes', route.id)!; }
    } else if (c.lifecycleStage === 'Researching') throw rule('Pick the route you used (select or add a verified route first).');
    if (result === 'Later' && !clean(p.laterDate)) throw rule('“Later” needs the agreed date.');
    const a = m.insert('attempts', {
      id: m.nextId('CA', 4), caseId: c.id, routeId: route?.id ?? null, date: ctx.now, channel, recipient, message: clean(p.message), result,
      evidence: clean(p.evidence), nextAction, nextActionDate: clean(p.nextActionDate) || null, ownerId: ctx.userId,
    });
    audit(m, ctx, { caseId: c.id, entity: 'ContactAttempt', entityId: a.id, action: 'Contact attempt recorded', to: `${channel} → ${recipient}`, reason: route ? `Route ${route.id}` : null, evidence: a.evidence || null, result, next: nextAction });
    if (route) m.update('routes', route.id, { lastChecked: ctx.now });
    ensureOwner(m, ctx, c);
    closeTasks(m, ctx, c.id, [...OUTREACH_KINDS, 'Research'], `Contact attempt ${a.id}: ${result}`);
    const cc = () => m.get('cases', c.id)!;
    const isIntro = channel === 'Introducer' || !!route?.collaboratorName || !!route?.organisation;
    let message = `Contact attempt ${a.id} recorded: ${result}.`;
    if (CONFIRMING_RESULTS.includes(result)) {
      if (c.contactPreference !== 'Allowed') m.update('cases', c.id, { contactPreference: 'Allowed', contactPreferenceUntil: null });
      if (c.workReason === 'New Lead' || c.workReason === 'New Artist') setField(m, ctx, cc(), 'workReason', 'Follow-up', 'Artist reached: the work now follows up the claim');
      setStage(m, ctx, cc(), 'Contact Confirmed', `${recipient} reached: ${result}${a.evidence ? ` (${a.evidence})` : ''}`, a.evidence);
      openTask(m, ctx, cc(), { kind: 'Claim', step: result === 'Needs Help' ? 'Help call, then send the claim invitation' : 'Send the claim invitation', why: `Conversation confirmed with ${recipient}`, trigger: `Contact attempt ${a.id}`, dueDate: clean(p.nextActionDate) || ctx.today, priority: 'High' });
      notify(m, ctx, 'New reply', `${c.canonicalName}: ${result.toLowerCase()} (${recipient}).`, c.id);
      message = `${c.canonicalName}: Contact Confirmed. Next: send the claim invitation.`;
    } else if (result === 'Introduction Requested') {
      setStage(m, ctx, cc(), 'Introduction Pending', `${recipient} agreed to introduce the artist`);
      openTask(m, ctx, cc(), { kind: 'Introduction', step: `Wait for ${recipient} to make the introduction`, why: 'Introducer contacted is not artist contacted', trigger: `Contact attempt ${a.id}`, dueDate: clean(p.nextActionDate) || addWorkingDays(ctx.today, 3), status: 'Waiting' });
    } else if (result === 'No Response') {
      if (stageIndex(c.lifecycleStage) < stageIndex('Contact Attempted') && c.lifecycleStage !== 'Introduction Pending') setStage(m, ctx, cc(), 'Contact Attempted', isIntro ? `Introduction requested from ${recipient}; no reply yet` : 'Message sent; no reply yet');
      const n = m.byCase('attempts', c.id).filter(x => x.routeId === (route?.id ?? null) && x.result === 'No Response').length;
      if (n >= 3) {
        openTask(m, ctx, cc(), { kind: 'Follow-up', step: 'Supervisor review: no reply after two follow-ups', why: `${n} attempts without a reply via ${route ? route.id : channel}`, trigger: `Contact attempt ${a.id}`, ownerId: supervisor(m) ?? c.ownerId, dueDate: ctx.today });
        message += ' No reply after two follow-ups: supervisor review created. Try another route or move to Waiting.';
      } else {
        openTask(m, ctx, cc(), { kind: 'Follow-up', step: `Follow-up #${n} via ${channel}`, why: `No reply to attempt ${a.id}`, trigger: `Contact attempt ${a.id}`, dueDate: clean(p.nextActionDate) || addWorkingDays(ctx.today, n === 1 ? 3 : 4), channel, recipient });
      }
    } else if (result === 'Wrong Person' || result === 'Bounce') {
      if (route) {
        m.update('routes', route.id, { state: 'Rejected', rejectionReason: `${result}${a.evidence ? `: ${a.evidence}` : ''}`, lastChecked: ctx.now });
        audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: route.id, action: 'Route rejected', field: 'state', from: 'Selected', to: 'Rejected', reason: result, evidence: a.evidence || null });
        syncRouteGraph(m, ctx, route.id);
      }
      const others = m.byCase('routes', c.id).filter(x => x.state === 'Verified');
      setStage(m, ctx, cc(), 'Researching', `${result} via ${route ? route.id : channel}`);
      openTask(m, ctx, cc(), { kind: 'Research', step: others.length ? 'Select another verified route' : 'Research a new route', why: `${result} on ${route ? route.id : channel}`, trigger: `Contact attempt ${a.id}` });
      message += others.length ? ' Route rejected. Another verified route is available.' : ' Route rejected. Research a new route.';
    } else if (result === 'Later') {
      const until = clean(p.laterDate);
      m.update('cases', c.id, { contactPreference: 'Later', contactPreferenceUntil: until });
      audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Contact preference changed', field: 'contactPreference', from: c.contactPreference, to: `Later until ${until}`, reason: `Asked by ${recipient}` });
      setStage(m, ctx, cc(), 'Contact Confirmed', `${recipient} asked to talk again on ${until}`);
      openTask(m, ctx, cc(), { kind: 'Follow-up', step: 'Agreed callback', why: `Asked to be contacted on ${until}`, trigger: `Contact attempt ${a.id}`, dueDate: until, status: 'Waiting' });
    } else if (result === 'Declined' || result === 'Do Not Contact') {
      commands.setContactPreference(m, ctx, { caseId: c.id, preference: result === 'Declined' ? 'Declined' : 'Do Not Contact', reason: `${recipient}: ${a.evidence || result}` });
      message = result === 'Do Not Contact' ? 'Recorded. Do-not-contact will survive every future import.' : 'Recorded as declined. Case closed with history kept.';
    }
    computePriority(m, cc(), ctx.today);
    syncNextAction(m, c.id);
    return { message, caseId: c.id, id: a.id };
  },

  // -------------------------------------------------------------------------- tasks
  createTask(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const step = req(p.step, 'Task');
    if (c.lifecycleStage === 'Closed') throw rule('Reopen the case before creating tasks.');
    const kind = (p.kind as TaskKind) || 'Manual';
    const t = openTask(m, ctx, c, {
      kind, step, why: clean(p.why) || 'Created by hand', trigger: 'Manual', dueDate: clean(p.dueDate) || ctx.today, priority: (p.priority as Priority) || c.priority,
      ownerId: p.ownerId || c.ownerId || ctx.userId, workReason: (p.workReason as WorkReason) || c.workReason,
    }, { failOnDuplicate: true });
    return { message: `Task ${t.id} created.`, caseId: c.id, id: t.id };
  },
  startTask(m, ctx, p) {
    const t = getTask(m, p.taskId); openTaskOnly(t);
    m.update('tasks', t.id, { status: 'In Progress', startedAt: t.startedAt ?? ctx.now, ownerId: t.ownerId ?? ctx.userId });
    audit(m, ctx, { caseId: t.caseId, entity: 'Task', entityId: t.id, action: 'Task started', field: 'status', from: t.status, to: 'In Progress' });
    return { message: `Started ${t.id}.`, caseId: t.caseId };
  },
  completeTask(m, ctx, p) {
    const t = getTask(m, p.taskId); openTaskOnly(t);
    const outcome = req(p.outcome, 'Outcome');
    const next = req(p.nextAction, 'Next action');
    if (p.evidence) m.update('tasks', t.id, { evidence: [...t.evidence, clean(p.evidence)] });
    m.update('tasks', t.id, { focusedMinutes: t.focusedMinutes + (Number(p.minutes) || 0) });
    finishTask(m, ctx, t, 'Completed', outcome, next);
    const c = m.get('cases', t.caseId)!;
    let created: Task | null = null;
    if (clean(p.nextActionDate) && c.lifecycleStage !== 'Closed') created = openTask(m, ctx, c, { kind: 'Manual', step: next, why: `Follow-on from ${t.id}: ${outcome}`, trigger: `Task ${t.id} completed`, dueDate: clean(p.nextActionDate) });
    return { message: `Task ${t.id} completed.${created ? ` Next task ${created.id} due ${created.dueDate}.` : ''}`, caseId: t.caseId };
  },
  holdTask(m, ctx, p) {
    const t = getTask(m, p.taskId); openTaskOnly(t);
    const reason = req(p.reason, 'A reason');
    m.update('tasks', t.id, { status: 'Waiting', notes: [...t.notes, { at: ctx.now, by: ctx.userId, text: `On hold: ${reason}`, kind: 'change' }] });
    audit(m, ctx, { caseId: t.caseId, entity: 'Task', entityId: t.id, action: 'Task put on hold', field: 'status', from: t.status, to: 'Waiting', reason });
    return { message: `${t.id} on hold.`, caseId: t.caseId };
  },
  rescheduleTask(m, ctx, p) {
    const t = getTask(m, p.taskId); openTaskOnly(t);
    const due = req(p.dueDate, 'New due date');
    const reason = req(p.reason, 'A reason');
    m.update('tasks', t.id, { dueDate: due });
    audit(m, ctx, { caseId: t.caseId, entity: 'Task', entityId: t.id, action: 'Task rescheduled', field: 'dueDate', from: t.dueDate, to: due, reason });
    syncNextAction(m, t.caseId);
    return { message: `${t.id} moved to ${due}.`, caseId: t.caseId };
  },
  reassignTask(m, ctx, p) {
    const t = getTask(m, p.taskId); openTaskOnly(t);
    const owner = req(p.ownerId, 'Owner');
    m.update('tasks', t.id, { ownerId: owner });
    audit(m, ctx, { caseId: t.caseId, entity: 'Task', entityId: t.id, action: 'Task reassigned', field: 'ownerId', from: userName(m, t.ownerId), to: userName(m, owner), reason: clean(p.reason) || null });
    return { message: `${t.id} assigned to ${userName(m, owner)}.`, caseId: t.caseId };
  },
  addTaskNote(m, ctx, p) {
    const t = getTask(m, p.taskId);
    const text = req(p.text, 'Text');
    const kind = p.kind === 'evidence' ? 'evidence' : 'note';
    m.update('tasks', t.id, kind === 'evidence' ? { evidence: [...t.evidence, text], notes: [...t.notes, { at: ctx.now, by: ctx.userId, text, kind }] } : { notes: [...t.notes, { at: ctx.now, by: ctx.userId, text, kind }] });
    audit(m, ctx, { caseId: t.caseId, entity: 'Task', entityId: t.id, action: kind === 'evidence' ? 'Evidence added' : 'Note added', to: text });
    return { message: kind === 'evidence' ? 'Evidence added.' : 'Note added.', caseId: t.caseId };
  },
  createFollowUp(m, ctx, p) {
    const t = getTask(m, p.taskId);
    const c = getCase(m, t.caseId);
    const step = req(p.step, 'Follow-up');
    const f = openTask(m, ctx, c, { kind: 'Follow-up', step, why: `Follow-up of ${t.id}`, trigger: `Task ${t.id}`, dueDate: req(p.dueDate, 'Due date'), workReason: 'Follow-up', ownerId: t.ownerId }, { failOnDuplicate: true });
    return { message: `Follow-up ${f.id} created.`, caseId: c.id, id: f.id };
  },
  changeNextAction(m, ctx, p) {
    const t = getTask(m, p.taskId);
    const next = req(p.nextAction, 'Next action');
    m.update('tasks', t.id, { nextAction: next });
    audit(m, ctx, { caseId: t.caseId, entity: 'Task', entityId: t.id, action: 'Next action changed', field: 'nextAction', from: t.nextAction, to: next });
    return { message: 'Next action updated.', caseId: t.caseId };
  },
  cancelTask(m, ctx, p) {
    const t = getTask(m, p.taskId); openTaskOnly(t);
    finishTask(m, ctx, t, 'Cancelled', `Cancelled: ${req(p.reason, 'A cancellation reason')}`);
    return { message: `${t.id} cancelled.`, caseId: t.caseId };
  },

  // -------------------------------------------------------------------------- claims
  sendClaimInvitation(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.claimStatus === 'Completed') throw rule('Already claimed. Go to Activation instead.');
    if (c.lifecycleStage !== 'Contact Confirmed') throw rule('Send the claim invitation after the conversation is confirmed.');
    if (!['Not Invited', 'Rejected'].includes(c.claimStatus)) throw rule(`Claim is already ${c.claimStatus.toLowerCase()}.`);
    const blocked = outreachBlocked(c, ctx.today); if (blocked) throw rule(blocked);
    const profileId = req(p.profileId, 'Profile ID');
    const recipient = req(p.recipient, 'Recipient');
    const e = m.insert('claimEvents', { id: m.nextId('CE', 4), caseId: c.id, type: 'Invited', date: ctx.now, profileId, claimRequestId: null, recipient, reviewerId: null, notes: clean(p.notes), evidence: clean(p.evidence), actorId: ctx.userId, source: 'User' });
    m.update('cases', c.id, { claimStatus: 'Invited' });
    audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Claim invitation sent', field: 'claimStatus', from: c.claimStatus, to: 'Invited', reason: `Profile ${profileId} → ${recipient}` });
    closeTasks(m, ctx, c.id, ['Claim'], 'Claim invitation sent');
    setStage(m, ctx, c, 'Claim Invited', `Claim link for ${profileId} sent to ${recipient}. A sent link is not a submitted claim.`);
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Claim', step: 'Check that the claim was submitted', why: 'Invitation sent; submission not yet recorded', trigger: `Claim event ${e.id}`, dueDate: addWorkingDays(ctx.today, 3), status: 'Waiting' });
    return { message: 'Invitation recorded. It does not count as a submitted claim.', caseId: c.id };
  },
  recordClaimSubmission(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.claimStatus !== 'Invited') throw rule('Record a submission after the invitation was sent.');
    const reqId = req(p.claimRequestId, 'Claim request ID');
    const inv = m.familyItems('claimEvents', c.id).filter(e => e.type === 'Invited').pop();
    const e = m.insert('claimEvents', { id: m.nextId('CE', 4), caseId: c.id, type: 'Submitted', date: clean(p.submittedAt) || ctx.now, profileId: inv?.profileId ?? null, claimRequestId: reqId, recipient: clean(p.claimant) || inv?.recipient || null, reviewerId: null, notes: clean(p.notes), evidence: clean(p.evidence), actorId: ctx.userId, source: 'User' });
    m.update('cases', c.id, { claimStatus: 'Submitted' });
    audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Claim submission recorded', field: 'claimStatus', from: 'Invited', to: 'Submitted', reason: `Request ${reqId}` });
    closeTasks(m, ctx, c.id, ['Claim'], `Submitted as ${reqId}`);
    setStage(m, ctx, c, 'Claim Submitted', `Claim request ${reqId} submitted. Not approved yet.`);
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Claim', step: 'Send the claim to admin review', why: `Claim ${reqId} submitted`, trigger: `Claim event ${e.id}` });
    notify(m, ctx, 'Claim submitted', `${c.canonicalName}: claim ${reqId} submitted.`, c.id);
    return { message: `Submission ${reqId} recorded. Not approved yet.`, caseId: c.id };
  },
  sendClaimToReview(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.claimStatus !== 'Submitted') throw rule('Only a submitted claim can go to review.');
    const reviewer = req(p.reviewerId, 'Reviewer');
    if (!can(m, reviewer, 'reviewClaim')) throw rule('Pick a reviewer who can approve claims.');
    const sub = m.familyItems('claimEvents', c.id).filter(e => e.type === 'Submitted').pop();
    const e = m.insert('claimEvents', { id: m.nextId('CE', 4), caseId: c.id, type: 'Sent to Review', date: ctx.now, profileId: sub?.profileId ?? null, claimRequestId: sub?.claimRequestId ?? null, recipient: null, reviewerId: reviewer, notes: clean(p.notes), evidence: '', actorId: ctx.userId, source: 'User' });
    m.update('cases', c.id, { claimStatus: 'In Review' });
    audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Claim sent to review', field: 'claimStatus', from: 'Submitted', to: 'In Review', reason: `Reviewer ${userName(m, reviewer)}` });
    closeTasks(m, ctx, c.id, ['Claim'], 'Sent to review');
    setStage(m, ctx, c, 'Claim Review', `Waiting for ${userName(m, reviewer)} to check claimant authority`);
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Claim Review', step: `Review claim ${sub?.claimRequestId ?? ''}`.trim(), why: 'Check claimant authority and the exact profile', trigger: `Claim event ${e.id}`, ownerId: reviewer, priority: 'High' });
    return { message: `Sent to ${userName(m, reviewer)} for review.`, caseId: c.id };
  },
  reviewClaim(m, ctx, p) {
    requirePerm(m, ctx, 'reviewClaim');
    const c = getCase(m, p.caseId);
    if (c.claimStatus !== 'In Review') throw rule('The claim is not in review.');
    const decision = oneOf(p.decision, ['Approve', 'Reject', 'Request Clarification'] as const, 'decision');
    const notes = req(p.notes, 'What was checked');
    const sub = m.familyItems('claimEvents', c.id).filter(e => e.type === 'Submitted').pop();
    const type = decision === 'Approve' ? 'Approved' : decision === 'Reject' ? 'Rejected' : 'Clarification Requested';
    const e = m.insert('claimEvents', { id: m.nextId('CE', 4), caseId: c.id, type, date: ctx.now, profileId: sub?.profileId ?? null, claimRequestId: sub?.claimRequestId ?? null, recipient: null, reviewerId: ctx.userId, notes, evidence: clean(p.evidence), actorId: ctx.userId, source: 'User' });
    closeTasks(m, ctx, c.id, ['Claim Review'], `Review: ${type}`);
    if (decision === 'Approve') {
      m.update('cases', c.id, { claimStatus: 'Approved' });
      audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Claim approved', field: 'claimStatus', from: 'In Review', to: 'Approved', reason: notes, evidence: e.evidence || null, next: 'Backend verification' });
      setStage(m, ctx, c, 'Claim Review', 'Approved. Waiting for backend verification before it counts as completed.');
      openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Backend Check', step: 'Verify the claim in the backend/admin record', why: 'Approval is not completion until the backend confirms', trigger: `Claim event ${e.id}`, ownerId: ctx.userId, priority: 'High' });
      notify(m, ctx, 'Claim approved', `${c.canonicalName}: claim approved, backend verification pending.`, c.id);
      return { message: 'Claim approved. It completes only after backend verification.', caseId: c.id };
    }
    if (decision === 'Reject') {
      m.update('cases', c.id, { claimStatus: 'Rejected' });
      audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Claim rejected', field: 'claimStatus', from: 'In Review', to: 'Rejected', reason: notes });
      setStage(m, ctx, c, 'Contact Confirmed', `Claim rejected: ${notes}`);
      openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Claim', step: 'Claim rejected: resolve with the artist', why: notes, trigger: `Claim event ${e.id}` });
      return { message: 'Claim rejected. Case back at Contact Confirmed.', caseId: c.id };
    }
    audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Claim clarification requested', reason: notes });
    openTask(m, ctx, c, { kind: 'Claim', step: `Get clarification: ${notes}`, why: 'Reviewer needs more evidence', trigger: `Claim event ${e.id}` });
    return { message: 'Clarification requested. Claim stays in review.', caseId: c.id };
  },
  verifyBackendClaim(m, ctx, p) {
    requirePerm(m, ctx, 'verifyBackendClaim');
    const c = getCase(m, p.caseId);
    if (c.claimStatus === 'Completed') throw rule('Already verified.');
    if (c.claimStatus !== 'Approved') throw rule('Cannot mark Claim Completed: the claim must be approved first, then verified in the backend.');
    const outcome = oneOf(p.outcome, ['Verified', 'Access unavailable'] as const, 'outcome');
    const ref = req(p.backendRef, 'Backend reference');
    const sub = m.familyItems('claimEvents', c.id).filter(e => e.type === 'Submitted').pop();
    if (outcome === 'Access unavailable') {
      const e = m.insert('claimEvents', { id: m.nextId('CE', 4), caseId: c.id, type: 'Backend Mismatch', date: ctx.now, profileId: sub?.profileId ?? null, claimRequestId: sub?.claimRequestId ?? null, recipient: null, reviewerId: ctx.userId, notes: clean(p.notes), evidence: ref, actorId: ctx.userId, source: 'User' });
      audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Backend mismatch', reason: 'Claim approved but backend access is unavailable', evidence: ref });
      openTask(m, ctx, c, { kind: 'Backend Check', step: 'Resolve backend mismatch with support', why: 'Claim approved but backend access is unavailable', trigger: `Claim event ${e.id}`, workReason: 'Technical Issue', priority: 'High' });
      setField(m, ctx, m.get('cases', c.id)!, 'workReason', 'Technical Issue', 'Claim approved but backend access is unavailable');
      return { message: 'Claim approved but backend access is unavailable. Support task created.', caseId: c.id };
    }
    const owner = clean(p.verifiedOwner) || sub?.recipient || c.canonicalName;
    const e = m.insert('claimEvents', { id: m.nextId('CE', 4), caseId: c.id, type: 'Backend Verified', date: ctx.now, profileId: sub?.profileId ?? null, claimRequestId: sub?.claimRequestId ?? null, recipient: owner, reviewerId: ctx.userId, notes: clean(p.notes), evidence: ref, actorId: ctx.userId, source: 'User' });
    m.update('cases', c.id, { claimStatus: 'Completed' });
    audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Backend claim verified', field: 'claimStatus', from: 'Approved', to: 'Completed', evidence: ref, next: 'Confirm artist access' });
    closeTasks(m, ctx, c.id, ['Backend Check', 'Claim'], `Backend verified (${ref})`);
    setStage(m, ctx, c, 'Claimed', `Backend shows profile ${sub?.profileId ?? ''} claimed by ${owner} (${ref})`, ref);
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Activation', step: 'Confirm the artist can access the profile', why: 'Claim completed; activation starts with access', trigger: `Claim event ${e.id}`, ownerId: c.ownerId });
    computePriority(m, c, ctx.today);
    return { message: 'Claim completed (backend verified). Activation task created.', caseId: c.id };
  },

  // -------------------------------------------------------------------------- activation + ARM
  verifyAccess(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.claimStatus !== 'Completed') throw rule('Access is verified after a backend-verified claim.');
    if (!['Claimed', 'Activation Pending'].includes(c.lifecycleStage)) throw rule(`Not at activation (now ${c.lifecycleStage}).`);
    const evidence = req(p.evidence, 'How access was verified');
    const e = m.insert('activationEvents', { id: m.nextId('AE', 4), caseId: c.id, type: 'Access Verified', date: ctx.now, feature: null, expectedOutcome: null, operatorId: ctx.userId, agreedDate: null, backendRef: clean(p.backendRef) || null, evidence, result: null, actorId: ctx.userId });
    m.update('cases', c.id, { activationStatus: 'Access Verified' });
    audit(m, ctx, { caseId: c.id, entity: 'ActivationEvent', entityId: e.id, action: 'Access verified', field: 'activationStatus', from: c.activationStatus, to: 'Access Verified', evidence });
    closeTasks(m, ctx, c.id, ['Activation'], 'Access verified');
    setStage(m, ctx, c, 'Activation Pending', 'Access verified. Meaningful first use still needed.');
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Activation', step: 'Choose one useful feature with the artist', why: 'Access alone is not activation', trigger: `Activation event ${e.id}` });
    notify(m, ctx, 'Activation pending', `${c.canonicalName}: access verified, first use pending.`, c.id);
    return { message: 'Access verified. Activation stays pending until a meaningful feature action is recorded.', caseId: c.id };
  },
  selectFeature(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.lifecycleStage !== 'Activation Pending' || !['Access Verified', 'Feature Selected'].includes(c.activationStatus)) throw rule('Verify access first.');
    const feature = oneOf(p.feature, FEATURES, 'feature');
    const agreed = req(p.agreedDate, 'Agreed date');
    const e = m.insert('activationEvents', { id: m.nextId('AE', 4), caseId: c.id, type: 'Feature Selected', date: ctx.now, feature, expectedOutcome: clean(p.expectedOutcome), operatorId: p.operatorId || ctx.userId, agreedDate: agreed, backendRef: null, evidence: '', result: null, actorId: ctx.userId });
    m.update('cases', c.id, { activationStatus: 'Feature Selected' });
    audit(m, ctx, { caseId: c.id, entity: 'ActivationEvent', entityId: e.id, action: 'Feature selected', to: feature, reason: clean(p.expectedOutcome) || null, next: `Guide on ${agreed}` });
    closeTasks(m, ctx, c.id, ['Activation'], `Feature chosen: ${feature}`);
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Activation', step: `Guide the artist: ${feature}`, why: clean(p.expectedOutcome) || 'First meaningful use', trigger: `Activation event ${e.id}`, dueDate: agreed, ownerId: p.operatorId || c.ownerId });
    return { message: `${feature} agreed for ${agreed}.`, caseId: c.id };
  },
  recordFirstUse(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.lifecycleStage !== 'Activation Pending') throw rule('First use is recorded while activation is pending.');
    const kind = oneOf(p.kind, ['Meaningful use', 'Login only'] as const, 'evidence type');
    if (kind === 'Login only') {
      const e = m.insert('activationEvents', { id: m.nextId('AE', 4), caseId: c.id, type: 'Login Only', date: ctx.now, feature: null, expectedOutcome: null, operatorId: ctx.userId, agreedDate: null, backendRef: clean(p.backendRef) || null, evidence: clean(p.evidence), result: 'Access only', actorId: ctx.userId });
      audit(m, ctx, { caseId: c.id, entity: 'ActivationEvent', entityId: e.id, action: 'Login recorded', reason: 'Login alone is access, not activation', result: 'Activation stays pending' });
      return { message: 'Login recorded. Login alone is not activation, so activation stays pending.', caseId: c.id };
    }
    if (!['Access Verified', 'Feature Selected'].includes(c.activationStatus)) throw rule('Verify access before recording meaningful use.');
    const ref = clean(p.backendRef), evidence = clean(p.evidence);
    if (!ref && !evidence) throw rule('Meaningful use needs a backend event reference or verified evidence.');
    const feat = m.familyItems('activationEvents', c.id).filter(e => e.type === 'Feature Selected').pop();
    const e = m.insert('activationEvents', { id: m.nextId('AE', 4), caseId: c.id, type: 'Meaningful Use', date: clean(p.timestamp) || ctx.now, feature: clean(p.feature) || feat?.feature || null, expectedOutcome: feat?.expectedOutcome ?? null, operatorId: ctx.userId, agreedDate: null, backendRef: ref || null, evidence, result: 'Verified', actorId: ctx.userId });
    m.update('cases', c.id, { activationStatus: 'Activated' });
    audit(m, ctx, { caseId: c.id, entity: 'ActivationEvent', entityId: e.id, action: 'Meaningful first use recorded', field: 'activationStatus', from: c.activationStatus, to: 'Activated', evidence: [ref, evidence].filter(Boolean).join(' · ') });
    closeTasks(m, ctx, c.id, ['Activation'], 'Meaningful first use verified');
    setStage(m, ctx, c, 'Activated', `${e.feature ?? 'Feature'} used (${ref || evidence})`, ref || evidence);
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'ARM', step: 'Hand over to ARM', why: 'Activated artists move to ongoing relationship management', trigger: `Activation event ${e.id}` });
    return { message: 'Activated: access plus meaningful use verified. Next: hand over to ARM.', caseId: c.id };
  },
  handoverToArm(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.lifecycleStage !== 'Activated') throw rule('Handover happens after activation.');
    const ownerId = req(p.relationshipOwnerId, 'Relationship owner');
    const next = clean(p.nextParticipationCheck) || addDays(ctx.today, PARTICIPATION_CHECK_DAYS);
    const arm = { relationshipOwnerId: ownerId, interests: clean(p.interests), language: clean(p.language) || c.language || '', supportNeeds: clean(p.supportNeeds), nextParticipationCheck: next, since: ctx.now };
    const e = m.insert('activationEvents', { id: m.nextId('AE', 4), caseId: c.id, type: 'ARM Handover', date: ctx.now, feature: null, expectedOutcome: arm.interests, operatorId: ownerId, agreedDate: next, backendRef: null, evidence: arm.supportNeeds, result: null, actorId: ctx.userId });
    m.update('cases', c.id, { arm });
    audit(m, ctx, { caseId: c.id, entity: 'ActivationEvent', entityId: e.id, action: 'Handed over to ARM', to: userName(m, ownerId), reason: `Interests: ${arm.interests || '—'}; support: ${arm.supportNeeds || '—'}`, next: `Participation check ${next}` });
    closeTasks(m, ctx, c.id, ['ARM'], 'Handed over to ARM');
    setStage(m, ctx, c, 'Ongoing ARM', `Relationship owner ${userName(m, ownerId)}; next check ${next}`);
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'ARM', step: '30-day participation check', why: 'Confirm continued participation', trigger: `Activation event ${e.id}`, dueDate: next, ownerId, status: 'Waiting' });
    return { message: `Handed over to ${userName(m, ownerId)}. Participation check on ${next}.`, caseId: c.id };
  },
  recordParticipationCheck(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.lifecycleStage !== 'Ongoing ARM') throw rule('Participation checks are for ARM cases.');
    const active = p.result === 'Active';
    const e = m.insert('activationEvents', { id: m.nextId('AE', 4), caseId: c.id, type: 'Participation Check', date: ctx.now, feature: null, expectedOutcome: null, operatorId: ctx.userId, agreedDate: null, backendRef: clean(p.backendRef) || null, evidence: clean(p.note), result: active ? 'Active' : 'Inactive', actorId: ctx.userId });
    audit(m, ctx, { caseId: c.id, entity: 'ActivationEvent', entityId: e.id, action: 'Participation check', result: active ? 'Active' : 'Inactive', evidence: clean(p.note) || null });
    closeTasks(m, ctx, c.id, ['ARM', 'Re-engagement'], `Participation check: ${active ? 'active' : 'inactive'}`);
    const cc = m.get('cases', c.id)!;
    if (active) {
      const next = addDays(ctx.today, PARTICIPATION_CHECK_DAYS);
      m.update('cases', c.id, { arm: { ...cc.arm!, nextParticipationCheck: next } });
      openTask(m, ctx, cc, { kind: 'ARM', step: '30-day participation check', why: 'Continued participation', trigger: `Activation event ${e.id}`, dueDate: next, ownerId: cc.arm?.relationshipOwnerId, status: 'Waiting' });
      return { message: `Still active. Next check ${next}.`, caseId: c.id };
    }
    setField(m, ctx, cc, 'workReason', 'Re-engagement', 'No further use after handover');
    openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Re-engagement', step: 'Re-engage: suggest one useful action', why: 'No further use since handover (no new claim invitation needed)', trigger: `Activation event ${e.id}`, dueDate: addWorkingDays(ctx.today, 2), ownerId: cc.arm?.relationshipOwnerId, workReason: 'Re-engagement' });
    return { message: 'Inactive. Re-engagement task created.', caseId: c.id };
  },

  // -------------------------------------------------------------------------- identity
  flagIdentity(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const other = getCase(m, p.otherCaseId);
    if (c.id === other.id) throw rule('Pick a different case.');
    const reason = req(p.reason, 'Why these might be the same artist');
    if (m.all('conflicts').some(x => x.status !== 'Decided' && x.caseIds.includes(c.id) && x.caseIds.includes(other.id))) throw rule('These cases are already in identity review.');
    const conflict = m.insert('conflicts', { id: m.nextId('IC', 4), caseIds: [c.id, other.id], kind: 'Manual flag', reason, status: 'Open', createdAt: ctx.now, createdBy: ctx.userId, decisionId: null });
    for (const x of [c, other]) if (stageIndex(x.lifecycleStage) <= stageIndex('Route Ready')) { setStage(m, ctx, x, 'Identity Review', `Possible duplicate (${conflict.id}): ${reason}`); m.update('cases', x.id, { identityStatus: 'Under Review' }); }
    notify(m, ctx, 'Identity conflict', `${c.canonicalName} / ${other.canonicalName}: flagged for identity review.`, c.id);
    return { message: `Possible duplicate ${conflict.id} added to Deduplicate.`, caseId: c.id, id: conflict.id };
  },
  decideIdentity(m, ctx, p) {
    requirePerm(m, ctx, 'identityDecision');
    const conflict = m.get('conflicts', p.conflictId);
    if (!conflict) throw rule('Review item not found.');
    if (conflict.status === 'Decided') throw rule('Already decided. Reverse the decision first.');
    const decision = oneOf(p.decision, ['Same Person', 'Keep Separate', 'Defer'] as const, 'decision');
    const reason = req(p.reason, 'A reason');
    const evidence = clean(p.evidence) || reason;
    const live = conflict.caseIds.map(id => m.get('cases', id)!).filter(c => c && !c.mergedIntoId);
    const snapshot: Record<string, Partial<ArtistCase>> = {};
    for (const c of live) snapshot[c.id] = { lifecycleStage: c.lifecycleStage, previousStage: c.previousStage, stageReason: c.stageReason, identityStatus: c.identityStatus, mergedIntoId: c.mergedIntoId, closedReason: c.closedReason, aliases: [...c.aliases], backendProfileIds: [...c.backendProfileIds], profileUrls: [...c.profileUrls] };
    const d = m.insert('decisions', { id: m.nextId('ID', 4), conflictId: conflict.id, caseIds: live.map(c => c.id), decision, canonicalId: null, reviewerId: ctx.userId, date: ctx.now, reason, evidence, added: null, snapshot, reversedAt: null, reversedBy: null, reverseReason: null });
    const restore = (c: ArtistCase) => {
      if (c.lifecycleStage !== 'Identity Review') return;
      const back = c.previousStage && c.previousStage !== 'Identity Review' ? c.previousStage : 'Unresearched';
      setStage(m, ctx, c, back, `Identity decided (${decision})`);
    };
    if (decision === 'Defer') {
      m.update('conflicts', conflict.id, { status: 'Deferred', decisionId: d.id });
      audit(m, ctx, { caseId: live[0]?.id ?? null, entity: 'IdentityConflict', entityId: conflict.id, action: 'Identity decision deferred', reason, evidence });
      return { message: 'Deferred. Cases stay in identity review.' };
    }
    if (decision === 'Same Person') {
      const canonical = getCase(m, p.canonicalId || live[0].id);
      if (!live.includes(canonical)) throw rule('Pick the surviving case from this group.');
      const added = { aliases: [] as string[], backendProfileIds: [] as string[] };
      for (const o of live.filter(c => c !== canonical)) {
        for (const n of [o.canonicalName, ...o.aliases]) if (nameKey(n) !== nameKey(canonical.canonicalName) && !canonical.aliases.includes(n)) { canonical.aliases.push(n); added.aliases.push(n); }
        for (const b of o.backendProfileIds) if (!canonical.backendProfileIds.includes(b)) { canonical.backendProfileIds.push(b); added.backendProfileIds.push(b); }
        for (const u of o.profileUrls) if (!canonical.profileUrls.includes(u)) canonical.profileUrls.push(u);
        closeTasks(m, ctx, o.id, 'all', `Merged into ${canonical.id}`, 'Cancelled');
        m.update('cases', o.id, { mergedIntoId: canonical.id, closedReason: `Merged into ${canonical.id} (confirmed duplicate)`, identityStatus: 'Verified' });
        setStage(m, ctx, m.get('cases', o.id)!, 'Closed', `Merged into ${canonical.id}: ${reason}`, evidence);
      }
      m.update('cases', canonical.id, { aliases: canonical.aliases, backendProfileIds: canonical.backendProfileIds, profileUrls: canonical.profileUrls, identityStatus: 'Verified', identityEvidence: evidence });
      m.rebuildMerges();
      m.update('decisions', d.id, { canonicalId: canonical.id, added });
      restore(m.get('cases', canonical.id)!);
      audit(m, ctx, { caseId: canonical.id, entity: 'IdentityDecision', entityId: d.id, action: 'Identity decided: same person', reason, evidence, to: `${live.length} cases → ${canonical.id}` });
      computePriority(m, m.get('cases', canonical.id)!, ctx.today);
    } else {
      for (const c of live) { m.update('cases', c.id, { identityStatus: 'Verified', identityEvidence: evidence }); restore(c); }
      audit(m, ctx, { caseId: live[0].id, entity: 'IdentityDecision', entityId: d.id, action: 'Identity decided: keep separate', reason, evidence, to: live.map(c => c.id).join(', ') });
    }
    m.update('conflicts', conflict.id, { status: 'Decided', decisionId: d.id });
    for (const c of live) { syncNextAction(m, c.id); clearReopen(m, ctx, m.canonical(c.id), `Duplicate decided: ${decision.toLowerCase()}`, ['duplicate']); syncArtistStatus(m, ctx, m.canonical(c.id)); }
    return { message: decision === 'Same Person' ? `Merged into ${m.get('decisions', d.id)!.canonicalId}. Reversible in Deduplicate → Decided.` : 'Kept as separate artists.', id: d.id };
  },
  reverseIdentityDecision(m, ctx, p) {
    requirePerm(m, ctx, 'identityDecision');
    const d = m.get('decisions', p.decisionId);
    if (!d) throw rule('Decision not found.');
    if (d.reversedAt) throw rule('Already reversed.');
    if (d.decision === 'Defer') throw rule('A deferral has nothing to reverse.');
    const reason = req(p.reason, 'Why the decision was wrong');
    for (const [id, snap] of Object.entries(d.snapshot ?? {})) {
      const c = m.get('cases', id);
      if (!c) continue;
      const from = c.lifecycleStage;
      m.update('cases', id, { ...snap, identityStatus: 'Under Review', updatedAt: ctx.now });
      audit(m, ctx, { caseId: id, entity: 'ArtistCase', entityId: id, action: 'Identity decision reversed', field: 'lifecycleStage', from, to: snap.lifecycleStage ?? from, reason });
      openTask(m, ctx, m.get('cases', id)!, { kind: 'Identity', step: 'Review outreach and claims made under the reversed identity decision', why: reason, trigger: `Decision ${d.id} reversed`, ownerId: supervisor(m) });
    }
    m.rebuildMerges();
    m.rebuildIndexes();
    m.update('decisions', d.id, { reversedAt: ctx.now, reversedBy: ctx.userId, reverseReason: reason });
    m.update('conflicts', d.conflictId, { status: 'Open', decisionId: null });
    return { message: 'Decision reversed. Cases restored and review tasks created.' };
  },

  // -------------------------------------------------------------------------- import exceptions + notifications
  resolveImportException(m, ctx, p) {
    requirePerm(m, ctx, 'resolveException');
    const r = m.get('importRows', p.rowId);
    if (!r || r.status !== 'Quarantined') throw rule('Quarantined row not found.');
    const action = oneOf(p.action, ['Resolved', 'Dismissed'] as const, 'action');
    const resolution = req(p.resolution, 'Resolution');
    m.update('importRows', r.id, { exceptionStatus: action, resolution, resolvedAt: ctx.now, ownerId: ctx.userId });
    audit(m, ctx, { caseId: null, entity: 'ImportRow', entityId: r.id, action: `Import exception ${action.toLowerCase()}`, reason: resolution, from: r.reason });
    return { message: `Row ${r.rowNumber} of ${r.batchId} ${action.toLowerCase()}.` };
  },
  /** No verified candidate from discovery: keep the case visible and let new evidence reopen it. */
  waitForNewEvidence(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (c.lifecycleStage === 'Waiting for Evidence') return { message: `${c.canonicalName} is already waiting for new evidence.`, caseId: c.id };
    return commands.moveToWaiting(m, ctx, { caseId: c.id, blocker: clean(p.blocker) || 'Automated discovery found no verified candidate', futureTrigger: 'New song, credit, collaborator contact or a profile found by a later search', nextReviewDate: clean(p.nextReviewDate) || addDays(ctx.today, 30) });
  },
  // -------------------------------------------------------------------------- v2: identity status, Goongoonalo status, duplicates
  /** Only a person sets the Goongoonalo status, and only for verified artists (do not contact is always allowed). */
  setGoongoonaloStatus(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const status = oneOf(p.status, GOONGOONALO_STATUSES, 'Goongoonalo status');
    const reason = clean(p.reason) || null;
    if ((status === 'REJECTED' || status === 'DO_NOT_CONTACT') && !reason) throw rule('A reason is required.');
    const changed = setGoongoonaloStatus(m, ctx, c, status, reason);
    return { message: changed ? `${c.canonicalName}: Goongoonalo status is now ${GOONGOONALO_INFO[status].label}. Identity verification is unchanged.` : `${c.canonicalName} is already ${GOONGOONALO_INFO[status].label}.`, caseId: c.id };
  },
  /** Not a real artist record (test content, a label or company name…). Kept with the reason, can be restored. */
  rejectArtist(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const reason = req(p.reason, 'A reason');
    if (c.rejectedAt) throw rule('Already rejected.');
    if (m.byCase('discoveryJobs', c.id).some(j => ['QUEUED', 'SEARCHING', 'PROCESSING'].includes(j.status))) throw rule('Wait until the running search finishes.');
    m.update('cases', c.id, { rejectedAt: ctx.now, rejectedReason: reason, updatedAt: ctx.now });
    closeTasks(m, ctx, c.id, 'all', `Cancelled: artist rejected (${reason})`, 'Cancelled');
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Artist rejected', reason, result: 'Kept with the reason; not searched or contacted' });
    syncArtistStatus(m, ctx, c.id, reason);
    return { message: `${c.canonicalName} rejected. The record and its history are kept.`, caseId: c.id };
  },
  restoreArtist(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (!c.rejectedAt) throw rule('This artist is not rejected.');
    m.update('cases', c.id, { rejectedAt: null, rejectedReason: null, updatedAt: ctx.now });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Artist restored', reason: clean(p.reason) || 'Restored by a person', from: c.rejectedReason });
    syncArtistStatus(m, ctx, c.id, 'Restored');
    return { message: `${c.canonicalName} restored.`, caseId: c.id };
  },
  /** Identity confirmed outside discovery (e.g. on a call or by the label); counts as verified, with the evidence. */
  confirmIdentity(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const evidence = req(p.evidence, 'Evidence');
    m.update('cases', c.id, { manualVerifiedAt: ctx.now, manualVerifiedBy: ctx.userId, identityEvidence: evidence, updatedAt: ctx.now });
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Identity confirmed by a person', evidence, result: 'Counts as verified' });
    syncArtistStatus(m, ctx, c.id, 'Identity confirmed by a person');
    return { message: `${c.canonicalName} verified.`, caseId: c.id };
  },
  /** Ask for a fresh look (e.g. something changed outside the system); earlier verification stays. */
  reopenArtist(m, ctx, p) {
    const c = getCase(m, p.caseId);
    const reason = req(p.reason, 'Why it should be reviewed again');
    if (!reopenArtist(m, ctx, c.id, 'manual', reason)) throw rule(c.rejectedAt ? 'Restore the artist first.' : 'Already reopened for this reason.');
    return { message: `${c.canonicalName} reopened. Earlier verification is kept.`, caseId: c.id };
  },
  markReopenReviewed(m, ctx, p) {
    const c = getCase(m, p.caseId);
    if (!c.reopen) throw rule('Nothing to review: the artist is not reopened.');
    clearReopen(m, ctx, c.id, clean(p.note) || 'Reviewed: nothing else to change');
    return { message: `${c.canonicalName}: changes reviewed.`, caseId: c.id };
  },
  scanDuplicates(m, ctx) {
    requirePerm(m, ctx, 'identityDecision');
    const found = scanDuplicates(m, ctx);
    return { message: found.length ? `${found.length} possible duplicate${found.length === 1 ? '' : 's'} found.` : 'No new possible duplicates.', data: { count: found.length } };
  },
  markNotificationsRead(m, _ctx, p) {
    const ids: string[] = Array.isArray(p.ids) ? p.ids : m.all('notifications').filter(n => !n.read).map(n => n.id);
    for (const id of ids) if (m.get('notifications', id)) m.update('notifications', id, { read: true });
    return { message: 'Notifications marked as read.' };
  },

  // -------------------------------------------------------------------------- people
  setUserRole(m, ctx, p) {
    requirePerm(m, ctx, 'manageUsers');
    const u = m.get('users', req(p.userId, 'User'));
    if (!u || u.role === 'Automation') throw rule('Unknown user.');
    const role = oneOf(p.role, PEOPLE_ROLES, 'role (Admin or User)');
    if (u.id === ctx.userId) throw rule('You cannot change your own role.');
    // Only the System Owner changes an Admin's role. The owner shows as Admin to everyone else and is refused the same
    // way, so nobody can tell which Admin is the owner. The owner's own role never changes (there is exactly one).
    if (u.role !== 'User' && m.get('users', ctx.userId)?.role !== 'System Owner') throw rule('Only the System Owner can change an Admin’s role.');
    if (u.role === 'System Owner') throw rule('This role cannot be changed.');
    if (u.role === role) return { message: `${u.name} is already ${role}.` };
    const from = u.role;
    m.update('users', u.id, { role });
    audit(m, ctx, { caseId: null, entity: 'User', entityId: u.id, action: 'Role changed', from, to: role });
    return { message: `${u.name} is now ${role}.`, id: u.id };
  },
};

export function similarityOf(a: string, b: string) { return similarKey(a) === similarKey(b); }
export { evidenceChanged };

// Discovery commands share the same registry, validation, transactions and audit trail.
Object.assign(commands, discoveryCommands);
