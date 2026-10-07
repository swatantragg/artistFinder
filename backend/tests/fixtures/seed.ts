// Test fixtures: a fictional workspace. Batch 001 goes through the real import pipeline, then case histories are written
// with the same commands the UI uses (backdated), so every stage has evidence, tasks and audit records behind it.
// Used by the tests only (unit tests and the in-memory e2e server); the app starts empty.
import { batch001Rows, FIXTURE_FILES, toStandardCsv } from './catalog';
import { commands } from '../../src/domain/commands';
import { fixtureProviders } from './web';
import { ENGINE_USER, syncDiscoveryState } from '../../src/domain/discovery/pipeline';
import { InternalCatalogueProvider } from '../../src/domain/discovery/providers';
import { DEFAULT_RUNNER, DiscoveryRunner } from '../../src/domain/discovery/runner';
import { syncContactGraph, syncProfileGraph } from '../../src/domain/graph';
import { processImport } from '../../src/domain/importer';
import { Model } from '../../src/domain/model';
import { audit } from '../../src/domain/ops';
import { staleDaysOf } from '../../src/domain/discovery/views';
import { afterCommand, sweepStale, syncArtistStatuses } from '../../src/domain/status';
import type { Contact, Ctx } from '../../src/domain/types';
import { addDays, at, parseCsv, sha256Text, todayISO } from '../../src/domain/util';

import { emptyModel } from '../../src/domain/workspace';
import { FIXTURE_USERS } from './users';

export async function seedFixtures(today = todayISO()): Promise<Model> {
  const m = emptyModel(FIXTURE_USERS);
  m.setMeta('seededOn', today);
  const ctxAt = (userId: string, offset: number, hour = 10, minute = 0): Ctx => ({ userId, now: at(addDays(today, offset), hour, minute), today: addDays(today, offset) });
  const csv = toStandardCsv(batch001Rows());
  await processImport(m, ctxAt('u-swatantra', -25, 9), { filename: FIXTURE_FILES.b001, checksum: sha256Text(csv), table: parseCsv(csv), importType: 'Full', exportDate: addDays(today, -26), source: 'Goongoonalo backend export (fixture)' });

  const caseOf = (artistId: string) => m.canonical(m.idx.caseByBackendId.get(artistId)!);
  // Each scripted step gets the next minute of its day (09:00 onwards), so histories read in the order they are written.
  let seq = 0;
  const run = (name: string, userId: string, offset: number, p: Record<string, unknown>) => {
    seq++;
    const ctx = ctxAt(userId, offset, 9 + Math.floor(seq / 60), seq % 60);
    const res = commands[name](m, ctx, p);
    // Same as the engine: the identity status follows every change, dated when it happened.
    afterCommand(m, ctx, name, res?.caseId, ENGINE_USER);
    return res;
  };
  const routeOf = (artistId: string, pred: (r: { contactId: string | null; sourceUrl: string | null; state: string }) => boolean = () => true) => m.byCase('routes', caseOf(artistId)).filter(pred).pop()!.id;
  const contactId = (res: { id?: string }) => res.id!;
  const S = 'u-swatantra', L = 'u-meenal', V = 'u-vikram', T = 'u-tara', D = 'u-dev';

  // Both sides of an imported identity conflict wait for the reviewer.
  for (const c of m.all('conflicts')) for (const id of c.caseIds) if (m.get('cases', id)!.lifecycleStage === 'Unresearched') {
    run('changeStage', L, -24, { caseId: id, stage: 'Identity Review', reason: `Possible duplicate (${c.id}): decide before any contact` });
    m.update('cases', id, { identityStatus: 'Under Review' });
  }
  // Past identity decisions: two different Rahul Sharmas, and two different Sameer Khans. Names alone never merge cases.
  const rahulPair = m.all('conflicts').find(c => c.caseIds.includes(caseOf('A099')));
  if (rahulPair) run('decideIdentity', L, -24, { conflictId: rahulPair.id, decision: 'Keep Separate', reason: 'Two different artists called Rahul Sharma', evidence: 'A001 is a Hindi singer on Nadaan Music Co.; A099 is a Punjabi DJ and producer on Taal Tunes with different songs' });
  const sameer = m.all('conflicts').find(c => c.caseIds.includes(caseOf('A044')));
  if (sameer) run('decideIdentity', L, -22, { conflictId: sameer.id, decision: 'Keep Separate', reason: 'Different languages, labels and roles', evidence: 'A045 is a Hindi producer on Sargam Records; A044 is an Urdu singer on Taal Tunes' });

  // ---- Joshua Singh: already onboarded, a willing introducer with a verified WhatsApp.
  // His number was in the contact directory before this catalogue was loaded, and a first catalogue load never evaluates
  // leads, so nobody connected him to Rahul Sharma's “Dil Ka Safar” yet. Find connection does that.
  const jo = caseOf('A030');
  const joK = directoryContact(m, ctxAt(V, -30, 9), { personName: 'Joshua Singh', caseId: jo, role: 'Artist', channel: 'WhatsApp', value: '+91 90000 00030 (fixture)', authorityEvidence: 'Number listed on his official website (fixture)', willingIntroducer: true }, 'Confirmed on a call before the catalogue import: Joshua is happy to introduce collaborators');
  run('assignOwner', L, -24, { caseId: jo, ownerId: V });
  run('startResearch', V, -24, { caseId: jo });
  run('addRoute', V, -24, { caseId: jo, contactId: joK, state: 'Verified', evidence: 'His own verified WhatsApp', confidence: 95 });
  run('updateRoute', V, -24, { routeId: routeOf('A030', r => r.contactId === joK), state: 'Selected', reason: 'Direct verified contact' });
  run('recordContactAttempt', V, -23, { caseId: jo, routeId: routeOf('A030', r => r.contactId === joK), channel: 'WhatsApp', recipient: 'Joshua Singh', message: 'Explained his existing profile and catalogue', result: 'Conversation Confirmed', evidence: 'Call with Joshua, 12 min', nextAction: 'Send claim invitation' });
  claimFlow(run, 'A030', jo, 'Joshua Singh', V, D, -23);
  run('verifyAccess', V, -18, { caseId: jo, evidence: 'Joshua logged in and saw his 4 songs' });
  run('selectFeature', V, -18, { caseId: jo, feature: 'Artist Post', expectedOutcome: 'First post announcing his new composition', agreedDate: addDays(today, -17), operatorId: V });
  run('recordFirstUse', V, -16, { caseId: jo, kind: 'Meaningful use', backendRef: 'EVT-DEMO-3001', evidence: 'Artist post published' });
  run('handoverToArm', V, -15, { caseId: jo, relationshipOwnerId: L, interests: 'Collaborations, film music', language: 'Hindi', supportNeeds: 'Prefers WhatsApp', nextParticipationCheck: addDays(today, 15) });

  // ---- Neha Verma: route created automatically by Joshua's verified contact, introduction made, conversation confirmed
  const neha = caseOf('A004');
  run('assignOwner', L, -21, { caseId: neha, ownerId: V });
  run('startResearch', V, -21, { caseId: neha });
  const nehaRoute = contactId(run('addRoute', V, -21, { caseId: neha, contactId: joK, state: 'Verified', evidence: 'Joshua Singh composed three of her songs and is a verified, willing introducer', confidence: 90 }) as { id?: string });
  run('updateRoute', V, -20, { routeId: nehaRoute, state: 'Selected', reason: 'Joshua composed three of her songs and is a willing introducer' });
  run('recordContactAttempt', V, -20, { caseId: neha, routeId: nehaRoute, channel: 'Introducer', recipient: 'Joshua Singh', message: 'Asked Joshua to introduce Neha', result: 'Introduction Requested', evidence: 'Joshua agreed on WhatsApp', nextAction: 'Wait for the introduction' });
  run('recordContactAttempt', V, -18, { caseId: neha, routeId: nehaRoute, channel: 'Phone', recipient: 'Neha Verma', message: 'Joshua connected us; explained the profile and the claim', result: 'Conversation Confirmed', evidence: 'Call with Neha after Joshua’s introduction', nextAction: 'Send claim invitation', nextActionDate: today });

  // ---- Rahul Sharma (A001): researched, two routes failed, waiting for evidence
  const rahul = caseOf('A001');
  run('assignOwner', L, -20, { caseId: rahul, ownerId: S });
  run('startResearch', S, -20, { caseId: rahul });
  run('updateChecklist', S, -20, { caseId: rahul, step: 1, status: 'Complete', note: 'No prior claim, contact or research on record' });
  run('updateChecklist', S, -20, { caseId: rahul, step: 2, status: 'Complete', note: '12 songs under A001, singer on all of them' });
  run('addResearch', S, -19, { caseId: rahul, source: 'Instagram', query: '"Rahul Sharma" singer', url: 'https://instagram.com/rahulsharma.official', result: 'Profile found: rahulsharma.official', evidence: 'Bio says actor and model; no music posts', confidence: 30, minutes: 12, checklistStep: 5 });
  run('addRoute', S, -19, { caseId: rahul, sourceUrl: 'https://instagram.com/rahulsharma.official', state: 'Candidate', evidence: 'Handle from search; bio does not mention music', confidence: 30, origin: 'Research' });
  run('updateRoute', S, -18, { routeId: routeOf('A001', r => !!r.sourceUrl), state: 'Rejected', reason: 'Wrong person: the profile belongs to an actor with the same name' });
  run('addResearch', S, -18, { caseId: rahul, source: 'Google', query: '"Rahul Sharma" "Dil Mera"', url: 'https://www.google.com/search?q=%22Rahul+Sharma%22+%22Dil+Mera%22', result: 'Only streaming pages, no official site', evidence: 'No website, press or management listed', confidence: 0, minutes: 9, checklistStep: 5 });
  run('addResearch', S, -18, { caseId: rahul, source: 'YouTube', query: 'Rahul Sharma Baarish Ki Raat', url: 'https://www.youtube.com/results?search_query=Rahul+Sharma+Baarish+Ki+Raat', result: 'Fan uploads only', evidence: 'No official channel', confidence: 0, minutes: 6, checklistStep: 5 });
  for (const [step, note] of [[3, 'No authorised internal contact on file'], [4, 'Credits: Amit Kumar (lyricist), Sameer Mehta (producer), Joshua Singh (producer on “Dil Ka Safar”); label Nadaan Music Co.'], [5, 'Instagram, YouTube, Spotify and Google searched: no verified profile']] as [number, string][]) run('updateChecklist', S, -18, { caseId: rahul, step, status: 'Complete', note });
  const nadaan = contactId(run('addContact', L, -17, { personName: 'Nadaan Music Co.', role: 'Label', channel: 'Email', value: 'artists@nadaan-music.example', authorityEvidence: 'Label A&R desk listed on the label website (fixture)', verified: true, verificationEvidence: 'Email confirmed by the label’s office manager' }));
  run('updateRoute', S, -17, { routeId: routeOf('A001', r => r.contactId === nadaan), state: 'Selected', reason: 'Only verified organisation on Rahul’s songs' });
  run('recordContactAttempt', S, -17, { caseId: rahul, routeId: routeOf('A001', r => r.contactId === nadaan), channel: 'Email', recipient: 'Nadaan Music Co. A&R', message: 'Asked the label to connect us with Rahul about his existing profile', result: 'No Response', evidence: 'Email sent 10:20', nextAction: 'Follow up in 3 working days' });
  run('recordContactAttempt', S, -13, { caseId: rahul, routeId: routeOf('A001', r => r.contactId === nadaan), channel: 'Email', recipient: 'Nadaan Music Co. A&R', message: 'Follow-up #1', result: 'No Response', evidence: 'Second email, no reply', nextAction: 'Second follow-up' });
  run('updateRoute', S, -11, { routeId: routeOf('A001', r => r.contactId === nadaan), state: 'Exhausted', reason: 'No reply to two emails in 6 working days; label does not share artist contacts' });
  run('updateChecklist', S, -11, { caseId: rahul, step: 6, status: 'In Progress', note: 'Not finished: the collaborators’ contacts were not checked against the directory' });
  run('updateChecklist', S, -11, { caseId: rahul, step: 7, status: 'Blocked', note: 'No verified route left to select' });
  run('moveToWaiting', S, -10, { caseId: rahul, blocker: 'No verified contact route found', futureTrigger: 'New song, new credit or a newly verified collaborator contact', nextReviewDate: addDays(today, 20) });
  run('updateChecklist', S, -10, { caseId: rahul, step: 8, status: 'Complete', note: 'Outcome: waiting for new evidence' });

  // ---- Aditya Joshi: same label route, exhausted, waiting
  const aditya = caseOf('A009');
  run('assignOwner', L, -17, { caseId: aditya, ownerId: T });
  run('startResearch', T, -17, { caseId: aditya });
  run('addResearch', T, -17, { caseId: aditya, source: 'Spotify', query: 'Aditya Joshi', url: 'https://open.spotify.com/search/Aditya%20Joshi', result: 'Several artists with this name', evidence: 'No profile matches his songs', confidence: 10, minutes: 10, checklistStep: 5 });
  run('updateRoute', T, -16, { routeId: routeOf('A009', r => r.contactId === nadaan), state: 'Selected', reason: 'Label route' });
  run('recordContactAttempt', T, -16, { caseId: aditya, routeId: routeOf('A009', r => r.contactId === nadaan), channel: 'Email', recipient: 'Nadaan Music Co. A&R', message: 'Asked for an introduction', result: 'No Response', evidence: 'Email sent', nextAction: 'Follow up' });
  run('updateRoute', T, -12, { routeId: routeOf('A009', r => r.contactId === nadaan), state: 'Exhausted', reason: 'Label never replied' });
  run('moveToWaiting', T, -12, { caseId: aditya, blocker: 'Label did not respond; no other route', futureTrigger: 'New collaborator with a verified contact', nextReviewDate: addDays(today, 18) });

  // ---- Pooja Reddy: nothing found, waiting
  const pooja = caseOf('A016');
  run('assignOwner', L, -15, { caseId: pooja, ownerId: V });
  run('startResearch', V, -15, { caseId: pooja });
  run('addResearch', V, -15, { caseId: pooja, source: 'Instagram', query: '"Pooja Reddy" Telugu singer', url: 'https://instagram.com/explore', result: 'No verifiable profile', evidence: 'Common name; no handle links to her songs', confidence: 0, minutes: 18, checklistStep: 5 });
  for (let s = 1; s <= 7; s++) run('updateChecklist', V, -14, { caseId: pooja, step: s, status: 'Complete', note: s === 7 ? 'Nothing to verify' : 'Done' });
  run('moveToWaiting', V, -14, { caseId: pooja, blocker: 'Common name, no profile or collaborator contact', futureTrigger: 'Profile link or collaborator contact', nextReviewDate: addDays(today, 16) });

  // ---- Researching
  for (const [aid, owner, off] of [['A003', V, -6], ['A012', T, -3], ['A015', S, -1]] as [string, string, number][]) {
    const id = caseOf(aid);
    run('assignOwner', L, off, { caseId: id, ownerId: owner });
    run('startResearch', owner, off, { caseId: id });
    run('updateChecklist', owner, off, { caseId: id, step: 1, status: 'Complete', note: 'No prior history' });
  }
  run('addResearch', T, -2, { caseId: caseOf('A012'), source: 'Instagram', query: 'Siddharth Menon composer', url: 'https://instagram.com/sid.menon.music', result: 'Possible profile', evidence: 'Posts mention two of his songs, not verified', confidence: 70, minutes: 15, checklistStep: 5 });
  run('addRoute', T, -2, { caseId: caseOf('A012'), sourceUrl: 'https://instagram.com/sid.menon.music', state: 'Candidate', evidence: 'Mentions two catalogue songs', confidence: 70, origin: 'Research' });

  // ---- Route Ready
  const arjun = caseOf('A005');
  run('assignOwner', L, -5, { caseId: arjun, ownerId: V });
  run('startResearch', V, -5, { caseId: arjun });
  const mgr = contactId(run('addContact', V, -3, { personName: 'Harpreet Gill', caseId: arjun, role: 'Manager', channel: 'Phone', value: '+91 90000 00105 (fixture)', authorityEvidence: 'Named as manager on Arjun’s official page (fixture)', verified: true, verificationEvidence: 'Manager confirmed she represents Arjun' }));
  run('addRoute', V, -3, { caseId: arjun, contactId: mgr, state: 'Verified', evidence: 'Verified manager', confidence: 85 });
  run('updateRoute', V, -2, { routeId: routeOf('A005', r => r.contactId === mgr), state: 'Selected', reason: 'Manager is the authorised representative' });
  const ananya = caseOf('A013');
  run('assignOwner', L, -2, { caseId: ananya, ownerId: T });
  run('startResearch', T, -2, { caseId: ananya });
  run('addRoute', T, -1, { caseId: ananya, sourceUrl: 'https://instagram.com/ananya.iyer.sings', state: 'Verified', evidence: 'Verified badge; links to her releases (fixture)', confidence: 92, origin: 'Research' });
  run('updateRoute', T, -1, { routeId: routeOf('A013'), state: 'Selected', reason: 'Official profile' });

  // ---- Introduction Pending (Gurpreet introduces Nikhil)
  const nikhil = caseOf('A017');
  run('assignOwner', L, -10, { caseId: nikhil, ownerId: V });
  const gk = contactId(run('addContact', V, -9, { personName: 'Gurpreet Sandhu', caseId: caseOf('A043'), role: 'Collaborator', channel: 'Phone', value: '+91 90000 00143 (fixture)', authorityEvidence: 'Composer on Nikhil’s songs', willingIntroducer: true, verified: true, verificationEvidence: 'Spoke to Gurpreet; confirmed he works with Nikhil' }));
  run('startResearch', V, -8, { caseId: nikhil });
  run('updateRoute', V, -7, { routeId: routeOf('A017', r => r.contactId === gk), state: 'Selected', reason: 'Willing introducer on shared songs' });
  run('recordContactAttempt', V, -6, { caseId: nikhil, routeId: routeOf('A017', r => r.contactId === gk), channel: 'Introducer', recipient: 'Gurpreet Sandhu', message: 'Asked Gurpreet to introduce Nikhil', result: 'Introduction Requested', evidence: 'Gurpreet agreed', nextAction: 'Wait for introduction', nextActionDate: addDays(today, -2) });

  // ---- Contact Attempted
  const sneha = caseOf('A006');
  run('assignOwner', L, -9, { caseId: sneha, ownerId: T });
  run('startResearch', T, -9, { caseId: sneha });
  run('addRoute', T, -8, { caseId: sneha, sourceUrl: 'https://instagram.com/sneha.patil.official', state: 'Verified', evidence: 'Official profile linked from her label page (fixture)', confidence: 88, origin: 'Research' });
  run('updateRoute', T, -8, { routeId: routeOf('A006'), state: 'Selected', reason: 'Official profile' });
  run('recordContactAttempt', T, -7, { caseId: sneha, routeId: routeOf('A006'), channel: 'Instagram', recipient: '@sneha.patil.official', message: 'DM about her existing profile', result: 'No Response', evidence: 'DM sent, seen', nextAction: 'Follow-up #1', nextActionDate: addDays(today, -3) });
  const riya = caseOf('A018');
  run('assignOwner', L, -6, { caseId: riya, ownerId: S });
  const riyaK = contactId(run('addContact', S, -6, { personName: 'Riya Sen', caseId: riya, role: 'Artist', channel: 'Email', value: 'riya.sen.music@example.com', authorityEvidence: 'Booking email on her website (fixture)', verified: true, verificationEvidence: 'Website domain matches her releases' }));
  run('startResearch', S, -6, { caseId: riya });
  run('addRoute', S, -6, { caseId: riya, contactId: riyaK, state: 'Verified', evidence: 'Her own booking email', confidence: 90 });
  run('updateRoute', S, -5, { routeId: routeOf('A018', r => r.contactId === riyaK), state: 'Selected', reason: 'Direct contact' });
  run('recordContactAttempt', S, -5, { caseId: riya, routeId: routeOf('A018', r => r.contactId === riyaK), channel: 'Email', recipient: 'riya.sen.music@example.com', message: 'Intro email about her profile', result: 'No Response', evidence: 'Email sent', nextAction: 'Follow-up #1', nextActionDate: today });

  // ---- Contact Confirmed (Manish), Claim stages, activation, ARM
  directToConfirmed(run, routeOf, caseOf, 'A019', 'Manish Gupta', T, L, -4);
  directToConfirmed(run, routeOf, caseOf, 'A020', 'Tanvi Kulkarni', S, L, -8);
  run('sendClaimInvitation', S, -6, { caseId: caseOf('A020'), profileId: 'A020', recipient: 'Tanvi Kulkarni', notes: 'Walkthrough offered' });
  directToConfirmed(run, routeOf, caseOf, 'A021', 'Harsh Vardhan', V, L, -10);
  run('sendClaimInvitation', V, -8, { caseId: caseOf('A021'), profileId: 'A021', recipient: 'Harsh Vardhan', notes: '' });
  run('recordClaimSubmission', V, -3, { caseId: caseOf('A021'), claimRequestId: 'CR-2026-0412', claimant: 'Harsh Vardhan' });
  directToConfirmed(run, routeOf, caseOf, 'A022', 'Divya Pillai', T, L, -12);
  run('sendClaimInvitation', T, -10, { caseId: caseOf('A022'), profileId: 'A022', recipient: 'Divya Pillai' });
  run('recordClaimSubmission', T, -7, { caseId: caseOf('A022'), claimRequestId: 'CR-2026-0398', claimant: 'Divya Pillai' });
  run('sendClaimToReview', T, -6, { caseId: caseOf('A022'), reviewerId: D, notes: 'ID and label letter attached' });
  directToConfirmed(run, routeOf, caseOf, 'A007', 'Rohan Desai', S, L, -14);
  run('sendClaimInvitation', S, -12, { caseId: caseOf('A007'), profileId: 'A007', recipient: 'Rohan Desai' });
  run('recordClaimSubmission', S, -9, { caseId: caseOf('A007'), claimRequestId: 'CR-2026-0377', claimant: 'Rohan Desai' });
  run('sendClaimToReview', S, -8, { caseId: caseOf('A007'), reviewerId: D });
  run('reviewClaim', D, -6, { caseId: caseOf('A007'), decision: 'Approve', notes: 'Government ID and label confirmation match profile A007', evidence: 'Docs checked in the admin console (fixture)' });
  for (const [aid, name, owner, off] of [['A023', 'Kunal Bhatia', V, -16], ['A024', 'Sana Qureshi', T, -18], ['A008', 'Kavya Nair', V, -24], ['A025', 'Varun Khanna', T, -20], ['A010', 'Meera Kapoor', S, -24]] as [string, string, string, number][]) {
    directToConfirmed(run, routeOf, caseOf, aid, name, owner, L, off);
    claimFlow(run, aid, caseOf(aid), name, owner, D, off);
  }
  run('verifyAccess', T, -8, { caseId: caseOf('A024'), evidence: 'Sana confirmed she can log in' });
  run('selectFeature', T, -8, { caseId: caseOf('A024'), feature: 'Artist Post', expectedOutcome: 'Announce her next single', agreedDate: addDays(today, -1), operatorId: T });
  run('recordFirstUse', T, -4, { caseId: caseOf('A024'), kind: 'Login only', evidence: 'Logged in, no post yet' });
  // Claims above were backend-verified at (offset + 5); access, feature and first use follow.
  for (const [aid, owner, off, ref] of [['A008', V, -24, 'EVT-DEMO-2048'], ['A025', T, -20, 'EVT-DEMO-2077'], ['A010', S, -24, 'EVT-DEMO-1990']] as [string, string, number, string][]) {
    run('verifyAccess', owner, off + 6, { caseId: caseOf(aid), evidence: 'Artist logged in and checked the catalogue' });
    run('selectFeature', owner, off + 6, { caseId: caseOf(aid), feature: 'Correct Profile', expectedOutcome: 'Photo and bio updated', agreedDate: addDays(today, off + 8), operatorId: owner });
    run('recordFirstUse', owner, off + 8, { caseId: caseOf(aid), kind: 'Meaningful use', backendRef: ref, evidence: 'Profile photo and bio changed (backend event)' });
  }
  run('handoverToArm', S, -10, { caseId: caseOf('A010'), relationshipOwnerId: L, interests: 'New album in December', language: 'Hindi', supportNeeds: 'Help with release posts', nextParticipationCheck: addDays(today, 20) });

  // ---- Closed with history: declined, and do-not-contact (survives every import)
  directToConfirmed(run, routeOf, caseOf, 'A026', 'Gaurav Sethi', T, L, -12, 'Declined');
  const lata = caseOf('A027');
  run('assignOwner', L, -13, { caseId: lata, ownerId: V });
  run('startResearch', V, -13, { caseId: lata });
  run('addRoute', V, -13, { caseId: lata, sourceUrl: 'https://instagram.com/lata.joshi.sings', state: 'Verified', evidence: 'Official profile (fixture)', confidence: 90, origin: 'Research' });
  run('updateRoute', V, -13, { routeId: routeOf('A027'), state: 'Selected', reason: 'Official profile' });
  run('recordContactAttempt', V, -12, { caseId: lata, routeId: routeOf('A027'), channel: 'Instagram', recipient: '@lata.joshi.sings', message: 'DM about her profile', result: 'Do Not Contact', evidence: 'Replied: “please do not contact me again”', nextAction: 'None: do not contact' });

  // ---- Automated discovery history (fixture providers, fictional results), run through the same background pipeline
  let clockOff = -15;
  const host = {
    mutate: async <T,>(fn: (mm: Model, ctx: Ctx) => T) => { seq++; return fn(m, ctxAt(ENGINE_USER, clockOff, 9 + Math.floor(seq / 60), seq % 60)); },
    touch: (fn: (mm: Model) => void) => fn(m),
    read: <T,>(fn: (mm: Model) => T) => fn(m),
    ctx: () => ctxAt(ENGINE_USER, clockOff),
  };
  const runner = new DiscoveryRunner(host, () => ({ mode: 'live', providers: [new InternalCatalogueProvider(() => m), ...fixtureProviders(() => m, { slow: false })], notes: [] }), { ...DEFAULT_RUNNER, pace: () => 0, backoffMs: 0 });
  const discover = async (aid: string, user: string, offset: number) => { clockOff = offset; const res = run('startDiscovery', user, offset, { caseId: caseOf(aid) }) as { id?: string }; await runner.runNow(res.id!); return res.id!; };
  const open = (aid: string) => m.byCase('profiles', caseOf(aid)).filter(p => p.verificationStatus === 'UNREVIEWED');
  // Joshua: Instagram and website verified
  await discover('A030', V, -14);
  for (const p of open('A030').filter(x => x.platform === 'Instagram' || x.platform === 'Website')) run('verifyProfile', V, -14, { profileId: p.id, note: 'Joshua confirmed both on our call' });
  // Kavya Nair and Lata Joshi (do not contact: discovery may still enrich the dossier): strongest candidate verified
  for (const [aid, user, off] of [['A008', V, -15], ['A027', V, -11]] as [string, string, number][]) {
    await discover(aid, user, off);
    const g = open(aid).filter(p => p.strength === 'STRONG')[0]?.groupKey;
    if (g) run('verifyCandidateGroup', user, off, { caseId: caseOf(aid), groupKey: g, note: 'Songs and label match the catalogue' });
  }
  // Neha Verma and Siddharth Menon: candidates waiting for a person to verify them
  await discover('A004', V, -5);
  await discover('A012', T, -2);
  // Riya Sen: the search failed (simulated provider outage) and can be retried
  m.setMeta('fixtures.outage', 'on');
  await discover('A018', S, -3);
  m.setMeta('fixtures.outage', 'off');
  // Meera Kapoor: a profile verified long ago in an earlier artist directory, now stale
  staleProfile(m, ctxAt(L, -190, 11), caseOf('A010'), 'Meera Kapoor');

  // ---- Goongoonalo status: decided by a person for verified artists, at different dates (week / month numbers)
  for (const [aid, off] of [['A030', -17], ['A010', -18], ['A024', -12], ['A008', -6], ['A025', -3], ['A023', -1]] as [string, number][]) {
    run('setGoongoonaloStatus', L, off, { caseId: caseOf(aid), status: 'GOONGOONALO', reason: 'Claimed and active on Goongoonalo' });
  }
  // Gaurav Sethi was reached and said no: identity confirmed on the call, Goongoonalo status rejected.
  run('confirmIdentity', T, -11, { caseId: caseOf('A026'), evidence: 'Confirmed on a call: he wrote and sang the catalogue songs' });
  run('setGoongoonaloStatus', L, -11, { caseId: caseOf('A026'), status: 'REJECTED', reason: 'Declined: not interested in a Goongoonalo profile' });
  // A record that is not an artist at all: kept with the reason, never searched or contacted.
  const label = run('createCase', V, -9, { name: 'Indigo Beats Official', reason: 'Listed as an artist in an old directory' }) as { caseId?: string };
  run('rejectArtist', L, -9, { caseId: label.caseId, reason: 'Label account, not an artist' });

  // Statuses for every artist, then the daily check: Meera's stale profile reopens her (her verification is kept).
  syncArtistStatuses(m, ctxAt(ENGINE_USER, -1), m.all('cases').map(c => c.id));
  sweepStale(m, ctxAt(ENGINE_USER, 0, 7), staleDaysOf(m));

  // Older notifications are already read; the last few days stay unread.
  for (const n of m.all('notifications')) if (n.at < at(addDays(today, -3), 0)) m.update('notifications', n.id, { read: true });
  m.takeDirty();
  return m;
}

type Run = (name: string, userId: string, offset: number, p: Record<string, unknown>) => unknown;
/** Route through the artist's own verified profile, then a confirmed conversation (or a decline). */
function directToConfirmed(run: Run, routeOf: (aid: string, pred?: (r: { contactId: string | null; sourceUrl: string | null; state: string }) => boolean) => string, caseOf: (aid: string) => string, aid: string, name: string, owner: string, lead: string, off: number, result = 'Conversation Confirmed') {
  const id = caseOf(aid);
  const handle = name.toLowerCase().replace(/[^a-z]+/g, '.');
  run('assignOwner', lead, off, { caseId: id, ownerId: owner });
  run('startResearch', owner, off, { caseId: id });
  run('updateChecklist', owner, off, { caseId: id, step: 1, status: 'Complete', note: 'No prior history' });
  run('addRoute', owner, off, { caseId: id, sourceUrl: `https://instagram.com/${handle}.music`, state: 'Verified', evidence: 'Official profile linked from the label page (fixture)', confidence: 90, origin: 'Research' });
  run('updateRoute', owner, off, { routeId: routeOf(aid, r => !!r.sourceUrl), state: 'Selected', reason: 'Official profile' });
  run('recordContactAttempt', owner, off + 1, { caseId: id, routeId: routeOf(aid, r => !!r.sourceUrl), channel: 'Instagram', recipient: `@${handle}.music`, message: 'Explained the existing profile and catalogue', result, evidence: result === 'Declined' ? 'Said they are not interested in managing a profile' : 'Replied and confirmed on a call', nextAction: result === 'Declined' ? 'None' : 'Send claim invitation', laterDate: '' });
}
/** Invitation -> submission -> review -> approval -> backend verification. */
function claimFlow(run: Run, aid: string, id: string, name: string, owner: string, reviewer: string, off: number) {
  run('sendClaimInvitation', owner, off + 1, { caseId: id, profileId: aid, recipient: name, notes: 'Walkthrough offered' });
  run('recordClaimSubmission', owner, off + 3, { caseId: id, claimRequestId: `CR-2026-${aid.slice(1).padStart(4, '0')}`, claimant: name });
  run('sendClaimToReview', owner, off + 3, { caseId: id, reviewerId: reviewer });
  run('reviewClaim', reviewer, off + 4, { caseId: id, decision: 'Approve', notes: 'Claimant authority confirmed', evidence: 'ID + label confirmation (fixture)' });
  run('verifyBackendClaim', reviewer, off + 5, { caseId: id, outcome: 'Verified', backendRef: `ADMIN-${aid}-CLAIMED`, verifiedOwner: name });
}

/** A contact that was already in the directory before this catalogue was loaded (no leads evaluated then). */
function directoryContact(m: Model, ctx: Ctx, p: Pick<Contact, 'personName' | 'caseId' | 'role' | 'channel' | 'value' | 'authorityEvidence' | 'willingIntroducer'>, verification: string): string {
  const k = m.insert('contacts', { id: m.nextId('CT', 4), ...p, organisation: null, verified: true, verifiedById: ctx.userId, verifiedAt: ctx.now, source: 'Contact directory (before the catalogue import)', createdAt: ctx.now });
  audit(m, ctx, { caseId: p.caseId, entity: 'Contact', entityId: k.id, action: 'Contact added', to: `${p.personName} (${p.role}, ${p.channel})`, evidence: p.authorityEvidence });
  audit(m, ctx, { caseId: p.caseId, entity: 'Contact', entityId: k.id, action: 'Contact verified', field: 'verified', from: 'false', to: 'true', evidence: verification });
  syncContactGraph(m, ctx, k.id);
  return k.id;
}
/** A verified profile carried over from an earlier directory, last checked long ago (shows the stale-profile flow). */
function staleProfile(m: Model, ctx: Ctx, caseId: string, name: string) {
  const slug = name.toLowerCase().split(' ').join('.');
  const url = `https://instagram.com/${slug}.music`;
  const p = m.insert('profiles', {
    id: m.nextId('PF', 4), caseId, collaboratorId: null, platform: 'Instagram', url, normalizedUrl: `instagram.com/${slug}.music`, displayName: name, username: `${slug}.music`, title: `${name} (@${slug}.music) · Instagram`,
    description: 'Verified in an earlier artist directory (fixture data).', location: null, language: null, links: [], tracks: [], followers: null, source: 'Earlier artist directory', foundVia: [],
    discoveryStatus: 'FOUND', verificationStatus: 'VERIFIED', evidenceScore: 70, strength: 'STRONG', matched: ['Verified in an earlier artist directory'], conflicts: [], matchedSongs: [], otherCaseId: null,
    groupKey: 'A', groupLabel: 'Candidate A', changeOfProfileId: null, scoreAtReview: 70, firstJobId: 'directory', lastJobId: 'directory', lastVersion: 0, discoveredAt: ctx.now, lastCheckedAt: ctx.now,
    reviewedAt: ctx.now, reviewedBy: ctx.userId, reviewNote: 'Carried over from the earlier directory', verifiedAt: ctx.now, verifiedBy: ctx.userId, rejectionReason: null, demo: false,
  });
  m.insert('verifiedProfiles', { id: m.nextId('VP', 4), caseId, profileId: p.id, platform: 'Instagram', url, username: p.username, displayName: name, verificationStatus: 'VERIFIED', verifiedBy: ctx.userId, verifiedAt: ctx.now, lastCheckedAt: ctx.now, source: 'Earlier artist directory (fixture data)', evidence: 'Verified before this system', replacedBy: null });
  syncProfileGraph(m, ctx, p);
  syncDiscoveryState(m, ctx, caseId);
}
