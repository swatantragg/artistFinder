// Verified artists → Excel (V2.7.2), in the artist directory's layout; "Social link" has one column per platform.
// Fictional fixture data only.
import * as XLSX from 'xlsx';
import { emptyEngine, fixtureEngine } from './fixtures/engine';
import type { Engine, Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';
import { sheetOf, type VerifiedExport } from '../src/domain/exports';
import { detectLayout } from '../src/domain/importer';
import { songCounts } from '../src/domain/views';
import { verifiedWorkbook } from '../src/server/exports';

class MemoryStore implements Store { async load(): Promise<Snapshot | null> { return null; } async save(_d: Dirty) {} async replace(_s: Snapshot) {} }
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
const U = 'u-swatantra';
const e: Engine = fixtureEngine(new MemoryStore());
await e.init();
const m = e.m;
const a = m.all('cases').find(c => !c.mergedIntoId && c.kind === 'Artist' && m.trackIdsOfCase(c.id).length > 1)!;
const now = new Date().toISOString();
const vp = (id: string, platform: string, url: string) => m.insert('verifiedProfiles', { id, caseId: a.id, profileId: null, platform: platform as any, url, username: url.split('/').pop()!, displayName: a.canonicalName, verificationStatus: 'VERIFIED', verifiedBy: U, verifiedAt: now, lastCheckedAt: now, source: 'test', evidence: 'test', replacedBy: null });
vp('VP-E1', 'Instagram', 'https://instagram.com/export.test'); vp('VP-E2', 'Facebook', 'https://facebook.com/export.test'); vp('VP-E3', 'X', 'https://x.com/export_test');
m.update('cases', a.id, { verifiedProfileCount: 3, artistStatus: 'VERIFIED', manualVerifiedAt: now, firstVerifiedAt: now, directory: { songs: 999, followers: 12, listeners: 3, verified: true, core: false, link: 'https://instagram.com/export.test', confidence: 90, basis: 'Official site links it', batchId: 'B1', sheet: 'A-B', row: 2 } });

console.log('Export data');
const data = e.query('verifiedExport', U) as VerifiedExport;
const row = data.rows.find(r => r.artistId === a.id)!;
check('every verified artist, and only them', data.rows.length > 0 && data.rows.every(r => { const c = m.get('cases', r.artistId)!; return c.verifiedProfileCount > 0 || !!c.manualVerifiedAt || c.claimStatus === 'Completed'; }) && !!row);
check('social links: Instagram, Facebook and X in their own columns, the rest blank', row.links.Instagram?.[0] === 'https://instagram.com/export.test' && row.links.Facebook?.length === 1 && row.links.X?.length === 1 && !row.links.YouTube, row.links);
check('songs = today’s count; titles from the songs on file; directory facts kept', row.songs === songCounts(m).get(a.id) && row.songs === 999 && row.titles.length === m.trackIdsOfCase(a.id).length && row.confidence === 90 && row.verified === true);
check('letter-pair sheets like the directory', sheetOf('Asha') === 'A-B' && sheetOf('Zubin') === 'Y-Z' && sheetOf('_Vinny') === 'U-V' && sheetOf('2 Toniks') === '0-9 & Other' && sheetOf('सिंगर') === '0-9 & Other');

console.log('\nThe workbook');
const wb = XLSX.read(verifiedWorkbook(data), { type: 'buffer' });
check('an Index sheet, then the letter sheets that have names', wb.SheetNames[0] === 'Index' && wb.SheetNames.includes(row.sheet), wb.SheetNames);
const ws = wb.Sheets[row.sheet];
const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
const h1 = aoa[0] as string[], h2 = aoa[1] as string[];
check('same columns as the directory, “Social link” split into platforms', h1[0] === '#' && h1[1] === 'Artist name' && h1[2] === 'Social link' && h2[2] === 'Instagram' && h2[3] === 'Facebook' && h2[4] === 'X' && h1.includes('Song titles') && h1.includes('Core member'), [h1, h2]);
check('“Social link” is one merged header over its columns', (ws['!merges'] ?? []).some(mg => mg.s.r === 0 && mg.s.c === 2 && mg.e.c === 2 + data.platforms.length - 1));
const line = aoa.find(r => (r as string[])[1] === a.canonicalName) as (string | number)[];
check('the artist’s row: three links, blanks elsewhere, songs and titles', line[2] === 'https://instagram.com/export.test' && line[3] === 'https://facebook.com/export.test' && line[4] === 'https://x.com/export_test' && line[5] === '' && line[2 + data.platforms.length + 2] === 999 && String(line[line.length - 1]).includes(' | '), line);
const link = ws[XLSX.utils.encode_cell({ r: aoa.indexOf(line), c: 2 })];
check('links are clickable', link?.l?.Target === 'https://instagram.com/export.test');
const sheets = wb.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', raw: false }) }));
check('the export can be imported again as an artist directory', detectLayout({ filename: 'x.xlsx', checksum: 'x', sheets })?.format === 'Artist directory');

const fresh = await emptyEngine(new MemoryStore());
const owner = fresh.m.all('users').find(u => u.role === 'System Owner')!;
const back = await fresh.upload({ filename: 'verified-artists.xlsx', bytes: new Uint8Array(verifiedWorkbook(data)), sheets } as any, owner.id);
const again = fresh.m.casesNamed(a.canonicalName)[0];
check('imported again: every platform column becomes a profile to verify; songs and titles come along', back.status === 'Processed' && back.rowCount === data.rows.length && fresh.m.byCase('profiles', again.id).map(p => p.platform).sort().join(',') === 'Facebook,Instagram,X' && again.directory?.songs === 999 && fresh.m.trackIdsOfCase(again.id).length === row.titles.length, [back.status, back.rowCount, fresh.m.byCase('profiles', again?.id ?? '').map(p => p.platform)]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
