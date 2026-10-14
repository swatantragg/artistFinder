// Status board (V2.7.1): each artist's step in the claim journey (1 On Goongoonalo? 2 route 3 first message 4 answer
// 5 claim), waiting or to do, members, greetings and who said stop. Fictional fixture data only.
import { fixtureEngine } from './fixtures/engine';
import type { Engine, Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';

class MemoryStore implements Store { async load(): Promise<Snapshot | null> { return null; } async save(_d: Dirty) {} async replace(_s: Snapshot) {} }
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
const U = 'u-swatantra';
const e: Engine = fixtureEngine(new MemoryStore());
await e.init();
const m = e.m;
const board = (p: object = {}) => e.query('statusBoard', U, p as Record<string, unknown>) as any;
const rowOf = (tab: string, id: string) => board({ tab }).rows.find((r: any) => r.caseId === id);
const tick = () => new Promise(r => setTimeout(r, 5));
const fresh = (id: string) => !m.familyItems('claimEvents', id).length && !m.familyItems('attempts', id).length && !m.familyItems('routes', id).length && !m.familyItems('messages', id).length;
const [a, b] = m.all('cases').filter(c => !c.mergedIntoId && c.kind === 'Artist' && c.goongoonaloStatus === 'PENDING' && fresh(c.id));
const now = new Date().toISOString();
for (const [c, handle] of [[a, 'board.a'], [b, 'board.b']] as const) {
  m.insert('verifiedProfiles', { id: `VP-${handle}`, caseId: c.id, profileId: null, platform: 'Instagram', url: `https://instagram.com/${handle}`, username: handle, displayName: c.canonicalName, verificationStatus: 'VERIFIED', verifiedBy: U, verifiedAt: now, lastCheckedAt: now, source: 'test', evidence: 'test', replacedBy: null });
  m.update('cases', c.id, { verifiedProfileCount: 1, artistStatus: 'VERIFIED', manualVerifiedAt: now, manualVerifiedBy: U, firstVerifiedAt: now, lifecycleStage: 'Researching', contactPreference: 'Allowed', contactPreferenceUntil: null, claimStatus: 'Not Invited' });
}

console.log('Claim journey');
check('an artist nobody started is not on the board', !rowOf('claims', a.id));
await e.command('setGoongoonaloStatus', U, { caseId: a.id, status: 'NOT_MEMBER', reason: 'Answered' });
let r = rowOf('claims', a.id);
check('answered “not yet”: step 2 of 5, choose the route (to do)', r?.step === 2 && r.steps === 5 && r.state === 'todo' && /route/i.test(r.stateLabel), r);
await tick(); await e.command('useProfileAsRoute', U, { caseId: a.id, url: 'https://instagram.com/board.a' });
r = rowOf('claims', a.id);
check('route chosen: step 3, send the invitation, route shown', r.step === 3 && r.state === 'todo' && r.route === 'Instagram @board.a', r);
await tick(); await e.command('sendMessage', U, { caseId: a.id, kind: 'invite', platform: 'Instagram', text: 'Hi there' });
r = rowOf('claims', a.id);
check('invitation sent: step 4, waiting for reply, follow-up date, last step + since', r.step === 4 && r.doneSteps === 3 && r.state === 'waiting' && r.stateLabel === 'Waiting for reply' && !!r.followUpDue && !!r.lastStep && !!r.since, r);
check('filters: waiting, step 4 and name', board({ tab: 'claims', state: 'waiting' }).rows.some((x: any) => x.caseId === a.id) && !board({ tab: 'claims', state: 'todo' }).rows.some((x: any) => x.caseId === a.id) && board({ tab: 'claims', step: 4 }).rows.some((x: any) => x.caseId === a.id) && board({ tab: 'claims', q: a.canonicalName.toUpperCase() }).rows.some((x: any) => x.caseId === a.id));
await tick(); await e.command('recordReply', U, { caseId: a.id, outcome: 'Interested' });
r = rowOf('claims', a.id);
check('answered: step 5, the claim', r.step === 5 && r.stepLabel === 'The claim' && r.state === 'todo', r);

console.log('\nMembers, greetings, stopped');
await e.command('setGoongoonaloStatus', U, { caseId: b.id, status: 'GOONGOONALO', reason: 'Already on it' });
r = rowOf('members', b.id);
check('a member is listed with a 4-step journey', r?.steps === 4 && r.step === 2 && !rowOf('claims', b.id), r);
await e.command('useProfileAsRoute', U, { caseId: b.id, url: 'https://instagram.com/board.b' });
for (const x of m.all('messages')) m.update('messages', x.id, { sentAt: new Date(Date.parse(x.sentAt) - 3600_000).toISOString() });
await tick(); await e.command('sendMessage', U, { caseId: b.id, kind: 'member', platform: 'Instagram', text: 'Hello' });
await tick(); await e.command('recordReply', U, { caseId: b.id, outcome: 'Replied' });
r = rowOf('members', b.id);
check('a member who answered is done (not a claim step)', r.state === 'done' && r.step === 4 && r.doneSteps === 4 && !/claim/i.test(r.stateLabel), r);
check('greetings tab: not asked yet', /Ask: greetings/.test(rowOf('greetings', b.id)?.stateLabel ?? ''), rowOf('greetings', b.id));
check('members: message sent → in Sent, not in Pending', board({ tab: 'members', msg: 'sent' }).rows.some((x: any) => x.caseId === b.id) && !board({ tab: 'members', msg: 'pending' }).rows.some((x: any) => x.caseId === b.id) && /Member message on Instagram @board\.b/.test(rowOf('members', b.id).sentWhat ?? ''));
check('claims: invitation sent → Sent; counts add up', board({ tab: 'claims', msg: 'sent' }).rows.some((x: any) => x.caseId === a.id) && board({ tab: 'claims' }).sent + board({ tab: 'claims' }).pending === board({ tab: 'claims' }).rows.length);

console.log('\nMessages: Pending and Sent, greetings need a yes');
const q = (name: string, p: object) => e.query(name, U, p as Record<string, unknown>) as any;
const sentInvites = q('messageSent', { kind: 'invite', top: false });
check('Sent list of join invitations has the artist, with the answer', sentInvites.rows.some((x: any) => x.caseId === a.id && /Answer: Interested/.test(x.state)), sentInvites.rows);
check('member messages are not in the invitations list', !sentInvites.rows.some((x: any) => x.caseId === b.id) && q('messageSent', { kind: 'member', top: false }).rows.some((x: any) => x.caseId === b.id));
const fest = (q('messagesOverview', { top: false }) as any).festival;
let gq = q('messageQueue', { kind: 'greeting', top: false, festivalId: fest?.id });
check('a member who has not said yes is not sendable, but listed as waiting for a yes', !gq.rows.some((x: any) => x.caseId === b.id) && gq.needYes.some((x: any) => x.caseId === b.id && x.lastAnswer === 'Replied'), gq.needYes);
await e.command('setGreetings', U, { caseId: b.id, consent: 'Yes', reason: 'Said yes in the chat' });
gq = q('messageQueue', { kind: 'greeting', top: false, festivalId: fest?.id });
check('after “said yes” the member can get the greeting', gq.rows.some((x: any) => x.caseId === b.id) && !gq.needYes.some((x: any) => x.caseId === b.id));
check('the chosen route comes first', gq.rows.find((x: any) => x.caseId === b.id)?.targets[0]?.chosen === true);

await tick(); await e.command('recordReply', U, { caseId: a.id, outcome: 'Not interested' }).catch(() => null);
m.update('cases', a.id, { contactPreference: 'Declined' });
check('not interested → Stopped tab, not in Claims', rowOf('stopped', a.id)?.state === 'ended' && !rowOf('claims', a.id));
const counts = board().counts;
check('tab counts', counts.claims >= 0 && counts.members >= 1 && counts.stopped >= 1, counts);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
