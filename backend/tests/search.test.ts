// Search: case, spaces and punctuation never matter, words may come in any order, and the best match comes first.
// Fictional names only.
import type { Store } from '../src/domain/engine';
import type { Dirty, Snapshot } from '../src/domain/model';
import { matchTier, matchesText, searchKey, searchQuery, TIER } from '../src/domain/search';
import { emptyEngine } from './fixtures/engine';

class MemoryStore implements Store {
  async load(): Promise<Snapshot | null> { return null; }
  async save(_d: Dirty) {}
  async replace(_s: Snapshot) {}
}
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}

console.log('Matching rules');
check('key ignores case, spaces, dots and dashes', searchKey('  K. Krishna-KUMAR ') === 'kkrishnakumar');
check('key removes Latin accents', searchKey('Shréya Ghoshål') === 'shreyaghoshal');
check('key keeps Indian vowel signs (दिल ≠ दल)', searchKey('दिल') !== searchKey('दल') && searchKey('दिल ') === searchKey('दिल'));
const t = (q: string, text: string) => matchTier(searchQuery(q), text);
check('exact, whatever the spacing', t('r arjun mehra', 'R. Arjun Mehra') === TIER.EXACT && t('RARJUNMEHRA', 'R. Arjun Mehra') === TIER.EXACT);
check('starts with', t('r. arj', 'R. Arjun Mehra') === TIER.PREFIX);
check('a word starts with', t('arjun meh', 'R. Arjun Mehra') === TIER.WORD_PREFIX);
check('contains', t('rjunme', 'R. Arjun Mehra') === TIER.CONTAINS);
check('all words in any order', t('mehra arjun', 'R. Arjun Mehra') === TIER.ALL_WORDS);
check('…each word must start a word (no matches inside words)', t('ks chithra', 'K. S. Chithra') > 0 && t('chithra ks', 'K. S. Chithra') === TIER.ALL_WORDS && t('chithra ks', 'Anubhoothi (Chithra) from Uthram Nakshathram') === 0);
check('similar spelling (doubled letters)', t('ishitarao', 'Ishitaa Rao') === TIER.SIMILAR && t('ishita rao', 'Ishitaa Rao') > 0);
check('similar spelling: Indian name spellings (th/t, sh/s, w/v, ee/i)', t('swati tirunal', 'Swathi Thirunal') === TIER.SIMILAR && t('sreya', 'Shreya Nair') > 0 && t('vani', 'Wani Kapoor') > 0);
check('…but never for unrelated names', t('swati tirunal', 'Sweta Rao') === 0);
check('no match → 0', t('xyz', 'R. Arjun Mehra') === 0 && t('', 'R. Arjun Mehra') === 0);
check('web app filter: words across fields', matchesText('dil  BAAT', 'Dil Ki Baat') && matchesText('baat mehra', 'Dil Ki Baat', 'R. Arjun Mehra') && !matchesText('baat xyz', 'Dil Ki Baat'));

console.log('\nSearching a catalogue');
const e = await emptyEngine(new MemoryStore());
const csv = [
  'artist_id,artist_name,artist_role,track_id,title,isrc,label,distributor',
  'X1,R. Arjun Mehra,Singer,T1,Dil Ki Baat,INZZZ2600001,Saaz Records,Raag Distribution',
  'X2,Arjun,Singer,T2,Baarish Ki Raat,INZZZ2600002,Saaz Records,Raag Distribution',
  'X3,Ishitaa Rao,Singer,T3,Chandni,INZZZ2600003,Lehar Music,Raag Distribution',
  'X4,Mehra Brothers,Performer,T4,Arjun Ka Geet,INZZZ2600004,Lehar Music,Raag Distribution',
  'X5,Devraj A.R.,Composer,T5,Raat Ki Rani,INZZZ2600005,Saaz Records,Raag Distribution',
].join('\n');
await e.upload({ filename: 'search_fixture.csv', bytes: new TextEncoder().encode(csv) }, 'u-swatantra');
const U = 'u-vikram';
const idOf = (src: string) => e.m.idx.caseByBackendId.get(src)!;
const top = (q: string) => (e.query('search', U, { q }) as { type: string; label: string; id: string }[]);
const artists = (q: string) => (e.query('artists', U, { q, kind: 'all' }) as { rows: { name: string; matched: string | null }[]; total: number });

check('top bar: "r arjun mehra" → R. Arjun Mehra first', top('r arjun mehra')[0]?.label === 'R. Arjun Mehra', top('r arjun mehra').slice(0, 3));
check('top bar: no spaces, upper case → same', top('RARJUNMEHRA')[0]?.label === 'R. Arjun Mehra');
check('top bar: extra spaces and dots → same', top('  r.   arjun   MEHRA ')[0]?.label === 'R. Arjun Mehra');
const arjun = top('arjun').filter(r => r.type === 'Artist').map(r => r.label);
check('top bar: "arjun" → exact name first, then name with the word', arjun[0] === 'Arjun' && arjun[1] === 'R. Arjun Mehra', arjun);
check('top bar: words in any order', top('mehra arjun').find(r => r.type === 'Artist')?.label === 'R. Arjun Mehra');
check('top bar: similar spelling still finds the artist', top('ishita rao').find(r => r.type === 'Artist')?.label === 'Ishitaa Rao');
check('top bar: song title without spaces or case', top('DILKIBAAT').find(r => r.type === 'Song')?.label === 'Dil Ki Baat');
check('top bar: ISRC with dashes and spaces', top('IN-ZZZ-26 00003').find(r => r.type === 'Song')?.label === 'Chandni');
check('top bar: artist ID in any case / with spaces', top(idOf('X5').toLowerCase())[0]?.label === 'Devraj A.R.' && top(idOf('X5').replace(/^A/, 'a ')).at(0)?.label === 'Devraj A.R.');
check('top bar: source artist ID', top('x3')[0]?.label === 'Ishitaa Rao');
check('top bar: nothing for unrelated text', top('qwertyuiop').length === 0);
check('top bar: one letter is ignored (too broad)', top('a').length === 0);

const a1 = artists('arjun');
check('Artists list: name matches before song matches', a1.rows[0]?.name === 'Arjun' && a1.rows[1]?.name === 'R. Arjun Mehra' && a1.rows.at(-1)?.name === 'Mehra Brothers' && /^Song/.test(a1.rows.at(-1)?.matched ?? ''), a1.rows.map(r => [r.name, r.matched]));
check('Artists list: "a.r." finds "Devraj A.R." by the word', artists('a.r.').rows.some(r => r.name === 'Devraj A.R.'));
check('Artists list: label search', artists('lehar music').total === 2);
check('Artists list: no false hits', artists('zzzz nothing').total === 0);
const opts = e.query('caseOptions', U, { q: 'ARJUN mehra' }) as { name: string }[];
check('artist picker (forms): best match first', opts[0]?.name === 'R. Arjun Mehra', opts.map(o => o.name));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
