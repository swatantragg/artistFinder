// Status board (V2.7.1): where every artist stands in the claim journey, members on Goongoonalo, festival greetings and
// who said stop. The steps are the ones of the Claims & routes tab: 1 On Goongoonalo? 2 The route 3 First message
// 4 Their answer 5 The claim (members stop after 4). Read-only; every row links to the step to continue.
import type { Model } from './model';
import { dmTargets, festivalsOf, optOutOf, outreachState, type Festival } from './messages';
import { notUndone } from './ops';
import type { ArtistCase, Ctx } from './types';
import { processSteps } from './undo';
import { artistRanks } from './views';

export type BoardTab = 'claims' | 'members' | 'greetings' | 'stopped';
export type RowState = 'todo' | 'waiting' | 'done' | 'ended';
export interface BoardRow {
  caseId: string; name: string; rank: number | null; goongoonalo: string;
  step: number; steps: number; stepLabel: string; doneSteps: number;
  state: RowState; stateLabel: string; next: string;
  route: string | null; lastStep: string | null; since: string | null; followUpDue: string | null;
  greetings: string; lastGreeting: string | null; optOut: string | null;
  /** The message of this tab went out (claims/members: the first message; greetings: the next festival's greeting). */
  sent: boolean; sentAt: string | null; sentWhat: string | null;
}

const CLAIM_FLOW = ['On Goongoonalo?', 'The route', 'Join invitation', 'Their answer', 'The claim'];
const MEMBER_FLOW = ['On Goongoonalo?', 'The route', 'Member message', 'Their answer'];

/** One artist's place in the journey: the step they are on (1-based), whether we act or wait, and what to do next. */
export function journeyOf(m: Model, c: ArtistCase, today: string, rank: number | null): BoardRow {
  const member = c.goongoonaloStatus === 'GOONGOONALO', pending = c.goongoonaloStatus === 'PENDING';
  const flow = member ? MEMBER_FLOW : CLAIM_FLOW;
  const routes = m.byCase('routes', c.id).filter(r => r.state !== 'Deleted');
  const chosen = routes.find(r => r.state === 'Selected') ?? null;
  const targets = dmTargets(m, c);
  const target = chosen?.sourceUrl ? targets.find(t => t.url === chosen.sourceUrl) : null;
  const attempts = notUndone(m.familyItems('attempts', c.id));
  const contacted = attempts.length > 0, answered = attempts.some(a => a.result !== 'No Response');
  const out = outreachState(m, c, today);
  const optOut = optOutOf(c);
  const claim = c.claimStatus, claimDone = claim === 'Completed';
  const steps = processSteps(m, c, 'all');
  const last = steps[steps.length - 1] ?? null;
  const at = optOut ? -1 : pending ? 0 : !chosen && !contacted ? 1 : !contacted ? 2 : !answered ? 3 : !member && !claimDone ? 4 : flow.length;
  const doneSteps = at < 0 ? [!pending, !!chosen || contacted, contacted, answered, claimDone].slice(0, flow.length).filter(Boolean).length : Math.min(at, flow.length);
  const due = out.sequence && !out.sequence.ended ? out.sequence.nextDue : null;
  let state: RowState, stateLabel: string, next: string;
  if (optOut) { state = 'ended'; stateLabel = optOut; next = optOut === 'Not interested' ? 'Said not interested: nothing to do (undo in the artist page if it was a mistake).' : 'Asked not to be contacted: nothing to do.'; }
  else if (at === 0) { state = 'todo'; stateLabel = 'Answer the first question'; next = 'Is the artist on Goongoonalo? Answer yes or no.'; }
  else if (at === 1) { state = 'todo'; stateLabel = 'Choose the route'; next = targets.length ? `Use ${targets[0].platform} @${targets[0].handle} or another way to reach them.` : 'Verify an Instagram, X or Facebook profile, or add someone who can pass the message on.'; }
  else if (at === 2) { state = 'todo'; stateLabel = member ? 'Send the member message' : 'Send the invitation'; next = target ? `Copy & open ${target.platform} @${target.handle}, paste and send.` : 'Send the message through the route, then record it.'; }
  else if (at === 3) {
    const overdue = !!due && due <= today;
    state = overdue ? 'todo' : 'waiting'; stateLabel = overdue ? 'Follow-up due' : 'Waiting for reply';
    next = overdue ? `No reply yet: send follow-up ${(out.sequence?.followUps ?? 0) + 1} (due ${due}).` : `Record the answer when they reply${due ? `; follow-up on ${due}` : ''}.`;
  } else if (at === 4 && !member) {
    const waitingOn: Record<string, string> = { Invited: 'Waiting for the artist to submit the claim', 'In Review': 'Waiting for the reviewer' };
    if (waitingOn[claim]) { state = 'waiting'; stateLabel = waitingOn[claim]; next = claim === 'Invited' ? 'Record the submission when the artist sends it.' : 'A reviewer approves or rejects the claim.'; }
    else { state = 'todo'; stateLabel = claim === 'Not Invited' ? 'Send the claim invitation' : claim === 'Submitted' ? 'Send the claim to review' : claim === 'Approved' ? 'Verify the backend claim' : claim === 'Rejected' ? 'Claim rejected: sort it out' : `Claim ${claim.toLowerCase()}`; next = `${stateLabel}.`; }
  } else if (member) { state = 'done'; stateLabel = 'Member: in touch'; next = 'Member messages and festival greetings go through the route.'; }
  else { state = 'todo'; stateLabel = 'Claimed: mark as on Goongoonalo'; next = 'The claim is completed: mark the artist as on Goongoonalo.'; }
  const greetingsSent = out.messages.filter(x => x.kind === 'greeting');
  const head = out.messages.find(x => x.followUpNo === 0 && (x.kind === 'invite' || x.kind === 'member'));
  const firstAttempt = [...attempts].sort((a, b) => a.date.localeCompare(b.date))[0];
  return {
    caseId: c.id, name: c.canonicalName, rank, goongoonalo: c.goongoonaloStatus,
    step: at < 0 ? doneSteps : Math.min(at + 1, flow.length), steps: flow.length, stepLabel: at < 0 ? 'Stopped' : flow[Math.min(at, flow.length - 1)], doneSteps,
    state, stateLabel, next,
    route: target ? `${target.platform} @${target.handle}` : chosen ? (chosen.collaboratorName ?? chosen.organisation ?? (chosen.contactId ? m.get('contacts', chosen.contactId)?.personName : null) ?? 'a go-between') : null,
    lastStep: last?.label ?? null, since: last?.at ?? null, followUpDue: due,
    greetings: c.greetings ?? 'Unknown', lastGreeting: greetingsSent.length ? greetingsSent[greetingsSent.length - 1].sentAt : null, optOut,
    sent: contacted, sentAt: head?.sentAt ?? firstAttempt?.date ?? null,
    sentWhat: head ? `${head.kind === 'invite' ? 'Join invitation' : 'Member message'} on ${head.platform} @${head.handle}` : firstAttempt ? `Contact recorded (${firstAttempt.channel})` : null,
  };
}

/** On the Greetings tab: the answer to greetings, and whether the next festival's greeting went out (only a yes gets one). */
function greetingRow(m: Model, r: BoardRow, festival: Festival | null): BoardRow {
  const g = r.greetings;
  const greeting = festival ? notUndone(m.familyItems('messages', r.caseId)).find(x => x.kind === 'greeting' && x.festivalId === festival.id) : undefined;
  const fest = festival?.name ?? 'the next festival';
  return {
    ...r, state: g === 'No' ? 'ended' : greeting ? 'done' : 'todo',
    stateLabel: g === 'No' ? 'No greetings' : greeting ? `${fest} greeting sent` : g === 'Yes' ? `Send the ${fest} greeting` : 'Ask: greetings yes or no?',
    next: g === 'No' ? 'Said no to greetings: none are sent.' : greeting ? `Greeted for ${fest}.` : g === 'Yes' ? `Messages → Festival greeting → ${fest}.` : 'Ask whether they want festival greetings; record “Yes to greetings” in Messages → Festival greeting.',
    sent: !!greeting, sentAt: greeting?.sentAt ?? null, sentWhat: greeting ? `${fest} greeting on ${greeting.platform} @${greeting.handle}` : null,
  };
}

/** Rows of one tab; the counts of every tab (for the tab labels). Top-250 artists first, then A–Z. */
export function statusBoard(m: Model, ctx: Ctx, p: { tab?: string; q?: string; state?: string; step?: string | number; scope?: string; msg?: string } = {}) {
  const tab: BoardTab = (['claims', 'members', 'greetings', 'stopped'] as const).find(t => t === p.tab) ?? 'claims';
  const ranks = artistRanks(m);
  const rows: Record<BoardTab, BoardRow[]> = { claims: [], members: [], greetings: [], stopped: [] };
  const festival = festivalsOf(m).find(f => f.date && f.date >= ctx.today) ?? null;
  for (const c of m.data.cases.values()) {
    if (c.mergedIntoId || c.rejectedAt || c.kind !== 'Artist' || c.goongoonaloStatus === 'REJECTED') continue;
    const member = c.goongoonaloStatus === 'GOONGOONALO';
    const started = c.goongoonaloStatus !== 'PENDING' || notUndone(m.familyItems('attempts', c.id)).length > 0 || m.byCase('routes', c.id).some(r => r.state === 'Selected');
    if (!member && !started) continue;   // not begun: still in Artists, not on the board
    const r = journeyOf(m, c, ctx.today, ranks.get(c.id) ?? null);
    if (r.optOut) rows.stopped.push(r);
    else if (member) { rows.members.push(r); rows.greetings.push(greetingRow(m, r, festival)); }
    else rows.claims.push(r);
  }
  const counts = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])) as Record<BoardTab, number>;
  const words = String(p.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const step = Number(p.step) || 0;
  const base = rows[tab].filter(r => (p.scope !== 'top' || (r.rank != null && r.rank <= 250)) && words.every(w => r.name.toLowerCase().includes(w)));
  const msg = tab === 'stopped' ? 'all' : p.msg === 'sent' || p.msg === 'pending' ? p.msg : 'all';
  const list = base
    .filter(r => (!step || r.step === step) && (!p.state || p.state === 'all' || r.state === p.state) && (msg === 'all' || r.sent === (msg === 'sent')))
    .sort((a, b) => msg === 'sent' ? (b.sentAt ?? '').localeCompare(a.sentAt ?? '') : (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  const waiting = rows[tab].filter(r => r.state === 'waiting').length, todo = rows[tab].filter(r => r.state === 'todo').length;
  const sent = base.filter(r => r.sent).length;
  return { tab, counts, waiting, todo, rows: list, msg, sent, pending: base.length - sent, festival: festival ? { id: festival.id, name: festival.name, date: festival.date } : null };
}
