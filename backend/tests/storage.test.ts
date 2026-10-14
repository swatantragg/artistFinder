// Storage (V2.5.0 clean-up): the catalogue part of the graph is not stored but rebuilt on load, saves never write it,
// and track signatures are SHA-256 hashes that still recognise unchanged rows on a re-import. Fictional fixture data only.
import { FIXTURE_MEDIA, fixtureMediaLibraryRows } from './fixtures/catalog';
import { fixtureEngine } from './fixtures/engine';
import { DERIVED_EDGE_TYPES, DERIVED_NODE_TYPES } from '../src/domain/constants';
import type { Store } from '../src/domain/engine';
import { caseGraph } from '../src/domain/graph';
import type { Dirty, Snapshot } from '../src/domain/model';
import { topArtistIds } from '../src/domain/views';
import { toCsv } from '../src/domain/util';

/** A store that keeps what it is given, like the database would. */
class KeepStore implements Store {
  saved: Dirty[] = [];
  constructor(public snap: Snapshot | null = null) {}
  async load() { return this.snap ? structuredClone(this.snap) : null; }
  async save(d: Dirty) { this.saved.push(d); }
  async replace(s: Snapshot) { this.snap = structuredClone(s); }
}
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
const U = 'u-swatantra';
const derivedEdge = (e: { type: string }) => (DERIVED_EDGE_TYPES as readonly string[]).includes(e.type);
const derivedNode = (n: { type: string }) => (DERIVED_NODE_TYPES as readonly string[]).includes(n.type);

console.log('The catalogue graph is rebuilt, not stored');
const a = fixtureEngine(new KeepStore());
await a.init();
const csv = toCsv(fixtureMediaLibraryRows());
await a.upload({ filename: FIXTURE_MEDIA.filename, bytes: new TextEncoder().encode(csv) }, U);
const stored = a.m.storedSnapshot();
check('the workspace has catalogue edges in memory', a.m.all('graphEdges').some(derivedEdge));
check('what the database keeps has none (edges or song/release nodes)', !stored.graphEdges!.some(derivedEdge) && !stored.graphNodes!.some(derivedNode));
check('edges decided by people stay stored', stored.graphEdges!.length > 0 && stored.graphEdges!.length === a.m.all('graphEdges').filter(e => !derivedEdge(e)).length);

const keep = new KeepStore(stored);
const b = fixtureEngine(keep);
check('loads the stored workspace', (await b.init()) === 'loaded');
const keys = (m: typeof a.m) => new Set(m.all('graphEdges').map(e => `${e.key}|${e.status}|${e.active}`));
const ka = keys(a.m), kb = keys(b.m);
const top = new Set(topArtistIds(b.m));
check('the rebuilt graph is part of the original (nothing invented)', [...kb].every(k => ka.has(k)), [...kb].filter(k => !ka.has(k)).slice(0, 3));
const songOfTop = (song: string) => b.m.creditsOfTrack(song.slice(5)).some(cr => cr.caseId && top.has(b.m.canonical(cr.caseId)));
check('catalogue links only for songs of the top 250 artists', b.m.all('graphEdges').filter(derivedEdge).every(e => songOfTop(e.sourceId.startsWith('song:') ? e.sourceId : e.targetId)));
check('fewer links kept than before (the rest are gone)', kb.size < ka.size, [ka.size, kb.size]);
check('every link decided by people is still there', a.m.all('graphEdges').filter(e => !derivedEdge(e)).every(e => b.m.get('graphEdges', e.id)));
const artist = topArtistIds(b.m).map(id => b.m.get('cases', id)!).find(c => b.m.trackIdsOfCase(c.id).length > 1)!;
const ga = caseGraph(a.m, artist.id), gb = caseGraph(b.m, artist.id);
check('a top artist’s Connection Graph is unchanged', ga.nodes.length === gb.nodes.length && ga.edges.length === gb.edges.length && gb.nodes.length > 1, [ga.nodes.length, gb.nodes.length, ga.edges.length, gb.edges.length]);
const outside = b.m.all('cases').find(c => !c.mergedIntoId && c.kind === 'Artist' && !top.has(c.id) && b.m.trackIdsOfCase(c.id).length > 0);
if (outside) check('an artist outside the top 250 has no catalogue graph', !b.m.get('graphNodes', `case:${outside.id}`) || caseGraph(b.m, outside.id).edges.every(e => !derivedEdge(e)));

await b.command('addRoute', U, { caseId: artist.id, sourceUrl: 'https://instagram.com/storage.test', state: 'Candidate', evidence: 'Storage test' });
await b.upload({ filename: 'again.csv', bytes: new TextEncoder().encode(csv) }, U);
const written = keep.saved.flatMap(d => [...(d.created.graphEdges ?? []), ...(d.updated.graphEdges ?? [])]);
const writtenNodes = keep.saved.flatMap(d => [...(d.created.graphNodes ?? []), ...(d.updated.graphNodes ?? [])]);
check('saves never write catalogue edges or song/release nodes', !written.some(derivedEdge) && !writtenNodes.some(derivedNode));
check('…but do write the new route’s edges', written.some(e => e.type === 'ROUTE_CONNECTS_ARTIST'));

console.log('\nTrack signatures are hashes');
check('64-character SHA-256 for every song', a.m.all('tracks').every(t => /^[0-9a-f]{64}$/.test(t.sig)));
const again = b.m.all('batches').sort((x, y) => x.id.localeCompare(y.id)).pop()!;
check('re-importing the same file: every row recognised as unchanged', again.skippedCount > 0 && again.summary.newSongs === 0 && again.summary.updatedSongs === 0, [again.skippedCount, again.summary.newSongs, again.summary.updatedSongs]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
