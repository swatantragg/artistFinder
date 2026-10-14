// Instagram accuracy (V2.7.1), on the candidates search really returned for the singer Shaan: his Instagram @singer_shaan
// (“Shaan Mukherji”) must win over a label page (@shaanmusiclabel), helped by the same handle on X and Facebook.
import { sameHandleOn, scoreProfile, MATCH_THRESHOLD, type ProfileInput } from '../src/domain/discovery/evidence';
import { artistQueries, type CaseFacts } from '../src/domain/discovery/queries';
import { manualProfileProblem } from '../src/domain/discovery/normalize';
import { fixtureEngine } from './fixtures/engine';
import type { Engine, Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
const facts: CaseFacts = {
  caseId: 'A000160', name: 'Shaan', aliases: [], artistIds: [], roles: ['Singer'], language: null, songs: [], labels: ['Shaan Music'], distributors: [], collaborators: [],
  profileUrls: [], otherSameName: [], rejected: new Map(), verifiedUrls: new Map(), stats: { songs: 605, credits: 0, collaborators: 0, isrcs: 0, labels: 1, releases: 0 },
};
const profile = (platform: ProfileInput['platform'], username: string, displayName: string, title: string): ProfileInput => ({
  normalizedUrl: `${platform.toLowerCase()}.com/${username}`, platform, displayName, username, title, description: '', location: null, language: null, links: [], tracks: [],
});
const igRight = profile('Instagram', 'singer_shaan', 'Shaan Mukherji', 'Shaan Mukherji (@singer_shaan)');
const igLabel = profile('Instagram', 'shaanmusiclabel', 'Shaan Music', 'Shaan Music (@shaanmusiclabel) • Instagram photos and videos');
const x = profile('X', 'singer_shaan', 'Shaan', 'Shaan (@singer_shaan) / X');
const fb = profile('Facebook', 'singer.shaan', 'Shaan', 'Shaan (@singer.shaan)');

console.log('Shaan on Instagram');
const sx = scoreProfile(x, facts), sf = scoreProfile(fb, facts);
check('X @singer_shaan and Facebook @singer.shaan reach 50%', sx.score >= MATCH_THRESHOLD && sf.score >= MATCH_THRESHOLD, [sx.score, sf.score]);
const label = scoreProfile(igLabel, facts);
check('the label page is marked as a label or company page and stays under 50%', label.items.some(i => i.kind === 'Label or company page') && label.score < MATCH_THRESHOLD, label.score);
const others = [{ platform: 'X', username: 'singer_shaan', verified: false }, { platform: 'Facebook', username: 'singer.shaan', verified: false }];
const same = sameHandleOn('Instagram', igRight.username, others);
check('same handle found on X and Facebook', same.length === 2, same);
const right = scoreProfile(igRight, facts, [], same);
check('@singer_shaan now reaches 50% and beats the label page', right.score >= MATCH_THRESHOLD && right.score > label.score, [right.score, label.score]);
check('the reason is shown to people', right.items.some(i => /Same handle as the artist’s X and Facebook/.test(i.detail)));
check('without the other platforms it would have stayed hidden (the old result)', scoreProfile(igRight, facts).score < MATCH_THRESHOLD);
check('a verified profile counts more', scoreProfile(igRight, facts, [], sameHandleOn('Instagram', 'singer_shaan', [{ platform: 'X', username: 'singer_shaan', verified: true }])).score > scoreProfile(igRight, facts, [], sameHandleOn('Instagram', 'singer_shaan', [{ platform: 'X', username: 'singer_shaan', verified: false }])).score);
check('short handles shared by many people do not count', sameHandleOn('Instagram', 'shaan', [{ platform: 'X', username: 'shaan', verified: true }]).length === 0);
check('the Instagram search adds the role, like a person would', artistQueries(facts, 'full').some(q => q.query === '"Shaan" singer site:instagram.com'), artistQueries(facts, 'full').map(q => q.query).slice(0, 4));

console.log('\nAdding a profile by hand: only real profile links of the chosen platform');
const ok = (p: string, u: string) => !manualProfileProblem(p, u).problem;
check('Facebook profile link accepted', ok('Facebook', 'https://www.facebook.com/singer.shaan'));
check('Instagram, X, Spotify, Apple Music, YouTube accepted', ok('Instagram', 'https://www.instagram.com/singer_shaan/') && ok('X', 'https://x.com/singer_shaan') && ok('X', 'https://twitter.com/singer_shaan') && ok('Spotify', 'https://open.spotify.com/artist/5cB4d4jPYjMT326sjihQ4m') && ok('Apple Music', 'https://music.apple.com/in/artist/shaan/260041408') && ok('YouTube', 'https://www.youtube.com/@singershaan'));
check('another site is refused', /not a Facebook link/i.test(manualProfileProblem('Facebook', 'https://evil.example/facebook.com/singer.shaan').problem ?? ''));
check('a look-alike host is refused', !ok('Facebook', 'https://facebook.com.evil.example/singer.shaan') && !ok('Instagram', 'https://instagram.com-login.example/x'));
check('a link of another platform is refused', !ok('Instagram', 'https://www.facebook.com/singer.shaan'));
check('a post instead of the profile is refused', !ok('Instagram', 'https://www.instagram.com/p/C123abc/'));
check('only https; no passwords or odd schemes', !ok('Instagram', 'http://instagram.com/singer_shaan') && !ok('Instagram', 'javascript:alert(1)') && !ok('Instagram', 'https://user:pass@instagram.com/singer_shaan'));

console.log('\nAdding a profile by hand: saved as verified, can replace a wrong one');
class MemoryStore implements Store { async load(): Promise<Snapshot | null> { return null; } async save(_d: Dirty) {} async replace(_s: Snapshot) {} }
const U = 'u-swatantra';
const e: Engine = fixtureEngine(new MemoryStore());
await e.init();
const m = e.m;
const a = m.all('cases').find(c => !c.mergedIntoId && c.kind === 'Artist' && !m.byCase('profiles', c.id).length)!;
async function refused(name: string, p: Promise<unknown>, match: RegExp) {
  try { await p; check(name, false, 'no error'); } catch (err) { check(name, match.test((err as Error).message), (err as Error).message); }
}
await refused('a bad link is refused by the server too', e.command('addProfileByHand', U, { caseId: a.id, platform: 'Instagram', url: 'https://instagram.com.evil.example/x' }), /not a Instagram link|not an Instagram link|Instagram/);
await e.command('addProfileByHand', U, { caseId: a.id, platform: 'Instagram', url: 'https://www.instagram.com/wrong.page/' });
const wrong = m.byCase('profiles', a.id).find(p => p.username === 'wrong.page')!;
check('added profile is verified, marked as added by hand', wrong?.verificationStatus === 'VERIFIED' && wrong.source === 'Added by hand' && m.byCase('verifiedProfiles', a.id).some(v => v.profileId === wrong.id && v.verificationStatus === 'VERIFIED'));
await refused('the same link twice is refused', e.command('addProfileByHand', U, { caseId: a.id, platform: 'Instagram', url: 'https://instagram.com/wrong.page' }), /already verified/);
await e.command('addProfileByHand', U, { caseId: a.id, platform: 'Instagram', url: 'https://www.instagram.com/right.page', replaceProfileId: wrong.id, note: 'The other one was a label page' });
const good = m.byCase('profiles', a.id).find(p => p.username === 'right.page')!;
check('the right one replaces the wrong one (kept in history)', good.verificationStatus === 'VERIFIED' && m.get('profiles', wrong.id)!.verificationStatus === 'REPLACED' && m.byCase('verifiedProfiles', a.id).find(v => v.profileId === wrong.id)!.verificationStatus === 'REPLACED');
check('audited with who and why', m.all('audit').some(x => x.entityId === good.id && x.action === 'Profile added by hand' && /label page/.test(x.reason ?? '')));
await refused('only a verified profile of the same platform can be replaced', e.command('addProfileByHand', U, { caseId: a.id, platform: 'X', url: 'https://x.com/right_page', replaceProfileId: good.id }), /Only a verified X profile/);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
