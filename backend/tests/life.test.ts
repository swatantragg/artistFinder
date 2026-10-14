// "Is the artist alive?" (V2.7.2): checked first by Find artist; an artist who passed away pauses the search (no quota)
// until a person decides: continue anyway, or remove (the next artist by songs moves up). And: artists whose search
// started leave the Artists list for Verified Artists → In progress. Fictional fixture data and fictional records only.
import { fixtureEngine, fixtureProviderSet } from './fixtures/engine';
import type { Engine, Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';
import { pickLife, type WdEntity } from '../src/domain/life';
import { artistRanks } from '../src/domain/views';
import type { LifeCheck } from '../src/domain/types';

class MemoryStore implements Store { async load(): Promise<Snapshot | null> { return null; } async save(_d: Dirty) {} async replace(_s: Snapshot) {} }
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
const NOW = '2026-10-14T10:00:00.000Z';
const claim = (id: string) => [{ mainsnak: { datavalue: { value: { id } } } }];
const time = (t: string, precision = 11) => [{ mainsnak: { datavalue: { value: { time: t, precision } } } }];
const person = (id: string, label: string, description: string, claims: Record<string, unknown[]>, sitelinks = 5): WdEntity => ({
  id, labels: { en: { value: label } }, descriptions: { en: { value: description } }, claims: { P31: claim('Q5'), ...claims } as WdEntity['claims'],
  sitelinks: Object.fromEntries(Array.from({ length: sitelinks }, (_, i) => [i ? `wiki${i}` : 'enwiki', { title: label }])),
});

console.log('Reading public records (Wikidata)');
{
  const singer = person('Q1', 'Meera Raag', 'Indian playback singer (1940–2021)', { P106: claim('Q2643890'), P569: time('+1940-01-02T00:00:00Z'), P570: time('+2021-03-04T00:00:00Z') });
  const l = pickLife(['Meera Raag'], [singer], NOW);
  check('a singer with a date of death → passed away, with the date and the Wikipedia link', l.status === 'Deceased' && l.deathDate === '2021-03-04' && l.birthDate === '1940-01-02' && /en\.wikipedia\.org\/wiki\/Meera_Raag/.test(l.source ?? ''), l);
  check('no date of death → no date on record (alive)', pickLife(['Meera Raag'], [person('Q2', 'Meera Raag', 'Indian singer', { P106: claim('Q177220') })], NOW).status === 'Alive');
  check('someone else with the name (a politician) does not count', pickLife(['Meera Raag'], [person('Q3', 'Meera Raag', 'Indian politician', { P106: claim('Q82955'), P570: time('+2001-01-01T00:00:00Z') })], NOW).status === 'Unknown');
  check('only the exact name counts (dots and case ignored)', pickLife(['K. S. Meera'], [person('Q4', 'K S Meera', 'Indian singer', { P570: time('+2010-05-05T00:00:00Z') })], NOW).status === 'Deceased'
    && pickLife(['Meera'], [person('Q5', 'Meera Raag Sharma', 'Indian singer', { P570: time('+2010-05-05T00:00:00Z') })], NOW).status === 'Unknown');
  check('only the year known → the year', pickLife(['Meera Raag'], [person('Q6', 'Meera Raag', 'singer', { P570: time('+1999-00-00T00:00:00Z', 9) })], NOW).deathDate === '1999');
  const two = pickLife(['Meera Raag'], [person('Q7', 'Meera Raag', 'Indian singer', {}, 30), person('Q8', 'Meera Raag', 'American singer', { P570: time('+1990-01-01T00:00:00Z') }, 3)], NOW);
  check('two singers with the name: the better known one, and the other is counted', two.status === 'Alive' && two.others === 1);
}

console.log('\nFind artist checks first, and waits for a person when the artist passed away');
const dead = new Set<string>();
let lifeDown = false;
const fakeLife = async (names: string[]): Promise<LifeCheck | null> => {
  if (lifeDown) throw new Error('Wikidata is busy');
  const d = dead.has(names[0]);
  return { status: d ? 'Deceased' : 'Alive', deathDate: d ? '2021-03-04' : null, birthDate: null, label: names[0], description: d ? 'Indian singer (1940–2021)' : 'Indian singer', source: 'https://www.wikidata.org/wiki/Q1', others: 0, checkedAt: NOW, decision: null, decidedBy: null, decidedAt: null };
};
const U = 'u-swatantra';
const e: Engine = fixtureEngine(new MemoryStore(), { providers: g => ({ ...fixtureProviderSet(g), lifeCheck: fakeLife }) });
await e.init();
const m = e.m;
const q = (name: string, p: object = {}) => e.query(name, U, p as Record<string, unknown>) as any;
const ranks0 = artistRanks(m);
const fresh = [...ranks0.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => m.get('cases', id)!).filter(c => c.artistStatus === 'NEW' && c.discoveryStatus === 'Not started');
const [a, b, c3] = fresh;
const inArtists = (id: string) => q('artists', { scope: 'all', pageSize: 100 }).rows.some((r: any) => r.id === id);
const inProgress = (id: string, status?: string) => q('verifiedArtists', { view: 'progress', status, pageSize: 100 }).rows.some((r: any) => r.id === id);
check('not started: listed in Artists', inArtists(a.id) && !inProgress(a.id));

dead.add(a.canonicalName);
await e.command('startDiscovery', U, { caseId: a.id });
await e.idle();
let ca = m.get('cases', a.id)!;
const job = m.byCase('discoveryJobs', a.id).pop()!;
check('passed away: the search pauses before searching (no queries, no quota)', job.status === 'FAILED' && /Paused: .*passed away/.test(job.failureReason ?? '') && !m.all('discoveryQueries').some(x => x.jobId === job.id), job.failureReason);
check('the artist shows “Needs decision” with the date and the source', ca.discoveryStatus === 'Needs decision' && ca.life?.status === 'Deceased' && ca.life.deathDate === '2021-03-04' && !!ca.life.source);
check('moved out of Artists into Verified Artists → In progress → Passed away', !inArtists(a.id) && inProgress(a.id, 'DECIDE'));
check('a search still finds the artist in Artists', q('artists', { q: a.canonicalName }).rows.some((r: any) => r.id === a.id));
check('row action asks the question; the badge counts it', /Passed away/.test(q('verifiedArtists', { view: 'progress', status: 'DECIDE' }).rows.find((r: any) => r.id === a.id)?.action?.label ?? '') && (q('meta').badges.verifiedTodo ?? 0) >= 1);
check('the timeline says what was checked', m.byCase('audit', a.id).some(x => x.action === 'Checked: is the artist alive?') && m.byCase('audit', a.id).some(x => x.action === 'Search paused: artist passed away'));

const behind = [...ranks0.entries()].filter(([, r]) => r > ranks0.get(a.id)!).sort((x, y) => x[1] - y[1]).slice(0, 3);
const res = await e.command('decideLife', U, { caseId: a.id, decision: 'remove', note: 'Family asked us not to' });
ca = m.get('cases', a.id)!;
const ranks1 = artistRanks(m);
check('remove: the artist is rejected with the reason, the decision is kept', !!ca.rejectedAt && /Passed away \(died 4 Mar 2021\)/.test(ca.rejectedReason ?? '') && ca.life?.decision === 'Removed' && ca.discoveryStatus !== 'Needs decision', [ca.rejectedReason, ca.discoveryStatus]);
check('the removed artist has no rank; everyone after moves up one place (#251 joins the top 250)', !ranks1.has(a.id) && behind.every(([id, r]) => ranks1.get(id) === r - 1), behind.map(([id, r]) => [r, ranks1.get(id)]));
check('the message says the artist was removed', /removed \(passed away\)/.test(res.message), res.message);
check('listed under Artists → Rejected (and can be restored)', q('artists', { status: 'REJECTED' }).rows.some((r: any) => r.id === a.id));

console.log('\nContinue anyway');
dead.add(b.canonicalName);
await e.command('startDiscovery', U, { caseId: b.id });
await e.idle();
check('second artist waits too', m.get('cases', b.id)!.discoveryStatus === 'Needs decision');
await e.command('decideLife', U, { caseId: b.id, decision: 'continue', note: 'Talk to the estate' });
await e.idle();
const cb = m.get('cases', b.id)!;
const last = m.byCase('discoveryJobs', b.id).pop()!;
check('continue: the decision is kept and the search runs to the end', cb.life?.decision === 'Proceed' && last.status !== 'FAILED' && cb.discoveryStatus !== 'Needs decision' && !cb.rejectedAt, [last.status, cb.discoveryStatus]);
await refusedLike('nothing to decide for an artist with no date of death', () => e.command('decideLife', U, { caseId: c3.id, decision: 'remove' }), /Nothing to decide/);

console.log('\nAlive, or the check is down');
lifeDown = true;
await e.command('startDiscovery', U, { caseId: c3.id });
await e.idle();
const cc = m.get('cases', c3.id)!;
check('records unavailable: the search goes on as before', m.byCase('discoveryJobs', c3.id).pop()!.status !== 'FAILED' && !cc.life);
check('started artists are in Verified Artists → In progress, not in Artists', !inArtists(c3.id) && (inProgress(c3.id) || q('verifiedArtists', {}).rows.some((r: any) => r.id === c3.id)));

console.log('\nArtists searched before the check existed');
lifeDown = false;
dead.add(c3.canonicalName);
const checkedN = await e.checkLives();
const c3b = m.get('cases', c3.id)!;
check('checked once in the background: the question appears on the artist page', checkedN >= 1 && c3b.life?.status === 'Deceased' && c3b.discoveryStatus === 'Needs decision' && inProgress(c3.id, 'DECIDE'), [checkedN, c3b.discoveryStatus]);
check('artists already checked are not checked again', (await e.checkLives()) === 0);

async function refusedLike(name: string, fn: () => Promise<unknown>, match: RegExp) {
  try { await fn(); check(name, false, 'no error'); } catch (err) { check(name, match.test((err as Error).message), (err as Error).message); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
