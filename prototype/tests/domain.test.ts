// Domain acceptance tests: the Rahul Sharma walkthrough (spec §36) and the business rules (spec §45, §63, §69), on the
// fictional fixture workspace. Runs against the same engine the app uses, with an in-memory store. `npm test`
import { fixtureFile, fixtureXlsxRows } from './fixtures/catalog';
import { FAST, fixtureEngine, fixtureProviderSet, setFixtureOutage } from './fixtures/engine';
import { normalizeProfileUrl } from '../src/domain/discovery/normalize';
import { artistQueries, buildFacts, collaboratorQueries } from '../src/domain/discovery/queries';
import { artistProfileUrl } from '../src/domain/discovery/normalize';
import { scoreProfile } from '../src/domain/discovery/evidence';
import { isArtistProfile, pickRelevant, relevantOpen } from '../src/domain/discovery/relevance';
import { nid, pathText } from '../src/domain/graph';
import { rescoreOpenCandidates } from '../src/domain/discovery/pipeline';
import type { DiscoveryProvider } from '../src/domain/discovery/providers';
import { Engine, type Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';
import { addDays } from '../src/domain/util';

class MemoryStore implements Store {
  saves = 0;
  failNext = false;
  async load(): Promise<Snapshot | null> { return null; }
  async save(_d: Dirty) { if (this.failNext) { this.failNext = false; throw new Error('disk full'); } this.saves++; }
  async replace(_s: Snapshot) {}
}

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
async function rejects(name: string, p: Promise<unknown>, match: RegExp) {
  try { await p; check(name, false, 'no error'); } catch (e) { check(name, match.test((e as Error).message), (e as Error).message); }
}
const enc = (s: string) => new TextEncoder().encode(s);

const store = new MemoryStore();
const eng = fixtureEngine(store);
const t0 = Date.now();
await eng.init();
const m = eng.m;
console.log(`Seeded fixtures in ${Date.now() - t0} ms`);
const U = 'u-swatantra';
const q = (name: string, p: Record<string, unknown> = {}) => eng.query(name, U, p) as any;
const caseOf = (aid: string) => m.get('cases', m.canonical(m.idx.caseByBackendId.get(aid)!))!;
const songsOf = (aid: string) => m.trackIdsOfCase(caseOf(aid).id).length;

console.log('\nSeed data (spec §35)');
const live = m.all('cases').filter(c => !c.mergedIntoId);
const byStage = (s: string) => live.filter(c => c.lifecycleStage === s).length;
check('about 1,250 artist cases', live.length >= 1240 && live.length <= 1260, live.length);
check('30+ songs', m.count('tracks') >= 30, m.count('tracks'));
for (const [stage, min] of [['Identity Review', 2], ['Waiting for Evidence', 3], ['Researching', 3], ['Route Ready', 2], ['Contact Attempted', 2], ['Contact Confirmed', 2], ['Claim Review', 2], ['Activated', 2], ['Ongoing ARM', 1]] as [string, number][]) {
  check(`at least ${min} in ${stage}`, byStage(stage) >= min, byStage(stage));
}
const allStages = ['Unresearched', 'Identity Review', 'Researching', 'Waiting for Evidence', 'Route Ready', 'Introduction Pending', 'Contact Attempted', 'Contact Confirmed', 'Claim Invited', 'Claim Submitted', 'Claim Review', 'Claimed', 'Activation Pending', 'Activated', 'Ongoing ARM', 'Closed'];
check('every lifecycle stage has at least one case', allStages.every(s => byStage(s) > 0), allStages.filter(s => !byStage(s)));
check('broken rows from Batch 001 are quarantined, not dropped', m.all('importRows').filter(r => r.status === 'Quarantined').length === 2);
check('every open task has an owner or a reason', m.all('tasks').filter(t => ['Queued', 'In Progress', 'Waiting'].includes(t.status)).every(t => t.why));

console.log('\nRahul Sharma before Batch 002');
const rahul0 = caseOf('A001');
const rahulId = rahul0.id;
check('Rahul is Waiting for Evidence', rahul0.lifecycleStage === 'Waiting for Evidence', rahul0.lifecycleStage);
check('Rahul has 12 songs', songsOf('A001') === 12, songsOf('A001'));
const researchBefore = m.byCase('research', rahulId).map(r => r.id).join(',');
const routesBefore = m.byCase('routes', rahulId).length;
check('Rahul has two tested routes (rejected + exhausted)', m.byCase('routes', rahulId).filter(r => r.state === 'Rejected' || r.state === 'Exhausted').length === 2);
check('waiting record lists blocker, tested routes and next review', !!rahul0.waiting?.blocker && rahul0.waiting.routesTested.length === 2 && !!rahul0.waiting.nextReviewDate);
const casesBefore = m.count('cases'), tracksBefore = m.count('tracks'), creditsBefore = m.count('credits'), tasksBefore = m.count('tasks'), routesTotal = m.count('routes');

console.log('\nBatch 002 (spec §36)');
const f2 = fixtureFile('b002');
const b2 = await eng.upload({ filename: f2.filename, bytes: enc(f2.csv) }, U);
const rahul = caseOf('A001');
check('processed', b2.status === 'Processed', b2.status);
check('Rahul remains the same case', rahul.id === rahulId);
check('no new artist case', m.count('cases') === casesBefore, m.count('cases') - casesBefore);
check('only 5 genuinely new songs', b2.summary.newSongs === 5 && m.count('tracks') === tracksBefore + 5, b2.summary.newSongs);
check('Rahul now has 17 songs', songsOf('A001') === 17, songsOf('A001'));
check('12 known rows skipped as unchanged', b2.skippedCount === 12, b2.skippedCount);
check('Joshua Singh relationship added', m.creditsOfCase(caseOf('A030').id).some(cr => m.get('tracks', cr.trackId)!.backendTrackId === 'T9001'));
check('Rahul reopened (Researching, work reason New Lead)', rahul.lifecycleStage === 'Researching' && rahul.workReason === 'New Lead', [rahul.lifecycleStage, rahul.workReason]);
check('exactly one case reopened', b2.summary.reopenedCases === 1 && b2.summary.reopenedCaseIds[0] === rahulId, b2.summary.reopenedCaseIds);
check('exactly one new route', b2.summary.newRoutes === 1 && m.count('routes') === routesTotal + 1 && m.byCase('routes', rahulId).length === routesBefore + 1, b2.summary.newRoutes);
const newRoute = m.get('routes', b2.summary.routeIds[0])!;
check('route goes Rahul → new song → Joshua → verified contact', newRoute.collaboratorName === 'Joshua Singh' && m.get('tracks', newRoute.trackId!)!.title === 'Dil Ka Safar 2' && !!m.get('contacts', newRoute.contactId!)?.verified);
check('exactly one new task', b2.summary.newTasks === 1, b2.summary.taskIds);
const openRahul = m.byCase('tasks', rahulId).filter(t => ['Queued', 'In Progress', 'Waiting'].includes(t.status));
check('Rahul has one open task: contact Joshua for an introduction', openRahul.length === 1 && /Joshua Singh/.test(openRahul[0].step), openRahul.map(t => t.step));
check('previous research untouched', m.byCase('research', rahulId).map(r => r.id).join(',') === researchBefore);
const reopen = m.byCase('reopens', rahulId).pop();
check('UI can show why it reopened', !!reopen && /Joshua Singh/.test(reopen.why) && reopen.batchId === b2.id, reopen?.why);
const detail = q('caseDetail', { id: rahulId });
check('dossier shows reopen reason and next action', !!detail.reopen && /Joshua/.test(detail.case.nextAction ?? ''), detail.case.nextAction);

console.log('\nBatch 003 = exact copy of Batch 002');
const snap = { cases: m.count('cases'), tracks: m.count('tracks'), credits: m.count('credits'), routes: m.count('routes'), tasks: m.count('tasks') };
const f3 = fixtureFile('b003');
const b3 = await eng.upload({ filename: f3.filename, bytes: enc(f3.csv) }, U);
check('repeat detected', b3.status === 'Repeat' && b3.repeatOfId === b2.id, [b3.status, b3.repeatOfId]);
check('no new artist / song / credit / route / task', m.count('cases') === snap.cases && m.count('tracks') === snap.tracks && m.count('credits') === snap.credits && m.count('routes') === snap.routes && m.count('tasks') === snap.tasks);
check('audit says existing batch retained', m.all('audit').some(a => a.entityId === b3.id && a.result === 'Existing batch retained. No duplicate work created.'));
const b2again = await eng.upload({ filename: 'renamed_copy.csv', bytes: enc(f2.csv) }, U);
check('same content under another name is still a repeat', b2again.status === 'Repeat');
void creditsBefore; void tasksBefore;

console.log('\nBatch 004 (mixed) and its corrected version');
const lata = caseOf('A027');
const lataTasks = m.byCase('tasks', lata.id).length;
const f4 = fixtureFile('b004');
const b4 = await eng.upload({ filename: f4.filename, bytes: enc(f4.csv) }, U);
check('row without artist ID quarantined with a reason', b4.quarantinedCount === 1 && m.all('importRows').some(r => r.batchId === b4.id && r.status === 'Quarantined' && /artist identifier/.test(r.reason ?? '')));
check('new artist Farhan Ali created', !!m.idx.caseByBackendId.get('A3001') && b4.summary.artistsCreated === 1, b4.summary.artistsCreated);
check('metadata change on Amit Kumar recorded with history', m.all('tracks').some(t => t.history.some(h => h.batchId === b4.id && h.to === 'Remastered 2026')));
check('do-not-contact survives import: no task for Lata Joshi', caseOf('A027').lifecycleStage === 'Closed' && m.byCase('tasks', lata.id).length === lataTasks && caseOf('A027').contactPreference === 'Do Not Contact');
check('waiting Aditya got the new song but no fake lead', caseOf('A009').lifecycleStage === 'Waiting for Evidence' && songsOf('A009') === 4);
const f4b = fixtureFile('b004fix');
const b4b = await eng.upload({ filename: f4b.filename, bytes: enc(f4b.csv) }, U);
check('corrected file becomes version 2 of the earlier batch', b4b.version === 2 && b4b.versionOfId === b4.id, [b4b.version, b4b.versionOfId]);
check('fixed row accepted, Zoya Merchant created', !!m.idx.caseByBackendId.get('A3002'));
check('earlier batch and its rows kept', !!m.get('batches', b4.id) && m.all('importRows').some(r => r.batchId === b4.id));

console.log('\nRahul: contact → claim → backend verification → activation → ARM');
const L = 'u-meenal', D = 'u-dev';
const run = (name: string, p: Record<string, unknown>, user = U) => eng.command(name, user, p);
await run('updateRoute', { routeId: newRoute.id, state: 'Selected', reason: 'Joshua is a willing introducer' });
check('route selected → Route Ready', caseOf('A001').lifecycleStage === 'Route Ready');
check('no duplicate task when selecting the same route', m.byCase('tasks', rahulId).filter(t => ['Queued', 'In Progress', 'Waiting'].includes(t.status)).length === 1);
await run('recordContactAttempt', { caseId: rahulId, routeId: newRoute.id, channel: 'Introducer', recipient: 'Joshua Singh', message: 'Asked for an intro', result: 'Introduction Requested', evidence: 'WhatsApp', nextAction: 'Wait for intro' });
check('introducer contacted ≠ artist contacted (Introduction Pending)', caseOf('A001').lifecycleStage === 'Introduction Pending');
await rejects('cannot send claim before confirmed contact', run('sendClaimInvitation', { caseId: rahulId, profileId: 'A001', recipient: 'Rahul' }), /after the conversation is confirmed/);
await run('recordContactAttempt', { caseId: rahulId, routeId: newRoute.id, channel: 'Phone', recipient: 'Rahul Sharma', message: 'Intro call', result: 'Conversation Confirmed', evidence: 'Call 14:10', nextAction: 'Send claim invitation' });
check('Contact Confirmed', caseOf('A001').lifecycleStage === 'Contact Confirmed');
await run('sendClaimInvitation', { caseId: rahulId, profileId: 'A001', recipient: 'Rahul Sharma' });
check('Claim Invited (claimStatus Invited, not Submitted)', caseOf('A001').claimStatus === 'Invited');
await rejects('cannot mark claimed from Claim Invited', run('changeStage', { caseId: rahulId, stage: 'Claimed', reason: 'try' }), /backend verification/);
await run('recordClaimSubmission', { caseId: rahulId, claimRequestId: 'CR-TEST-1' });
await run('sendClaimToReview', { caseId: rahulId, reviewerId: D });
await rejects('operator cannot approve claims', run('reviewClaim', { caseId: rahulId, decision: 'Approve', notes: 'ok' }, 'u-vikram'), /cannot do this/);
await run('reviewClaim', { caseId: rahulId, decision: 'Approve', notes: 'ID checked' }, D);
check('approved is not completed', caseOf('A001').claimStatus === 'Approved' && caseOf('A001').lifecycleStage === 'Claim Review');
await rejects('cannot verify access before backend verification', run('verifyAccess', { caseId: rahulId, evidence: 'x' }), /backend-verified claim/);
await run('verifyBackendClaim', { caseId: rahulId, outcome: 'Verified', backendRef: 'ADMIN-A001' }, D);
check('Claimed after backend verification', caseOf('A001').lifecycleStage === 'Claimed' && caseOf('A001').claimStatus === 'Completed');
await run('verifyAccess', { caseId: rahulId, evidence: 'Logged in' });
await run('recordFirstUse', { caseId: rahulId, kind: 'Login only', evidence: 'login' });
check('login alone is not activation', caseOf('A001').lifecycleStage === 'Activation Pending');
await rejects('meaningful use needs evidence', run('recordFirstUse', { caseId: rahulId, kind: 'Meaningful use' }), /backend event reference or verified evidence/);
await run('selectFeature', { caseId: rahulId, feature: 'Artist Post', agreedDate: addDays(eng.ctx().today, 1) });
await run('recordFirstUse', { caseId: rahulId, kind: 'Meaningful use', backendRef: 'EVT-1' });
check('Activated', caseOf('A001').lifecycleStage === 'Activated' && caseOf('A001').activationStatus === 'Activated');
await run('handoverToArm', { caseId: rahulId, relationshipOwnerId: L });
check('Ongoing ARM with participation check task', caseOf('A001').lifecycleStage === 'Ongoing ARM' && m.byCase('tasks', rahulId).some(t => t.kind === 'ARM' && t.status === 'Waiting'));
check('every step is in the audit timeline', m.byCase('audit', rahulId).filter(a => a.action === 'Lifecycle stage changed').length >= 9);

console.log('\nRules (spec §45, §69)');
const amit = caseOf('A003');
await rejects('closing needs a reason', run('closeCase', { caseId: amit.id, reason: '' }), /reason is required/);
await rejects('rejecting a route needs a reason', run('updateRoute', { routeId: m.byCase('routes', caseOf('A012').id)[0].id, state: 'Rejected' }), /reason/);
await rejects('Route Ready needs a selected route', run('changeStage', { caseId: amit.id, stage: 'Route Ready', reason: 'x' }), /selected, verified route/);
await rejects('no outreach to a do-not-contact artist', run('reopenCase', { caseId: lata.id, reason: 'x' }), /asked not to be contacted/);
const sameTask = { caseId: amit.id, step: 'Call back', dueDate: eng.ctx().today };
await run('createTask', sameTask);
await rejects('duplicate open task is refused', run('createTask', sameTask), /equivalent open task/);
const conflict = m.all('conflicts').find(c => c.status === 'Open' && c.caseIds.includes(caseOf('A214').id))!;
await rejects('cannot research during identity review', run('startResearch', { caseId: caseOf('A214').id }), /identity conflict/);
await run('decideIdentity', { conflictId: conflict.id, decision: 'Same Person', canonicalId: caseOf('A002').id, reason: 'Same artist', evidence: 'Same phone on both profiles' }, L);
check('merge keeps both artist IDs on one case', caseOf('A214').id === caseOf('A002').id && caseOf('A002').backendProfileIds.includes('A214'));
const dec = m.all('decisions').find(d => d.conflictId === conflict.id && !d.reversedAt)!;
await run('reverseIdentityDecision', { decisionId: dec.id, reason: 'Different people after all' }, L);
check('merge is reversible', !m.get('cases', m.idx.caseByBackendId.get('A214')!)!.mergedIntoId && m.idx.caseByBackendId.get('A214') !== caseOf('A002').id);

console.log('\nAtomic writes');
const before = m.count('audit');
store.failNext = true;
await rejects('failed save is reported', run('addResearch', { caseId: amit.id, source: 'Google', result: 'x' }), /disk full/);
check('failed save leaves nothing behind', m.count('audit') === before && !m.byCase('research', amit.id).some(r => r.result === 'x'));
const tasksNow = m.count('tasks');
await rejects('rule failure midway rolls back', run('moveToWaiting', { caseId: amit.id, blocker: 'x' }), /Next review date is required/);
check('no partial changes after a rejected command', m.count('tasks') === tasksNow);

console.log('\nNew verified contact reopens a waiting case (no new song needed)');
{
  const e2 = fixtureEngine(new MemoryStore());
  await e2.init();
  const m2 = e2.m;
  const rid = m2.canonical(m2.idx.caseByBackendId.get('A001')!);
  const sameerM = m2.canonical(m2.idx.caseByBackendId.get('A040')!);
  const added = await e2.command('addContact', 'u-vikram', { personName: 'Sameer Mehta', caseId: sameerM, role: 'Collaborator', channel: 'Phone', value: '+91 90000 00140 (demo)', authorityEvidence: 'Producer on Rahul’s songs' });
  check('unverified contact does not reopen anything', m2.get('cases', rid)!.lifecycleStage === 'Waiting for Evidence');
  const res = await e2.command('verifyContact', 'u-vikram', { contactId: added.id, evidence: 'Spoke to Sameer on the phone' });
  const r2 = m2.get('cases', rid)!;
  check('verifying the collaborator contact reopens Rahul', r2.lifecycleStage === 'Researching' && r2.workReason === 'New Lead', [r2.lifecycleStage, (res as any).message]);
  check('exactly one route and one open task for Rahul from it', m2.byCase('routes', rid).filter(r => r.contactId === added.id).length === 1 && m2.byCase('tasks', rid).filter(t => ['Queued', 'In Progress', 'Waiting'].includes(t.status)).length === 1);
  const routesNow = m2.count('routes'), tasksNow2 = m2.count('tasks');
  const f2b = fixtureFile('b002');
  await e2.upload({ filename: f2b.filename, bytes: enc(f2b.csv) }, U);
  check('a later import does not duplicate that lead', m2.byCase('routes', rid).filter(r => r.contactId === added.id).length === 1);
  check('Joshua lead is still added as a second route, no extra reopen', m2.count('routes') === routesNow + 1 && m2.byCase('reopens', rid).length === 1, [m2.count('routes') - routesNow, m2.count('tasks') - tasksNow2]);
}

console.log('\nSongs and credits added by hand (spec §64)');
{
  const e3 = fixtureEngine(new MemoryStore());
  await e3.init();
  const m3 = e3.m;
  const pooja = m3.canonical(m3.idx.caseByBackendId.get('A016')!);
  const before3 = m3.trackIdsOfCase(pooja).length;
  const song = await e3.command('addSong', U, { caseId: pooja, title: 'Kinare Ki Dhun', role: 'Singer', source: 'Found on a streaming page (fixture)' });
  check('song linked to the artist', m3.trackIdsOfCase(pooja).length === before3 + 1);
  await rejects('same track ID cannot be added twice', e3.command('addSong', U, { caseId: pooja, title: 'x', backendTrackId: m3.get('tracks', song.id!)!.backendTrackId }), /already exists/);
  const joshua = m3.canonical(m3.idx.caseByBackendId.get('A030')!);
  await e3.command('addCredit', U, { trackId: song.id, personCaseId: joshua, role: 'Composer' });
  const p3 = m3.get('cases', pooja)!;
  check('credit for a verified collaborator reopens the waiting artist', p3.lifecycleStage === 'Researching' && m3.byCase('routes', pooja).some(r => r.collaboratorName === 'Joshua Singh'), p3.lifecycleStage);
  check('the song now has two credits', m3.creditsOfTrack(song.id!).length === 2);
  await rejects('duplicate credit refused', e3.command('addCredit', U, { trackId: song.id, personCaseId: joshua, role: 'Composer' }), /already credited/);
}

console.log('\nArtist discovery engine (spec §89)');
{
  const ed = fixtureEngine(new MemoryStore());
  await ed.init();
  const md = ed.m;
  const C = (aid: string) => md.canonical(md.idx.caseByBackendId.get(aid)!);
  const rid = C('A001');
  const open = (id: string) => md.byCase('profiles', id).filter(p => p.verificationStatus === 'UNREVIEWED');
  check('Rahul starts with discovery not started', md.get('cases', rid)!.discoveryStatus === 'Not started');
  const qs = artistQueries(buildFacts(md, rid), 'full');
  check('only the artist is searched: name, platforms (site:), role; ISRCs only as artist lookups', ['name', 'site', 'role', 'isrc'].every(k => qs.some(q => q.kind === k)) && !qs.some(q => ['song', 'label', 'distributor', 'collaborator'].includes(q.kind)), qs.map(q => q.query));
  check('no collaborator searches', collaboratorQueries(buildFacts(md, rid), 'full').length === 0);
  const web = fixtureProviderSet(() => md).providers;
  check('ISRCs go to Spotify only; YouTube only searches channels by name', web.filter(x => x.handles({ query: '"X"', kind: 'isrc', priority: 1, subject: 'artist', subjectName: 'X', subjectKey: 'x', isrc: 'X' })).map(x => x.id).join() === 'fixture-spotify' && !web.find(x => x.id === 'fixture-youtube')!.handles({ query: '"X" site:youtube.com', kind: 'site', priority: 1, subject: 'artist', subjectName: 'X', subjectKey: 'x' }));
  const keep = (u: string) => artistProfileUrl(u)?.normalized ?? null;
  check('artist profile links kept, song/track/video/album pages dropped', keep('https://open.spotify.com/artist/abc') === 'open.spotify.com/artist/abc' && !keep('https://open.spotify.com/track/abc') && !keep('https://www.youtube.com/watch?v=abc') && !keep('https://shazam.com/song/1/x') && !keep('https://music.apple.com/in/album/x/1') && !!keep('https://www.youtube.com/@artist') && !keep('https://www.instagram.com/p/xyz/') && !keep('https://example.com/some/article'));
  check('a SoundCloud track or an X post keeps its account', keep('https://soundcloud.com/artist-name/some-track') === 'soundcloud.com/artist-name' && keep('https://x.com/artist/status/1') === 'x.com/artist');
  // match %: the artist's own profile clears 50%, a fan page or another person does not
  const facts = buildFacts(md, rid);
  const base = { platform: 'Instagram' as const, title: '', description: '', location: null, language: null, links: [], tracks: [] };
  const own = scoreProfile({ ...base, normalizedUrl: 'instagram.com/rahulsharmaofficial', displayName: 'Rahul Sharma', username: 'rahulsharmaofficial', description: 'Singer. New music every month' }, facts).score;
  const fan = scoreProfile({ ...base, normalizedUrl: 'instagram.com/rahulsharmafans', displayName: 'Rahul Sharma Fan Club', username: 'rahulsharmafans' }, facts).score;
  const other = scoreProfile({ ...base, normalizedUrl: 'instagram.com/chef.rahul', displayName: 'Chef Rahul', username: 'chef.rahul', description: 'Chef and food blogger' }, facts).score;
  check('match %: own profile ≥ 50, fan page and another person < 50', own >= 50 && fan < 50 && other < 50, { own, fan, other });
  const mk = (id: string, score: number, url: string, platform: string, status = 'UNREVIEWED') => ({ id, evidenceScore: score, url, normalizedUrl: normalizeProfileUrl(url)!.normalized, platform, verificationStatus: status, changeOfProfileId: null, followers: null }) as never;
  check('50% and above shown, weaker ones hidden', pickRelevant([mk('a', 80, 'https://instagram.com/a', 'Instagram'), mk('b', 40, 'https://instagram.com/b', 'Instagram')]).map((x: { id: string }) => x.id).join() === 'a');
  check('nothing reaches 50%: the best two are shown', pickRelevant([mk('c', 10, 'https://instagram.com/c', 'Instagram'), mk('a', 30, 'https://instagram.com/a', 'Instagram'), mk('b', 20, 'https://youtube.com/@b', 'YouTube')]).map((x: { id: string }) => x.id).join() === 'a,b');
  check('a single weak profile is still shown', pickRelevant([mk('a', 25, 'https://open.spotify.com/artist/a', 'Spotify')]).length === 1);
  check('song, track and video pages are never shown, whatever their score', pickRelevant([mk('s', 95, 'https://open.spotify.com/track/x', 'Spotify'), mk('v', 90, 'https://www.youtube.com/watch?v=x', 'YouTube')]).length === 0);
  check('same profile in different URL shapes normalizes to one', normalizeProfileUrl('instagram.com/rahulsharma/')!.normalized === normalizeProfileUrl('https://www.instagram.com/rahulsharma?hl=en')!.normalized);
  const started = await ed.command('startDiscovery', U, { caseId: rid });
  check('Find artist queues a background job and returns at once', ['QUEUED', 'SEARCHING'].includes(md.get('discoveryJobs', started.id!)!.status));
  await rejects('a second Find artist while searching is refused', ed.command('startDiscovery', U, { caseId: rid }), /already running/);
  await ed.idle();
  const job = md.get('discoveryJobs', started.id!)!;
  check('job finished and waits for a person', job.status === 'NEEDS_REVIEW' && job.steps.every(s => s.state === 'done' || s.state === 'skipped'), job.status);
  const profs = md.byCase('profiles', rid);
  const by = (pl: string, u?: string) => profs.find(p => p.platform === pl && (!u || p.username === u))!;
  check('finds Instagram, YouTube, Spotify, Facebook and a website', ['Instagram', 'YouTube', 'Spotify', 'Facebook', 'Website'].every(pl => profs.some(p => p.platform === pl)));
  const rel = relevantOpen(md, rid);
  check('candidates shown: 50% match or more, best first', rel.length >= 5 && rel.every(p => p.evidenceScore >= 50) && rel.every((p, i) => i === 0 || rel[i - 1].evidenceScore >= p.evidenceScore), rel.map(p => p.evidenceScore));
  check('only artist profile links are candidates', profs.every(p => isArtistProfile(p)));
  // candidates stored by an older search with the old score are re-scored once (upgrade v2.1), statuses follow
  {
    const target = rel[0];
    md.update('profiles', target.id, { evidenceScore: 7, strength: 'WEAK' });
    const changedN = rescoreOpenCandidates(md, ed.ctx(U), rid);
    check('re-scoring restores the match % of older candidates', changedN >= 1 && md.get('profiles', target.id)!.evidenceScore >= 50, md.get('profiles', target.id)!.evidenceScore);
    check('re-scoring keeps the artist waiting for review', md.get('cases', rid)!.artistStatus === 'NEEDS_REVIEW' && md.get('cases', rid)!.discoveryStatus === 'Needs verification');
  }
  check('weak matches are not stored: same-name DJ, travel vlogger', !profs.some(p => ['djrahulsharma', 'rahulsharmavlogs'].includes(p.username ?? '') && p.verificationStatus === 'UNREVIEWED'));
  check('duplicate URLs merged into one candidate', new Set(profs.map(p => p.normalizedUrl)).size === profs.length);
  check('a profile found by several searches lists all of them', by('Instagram', 'rahulsharma.sings').foundVia.length >= 2);
  check('match says why (name, handle, songs)', ['Name is', 'Handle @', 'Song “'].every(t => by('Instagram', 'rahulsharma.sings').matched.some(x => x.includes(t))), by('Instagram', 'rahulsharma.sings').matched);
  check('conflicts are shown, e.g. a different city', by('Facebook').conflicts.some(c => c.startsWith('Different city')));
  check('the actor account rejected earlier is not offered again', !profs.some(p => p.username === 'rahulsharma.official' && p.verificationStatus === 'UNREVIEWED'));
  check('nothing is verified automatically', !profs.some(p => p.verificationStatus === 'VERIFIED'));
  check('candidate profiles are possible edges in the graph', md.edgesOf(nid.case(rid)).some(e => e.type === 'ARTIST_HAS_PROFILE' && e.status === 'possible'));
  const joshuaPath = md.byCase('connectionPaths', rid).find(p => !p.note && p.steps.some(s => s.label === 'Joshua Singh'));
  check('discovery found Rahul → “Dil Ka Safar” → Joshua Singh → verified contact', !!joshuaPath && pathText(joshuaPath.steps) === 'Rahul Sharma → “Dil Ka Safar” → Joshua Singh → Verified WhatsApp' && joshuaPath.strength === 'STRONG', joshuaPath && pathText(joshuaPath.steps));
  const multi = md.byCase('connectionPaths', rid).find(p => p.steps.some(s => s.label === 'Riya Sen'));
  check('multi-hop path through Amit Kumar and Riya Sen is only “possible”', !!multi && multi.edgeCount === 5 && multi.strength !== 'STRONG');
  check('label path already tried is flagged, not suggested', md.byCase('connectionPaths', rid).some(p => p.note?.startsWith('Already tried')));
  check('collaborators looked up: existing cases reused, nothing added to their dossiers', md.all('collaborators').some(x => x.caseId === C('A003') && x.status === 'Linked case') && open(C('A003')).length === 0);
  check('a public mention is a discovered relationship, not a verified one', md.edgesOf(nid.case(rid)).some(e => e.type === 'PERSON_CONNECTED_TO_ARTIST' && e.status === 'discovered'));
  // human verification
  const ig = by('Instagram', 'rahulsharma.sings');
  await ed.command('verifyProfile', U, { profileId: ig.id, note: 'Bio lists his songs and label' });
  check('verify saves a verified profile with who and when', md.byCase('verifiedProfiles', rid).some(v => v.url === ig.url && v.verifiedBy === U && !!v.verifiedAt));
  check('the case remembers it', md.get('cases', rid)!.verifiedProfileCount === 1 && md.get('cases', rid)!.profileUrls.includes(ig.url));
  check('its graph edge becomes verified', md.edgesOf(nid.profile(ig.id)).some(e => e.type === 'ARTIST_HAS_PROFILE' && e.status === 'verified'));
  const fb = by('Facebook');
  await rejects('rejecting needs a reason', ed.command('rejectProfile', U, { profileId: fb.id }), /reason is required/);
  await ed.command('rejectProfile', U, { profileId: fb.id, reason: 'Wrong page: Delhi namesake' });
  check('rejected candidate is saved with the reason', md.get('profiles', fb.id)!.verificationStatus === 'REJECTED' && md.get('profiles', fb.id)!.rejectionReason === 'Wrong page: Delhi namesake');
  check('a rejected candidate is no longer shown', !relevantOpen(md, rid).some(p => p.id === fb.id));
  await ed.command('reconsiderProfile', U, { profileId: fb.id });
  check('a rejected candidate can be reconsidered', md.get('profiles', fb.id)!.verificationStatus === 'UNREVIEWED');
  await ed.command('deferProfile', U, { profileId: fb.id });
  check('not sure: deferred for later, still listed', md.get('profiles', fb.id)!.verificationStatus === 'DEFERRED' && relevantOpen(md, rid).some(p => p.id === fb.id));
  check('same-name cases are never merged', !md.get('cases', C('A099'))!.mergedIntoId && C('A099') !== rid);
  await ed.command('verifyCandidateGroup', U, { caseId: rid, groupKey: ig.groupKey });
  check('a candidate group can be verified together', md.byCase('verifiedProfiles', rid).length >= 4, md.byCase('verifiedProfiles', rid).length);
  // connection → route → contact
  await ed.command('findConnection', U, { caseId: rid });
  const path = md.byCase('connectionPaths', rid).find(p => p.status === 'SUGGESTED' && !p.note && p.steps.some(s => s.label === 'Joshua Singh'))!;
  check('a verified profile gives a direct path too', md.byCase('connectionPaths', rid).some(p => p.targetType === 'profile'));
  const made = await ed.command('createRouteFromPath', U, { pathId: path.id });
  const route = md.get('routes', made.id!)!;
  check('Create route: Candidate route that keeps the path', route.state === 'Candidate' && route.path?.length === 4 && route.contactId === path.targetContactId);
  await rejects('the same path cannot create a second route', ed.command('createRouteFromPath', U, { pathId: path.id }), /already/);
  await ed.command('verifyRoute', U, { routeId: route.id });
  const r2 = md.get('cases', rid)!;
  check('verified route → Route Ready with an introduction task', r2.lifecycleStage === 'Route Ready' && md.byCase('tasks', rid).some(t => t.kind === 'Introduction' && t.status === 'Queued'));
  check('leaving Waiting through a verified connection is a recorded reopen', md.byCase('reopens', rid).length === 1);
  await ed.command('recordContactAttempt', U, { caseId: rid, routeId: route.id, channel: 'Phone', recipient: 'Rahul Sharma', message: 'Joshua introduced us', result: 'Conversation Confirmed', evidence: 'Call', nextAction: 'Send claim invitation' });
  check('contact workflow continues (Contact Confirmed)', md.get('cases', rid)!.lifecycleStage === 'Contact Confirmed');
  // future imports reuse verified knowledge
  const jobsBefore = md.byCase('discoveryJobs', rid).length;
  await rejects('a verified artist is not searched again in full', ed.command('startDiscovery', U, { caseId: rid }), /Refresh search/);
  const rows = fixtureXlsxRows();
  const xb = await ed.upload({ filename: 'goongoonalo_artist_extract.xlsx', bytes: enc(JSON.stringify(rows)), sheets: [{ name: 'Extract', rows }] }, U);
  check('Excel upload: known artists, no duplicates', xb.status === 'Processed' && xb.acceptedCount === 0 && xb.skippedCount === rows.length - 1, [xb.status, xb.acceptedCount, xb.skippedCount]);
  const ia = ed.query('importArtists', U, { id: xb.id }) as any;
  const rahulRow = ia.rows.find((x: any) => x.id === rid);
  check('import result: Rahul is a verified artist found (profiles reused)', !!rahulRow && rahulRow.verified.length >= 4 && rahulRow.songsInFile === 12);
  check('no discovery was started by the import', md.byCase('discoveryJobs', rid).length === jobsBefore);
  // Batch 002: targeted discovery around the new evidence
  const f2 = fixtureFile('b002');
  const b2 = await ed.upload({ filename: f2.filename, bytes: enc(f2.csv) }, U);
  const tjId = (b2.summary.targetedJobIds ?? []).find(id => md.get('discoveryJobs', id)!.caseId === rid);
  check('Batch 002 queued targeted discovery for verified Rahul (and verified Joshua)', !!tjId && md.get('discoveryJobs', tjId)!.mode === 'targeted');
  await ed.idle();
  const tq = [...new Set((md.idx.queriesByJob.get(tjId!) ?? []).map(id => md.get('discoveryQueries', id)!.query))];
  check('targeted search only around the new songs, ISRCs and collaborators', tq.length > 0 && tq.every(q => /Dil Ka Safar 2|Pehli Udaan|Sawan Ki Dhun|Jugnu Re|Hawa Mein|INGAM2609|Riya Sen|Amit Kumar|Sameer Mehta|Nadaan/.test(q)), tq);
  check('earlier evidence is preserved (version 1 kept)', md.all('discoveryEvidence').some(e => e.caseId === rid && e.version === 1));
  const riya = md.byCase('connectionPaths', rid).find(p => p.steps.some(s => s.label === '“Hawa Mein”'));
  check('a potential new route appears: Rahul → “Hawa Mein” → Riya Sen → verified email', !!riya && riya.edgeCount === 3, riya && pathText(riya.steps));
  check('Joshua’s verified knowledge is reused (no new Joshua candidates)', open(C('A030')).length === 0);
  const edges = md.count('graphEdges'), jobs = md.count('discoveryJobs');
  const f3 = fixtureFile('b003');
  const b3 = await ed.upload({ filename: f3.filename, bytes: enc(f3.csv) }, U);
  check('repeat import: no duplicate graph edges or jobs', b3.status === 'Repeat' && md.count('graphEdges') === edges && md.count('discoveryJobs') === jobs);
  // refresh: version 2 and a detected profile change
  const lettersBefore = new Map(md.byCase('profiles', rid).map(p => [p.id, p.groupKey]));
  await ed.command('startDiscovery', U, { caseId: rid, mode: 'refresh' });
  await ed.idle();
  const after = md.byCase('profiles', rid);
  const oldLetters = new Set([...lettersBefore.values()].filter(Boolean));
  check('candidate letters stay the same across search versions (new groups get new letters)',
    after.filter(p => lettersBefore.has(p.id)).every(p => p.groupKey === lettersBefore.get(p.id))
    && after.filter(p => !lettersBefore.has(p.id) && p.groupKey).every(p => after.some(q => lettersBefore.has(q.id) && q.groupKey === p.groupKey) || !oldLetters.has(p.groupKey)),
    after.map(p => `${p.username ?? p.url}:${lettersBefore.get(p.id) ?? '-'}→${p.groupKey}`));
  const job3 = md.byCase('discoveryJobs', rid).find(j => j.mode === 'refresh')!;
  check('completion message counts only new candidates', /new candidate/.test(String(md.all('notifications').find(n => n.text.includes('Rahul Sharma discovery completed') && n.at === job3.finishedAt)?.text)), md.all('notifications').filter(n => n.text.includes('Rahul Sharma discovery completed')).map(n => n.text));
  const versions = [...new Set(md.byCase('discoveryJobs', rid).map(j => j.version))];
  check('refresh creates a new version and keeps the old ones', versions.includes(1) && Math.max(...versions) >= 2, versions);
  const change = md.byCase('profiles', rid).find(p => p.changeOfProfileId && p.verificationStatus === 'UNREVIEWED');
  check('profile change detected (@rahulsharma.sings → @rahulsharma.sings2), not overwritten', !!change && change.username === 'rahulsharma.sings2' && md.get('profiles', change.changeOfProfileId!)!.verificationStatus === 'VERIFIED');
  await ed.command('resolveProfileChange', U, { profileId: change!.id, decision: 'verify_new' });
  check('verify new: old profile kept as replaced', md.get('profiles', change!.changeOfProfileId!)!.verificationStatus === 'REPLACED' && md.get('profiles', change!.id)!.verificationStatus === 'VERIFIED' && md.byCase('verifiedProfiles', rid).some(v => v.verificationStatus === 'REPLACED'));
  // cache: the other Rahul Sharma reuses the same name queries
  await ed.command('startDiscovery', U, { caseId: C('A099') });
  await ed.idle();
  const j99 = md.byCase('discoveryJobs', C('A099')).pop()!;
  check('search cache: repeated queries are not searched again', j99.cachedCount > 0, j99.cachedCount);
  // failure and retry
  setFixtureOutage(ed, true);
  const fail = await ed.command('startDiscovery', U, { caseId: C('A009') });
  await ed.idle();
  const fj = md.get('discoveryJobs', fail.id!)!;
  check('provider outage → FAILED with a reason, never “artist not found”', fj.status === 'FAILED' && /unavailable/.test(fj.failureReason ?? '') && md.get('cases', C('A009'))!.discoveryStatus === 'Failed');
  setFixtureOutage(ed, false);
  await ed.command('retryDiscovery', U, { jobId: fj.id });
  await ed.idle();
  check('retry works once the source is back', md.byCase('discoveryJobs', C('A009')).some(j => j.retryOf === fj.id && j.status !== 'FAILED'));
  // no result
  await ed.command('startDiscovery', U, { caseId: C('A016') });
  await ed.idle();
  const nd = ed.query('discoveryDetail', U, { id: C('A016') }) as any;
  check('obscure artist: “no verified candidate found”, queries listed, case kept', md.get('cases', C('A016'))!.discoveryStatus === 'No candidate' && nd.noResult?.queries.length > 0 && nd.noResult.sources.length > 0);
  // stale
  const meera = ed.query('discoveryDetail', U, { id: C('A010') }) as any;
  check('stale verified profile is flagged', meera.verified[0]?.stale === true);
  await ed.command('setDiscoverySettings', U, { staleDays: 3650 });
  check('stale threshold is configurable', (ed.query('discoveryDetail', U, { id: C('A010') }) as any).verified[0].stale === false);
  // do not contact
  const lata = C('A027');
  await ed.command('findConnection', U, { caseId: lata });
  const lp = md.byCase('connectionPaths', lata)[0];
  if (lp) await rejects('do-not-contact: no route from a connection path', ed.command('createRouteFromPath', U, { pathId: lp.id }), /contact/i);
  check('do-not-contact artist can still be enriched by discovery', md.get('cases', lata)!.verifiedProfileCount > 0 && md.get('cases', lata)!.contactPreference === 'Do Not Contact');
  // bulk
  await rejects('operators cannot start bulk discovery', ed.command('startBulkDiscovery', 'u-vikram', {}), /cannot do this/);
  const ids = md.all('cases').filter(c => c.discoveryStatus === 'Not started' && c.lifecycleStage === 'Unresearched').slice(0, 12).map(c => c.id);
  const bulk = await ed.command('startBulkDiscovery', U, { caseIds: ids });
  check('bulk search queues each artist once', (bulk.data as any).count === ids.length);
  await ed.idle();
  const bp = (ed.query('discoveryStatus', U) as any).bulk;
  check('bulk finished in the background with progress counts', bp.done && bp.total === ids.length && bp.completed + bp.failed === ids.length, bp);
  check('one summary notification for the bulk run, not one per artist', md.all('notifications').filter(n => n.text.startsWith('Search all unverified finished')).length === 1);
  check('bulk does not move lifecycle stages', ids.every(id => md.get('cases', id)!.lifecycleStage === 'Unresearched'));
  const more = md.all('cases').filter(c => c.discoveryStatus === 'Not started' && c.lifecycleStage === 'Unresearched').slice(0, 40).map(c => c.id);
  const bulk2 = await ed.command('startBulkDiscovery', U, { caseIds: more });
  await ed.command('stopBulkDiscovery', U, { bulkId: bulk2.id });
  await ed.idle();
  const stoppedJobs = md.all('discoveryJobs').filter(j => j.bulkId === bulk2.id && j.status === 'CANCELLED');
  check('stop remaining: unstarted searches are stopped, not failed', stoppedJobs.length > 0 && !md.all('discoveryJobs').some(j => j.bulkId === bulk2.id && j.status === 'FAILED' && !j.resultCount && !j.queryCount));
  check('stopped artists go back to Not started', stoppedJobs.every(j => md.get('cases', j.caseId)!.discoveryStatus === 'Not started'));
  check('stopping sends one summary notification', md.all('notifications').filter(n => n.text.startsWith('Search all unverified stopped')).length === 1);
  const again = await ed.command('startDiscovery', U, { caseId: stoppedJobs[0].caseId });
  check('a stopped artist can be searched later as v1', md.get('discoveryJobs', again.id!)!.version === 1);
  await ed.idle();
  for (const name of ['discoveryOverview', 'discoveryStatus', 'bulkPreview']) { try { ed.query(name, U, {}); check(`${name} query`, true); } catch (e) { check(`${name} query`, false, (e as Error).message); } }
  const g = ed.query('caseGraph', U, { id: rid }) as any;
  check('connection graph: artist, songs, collaborators, profiles, contacts, routes', ['Artist', 'Song', 'Profile', 'Contact', 'Route'].every(t => g.nodes.some((n: any) => n.type === t)) && g.edges.some((e: any) => e.status === 'verified') && g.edges.every((e: any) => e.evidence));
  const g2 = ed.query('caseGraph', U, { id: rid, depth: 2 }) as any;
  check('depth 2 adds second-degree connections', g2.nodes.length > g.nodes.length);
  check('graph shows Rahul → “Dil Ka Safar” → Joshua → contact', g.nodes.some((n: any) => n.label === 'Dil Ka Safar') && g.nodes.some((n: any) => n.label === 'Joshua Singh') && g.edges.some((e: any) => e.type === 'PERSON_HAS_CONTACT'));
}
{
  // Without a live search provider Find artist is off with the reason: discovery never invents results.
  const real = new Engine(new MemoryStore(), { runner: FAST.runner });
  await real.init();
  const csv = 'artist_id,artist_name,artist_role,track_id,title,label,distributor\nX1,Real Artist,Singer,TX1,Some Song,Some Label,Some Distributor\n';
  await real.upload({ filename: 'real_export.csv', bytes: enc(csv) }, U);
  const rc = real.m.idx.caseByBackendId.get('X1')!;
  await rejects('no search configured: Find artist is refused with the reason', real.command('startDiscovery', U, { caseId: rc }), /Live search is not configured/);
  await rejects('no search configured: bulk search is refused too', real.command('startBulkDiscovery', U, {}), /Live search is not configured/);
  check('no search configured: config and dossier say why', !!(real.discoveryConfig() as any).blocked && (real.query('caseDetail', U, { id: rc }) as any).actions.some((a: any) => a.id === 'findArtist' && a.disabled));
  check('no search configured: no job, no invented profile', real.m.count('discoveryJobs') === 0 && real.m.count('profiles') === 0);
  const live = new Engine(new MemoryStore(), { runner: FAST.runner, providers: () => ({ mode: 'live', providers: [], notes: [] }) });
  await live.init();
  await live.upload({ filename: 'real_export.csv', bytes: enc(csv) }, U);
  const lr = await live.command('startDiscovery', U, { caseId: live.m.idx.caseByBackendId.get('X1')! });
  check('live search configured: Find artist runs on real data', !!lr.id && live.m.count('discoveryJobs') === 1);
  await live.idle();
}
{
  // Usage limits: a quota provider never goes over its limit, even with parallel searches.
  let calls = 0; const times: number[] = [];
  const fake: DiscoveryProvider = { id: 'fakeweb', label: 'Fake web search', kind: 'web', limits: { perMonth: 7, perArtist: 3, minIntervalMs: 40 }, handles: () => true, search: async () => { calls++; times.push(Date.now()); return []; } };
  const q = new Engine(new MemoryStore(), { runner: FAST.runner, providers: () => ({ mode: 'live', providers: [fake], notes: [] }) });
  await q.init();
  const rows = ['X1,Artist One', 'X2,Artist Two', 'X3,Artist Three', 'X4,Artist Four', 'X5,Artist Five'].map((r, i) => `${r},Singer,TQ${i},Song Number ${i},Some Label,Some Distributor`).join('\n');
  await q.upload({ filename: 'quota.csv', bytes: enc(`artist_id,artist_name,artist_role,track_id,title,label,distributor\n${rows}\n`) }, U);
  const cid = (a: string) => q.m.idx.caseByBackendId.get(a)!;
  const b = await q.command('startBulkDiscovery', U, {});
  check('limits: bulk queues only what the budget covers (7 calls, 3 per artist → 2 artists)', (b.data as any).count === 2 && (b.data as any).skipped === 3, b.data);
  await q.idle();
  check('limits: one artist search uses at most its per-artist share', calls === 6, calls);
  check('limits: calls are spaced (requests-per-second limit)', times.every((t, i) => i === 0 || t - times[i - 1] >= 30), times.map((t, i) => i ? t - times[i - 1] : 0));
  check('limits: usage is counted (6 of 7 this month)', (q.discoveryConfig() as any).usage[0].month.used === 6);
  const r1 = await q.command('startDiscovery', U, { caseId: cid('X3') });
  const r2 = await q.command('startDiscovery', U, { caseId: cid('X4') }).catch((e: Error) => e);
  await q.idle();
  const lost = r2 instanceof Error ? /limit reached/.test(r2.message) : [r1, r2].map(r => q.m.get('discoveryJobs', r.id!)!).filter(j => j.status === 'FAILED' && /limit reached/.test(j.failureReason ?? '')).length === 1;
  check('limits: the last call goes to one search; the other stops with the reason, never "not found"', calls === 7 && lost, [calls, r2 instanceof Error ? r2.message : 'queued']);
  await rejects('limits: Find artist is refused once the limit is reached', q.command('startDiscovery', U, { caseId: cid('X5') }), /limit reached/);
  await rejects('limits: bulk search is refused too', q.command('startBulkDiscovery', U, {}), /limit reached/);
  check('limits: dossier shows Find artist disabled with the reason', (q.query('caseDetail', U, { id: cid('X5') }) as any).actions.some((a: any) => a.id === 'findArtist' && /limit reached/.test(a.disabled ?? '')));
  check('limits: no call over the limit was made', calls === 7, calls);
}

console.log('\nQueries');
for (const name of ['meta', 'dashboard', 'listCases', 'queue', 'imports', 'exceptions', 'researchOverview', 'routesOverview', 'contacts', 'recentAttempts', 'claimsOverview', 'reopened', 'identityQueue', 'reports', 'auditLog', 'notifications']) {
  try { const t = Date.now(); q(name); const ms = Date.now() - t; check(`${name} (${ms} ms)`, ms < 1500); } catch (e) { check(name, false, (e as Error).message); }
}
for (const name of ['caseDetail', 'caseSongs', 'caseCollaborators', 'caseRoutes', 'caseResearch', 'caseAttempts', 'caseClaims', 'caseActivation', 'caseTasks', 'caseTimeline']) {
  try { q(name, { id: rahulId }); check(name, true); } catch (e) { check(name, false, (e as Error).message); }
}
check('search finds Rahul by name and by artist ID', q('search', { q: 'rahul' }).some((x: any) => x.caseId === rahulId) && q('search', { q: 'A001' }).some((x: any) => x.caseId === rahulId));
check('search finds a song by ISRC', q('search', { q: 'INGAM2609001' }).some((x: any) => x.type === 'Song'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
