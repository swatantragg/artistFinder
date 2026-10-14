// Artist directory import (V2.7.2): the Admin Studio export (one sheet per letter pair; Artist name, Social link,
// Confidence %, Link basis, Songs, Followers, Listeners, Verified, Core member, Song titles). Fictional names only.
import { emptyEngine } from './fixtures/engine';
import type { Engine, Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';
import { artistRanks } from '../src/domain/views';
import { LABEL_NAME, PLACEHOLDER_NAME, deathDateOf } from '../src/domain/importer';

class MemoryStore implements Store { async load(): Promise<Snapshot | null> { return null; } async save(_d: Dirty) {} async replace(_s: Snapshot) {} }
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
const HEAD = ['#', 'Artist name', 'Social link', 'Confidence %', 'Link basis', 'Songs', 'Followers', 'Listeners', 'Verified', 'Core member', 'Song titles'];
const sheets = [
  { name: 'Index', rows: [['Goongoonalo - artist names with social links'], [], ['Source', 'Admin Studio artist directory'], ['Total names', '7']] },
  { name: 'A-B', rows: [HEAD,
    ['1', 'Asha Raag', 'https://instagram.com/asharaag', '92', 'Bio reads playback singer; official site links it', '12', '5000', '900', 'Yes', 'Yes', 'Neela Gagan | Saawan Aaya | Neela Gagan'],
    ['2', 'Bansi Lal', 'n/a - deceased', '100', 'Died 13 February 2016 in Pune aged 84', '60', '0', '0', '', '', 'Purani Yaad'],
    ['3', 'Bharat Sound Records Pvt. Ltd.', 'not researched', '', '', '900', '0', '0', '', '', 'no lead-artist songs found'],
  ] },
  { name: 'C-D', rows: [HEAD,
    ['1', 'Chand Tara', 'none found', '15', 'Common name; no profile could be verified', '3', '0', '0', '', '', 'Ek | Do | Teen'],
    ['2', 'Dhun Studio', 'n/a - not an individual', '', 'Reads as a recording studio', '5', '0', '0', '', '', 'Jingle'],
    ['3', 'Asha Raag', 'not researched', '', '', '14', '0', '0', '', '', 'Saawan Aaya | Pehli Baarish'],
    ['4', 'Chetan Mehra', 'https://x.com/chetanmehra', '62', 'Name match only', '400', '10', '0', '', '', 'Raag Ek'],
  ] },
];
const e: Engine = await emptyEngine(new MemoryStore());
const owner = e.m.all('users').find(u => u.role === 'System Owner') ?? e.m.all('users').find(u => u.id !== 'u-engine')!;
const up = (s: typeof sheets) => e.upload({ filename: 'directory.xlsx', bytes: new TextEncoder().encode(JSON.stringify(s)), sheets: s } as any, owner.id);
const b = await up(sheets);
const m = e.m;
const one = (name: string) => m.casesNamed(name)[0];
const titles = (name: string) => m.trackIdsOfCase(one(name).id).map(id => m.get('tracks', id)!.title).sort();

console.log('Reading the file');
check('recognised as an artist directory; every sheet read (Index skipped)', b.status === 'Processed' && b.format === 'Artist directory' && b.rowCount === 7, [b.status, b.format, b.rowCount]);
check('one artist per name (a name on two sheets is one artist)', m.count('cases') === 6 && b.summary.artistsCreated === 6);
check('song titles become songs, without repeats', JSON.stringify(titles('Asha Raag')) === JSON.stringify(['Neela Gagan', 'Pehli Baarish', 'Saawan Aaya']), titles('Asha Raag'));
check('“no lead-artist songs found” adds no song', m.trackIdsOfCase(one('Bharat Sound Records Pvt. Ltd.').id).length === 0);
const asha = one('Asha Raag');
check('directory facts kept: songs (the bigger number), followers, listeners, core member', asha.directory?.songs === 14 && asha.directory.followers === 5000 && asha.directory.core === true, asha.directory);

console.log('\nWhat the columns do');
check('Verified = Yes → on Goongoonalo (status event with the reason)', asha.goongoonaloStatus === 'GOONGOONALO' && m.byCase('statusEvents', asha.id).some(x => /Admin Studio/.test(x.reason ?? '')));
const pf = m.byCase('profiles', asha.id)[0];
check('social link → a profile to verify, with its confidence and reason', pf?.verificationStatus === 'UNREVIEWED' && pf.evidenceScore === 92 && pf.strength === 'STRONG' && /Bio reads playback singer/.test(pf.matched[0]) && one('Asha Raag').artistStatus === 'NEEDS_REVIEW');
const ch = m.byCase('profiles', one('Chetan Mehra').id)[0];
check('below 70% → weak, with the warning to check', ch?.strength === 'WEAK' && /Below 70%/.test(ch.conflicts[0] ?? ''));
const bansi = one('Bansi Lal');
check('n/a - deceased → passed away (date read from the basis), waiting for a decision', bansi.life?.status === 'Deceased' && bansi.life.deathDate === '2016-02-13' && bansi.discoveryStatus === 'Needs decision');
check('not an individual → a label (kept apart, not rejected)', one('Dhun Studio').kind === 'Label' && !one('Dhun Studio').rejectedAt);
check('a label name → the Labels list (not rejected, not in the artist ranking)', one('Bharat Sound Records Pvt. Ltd.').kind === 'Label' && !one('Bharat Sound Records Pvt. Ltd.').rejectedAt);
check('none found → noted in the timeline', m.byCase('audit', one('Chand Tara').id).some(x => x.action === 'Directory research: no profile found'));
const ranks = artistRanks(m);
check('ranked by the directory song count; labels are not in the artist ranking', ranks.get(one('Chetan Mehra').id) === 1 && !ranks.has(one('Bharat Sound Records Pvt. Ltd.').id) && !ranks.has(one('Dhun Studio').id), [...ranks.entries()]);
const labelsList = e.query('artists', owner.id, { kind: 'Label', scope: 'all' }) as any;
check('Labels have their own list (Who → Labels), and are not in the artists list', labelsList.rows.map((r: any) => r.name).sort().join('|') === 'Bharat Sound Records Pvt. Ltd.|Dhun Studio' && !(e.query('artists', owner.id, { scope: 'all' }) as any).rows.some((r: any) => r.kind === 'Label'), labelsList.rows.map((r: any) => r.name));
check('summary counts', JSON.stringify(b.summary.directory) === JSON.stringify({ profiles: 2, members: 1, deceased: 1, notIndividual: 1, labels: 1, placeholders: 0, noneFound: 1, core: 1, songs: 9 }), b.summary.directory);

console.log('\nAgain');
const again = await up(sheets);
check('the same file again: a repeat, nothing changes', again.status === 'Repeat' && m.count('cases') === 6);
await e.command('setGoongoonaloStatus', owner.id, { caseId: one('Chand Tara').id, status: 'DO_NOT_CONTACT', reason: 'Asked us' });
const changed = sheets.map(s => s.name === 'C-D' ? { ...s, rows: [...s.rows, ['5', 'Chand Tara', 'not researched', '', '', '4', '0', '0', 'Yes', '', 'Ek | Chaar']] } : s);
await up(changed);
check('a person’s answer is never overwritten by “Verified = Yes”; new titles are added', one('Chand Tara').goongoonaloStatus === 'DO_NOT_CONTACT' && titles('Chand Tara').includes('Chaar') && titles('Chand Tara').length === 4);
check('placeholders and label names are told apart from people', ['Instrumental', 'Chorus', 'Karaoke', 'Various Artists', 'Traditional'].every(n => PLACEHOLDER_NAME.test(n)) && ['Goongoonalo', 'Manorama Music', 'Red Ribbon Entertainment Pvt. Ltd.'].every(n => LABEL_NAME.test(n)) && !['Shaan', 'Hariharan', 'Group Captain Rao'].some(n => LABEL_NAME.test(n) || PLACEHOLDER_NAME.test(n)));
check('death dates in other forms', deathDateOf('Twins K.G. Jayan (d. 16 April 2024) and K.G. Vijayan') === '2024-04-16' && deathDateOf('Gujarati composer, lyricist and singer, 1912-1984') === '1984' && deathDateOf('Historical figure') === null);

console.log('\nLabels: their own list, switchable');
const chetan = one('Chetan Mehra');
await e.command('setKind', owner.id, { caseId: chetan.id, kind: 'Label', reason: 'It is a label account' });
check('a person can mark an artist as a label: out of the artist ranking, into Labels', m.get('cases', chetan.id)!.kind === 'Label' && !artistRanks(m).has(chetan.id) && (e.query('artists', owner.id, { kind: 'Label', scope: 'all' }) as any).rows.some((r: any) => r.id === chetan.id));
await e.command('setKind', owner.id, { caseId: chetan.id, kind: 'Artist' });
check('… and back to an artist', m.get('cases', chetan.id)!.kind === 'Artist' && artistRanks(m).has(chetan.id));
// a record set aside by the earlier rule (rejected as a label) comes back as a label after the upgrade
const old = one('Asha Raag');
m.update('cases', old.id, { kind: 'Artist', rejectedAt: new Date().toISOString(), rejectedReason: 'Looks like a label or company, not a person (“X Pvt. Ltd.”). Restore it if this is an artist.' });
m.setMeta('upgrade:labels-v2.7.2', '');
const { upgradeWorkspace } = await import('../src/domain/upgrade');
const notes = upgradeWorkspace(m, { userId: 'u-engine', now: new Date().toISOString(), today: new Date().toISOString().slice(0, 10) } as any);
const trad = one('Bharat Sound Records Pvt. Ltd.');
m.update('cases', trad.id, { canonicalName: 'Traditional', kind: 'Artist', rejectedAt: new Date().toISOString(), rejectedReason: 'Looks like a label or company, not a person (“Traditional”). Restore it if this is an artist.' });
m.setMeta('upgrade:labels-v2.7.2', '');
upgradeWorkspace(m, { userId: 'u-engine', now: new Date().toISOString(), today: new Date().toISOString().slice(0, 10) } as any);
check('… but a placeholder credit (“Traditional”) stays set aside', !!m.get('cases', trad.id)!.rejectedAt && m.get('cases', trad.id)!.kind === 'Artist');
check('upgrade: labels rejected by the old rule come back in the Labels list', m.get('cases', old.id)!.kind === 'Label' && !m.get('cases', old.id)!.rejectedAt && notes.some(n => /Labels list/.test(n)), notes);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
