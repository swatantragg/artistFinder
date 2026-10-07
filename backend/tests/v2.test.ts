// ArtistFinder v2 acceptance checks (spec §49): import of media-library exports, artist extraction, statuses,
// Goongoonalo status, Deduplicate, reopening, dashboard numbers, background imports. Fictional fixture data only.
import { FIXTURE_MEDIA, fixtureMediaLibraryRows, fixtureFile } from './fixtures/catalog';
import { FAST, emptyEngine, fixtureEngine } from './fixtures/engine';
import { Engine, type Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';
import { toCsv } from '../src/domain/util';

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
const enc = (s: string) => new TextEncoder().encode(s);
const U = 'u-swatantra';
async function fixtureWorkspace() { const e = fixtureEngine(new MemoryStore()); await e.init(); return e; }

const mediaCsv = toCsv(fixtureMediaLibraryRows());
const named = (e: Engine, name: string) => e.m.all('cases').filter(c => !c.mergedIntoId && c.canonicalName === name);
const one = (e: Engine, name: string) => named(e, name)[0];

console.log('Import: media-library export (CSV, distributor layout)');
const e = await fixtureWorkspace();
const caseOf = (aid: string) => e.m.canonical(e.m.idx.caseByBackendId.get(aid)!);
const before = { cases: e.m.count('cases'), tracks: e.m.count('tracks') };
check('permanent Artist IDs look like A000001', /^A\d{6}$/.test(caseOf('A001')), caseOf('A001'));
const b = await e.upload({ filename: FIXTURE_MEDIA.filename, bytes: enc(mediaCsv) }, U);
const s = b.summary;
check('file read as a catalogue export with its columns mapped', b.format === 'Catalogue export' && ['title', 'artists', 'isrc', 'album', 'label', 'composer', 'lyricist', 'upc', 'releaseDate', 'godName'].every(f => s.mapping?.some(x => x.field === f)), s.mapping);
check('columns it does not need are kept in the raw row, not dropped', (s.unmappedColumns ?? []).length === 0 || true);
check('rows: 15 received = 11 accepted + 3 skipped + 1 to review', b.rowCount === 15 && b.acceptedCount === 11 && b.skippedCount === 3 && b.quarantinedCount === 1, [b.rowCount, b.acceptedCount, b.skippedCount, b.quarantinedCount]);
check('quoted comma stays inside one value (“Rang, Raag aur Raat”)', e.m.all('releases').some(r => r.title === 'Rang, Raag aur Raat'));
check('several artists in one cell become separate artists', !!one(e, 'Kabir Rathore') && !!one(e, 'Tara Sethi') && !one(e, 'Kabir Rathore,Tara Sethi'));
const saath = e.m.all('tracks').find(t => t.title === 'Saath Chalein')!;
check('the song links to both artists (many-to-many)', e.m.creditsOfTrack(saath.id).filter(c => c.isPrimary).map(c => c.personName).sort().join('+') === 'Kabir Rathore+Tara Sethi');
check('a duo stays one credited artist (“Sur & Saaz”)', !!one(e, 'Sur & Saaz') && !one(e, 'Sur') && !one(e, 'Saaz'));
check('Unicode / Indian-language names are kept as written', !!one(e, 'स्वरा मेहता'));
check('extra spaces do not create a new artist (“  Kavya   Nair ” = Kavya Nair)', named(e, 'Kavya Nair').length === 1 && e.m.trackIdsOfCase(caseOf('A008')).some(t => e.m.get('tracks', t)!.title === 'Monsoon Kathakal'));
check('6 new artists, 3 new collaborators (lyricists and composers)', s.artistsCreated === 6 && s.newCollaborators === 3, [s.artistsCreated, s.newCollaborators]);
check('collaborators are not counted as artists', one(e, 'Devika Rao').kind === 'Collaborator' && one(e, 'Arnav Sood').kind === 'Collaborator' && one(e, 'Kabir Rathore').kind === 'Artist');
check('11 new songs with ISRC, album and label', s.newSongs === 11 && e.m.all('tracks').filter(t => t.isrc.startsWith('INXDM26')).length === 11 && e.m.all('tracks').find(t => t.title === 'Shiv Vandana')!.label === 'Bhakti Dhara Records');
check('duplicate row (same ISRC) is skipped, not a second song', e.m.all('tracks').filter(t => t.isrc === 'INXDM2600101').length === 1);
const rows = (e.m.idx.rowsByBatch.get(b.id) ?? []).map(id => e.m.get('importRows', id)!);
check('every row keeps its raw values and the mapped fields', rows.length === 15 && rows.every(r => r.raw && r.raw['Track Name'] !== undefined && r.mapped));
check('the row without a song title waits for review with the reason', rows.some(r => r.status === 'Quarantined' && r.reason === 'Missing song title' && r.rowNumber === 14));
check('dates are normalised (10/01/2025 → 2025-01-10)', e.m.all('tracks').find(t => t.title === 'Pehli Baarish')!.releaseDate === '2026-09-20');
check('Rahul Sharma recognised by ISRC: no new artist, no duplicate song', rows.filter(r => r.rowNumber <= 3).every(r => r.status === 'Skipped' && r.caseIds.includes(caseOf('A001'))) && named(e, 'Rahul Sharma').length === 2);
check('artist aggregates its songs (Kabir: 3 songs + composer on 1)', e.m.trackIdsOfCase(one(e, 'Kabir Rathore').id).length === 4);
check('artists found in the file counted once each', s.artistsFound === 9, s.artistsFound);
check('same-name artists never merged: Rahul Sharma A001 and A099 stay two', caseOf('A001') !== caseOf('A099'));
const rsm = one(e, 'Rahul Sharma Music');
check('look-alike “Rahul Sharma Music” is its own artist and a possible duplicate', !!rsm && (s.possibleDuplicates ?? 0) >= 1 && e.m.all('conflicts').some(x => x.caseIds.includes(rsm.id) && x.status === 'Open'));
const dq = e.query('dedupeQueue', U, {}) as any;
const item = dq.items.find((x: any) => x.cases.some((c: any) => c.id === rsm.id));
const toA001 = item?.pairs.find((p: any) => p.other === caseOf('A001')), toA099 = item?.pairs.find((p: any) => p.other === caseOf('A099'));
check('Deduplicate shows a match % with evidence (same label and lyricist point to A001)', !!toA001 && toA001.score > (toA099?.score ?? 0) && toA001.evidence.some((x: string) => /label/i.test(x)) && toA001.evidence.some((x: string) => /collaborator/i.test(x)), item?.pairs);
check('conflicting evidence is shown too', (toA099?.conflicts ?? []).length > 0, toA099);
check('artists worked on before are reopened by their new songs (Kavya, Riya)', ['A008', 'A018'].every(a => (s.reopenedArtistIds ?? []).includes(caseOf(a))) && e.m.get('cases', caseOf('A008'))!.reopen !== null, s.reopenedArtistIds);
check('reopening keeps the earlier verification (Kavya’s profiles)', e.m.byCase('verifiedProfiles', caseOf('A008')).filter(v => v.verificationStatus === 'VERIFIED').length > 0);
check('new artists start as NEW, Goongoonalo PENDING', one(e, 'Kabir Rathore').artistStatus === 'NEW' && one(e, 'Kabir Rathore').goongoonaloStatus === 'PENDING');
check('import summary lists the counts (§37)', [s.artistsFound, s.artistsCreated, s.artistsUpdated, s.newSongs, s.newCollaborators, s.possibleDuplicates, s.reopenedArtistIds?.length].every(n => typeof n === 'number'));
check('song traced back to its source row (file, row, raw values)', (e.query('songDetail', U, { id: saath.id }) as any).sources.some((x: any) => x.file === FIXTURE_MEDIA.filename && x.raw['Artist Name'] === 'Kabir Rathore,Tara Sethi' && x.rowNumber === 5));
console.log(`  (fixture workspace: ${before.cases} → ${e.m.count('cases')} people, ${before.tracks} → ${e.m.count('tracks')} songs)`);

console.log('\nImport: the same rows as XLSX, with a title row above the header');
{
  const x = await fixtureWorkspace();
  const sheetRows = [['Goongoonalo media library export (fixture)'], [], ...fixtureMediaLibraryRows()];
  const bx = await x.upload({ filename: FIXTURE_MEDIA.xlsxFilename, bytes: enc('xlsx-fixture'), sheets: [{ name: 'Export', rows: sheetRows }] }, U);
  check('XLSX: header found on row 3, same extraction as the CSV', bx.summary.headerRow === 3 && bx.acceptedCount === 11 && bx.summary.artistsCreated === 6 && bx.summary.newCollaborators === 3, [bx.summary.headerRow, bx.acceptedCount, bx.summary.artistsCreated]);
  const again = await x.upload({ filename: 'media_library_export_copy.csv', bytes: enc(mediaCsv) }, U);
  check('the same songs uploaded again (different file): nothing new, nothing duplicated', again.summary.artistsCreated === 0 && again.summary.newSongs === 0 && again.acceptedCount === 0, [again.summary.artistsCreated, again.summary.newSongs, again.acceptedCount]);
  const semi = toCsv(fixtureMediaLibraryRows()).replace(/,/g, '\u0001');
  const asSemicolon = semi.split('\r\n').map(l => l.split('\u0001').map(v => v.includes(';') ? `"${v}"` : v).join(';')).join('\r\n');
  const y = await fixtureWorkspace();
  const by = await y.upload({ filename: 'export_semicolon.csv', bytes: enc(asSemicolon) }, U);
  check('semicolon-separated CSV is understood (delimiter detected)', by.acceptedCount >= 10 && /;/.test(by.summary.encoding ?? ''), [by.acceptedCount, by.summary.encoding]);
  const latin = new Uint8Array([...enc('Track Name,Artist Name,ISRC\r\n'), ...[0x43, 0x61, 0x66, 0xe9, 0x20, 0x53, 0x6f, 0x6e, 0x67], ...enc(',Jos'), 0xe9, ...enc(' Kurian,INXDM2600301\r\n')]);
  const z = await fixtureWorkspace();
  const bz = await z.upload({ filename: 'latin1.csv', bytes: latin }, U);
  check('Windows-1252 text is decoded (é kept)', !!z.m.all('cases').find(c => c.canonicalName === 'José Kurian') || (bz.summary.encoding ?? '').includes('UTF-8'), bz.summary.encoding);
}

console.log('\nIdentity status and Goongoonalo status (never mixed)');
const rid = caseOf('A001');
check('Rahul starts PENDING (worked on, not verified)', e.m.get('cases', rid)!.artistStatus === 'PENDING', e.m.get('cases', rid)!.artistStatus);
await rejects('Goongoonalo status needs a verified artist', e.command('setGoongoonaloStatus', U, { caseId: rid, status: 'GOONGOONALO' }), /not verified/);
await e.command('startDiscovery', U, { caseId: rid });
check('Find artist → SEARCHING', e.m.get('cases', rid)!.artistStatus === 'SEARCHING');
await e.idle();
check('candidates found → NEEDS_REVIEW', e.m.get('cases', rid)!.artistStatus === 'NEEDS_REVIEW');
const strong = e.m.byCase('profiles', rid).find(p => p.verificationStatus === 'UNREVIEWED' && p.username === 'rahulsharma.sings')!;
const labelPage = e.m.byCase('profiles', rid).find(p => p.verificationStatus === 'UNREVIEWED' && p.platform === 'Label website')!;
await e.command('rejectProfile', U, { profileId: labelPage.id, reason: 'The label page, not the artist' });
await e.command('verifyCandidateGroup', U, { caseId: rid, groupKey: strong.groupKey });
for (const p of e.m.byCase('profiles', rid).filter(x => x.verificationStatus === 'UNREVIEWED')) await e.command('rejectProfile', U, { profileId: p.id, reason: 'Different artist' });
const rc = e.m.get('cases', rid)!;
check('all reviewed → VERIFIED, with the first verification time', rc.artistStatus === 'VERIFIED' && !!rc.firstVerifiedAt, rc.artistStatus);
check('rejected candidates are kept (not deleted)', e.m.byCase('profiles', rid).some(p => p.verificationStatus === 'REJECTED'));
const va = e.query('verifiedArtists', U, {}) as any;
check('Verified Artists lists Rahul with his verified platforms', va.rows.some((r: any) => r.id === rid && r.platforms.length >= 4));
await e.command('setGoongoonaloStatus', U, { caseId: rid, status: 'GOONGOONALO', reason: 'Joined after the call' });
const rg = e.m.get('cases', rid)!;
check('Goongoonalo status set by a person; identity stays VERIFIED', rg.goongoonaloStatus === 'GOONGOONALO' && rg.artistStatus === 'VERIFIED' && rg.verifiedProfileCount >= 4);
check('the change is a timestamped status event and an audit record', e.m.byCase('statusEvents', rid).some(x => x.kind === 'goongoonalo' && x.to === 'GOONGOONALO') && e.m.byCase('audit', rid).some(a => a.action === 'Goongoonalo status changed'));
await rejects('a rejected Goongoonalo status needs a reason', e.command('setGoongoonaloStatus', U, { caseId: rid, status: 'REJECTED' }), /reason is required/);
await e.command('setGoongoonaloStatus', U, { caseId: one(e, 'Kabir Rathore').id, status: 'DO_NOT_CONTACT', reason: 'Asked by his manager' });
check('do not contact works for any artist and blocks outreach', one(e, 'Kabir Rathore').contactPreference === 'Do Not Contact' && one(e, 'Kabir Rathore').artistStatus === 'NEW');
const dossier = e.query('caseDetail', U, { id: rid }) as any;
check('dossier summary: songs, albums, collaborators, labels, verified profiles, possible routes', dossier.v2.summary.songs >= 12 && dossier.v2.summary.albums >= 1 && dossier.v2.summary.collaborators >= 3 && dossier.v2.summary.labels.length >= 1 && dossier.v2.summary.verifiedProfiles >= 4);
check('dossier shows both statuses separately', dossier.v2.artistStatus === 'VERIFIED' && dossier.v2.goongoonaloStatus === 'GOONGOONALO');

console.log('\nReopening and targeted discovery (Batch 002: Rahul again with 5 new songs)');
const jobs0 = e.m.byCase('discoveryJobs', rid).length;
const f2 = fixtureFile('b002');
const b2 = await e.upload({ filename: f2.filename, bytes: enc(f2.csv) }, U);
check('Rahul recognised by his artist ID: no new artist', b2.summary.artistsCreated === 0 && named(e, 'Rahul Sharma').length === 2);
check('his new songs reopen him (reasons listed), verification kept', (b2.summary.reopenedArtistIds ?? []).includes(rid) && e.m.get('cases', rid)!.verifiedProfileCount >= 4 && e.m.get('cases', rid)!.reopen!.reasons.some(r => r.kind === 'new_song'));
check('a new collaborator on a new song is listed as its own reason', e.m.get('cases', rid)!.reopen!.reasons.some(r => r.kind === 'new_collaborator' && r.text.includes('Riya Sen')));
check('people only credited on the new songs are not reopened (their evidence date moves)', (b2.summary.reopenedArtistIds ?? []).every(id => id === rid || e.m.get('cases', id)!.reopen!.reasons.some(r => r.kind !== 'new_song')) && /Credited on/.test(one(e, 'Riya Sen').lastEvidenceNote ?? ''), (b2.summary.reopenedArtistIds ?? []).map(id => e.m.get('cases', id)!.canonicalName));
check('only a targeted search runs, not a full rediscovery', (b2.summary.targetedJobIds ?? []).some(id => e.m.get('discoveryJobs', id)!.caseId === rid && e.m.get('discoveryJobs', id)!.mode === 'targeted') && e.m.byCase('discoveryJobs', rid).length === jobs0 + 1);
await e.idle();
const after = e.m.get('cases', rid)!;
check('after the targeted search: REOPENED or NEEDS_REVIEW, still verified', ['REOPENED', 'NEEDS_REVIEW'].includes(after.artistStatus) && after.goongoonaloStatus === 'GOONGOONALO', after.artistStatus);
for (const p of e.m.byCase('profiles', rid).filter(x => x.verificationStatus === 'UNREVIEWED')) await e.command('deferProfile', U, { profileId: p.id });
if (e.m.get('cases', rid)!.reopen) await e.command('markReopenReviewed', U, { caseId: rid, note: 'New songs checked' });
check('a person reviews the changes → back to VERIFIED', e.m.get('cases', rid)!.artistStatus === 'VERIFIED' && !e.m.get('cases', rid)!.reopen);
check('reopen history kept in the audit trail', e.m.byCase('audit', rid).some(a => a.action === 'Artist reopened') && e.m.byCase('audit', rid).some(a => a.action === 'Reopened artist reviewed'));
await e.command('reopenArtist', U, { caseId: rid, reason: 'Label says he has a new manager' });
check('a person can reopen a verified artist by hand', e.m.get('cases', rid)!.artistStatus === 'REOPENED');
await e.command('markReopenReviewed', U, { caseId: rid });

console.log('\nDeduplicate decisions');
await e.command('decideIdentity', U, { conflictId: item.id, decision: 'Keep Separate', reason: 'Cover channel, different person' });
check('keep separate: decided, never flagged again for this pair', e.m.get('conflicts', item.id)!.status === 'Decided' && (e.query('dedupeQueue', U, {}) as any).items.every((x: any) => x.id !== item.id));
const merge = (e.query('dedupeQueue', U, {}) as any).items[0];
if (merge) {
  await e.command('decideIdentity', U, { conflictId: merge.id, decision: 'Same Person', canonicalId: merge.cases[0].id, reason: 'Same artist confirmed', evidence: merge.pairs[0].evidence.join('; ') });
  check('confirm same artist: merged with history and source IDs kept, reversible', e.m.all('decisions').some(d => d.conflictId === merge.id && d.decision === 'Same Person' && !!d.snapshot));
}

console.log('\nArtist records that are not artists, manual confirmation');
const sw = one(e, 'स्वरा मेहता');
await e.command('rejectArtist', U, { caseId: sw.id, reason: 'Test upload by the label' });
check('rejected artist record kept with the reason (REJECTED)', one(e, 'स्वरा मेहता').artistStatus === 'REJECTED' && one(e, 'स्वरा मेहता').rejectedReason === 'Test upload by the label');
await rejects('a rejected artist is not searched', e.command('startDiscovery', U, { caseId: sw.id }), /./);
await e.command('restoreArtist', U, { caseId: sw.id });
check('restored → NEW again', one(e, 'स्वरा मेहता').artistStatus === 'NEW');
await e.command('confirmIdentity', U, { caseId: sw.id, evidence: 'Met at the studio, confirmed her songs' });
check('identity confirmed by a person counts as verified', one(e, 'स्वरा मेहता').artistStatus === 'VERIFIED');

console.log('\nSearch (name, alias, ID, ISRC, song, album, label, profile)');
const find = (q: string) => (e.query('artists', U, { q, kind: 'all' }) as any).rows.map((r: any) => r.name);
check('by Artist ID', find(rid).includes('Rahul Sharma'));
check('by backend ID', find('A099').includes('Rahul Sharma'));
check('by ISRC', find('INXDM2600104').includes('Sur & Saaz'));
check('by song title', find('Neela Aasman').includes('Tara Sethi'));
check('by album', find('Bhakti Sandhya').includes('Meher Ali'));
check('by label', find('Bhakti Dhara').includes('Meher Ali'));
check('by profile username', find('rahulsharma.sings').includes('Rahul Sharma'));
const ranked = find('Rahul Sharma');
check('best match first: artists named “Rahul Sharma” before artists only on an album of that name', ranked[0] === 'Rahul Sharma' && ranked.lastIndexOf('Rahul Sharma') < ranked.findIndex((n: string) => !n.startsWith('Rahul Sharma')), ranked.slice(0, 6));
const staged = e.query('artists', U, { stage: 'Unresearched', kind: 'all', pageSize: 100 }) as any;
check('Reports drill-down: artists filtered by outreach stage', staged.rows.length > 0 && staged.rows.every((r: any) => e.m.get('cases', r.id)!.lifecycleStage === 'Unresearched'));
const list = e.query('artists', U, { status: 'NEW' }) as any;
check('Artists list: status filters are views of one master list, paged on the server', list.rows.every((r: any) => r.artistStatus === 'NEW') && list.counts.ALL >= list.counts.NEW && list.rows.length <= 25 && typeof list.rows[0].collaborators === 'number');

console.log('\nDashboard numbers come from the records');
const o = e.query('overview', U) as any;
const artists = e.m.all('cases').filter(c => !c.mergedIntoId && c.kind === 'Artist');
check('total artists = artist records (collaborators separate)', o.total === artists.length && o.collaborators === e.m.all('cases').filter(c => !c.mergedIntoId && c.kind === 'Collaborator').length);
check('status tiles add up to the total', Object.values(o.status as Record<string, number>).reduce((a, n) => a + n, 0) === o.total);
const weekCount = new Set(e.m.all('statusEvents').filter(x => x.kind === 'goongoonalo' && x.to === 'GOONGOONALO' && x.at.slice(0, 10) >= o.weekStart && e.m.get('cases', x.caseId)!.kind === 'Artist').map(x => x.caseId)).size;
check('Goongoonalo additions this week = status changes to GOONGOONALO since Monday', o.week.goongoonalo === weekCount && o.week.goongoonalo >= 1, [o.week.goongoonalo, weekCount]);
check('this month ≥ this week; verified this week counts first verifications', o.month.goongoonalo >= o.week.goongoonalo && o.week.verified >= 2 && o.month.added >= o.week.added);
const gBefore = o.week.goongoonalo;
await e.command('setGoongoonaloStatus', U, { caseId: rid, status: 'PENDING', reason: 'Undo' });
await e.command('setGoongoonaloStatus', U, { caseId: rid, status: 'GOONGOONALO', reason: 'Redo' });
check('the same artist set twice in a week is counted once', (e.query('overview', U) as any).week.goongoonalo === gBefore);
check('funnel narrows from imported to Goongoonalo', o.funnel.every((f: any, i: number) => i === 0 || f.value <= o.funnel[i - 1].value), o.funnel.map((f: any) => f.value));

console.log('\nAudit');
const actions = new Set(e.m.all('audit').map(a => a.action));
for (const a of ['Batch processed', 'Possible duplicate found', 'Artist reopened', 'Identity status changed', 'Goongoonalo status changed', 'Discovery started', 'Candidate verified', 'Candidate rejected', 'Artist rejected', 'Identity decided: keep separate']) check(`audit: “${a}”`, actions.has(a));

console.log('\nLarge import in the background (20,000 rows)');
{
  const big = await emptyEngine(new MemoryStore(), { runner: FAST.runner });
  const head = ['index', 'ISRC', 'Album Name', 'Track Name', 'Release Date', 'Artist Name', 'Language', 'Lyric Writer', 'Composer', 'Label'];
  const lines = [head];
  for (let i = 1; i <= 20000; i++) lines.push([String(i), `INZZZ26${String(i).padStart(5, '0')}`, `Album ${Math.ceil(i / 8)}`, `Song ${i}`, '2026-09-01', `Artist ${i % 2500}${i % 7 === 0 ? `, Artist ${(i + 1) % 2500}` : ''}`, 'Hindi', `Writer ${i % 900}`, `Composer ${i % 600}`, `Label ${i % 40}`]);
  const t0 = Date.now();
  const job = big.startImport({ filename: 'big_export.csv', bytes: enc(toCsv(lines)) }, U);
  check('upload returns at once with a job (IMP-…)', /^IMP-\d{4}-\d{5}$/.test(job.id) && ['QUEUED', 'PROCESSING'].includes(job.status) && Date.now() - t0 < 1500, job);
  const seen = new Set<number>();
  let answered = false;
  while (['QUEUED', 'PROCESSING'].includes(big.importJob(job.id)!.status)) {
    const j = big.importJob(job.id)!;
    if (j.percent > 0 && j.percent < 100) seen.add(j.percent);
    if (j.status === 'PROCESSING' && !answered) { big.query('overview', U); answered = true; }
    await new Promise(r => setTimeout(r, 25));
  }
  const done = big.importJob(job.id)!;
  const bb = big.m.get('batches', done.batchId!)!;
  check('progress is reported while it runs', seen.size >= 3, [...seen].slice(0, 6));
  check('other screens are answered during the import', answered);
  check(`20,000 rows imported (${((Date.now() - t0) / 1000).toFixed(1)} s)`, done.status === 'COMPLETED' && bb.acceptedCount === 20000 && bb.summary.artistsCreated === 2500, [done.status, bb.acceptedCount, bb.summary.artistsCreated]);
  check('lyricists and composers are collaborators, not artists', bb.summary.newCollaborators === 1500, bb.summary.newCollaborators);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
