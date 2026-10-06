// Continuous refresh engine (spec §15, PDF p9): new songs, credits or verified contacts can give an
// existing case a usable lead. Waiting cases reopen; every affected case gets at most one new route and one task.
import { stageIndex, audit, closeTasks, computePriority, evidenceChanged, notify, openTask, setField, setStage } from './ops';
import { syncRouteGraph } from './graph';
import type { Model } from './model';
import type { ArtistCase, Contact, Ctx, Track } from './types';
import { nameKey } from './util';
import { reopenArtist } from './status';

export interface Lead {
  caseId: string;
  track: Track;
  via: string;
  viaCaseId: string | null;
  contact: Contact;
  kind: 'Collaborator' | 'Label' | 'Distributor';
  role: string;
}
export interface RefreshOutcome { reopenedCaseIds: string[]; taskIds: string[]; routeIds: string[]; suppressedCaseIds: string[]; enrichedCaseIds: string[] }
export const emptyOutcome = (): RefreshOutcome => ({ reopenedCaseIds: [], taskIds: [], routeIds: [], suppressedCaseIds: [], enrichedCaseIds: [] });

/** Only artists and collaborators act as introducers; managers and representatives speak for their own artist only. */
const INTRODUCER_ROLES = ['Artist', 'Collaborator'];
function verifiedPersonContacts(m: Model, caseId: string | null, name: string): Contact[] {
  const out = new Map<string, Contact>();
  if (caseId) for (const k of m.contactsFor(m.canonical(caseId))) if (k.verified && INTRODUCER_ROLES.includes(k.role)) out.set(k.id, k);
  for (const k of m.contactsNamed(name)) if (k.verified && !k.organisation && INTRODUCER_ROLES.includes(k.role)) out.set(k.id, k);
  return [...out.values()];
}
function verifiedOrgContacts(m: Model, org: string): Contact[] {
  if (!org) return [];
  return m.all('contacts').filter(k => k.verified && k.organisation && nameKey(k.organisation) === nameKey(org));
}
function addLead(map: Map<string, Lead[]>, lead: Lead) {
  const list = map.get(lead.caseId) ?? [];
  if (!list.some(l => l.contact.id === lead.contact.id)) list.push(lead);
  map.set(lead.caseId, list);
}

/** Leads created by songs (new tracks, or new credits on known tracks). */
export function leadsForTracks(m: Model, trackIds: Iterable<string>): Map<string, Lead[]> {
  const leads = new Map<string, Lead[]>();
  for (const tid of trackIds) {
    const t = m.get('tracks', tid);
    if (!t) continue;
    const credits = m.creditsOfTrack(tid).filter(c => c.status === 'Active');
    for (const target of credits) {
      if (!target.caseId) continue;
      const caseId = m.canonical(target.caseId);
      for (const other of credits) {
        if (other === target || (other.caseId && m.canonical(other.caseId) === caseId)) continue;
        for (const k of verifiedPersonContacts(m, other.caseId, other.personName)) {
          addLead(leads, { caseId, track: t, via: other.personName, viaCaseId: other.caseId ? m.canonical(other.caseId) : null, contact: k, kind: 'Collaborator', role: other.role });
        }
      }
      // A label or distributor speaks for the release's primary artist, not for every credited collaborator.
      if (!target.isPrimary) continue;
      for (const k of verifiedOrgContacts(m, t.label)) addLead(leads, { caseId, track: t, via: t.label, viaCaseId: null, contact: k, kind: 'Label', role: 'Label' });
      for (const k of verifiedOrgContacts(m, t.distributor)) addLead(leads, { caseId, track: t, via: t.distributor, viaCaseId: null, contact: k, kind: 'Distributor', role: 'Distributor' });
    }
  }
  return leads;
}

/** Leads created when a contact becomes verified (rule 16: no new song needed). */
export function leadsForContact(m: Model, k: Contact): Map<string, Lead[]> {
  const leads = new Map<string, Lead[]>();
  if (!k.verified) return leads;
  if (k.organisation) {
    for (const t of m.all('tracks')) {
      const kind = nameKey(t.label) === nameKey(k.organisation) ? 'Label' : nameKey(t.distributor) === nameKey(k.organisation) ? 'Distributor' : null;
      if (!kind) continue;
      for (const cr of m.creditsOfTrack(t.id)) if (cr.caseId && cr.status === 'Active' && cr.isPrimary) addLead(leads, { caseId: m.canonical(cr.caseId), track: t, via: k.organisation, viaCaseId: null, contact: k, kind, role: kind });
    }
    return leads;
  }
  if (!INTRODUCER_ROLES.includes(k.role)) return leads;
  const personCase = k.caseId ? m.canonical(k.caseId) : m.casesNamed(k.personName)[0]?.id ?? null;
  if (!personCase) return leads;
  for (const tid of m.trackIdsOfCase(personCase)) {
    const t = m.get('tracks', tid)!;
    const mine = m.creditsOfTrack(tid).find(c => c.caseId && m.canonical(c.caseId) === personCase);
    for (const cr of m.creditsOfTrack(tid)) {
      if (!cr.caseId || cr.status !== 'Active') continue;
      const caseId = m.canonical(cr.caseId);
      if (caseId === personCase) continue;
      addLead(leads, { caseId, track: t, via: k.personName, viaCaseId: personCase, contact: k, kind: 'Collaborator', role: mine?.role ?? 'Collaborator' });
    }
  }
  return leads;
}

const ENRICH_ONLY_FROM = stageIndex('Contact Confirmed');

/** Turn leads into routes, reopened cases and tasks. Never duplicates routes or tasks; never touches do-not-contact cases. */
export function applyLeads(m: Model, ctx: Ctx, leads: Map<string, Lead[]>, origin: { label: string; batchId?: string | null; contactId?: string | null; newTracks?: Set<string> }, out: RefreshOutcome = emptyOutcome()): RefreshOutcome {
  for (const [caseId, list] of leads) {
    const c = m.get('cases', caseId);
    if (!c || c.mergedIntoId) continue;
    // Never repeat failed work: contacts that already have a route on this case (including rejected/exhausted) are skipped.
    const routes = m.byCase('routes', c.id);
    const fresh = list.filter(l => !routes.some(r => r.contactId === l.contact.id));
    if (!fresh.length) continue;
    const lead = pickLead(fresh);
    const isNewSong = origin.newTracks?.has(lead.track.id) ?? false;
    const evidence = `${lead.via} (${lead.role}) on ${isNewSong ? 'newly added song' : 'song'} “${lead.track.title}” has a verified contact`;
    if (c.contactPreference === 'Do Not Contact' || c.contactPreference === 'Declined') {
      if (!out.suppressedCaseIds.includes(c.id)) {
        out.suppressedCaseIds.push(c.id);
        audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'New evidence recorded, outreach suppressed', reason: `Contact preference is ${c.contactPreference}`, evidence });
        notify(m, ctx, 'Do-not-contact protected', `${c.canonicalName}: new evidence from ${origin.label}, but no outreach was created (${c.contactPreference}).`, c.id);
      }
      continue;
    }
    if (c.lifecycleStage === 'Closed' || stageIndex(c.lifecycleStage) >= ENRICH_ONLY_FROM) {
      audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'New evidence recorded', reason: `${origin.label}; case already ${c.lifecycleStage}, no new outreach needed`, evidence });
      continue;
    }
    const route = m.insert('routes', {
      id: m.nextId('RT', 4), targetCaseId: c.id, trackId: lead.track.id, collaboratorName: lead.kind === 'Collaborator' ? lead.via : null,
      collaboratorCaseId: lead.viaCaseId, organisation: lead.kind === 'Collaborator' ? null : lead.via, contactId: lead.contact.id, sourceUrl: null,
      evidence, confidence: lead.contact.willingIntroducer ? 90 : 75, state: 'Verified', ranking: lead.contact.willingIntroducer ? 1 : lead.kind === 'Collaborator' ? 2 : 3,
      lastChecked: ctx.now, rejectionReason: null, ownerId: c.ownerId, origin: origin.label, path: null, pathId: null, createdAt: ctx.now,
    });
    out.routeIds.push(route.id);
    syncRouteGraph(m, ctx, route.id);
    audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: route.id, action: 'Route created by new evidence', reason: origin.label, evidence, to: `${c.canonicalName} → “${lead.track.title}” → ${lead.via} → verified ${lead.contact.channel}` });
    evidenceChanged(m, ctx, c, `New lead: ${evidence}`);
    const step = `Contact ${lead.via} for an introduction to ${c.canonicalName}`;
    const why = `New lead: ${lead.via} is now a verified route through ${c.canonicalName}'s ${isNewSong ? 'newly added song' : 'song'} “${lead.track.title}”.`;
    if (c.lifecycleStage === 'Waiting for Evidence') {
      const oldStage = c.lifecycleStage;
      closeTasks(m, ctx, c.id, ['Research'], `Reopened by new evidence (${origin.label})`);
      setStage(m, ctx, c, 'Researching', `Reopened: ${why}`, evidence);
      setField(m, ctx, c, 'workReason', 'New Lead', why);
      const task = openTask(m, ctx, c, { kind: 'Introduction', step, why, trigger: origin.label, evidenceChange: evidence, priority: 'High', workReason: 'New Lead', channel: 'Introducer', recipient: lead.via });
      out.taskIds.push(task.id);
      out.reopenedCaseIds.push(c.id);
      m.insert('reopens', {
        id: m.nextId('RO', 4), caseId: c.id, date: ctx.now, oldStage, newStage: 'Researching', evidence, why, routeId: route.id, taskId: task.id,
        batchId: origin.batchId ?? null, contactId: origin.contactId ?? null, ownerId: c.ownerId,
      });
      notify(m, ctx, 'Case reopened', `${c.canonicalName} reopened: ${why}`, c.id);
      reopenArtist(m, ctx, c.id, 'new_lead', why);
    } else {
      if (['Unresearched', 'Researching'].includes(c.lifecycleStage)) setField(m, ctx, c, 'workReason', 'New Lead', why);
      if (c.ownerId && ['Researching', 'Route Ready', 'Contact Attempted', 'Introduction Pending'].includes(c.lifecycleStage)) {
        const task = openTask(m, ctx, c, { kind: 'Introduction', step, why, trigger: origin.label, evidenceChange: evidence, priority: 'High', workReason: 'New Lead', channel: 'Introducer', recipient: lead.via });
        if (!out.taskIds.includes(task.id)) out.taskIds.push(task.id);
      }
      notify(m, ctx, 'New lead', `${c.canonicalName}: ${why}`, c.id);
    }
    computePriority(m, m.get('cases', c.id)!, ctx.today);
  }
  return out;
}
function pickLead(list: Lead[]): Lead {
  return list.slice().sort((a, b) => Number(b.contact.willingIntroducer) - Number(a.contact.willingIntroducer) || (a.kind === 'Collaborator' ? 0 : 1) - (b.kind === 'Collaborator' ? 0 : 1))[0];
}
export function isEnrichOnly(c: ArtistCase) { return c.lifecycleStage === 'Closed' || stageIndex(c.lifecycleStage) >= ENRICH_ONLY_FROM; }
