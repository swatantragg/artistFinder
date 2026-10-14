// Messages (V2.5.0): direct messages on verified profiles, the Goongoonalo question first, limits, follow-ups 3/7/14,
// replies and opt-outs, festival greetings with consent, templates, and deleting a route. Fictional fixture data only.
import { fixtureEngine } from './fixtures/engine';
import type { Engine, Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';
import { addDays } from '../src/domain/util';

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
/** Let the next message through the "seconds between messages" rule (as if a minute had passed). */
const later = () => { for (const x of m.all('messages')) m.update('messages', x.id, { sentAt: new Date(Date.parse(x.sentAt) - 3600_000).toISOString() }); };
/** Move every message of a case back in time by n days. */
const backdate = (caseId: string, n: number) => { for (const x of m.byCase('messages', caseId)) m.update('messages', x.id, { sentAt: new Date(Date.parse(x.sentAt) - n * 86400_000).toISOString() }); };

// Two verified artists with a verified Instagram profile, still before outreach.
const insta = m.all('verifiedProfiles').filter(v => v.platform === 'Instagram' && v.verificationStatus === 'VERIFIED').map(v => m.get('cases', v.caseId)!).filter(c => c && !c.mergedIntoId);
const [a, b] = [...new Map(insta.map(c => [c.id, c])).values()];
if (!a || !b) { console.log('  ✗ fixture needs two artists with a verified Instagram profile'); process.exit(1); }
for (const c of [a, b]) m.update('cases', c.id, { lifecycleStage: 'Researching', contactPreference: 'Allowed', contactPreferenceUntil: null, claimStatus: 'Not Invited', goongoonaloStatus: 'PENDING', greetings: 'Unknown' });

console.log('First question: is the artist on Goongoonalo?');
const answer = q('messageQueue', { kind: 'answer', top: false });
check('unanswered artists are asked first', answer.rows.some((r: any) => r.caseId === a.id) && answer.rows.some((r: any) => r.caseId === b.id));
await rejects('no invitation before the answer', e.command('sendMessage', U, { caseId: a.id, kind: 'invite', platform: 'Instagram', text: 'Hi' }), /Answer first/);
await e.command('setGoongoonaloStatus', U, { caseId: a.id, status: 'NOT_MEMBER', reason: 'Answered in Messages' });
await e.command('setGoongoonaloStatus', U, { caseId: b.id, status: 'GOONGOONALO', reason: 'Answered in Messages' });
const inv = q('messageQueue', { kind: 'invite', top: false });
const row = inv.rows.find((r: any) => r.caseId === a.id);
check('“No” → join invitation, written for the artist', !!row && row.text.includes(a.canonicalName) && !row.text.includes('{name}'), row?.text);
check('the chat opens on the verified profile only', row?.targets.length > 0 && row.targets.every((t: any) => t.dmUrl.startsWith('https://ig.me/m/') || t.dmUrl.startsWith('https://x.com/') || t.dmUrl.startsWith('https://m.me/')), row?.targets);
check('“Yes” → member message, not the invitation', q('messageQueue', { kind: 'member', top: false }).rows.some((r: any) => r.caseId === b.id) && !inv.rows.some((r: any) => r.caseId === b.id));
await rejects('no message to a platform without a verified profile', e.command('sendMessage', U, { caseId: a.id, kind: 'invite', platform: 'Facebook', text: 'Hi' }), /verified Facebook|no verified/i);

console.log('\nSend: recorded as a contact attempt, follow-ups planned 3, 7 and 14 days out');
await e.command('sendMessage', U, { caseId: a.id, kind: 'invite', platform: 'Instagram', text: row.text, templateId: row.templateId });
const msgA = m.byCase('messages', a.id)[0];
const att = m.get('attempts', msgA?.attemptId);
check('message stored with its contact attempt', !!msgA && att?.channel === 'Instagram' && att.result === 'No Response' && att.routeId === null);
check('artist moves to Contact Attempted', m.get('cases', a.id)!.lifecycleStage === 'Contact Attempted');
check('follow-up #1 planned for day 3', m.byCase('tasks', a.id).some(t => t.kind === 'Follow-up' && t.dueDate === addDays(msgA.sentAt, 3) && t.status === 'Waiting'));
await rejects('the same invitation is not sent twice', e.command('sendMessage', U, { caseId: a.id, kind: 'invite', platform: 'Instagram', text: 'again' }), /already sent/);
await rejects('seconds between messages are enforced', e.command('sendMessage', U, { caseId: b.id, kind: 'member', platform: 'Instagram', text: 'Hi' }), /Wait \d+ s/);
later();
await e.command('sendMessage', U, { caseId: b.id, kind: 'member', platform: 'Instagram', text: 'Welcome' });
check('member message recorded; a member stays in their stage', m.byCase('messages', b.id).length === 1 && m.get('cases', b.id)!.lifecycleStage === 'Researching');

console.log('\nFollow-ups');
check('no follow-up before day 3', !q('messageQueue', { kind: 'followup', top: false }).rows.some((r: any) => r.caseId === a.id));
backdate(a.id, 3);
const fu = q('messageQueue', { kind: 'followup', top: false }).rows.find((r: any) => r.caseId === a.id);
check('follow-up #1 due on day 3', fu?.followUpNo === 1, fu);
for (const [n, back] of [[1, 4], [2, 7], [3, 0]] as const) {
  later();
  await e.command('sendMessage', U, { caseId: a.id, kind: 'followup', platform: 'Instagram', text: `Follow-up ${n}` });
  if (back) backdate(a.id, back);
}
const seq = m.byCase('messages', a.id);
check('at most 3 follow-ups, all in one sequence', seq.filter(x => x.followUpNo > 0).length === 3 && seq.every(x => x.sequenceId === seq[0].id));
later();
await rejects('no 4th follow-up', e.command('sendMessage', U, { caseId: a.id, kind: 'followup', platform: 'Instagram', text: 'Again' }), /No follow-up due/);
check('waiting list still offers a late reply', q('messageWaiting').rows.some((r: any) => r.caseId === a.id && r.exhausted));

console.log('\nReplies and opt-outs');
await e.command('recordReply', U, { caseId: a.id, outcome: 'Interested' });
check('“Interested” → Contact Confirmed, claim invitation next', m.get('cases', a.id)!.lifecycleStage === 'Contact Confirmed' && m.byCase('tasks', a.id).some(t => t.kind === 'Claim' && ['Queued', 'In Progress', 'Waiting'].includes(t.status)));
check('an answer ends the sequence', !q('messageWaiting').rows.some((r: any) => r.caseId === a.id));
await e.command('recordReply', U, { caseId: b.id, outcome: 'Do not disturb' });
const vb = q('verifiedArtists', { pageSize: 100 }).rows.find((r: any) => r.id === b.id);
check('“Do not disturb” → opted out, shown in Verified Artists', m.get('cases', b.id)!.contactPreference === 'Do Not Contact' && vb?.optOut === 'Do not disturb', vb);
later();
await rejects('nobody can message an opted-out artist', e.command('sendMessage', U, { caseId: b.id, kind: 'greeting', platform: 'Instagram', text: 'Hi' }), /not to be contacted|asked not/i);

console.log('\nFestival greetings: members who said yes');
const d = fixtureEngine(new MemoryStore()); await d.init();
const c = d.m.get('cases', b.id)!;
d.m.update('cases', c.id, { contactPreference: 'Allowed', goongoonaloStatus: 'GOONGOONALO', greetings: 'Unknown' });
const qd = (name: string, p: object = {}) => d.query(name, U, p as Record<string, unknown>) as any;
const diwali = qd('messagesOverview').festivals.find((f: any) => f.name === 'Diwali');
check('festival calendar includes regional festivals', ['Pongal', 'Onam', 'Baisakhi'].every(n => qd('messagesOverview').festivals.some((f: any) => f.name === n)));
check('no greeting without a yes', !qd('messageQueue', { kind: 'greeting', top: false, festivalId: diwali.id }).rows.some((r: any) => r.caseId === c.id));
await d.command('setGreetings', U, { caseId: c.id, consent: 'Yes' });
const g = qd('messageQueue', { kind: 'greeting', top: false, festivalId: diwali.id, templateId: 'auto' }).rows.find((r: any) => r.caseId === c.id);
check('with a yes: greeting written with the festival name and a way to stop', !!g && g.text.includes('Diwali') && /STOP/.test(g.text), g?.text);
await d.command('sendMessage', U, { caseId: c.id, kind: 'greeting', platform: 'Instagram', text: g.text, festivalId: diwali.id });
check('one greeting per festival', !qd('messageQueue', { kind: 'greeting', top: false, festivalId: diwali.id }).rows.some((r: any) => r.caseId === c.id));
await d.command('recordReply', U, { caseId: c.id, outcome: 'Stop greetings' });
check('“STOP” turns greetings off', d.m.get('cases', c.id)!.greetings === 'No');
const pongal = qd('messagesOverview').festivals.find((f: any) => f.name === 'Pongal');
await rejects('a festival without a date cannot be sent', d.command('sendMessage', U, { caseId: c.id, kind: 'greeting', platform: 'Instagram', text: 'x', festivalId: pongal.id }), /date|greetings/i);

console.log('\nTemplates and limits');
check('three message templates built in (+ greetings)', ['invite', 'member', 'followup'].every(k => qd('messagesOverview').templates.some((t: any) => t.kind === k && t.builtIn)));
const saved = await d.command('saveTemplate', U, { name: 'Short invite', kind: 'invite', language: 'Hindi', text: 'Namaste {name}!' });
check('a person can add their own template', qd('messagesOverview').templates.some((t: any) => t.id === saved.id && !t.builtIn));
await rejects('built-in templates cannot be deleted', d.command('deleteTemplate', U, { id: 'TM-invite' }), /cannot be deleted/);
await d.command('deleteTemplate', U, { id: saved.id });
check('own template deleted', !qd('messagesOverview').templates.some((t: any) => t.id === saved.id));
await d.command('saveMessageSettings', U, { daily: { Instagram: 1, X: 20, Facebook: 20 }, gapSeconds: 10 });
const other = d.m.all('cases').find(x => x.id !== c.id && d.m.byCase('verifiedProfiles', x.id).some(v => v.platform === 'Instagram' && v.verificationStatus === 'VERIFIED'))!;
d.m.update('cases', other.id, { contactPreference: 'Allowed', goongoonaloStatus: 'GOONGOONALO', lifecycleStage: 'Researching' });
for (const x of d.m.all('messages')) d.m.update('messages', x.id, { sentAt: new Date(Date.now() - 60_000).toISOString() });
await rejects('daily limit per platform', d.command('sendMessage', U, { caseId: other.id, kind: 'member', platform: 'Instagram', text: 'Hi' }), /limit/);

console.log('\nDelete a route');
const r = d.m.all('routes').find(x => x.state === 'Selected' || x.state === 'Verified')!;
const before = (d.query('caseRoutes', U, { id: r.targetCaseId }) as any[]).length;
await d.command('deleteRoute', U, { routeId: r.id, reason: 'Test route' });
check('deleted route disappears from the Routes tab', (d.query('caseRoutes', U, { id: r.targetCaseId }) as any[]).length === before - 1);
check('kept in the timeline', d.m.byCase('audit', r.targetCaseId).some(x => x.action === 'Route deleted' && x.entityId === r.id));
check('its graph connections are switched off', d.m.edgesOf(`route:${r.id}`).every(x => !x.active));
await rejects('cannot delete twice', d.command('deleteRoute', U, { routeId: r.id }), /already deleted/);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
