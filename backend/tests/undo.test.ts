// Undo and reset (V2.6.0): every step of the contact and claim processes can be undone (everything it changed goes back)
// and a whole process reset after typing RESET. Records stay, marked as undone. Fictional fixture data only.
import { fixtureEngine } from './fixtures/engine';
import type { Engine, Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';

class MemoryStore implements Store {
  async load(): Promise<Snapshot | null> { return null; }
  async save(_d: Dirty) {}
  async replace(_s: Snapshot) {}
}
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
async function rejects(name: string, p: Promise<unknown>, match: RegExp) {
  try { await p; check(name, false, 'no error'); } catch (e) { check(name, match.test((e as Error).message), (e as Error).message); }
}
const U = 'u-swatantra';
const e: Engine = fixtureEngine(new MemoryStore());
await e.init();
const m = e.m;
const q = (name: string, p: object = {}) => e.query(name, U, p as Record<string, unknown>) as any;
const later = () => { for (const x of m.all('messages')) m.update('messages', x.id, { sentAt: new Date(Date.parse(x.sentAt) - 3600_000).toISOString() }); };
const open = (caseId: string, kind: string) => m.byCase('tasks', caseId).filter(t => t.kind === kind && ['Queued', 'In Progress', 'Waiting'].includes(t.status));
/** Commands within one test run in the same millisecond rarely; keep steps apart so each has its own moment. */
const tick = () => new Promise(r => setTimeout(r, 5));

// An artist with no earlier claim, activation or contact history, given a verified Instagram profile.
const clean = (id: string) => !m.familyItems('claimEvents', id).length && !m.familyItems('activationEvents', id).length && !m.familyItems('attempts', id).length && !m.familyItems('routes', id).length;
const a = m.all('cases').find(c => !c.mergedIntoId && c.kind === 'Artist' && clean(c.id))!;
const now = new Date().toISOString();
m.insert('verifiedProfiles', { id: 'VP-UNDO', caseId: a.id, profileId: null, platform: 'Instagram', url: 'https://instagram.com/undo.test', username: 'undo.test', displayName: a.canonicalName, verificationStatus: 'VERIFIED', verifiedBy: U, verifiedAt: now, lastCheckedAt: now, source: 'test', evidence: 'test', replacedBy: null });
m.update('cases', a.id, { verifiedProfileCount: 1, artistStatus: 'VERIFIED', manualVerifiedAt: now, manualVerifiedBy: U, firstVerifiedAt: now });
m.update('cases', a.id, { lifecycleStage: 'Researching', contactPreference: 'Allowed', contactPreferenceUntil: null, claimStatus: 'Not Invited', goongoonaloStatus: 'PENDING' });
await e.command('setGoongoonaloStatus', U, { caseId: a.id, status: 'NOT_MEMBER', reason: 'Answered' });

console.log('Contact: undo a sent message');
await tick();
await e.command('sendMessage', U, { caseId: a.id, kind: 'invite', platform: 'Instagram', text: 'Hi there' });
check('sent: Contact Attempted with a follow-up task', m.get('cases', a.id)!.lifecycleStage === 'Contact Attempted' && open(a.id, 'Follow-up').length === 1);
await rejects('undo needs a reason', e.command('undoStep', U, { caseId: a.id, process: 'contact' }), /reason|Why/i);
await tick();
await e.command('undoStep', U, { caseId: a.id, process: 'contact', reason: 'Clicked by mistake' });
const msg = m.byCase('messages', a.id)[0];
check('message and its contact attempt are kept, marked undone', !!msg.undoneAt && !!m.get('attempts', msg.attemptId)!.undoneAt);
check('stage back to Researching, follow-up cancelled', m.get('cases', a.id)!.lifecycleStage === 'Researching' && open(a.id, 'Follow-up').length === 0);
check('the invitation can be sent again', q('messageQueue', { kind: 'invite', top: false }).rows.some((r: any) => r.caseId === a.id));
check('the undo is in the timeline', m.byCase('audit', a.id).some(x => x.action === 'Step undone'));

console.log('\nContact: “Not interested” by mistake');
later(); await tick();
await e.command('sendMessage', U, { caseId: a.id, kind: 'invite', platform: 'Instagram', text: 'Hi again' });
await tick();
await e.command('recordReply', U, { caseId: a.id, outcome: 'Not interested' });
check('declined: case closed, opted out', m.get('cases', a.id)!.lifecycleStage === 'Closed' && m.get('cases', a.id)!.contactPreference === 'Declined');
const pv = q('caseProcess', { id: a.id }).contact;
check('process shows it ended, next step = undo', !!pv.ended && pv.nextAction === 'undo', pv);
await tick();
await e.command('undoStep', U, { caseId: a.id, process: 'contact', reason: 'Wrong button' });
const c1 = m.get('cases', a.id)!;
check('undo: contact allowed again, case open, back in Contact Attempted', c1.contactPreference === 'Allowed' && c1.lifecycleStage === 'Contact Attempted' && !c1.closedReason, [c1.contactPreference, c1.lifecycleStage]);
check('the follow-up the answer cancelled is open again', open(a.id, 'Follow-up').length === 1);
check('waiting for the answer again', q('messageWaiting').rows.some((r: any) => r.caseId === a.id));

console.log('\nClaim: undo steps one by one, then reset');
await tick();
await e.command('recordReply', U, { caseId: a.id, outcome: 'Interested' });
check('interested → Contact Confirmed', m.get('cases', a.id)!.lifecycleStage === 'Contact Confirmed');
for (const [cmd, p] of [['sendClaimInvitation', { profileId: 'GG-1', recipient: 'Artist' }], ['recordClaimSubmission', { claimRequestId: 'CR-1' }], ['sendClaimToReview', { reviewerId: U }], ['reviewClaim', { decision: 'Approve', notes: 'ID checked' }]] as const) {
  await tick(); await e.command(cmd, U, { caseId: a.id, ...p });
}
check('claim approved', m.get('cases', a.id)!.claimStatus === 'Approved' && open(a.id, 'Backend Check').length === 1);
await rejects('contact cannot be undone while the claim runs', e.command('undoStep', U, { caseId: a.id, process: 'contact', reason: 'x' }), /claim/i);
await tick();
await e.command('undoStep', U, { caseId: a.id, process: 'claim', reason: 'Approved too early' });
const c2 = m.get('cases', a.id)!;
check('undo approval: back in review, backend check cancelled, review task open again', c2.claimStatus === 'In Review' && open(a.id, 'Backend Check').length === 0 && open(a.id, 'Claim Review').length === 1, [c2.claimStatus]);
check('claim record ignores the undone approval', !q('caseClaims', { id: a.id }).fields.approvedAt);
await rejects('reset needs RESET', e.command('resetProcess', U, { caseId: a.id, process: 'claim', reason: 'Start over', confirm: 'yes' }), /RESET/);
await tick();
await e.command('resetProcess', U, { caseId: a.id, process: 'claim', reason: 'Start over', confirm: 'RESET' });
const c3 = m.get('cases', a.id)!;
check('reset: Not Invited, back to Contact Confirmed', c3.claimStatus === 'Not Invited' && c3.lifecycleStage === 'Contact Confirmed', [c3.claimStatus, c3.lifecycleStage]);
check('every claim event kept, marked undone', m.byCase('claimEvents', a.id).length >= 4 && m.byCase('claimEvents', a.id).every(x => !!x.undoneAt));
check('next task: send the claim invitation again', open(a.id, 'Claim').some(t => /claim invitation/i.test(t.step)));

console.log('\nReset the contact process');
await tick();
await e.command('resetProcess', U, { caseId: a.id, process: 'contact', reason: 'Start over', confirm: 'RESET' });
const c4 = m.get('cases', a.id)!;
check('reset: back to Researching, no live attempts or messages', c4.lifecycleStage === 'Researching' && m.byCase('attempts', a.id).every(x => !!x.undoneAt) && m.byCase('messages', a.id).every(x => !!x.undoneAt), c4.lifecycleStage);
check('process starts over: next is the first message', q('caseProcess', { id: a.id }).contact.nextAction === 'messages');

console.log('\nChoose the artist’s own profile as the route');
await tick();
await e.command('useProfileAsRoute', U, { caseId: a.id, url: 'https://instagram.com/undo.test' });
const route = m.byCase('routes', a.id).find(r => r.sourceUrl === 'https://instagram.com/undo.test');
check('route created from the verified profile and selected', route?.state === 'Selected' && route.origin === 'Verified profile' && m.get('cases', a.id)!.lifecycleStage === 'Route Ready', [route?.state, m.get('cases', a.id)!.lifecycleStage]);
await e.command('useProfileAsRoute', U, { caseId: a.id, url: 'https://instagram.com/undo.test' });
check('choosing it again does not make a second route', m.byCase('routes', a.id).filter(r => r.sourceUrl === 'https://instagram.com/undo.test').length === 1);
later(); await tick();
await e.command('sendMessage', U, { caseId: a.id, kind: 'invite', platform: 'Instagram', text: 'Hi via the route' });
const viaRoute = m.byCase('messages', a.id).filter(x => !x.undoneAt).pop()!;
check('the message is recorded on that route', m.get('attempts', viaRoute.attemptId)!.routeId === route!.id);

console.log('\nActivation is part of the claim: undo and reset still work after it');
await tick(); await e.command('recordReply', U, { caseId: a.id, outcome: 'Interested' });
for (const [cmd, p] of [['sendClaimInvitation', { profileId: 'GG-2', recipient: 'Artist' }], ['recordClaimSubmission', { claimRequestId: 'CR-2' }], ['sendClaimToReview', { reviewerId: U }], ['reviewClaim', { decision: 'Approve', notes: 'ID checked' }], ['verifyBackendClaim', { outcome: 'Verified', backendRef: 'ADMIN-1' }], ['verifyAccess', { evidence: 'Logged in with the artist' }]] as const) {
  await tick(); await e.command(cmd, U, { caseId: a.id, ...p });
}
check('claimed and activation started', m.get('cases', a.id)!.claimStatus === 'Completed' && m.get('cases', a.id)!.activationStatus === 'Access Verified');
const pv2 = q('caseProcess', { id: a.id });
check('undo and reset are available (no longer blocked by activation)', !pv2.claim.canUndo && !pv2.claim.canReset && !pv2.all.canReset, pv2.claim);
await tick(); await e.command('undoStep', U, { caseId: a.id, process: 'claim', reason: 'Access was a mistake' });
const c5 = m.get('cases', a.id)!;
check('undo: access verification taken back first (Claimed, not started)', c5.activationStatus === 'Not Started' && c5.lifecycleStage === 'Claimed' && m.byCase('activationEvents', a.id).every(x => !!x.undoneAt), [c5.activationStatus, c5.lifecycleStage]);
await tick(); await e.command('resetProcess', U, { caseId: a.id, process: 'all', reason: 'Start again from the beginning', confirm: 'RESET' });
const c6 = m.get('cases', a.id)!;
check('reset everything: claim Not Invited, no live contact, back before the first message', c6.claimStatus === 'Not Invited' && m.byCase('attempts', a.id).every(x => !!x.undoneAt) && ['Route Ready', 'Researching'].includes(c6.lifecycleStage), [c6.claimStatus, c6.lifecycleStage]);
check('the chosen route stays (it is still a good way to reach the artist)', m.get('routes', route!.id)!.state === 'Selected');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
