// Keep only the verified artists (V2.7.2): they keep everything that is theirs; every other artist, song and import goes.
// Fictional fixture data only.
import { fixtureEngine } from './fixtures/engine';
import type { Engine, Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';
import { isVerified } from '../src/domain/status';

let replaced = null as Snapshot | null;
class MemoryStore implements Store { async load(): Promise<Snapshot | null> { return null; } async save(_d: Dirty) {} async replace(s: Snapshot) { replaced = s; } }
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
async function rejects(name: string, p: Promise<unknown>, match: RegExp) {
  try { await p; check(name, false, 'no error'); } catch (e) { check(name, match.test((e as Error).message), (e as Error).message); }
}
const OWNER = 'u-swatantra';
const e: Engine = fixtureEngine(new MemoryStore());
await e.init();
// make sure there is one verified artist with songs, a verified profile, a route and a message
let m = e.m;
const a = m.all('cases').find(c => !c.mergedIntoId && c.kind === 'Artist' && m.trackIdsOfCase(c.id).length > 1 && !isVerified(c))!;
const now = new Date().toISOString();
m.insert('verifiedProfiles', { id: 'VP-PRUNE', caseId: a.id, profileId: null, platform: 'Instagram', url: 'https://instagram.com/prune.test', username: 'prune.test', displayName: a.canonicalName, verificationStatus: 'VERIFIED', verifiedBy: OWNER, verifiedAt: now, lastCheckedAt: now, source: 'test', evidence: 'test', replacedBy: null });
m.update('cases', a.id, { verifiedProfileCount: 1, artistStatus: 'VERIFIED', manualVerifiedAt: now, manualVerifiedBy: OWNER, firstVerifiedAt: now, lifecycleStage: 'Researching', contactPreference: 'Allowed', goongoonaloStatus: 'NOT_MEMBER' });
await e.command('useProfileAsRoute', OWNER, { caseId: a.id, url: 'https://instagram.com/prune.test' });
await e.command('sendMessage', OWNER, { caseId: a.id, kind: 'invite', platform: 'Instagram', text: 'Hello' });
const verifiedBefore = m.all('cases').filter(c => !c.mergedIntoId && !c.rejectedAt && isVerified(c)).map(c => c.id);
const songsOfA = m.trackIdsOfCase(a.id).length;
const routesOfA = m.byCase('routes', a.id).length;
const casesBefore = m.count('cases');

console.log('Keep only the verified artists');
await rejects('only the System Owner, and only with the confirmation', e.keepOnlyVerified('u-priya'), /System Owner/);
const res = await e.keepOnlyVerified(OWNER);
m = e.m;
check('only verified artists (and merged duplicates of them) remain', m.all('cases').every(c => verifiedBefore.includes(c.id) || (!!c.mergedIntoId && verifiedBefore.includes(c.mergedIntoId))) && verifiedBefore.every(id => !!m.get('cases', id)) && m.count('cases') < casesBefore, [res.kept, casesBefore]);
check('their songs, profile, route and message stay', m.trackIdsOfCase(a.id).length === songsOfA && m.byCase('verifiedProfiles', a.id).length === 1 && m.byCase('routes', a.id).length === routesOfA && m.byCase('messages', a.id).length === 1, [m.trackIdsOfCase(a.id).length, songsOfA, m.byCase('verifiedProfiles', a.id).length, m.byCase('routes', a.id).length, m.byCase('messages', a.id).length]);
check('no import batches or import rows left', m.count('batches') === 0 && m.count('importRows') === 0);
check('people and settings stay', m.all('users').some(u => u.id === OWNER) && m.all('meta').length > 0);
const caseIds = new Set(m.all('cases').map(c => c.id));
const dangling = [
  ...m.all('credits').filter(cr => cr.caseId && !caseIds.has(cr.caseId)).map(x => `credit ${x.id}`),
  ...m.all('credits').filter(cr => !m.get('tracks', cr.trackId)).map(x => `credit track ${x.id}`),
  ...m.all('routes').filter(r => !caseIds.has(r.targetCaseId)).map(x => `route ${x.id}`),
  ...m.all('profiles').filter(p => p.caseId && !caseIds.has(p.caseId)).map(x => `profile ${x.id}`),
  ...m.all('tasks').filter(t => !caseIds.has(t.caseId)).map(x => `task ${x.id}`),
  ...m.all('audit').filter(x => x.caseId && !caseIds.has(x.caseId)).map(x => `audit ${x.id}`),
  ...m.all('discoveryQueries').filter(q => !m.get('discoveryJobs', q.jobId)).map(x => `query ${x.id}`),
  ...m.all('tracks').filter(t => t.releaseId && !m.get('releases', t.releaseId)).map(x => `release of ${x.id}`),
];
check('nothing points at a removed record', !dangling.length, dangling.slice(0, 5));
const saved = replaced as Snapshot | null;
check('the database got exactly what is kept', !!saved && saved.cases!.length === m.count('cases') && (saved.importRows ?? []).length === 0);
check('the app still works on what is left', !!e.query('caseDetail', OWNER, { id: a.id }) && (e.query('artists', OWNER, {}) as any).rows !== undefined && (e.query('verifiedArtists', OWNER, {}) as any).rows.some((r: any) => r.id === a.id));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
