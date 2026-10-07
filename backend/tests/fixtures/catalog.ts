// Test fixtures: a fictional catalogue. Every name, song, label, ID and contact here is invented and is
// NOT Goongoonalo catalogue data. Used by the tests only, never by the app. The generator is deterministic, so Batch 002 can repeat Batch 001 rows byte for byte.
import { STANDARD_COLUMNS } from '../../src/domain/importer';
import { MEDIA_COLUMNS } from '../../src/domain/importmap';
import { rng, toCsv } from '../../src/domain/util';

export { MEDIA_COLUMNS };

export const LABELS = ['Sargam Records', 'Indigo Beats', 'Rangmanch Audio', 'Taal Tunes', 'Monsoon Melodies'];
export const DISTRIBUTORS = ['Pulse Digital Distribution', 'Raag Distribution', 'SoundBridge India'];
const LANGS = ['Hindi', 'Hindi', 'Hindi', 'Punjabi', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Malayalam', 'Kannada', 'Gujarati', 'Bhojpuri'];
const W1 = ['Dil', 'Pyaar', 'Baarish', 'Saanson', 'Raat', 'Sapne', 'Khwaab', 'Chandni', 'Mausam', 'Yaadein', 'Dhadkan', 'Tanhaai', 'Mehfil', 'Roshni', 'Sitaare', 'Kinare', 'Pehli', 'Aakhri', 'Udaan', 'Sawan', 'Jugnu', 'Rangeen', 'Saagar', 'Hawa'];
const W2 = ['Mera', 'Ki Raat', 'Mein', 'Ke Rang', 'Se Pare', 'Tera', 'Hamara', 'Ki Baatein', 'Ka Jaadu', 'Re', 'Ki Dhun', 'Ke Paar', 'Si', 'Ka Mausam', 'Ki Khushboo', 'Ka Geet'];
const FIRST = ['Aarav', 'Vihaan', 'Ishaan', 'Reyansh', 'Ayaan', 'Advait', 'Arnav', 'Dhruv', 'Shaurya', 'Atharv', 'Krish', 'Yash', 'Neil', 'Om', 'Parth', 'Rudra', 'Samar', 'Tejas', 'Veer', 'Aditi', 'Anika', 'Diya', 'Isha', 'Jhanvi', 'Kiara', 'Mahi', 'Myra', 'Naina', 'Navya', 'Pari', 'Prisha', 'Saanvi', 'Trisha', 'Vanya', 'Zara', 'Aisha', 'Ira', 'Riddhi', 'Lakshya', 'Hridaan'];
const LAST = ['Agarwal', 'Bhatt', 'Chopra', 'Dutta', 'Fernandes', 'Ghosh', 'Hegde', 'Iyengar', 'Jain', 'Kapadia', 'Lal', 'Mathur', 'Nanda', 'Oberoi', 'Pandit', 'Rastogi', 'Saxena', 'Thakur', 'Upadhyay', 'Wadhwa', 'Yadav', 'Zaveri', 'Bose', 'Chauhan', 'Das', 'Gill', 'Kohli', 'Mishra', 'Naidu', 'Tiwari', 'Vyas', 'Banerjee', 'Malik', 'Dhillon', 'Shetty', 'Kamat', 'Bhalla', 'Grover', 'Sodhi', 'Anand'];

export interface FixtureArtist { id: string; name: string; lang: string; label: string; dist: string; role: string; songs: number; collab?: [string, string][]; titles?: string[] }
/** Hand-made artists that the fixture histories use. Backend artist IDs look like the spec's (A001). */
export const DETAILED: FixtureArtist[] = [
  { id: 'A001', name: 'Rahul Sharma', lang: 'Hindi', label: 'Nadaan Music Co.', dist: 'Raag Distribution', role: 'Singer', songs: 12 },
  { id: 'A002', name: 'Priya Shah', lang: 'Gujarati', label: 'Rangmanch Audio', dist: 'Pulse Digital Distribution', role: 'Singer', songs: 5, collab: [['A042', 'Lyricist']] },
  { id: 'A003', name: 'Amit Kumar', lang: 'Hindi', label: 'Sargam Records', dist: 'Raag Distribution', role: 'Lyricist', songs: 6 },
  { id: 'A004', name: 'Neha Verma', lang: 'Hindi', label: 'Indigo Beats', dist: 'SoundBridge India', role: 'Singer', songs: 6, collab: [['A030', 'Composer']] },
  { id: 'A005', name: 'Arjun Mehta', lang: 'Punjabi', label: 'Taal Tunes', dist: 'Pulse Digital Distribution', role: 'Singer', songs: 5 },
  { id: 'A006', name: 'Sneha Patil', lang: 'Marathi', label: 'Monsoon Melodies', dist: 'Raag Distribution', role: 'Singer', songs: 4 },
  { id: 'A007', name: 'Rohan Desai', lang: 'Hindi', label: 'Sargam Records', dist: 'SoundBridge India', role: 'Composer', songs: 7 },
  { id: 'A008', name: 'Kavya Nair', lang: 'Malayalam', label: 'Indigo Beats', dist: 'Pulse Digital Distribution', role: 'Singer', songs: 6 },
  { id: 'A009', name: 'Aditya Joshi', lang: 'Hindi', label: 'Nadaan Music Co.', dist: 'Raag Distribution', role: 'Performer', songs: 3 },
  { id: 'A010', name: 'Meera Kapoor', lang: 'Hindi', label: 'Rangmanch Audio', dist: 'SoundBridge India', role: 'Singer', songs: 9 },
  { id: 'A011', name: 'Ishita Rao', lang: 'Kannada', label: 'Taal Tunes', dist: 'Pulse Digital Distribution', role: 'Singer', songs: 4 },
  { id: 'A012', name: 'Siddharth Menon', lang: 'Tamil', label: 'Monsoon Melodies', dist: 'Raag Distribution', role: 'Composer', songs: 5 },
  { id: 'A013', name: 'Ananya Iyer', lang: 'Tamil', label: 'Indigo Beats', dist: 'SoundBridge India', role: 'Singer', songs: 4 },
  { id: 'A015', name: 'Vivek Bansal', lang: 'Hindi', label: 'Sargam Records', dist: 'Pulse Digital Distribution', role: 'Producer', songs: 3 },
  { id: 'A016', name: 'Pooja Reddy', lang: 'Telugu', label: 'Taal Tunes', dist: 'Raag Distribution', role: 'Singer', songs: 4 },
  { id: 'A017', name: 'Nikhil Chawla', lang: 'Punjabi', label: 'Rangmanch Audio', dist: 'SoundBridge India', role: 'Singer', songs: 3, collab: [['A043', 'Composer']] },
  { id: 'A018', name: 'Riya Sen', lang: 'Bengali', label: 'Monsoon Melodies', dist: 'Pulse Digital Distribution', role: 'Singer', songs: 3 },
  { id: 'A019', name: 'Manish Gupta', lang: 'Hindi', label: 'Indigo Beats', dist: 'Raag Distribution', role: 'Composer', songs: 4 },
  { id: 'A020', name: 'Tanvi Kulkarni', lang: 'Marathi', label: 'Taal Tunes', dist: 'SoundBridge India', role: 'Singer', songs: 3 },
  { id: 'A021', name: 'Harsh Vardhan', lang: 'Hindi', label: 'Sargam Records', dist: 'Pulse Digital Distribution', role: 'Performer', songs: 3 },
  { id: 'A022', name: 'Divya Pillai', lang: 'Malayalam', label: 'Monsoon Melodies', dist: 'Raag Distribution', role: 'Singer', songs: 4 },
  { id: 'A023', name: 'Kunal Bhatia', lang: 'Hindi', label: 'Indigo Beats', dist: 'SoundBridge India', role: 'Singer', songs: 5 },
  { id: 'A024', name: 'Sana Qureshi', lang: 'Hindi', label: 'Rangmanch Audio', dist: 'Pulse Digital Distribution', role: 'Singer', songs: 3 },
  { id: 'A025', name: 'Varun Khanna', lang: 'Hindi', label: 'Taal Tunes', dist: 'Raag Distribution', role: 'Producer', songs: 4 },
  { id: 'A026', name: 'Gaurav Sethi', lang: 'Punjabi', label: 'Sargam Records', dist: 'SoundBridge India', role: 'Singer', songs: 2 },
  { id: 'A027', name: 'Lata Joshi', lang: 'Hindi', label: 'Rangmanch Audio', dist: 'Raag Distribution', role: 'Singer', songs: 3 },
  { id: 'A030', name: 'Joshua Singh', lang: 'Hindi', label: 'Indigo Beats', dist: 'Pulse Digital Distribution', role: 'Composer', songs: 4 },
  { id: 'A040', name: 'Sameer Mehta', lang: 'Hindi', label: 'Sargam Records', dist: 'Raag Distribution', role: 'Producer', songs: 2 },
  { id: 'A042', name: 'Farah Ali', lang: 'Gujarati', label: 'Rangmanch Audio', dist: 'Pulse Digital Distribution', role: 'Lyricist', songs: 1 },
  { id: 'A043', name: 'Gurpreet Sandhu', lang: 'Punjabi', label: 'Rangmanch Audio', dist: 'SoundBridge India', role: 'Composer', songs: 2 },
  { id: 'A044', name: 'Sameer Khan', lang: 'Urdu', label: 'Taal Tunes', dist: 'SoundBridge India', role: 'Singer', songs: 2 },
  { id: 'A045', name: 'Sameer Khan', lang: 'Hindi', label: 'Sargam Records', dist: 'Raag Distribution', role: 'Producer', songs: 2 },
  { id: 'A099', name: 'Rahul Sharma', lang: 'Punjabi', label: 'Taal Tunes', dist: 'SoundBridge India', role: 'Producer', songs: 3, titles: ['Bhangra Raat', 'Gidda Beat', 'Punjab Di Shaam'] },
  { id: 'A214', name: 'Priya Shah', lang: 'Hindi', label: 'Taal Tunes', dist: 'SoundBridge India', role: 'Singer', songs: 2 },
  { id: 'A215', name: 'Ishitaa Rao', lang: 'Kannada', label: 'Taal Tunes', dist: 'Pulse Digital Distribution', role: 'Singer', songs: 1 },
];
const RAHUL_SONGS = ['Dil Mera', 'Baarish Ki Raat', 'Saanson Mein', 'Khwaab Tera', 'Raat Ke Rang', 'Mausam Hamara', 'Yaadein Re', 'Chandni Se Pare', 'Dhadkan Ki Dhun', 'Sapne Ke Paar', 'Roshni Si', 'Dil Ka Safar'];
/** Rahul's credits: Amit Kumar writes lyrics, Sameer Mehta produces, and Joshua Singh produced “Dil Ka Safar”. */
const rahulCredits = (i: number): [string, string][] => (i === 11 ? [['A030', 'Producer'], ['A003', 'Lyricist']] : i % 3 === 0 ? [['A003', 'Lyricist']] : i % 3 === 1 ? [['A040', 'Producer']] : []);
export const TOTAL_CASES = 1250;

export interface CatalogRow { [k: string]: string }
function row(o: Partial<CatalogRow>): CatalogRow { const r: CatalogRow = {}; for (const c of STANDARD_COLUMNS) r[c] = o[c] ?? ''; return r; }
const isrc = (n: number) => `INGAM26${String(n).padStart(5, '0')}`;

/** Batch 001 rows: detailed artists plus a bulk of fictional artists, ~1,250 unique people in total. */
export function batch001Rows(): CatalogRow[] {
  const r = rng(20261002);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const rows: CatalogRow[] = [];
  let t = 1001;
  const title = () => `${pick(W1)} ${pick(W2)}`;
  const date = () => `${2023 + Math.floor(r() * 4)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;
  const byId = new Map(DETAILED.map(a => [a.id, a]));
  for (const a of DETAILED) {
    for (let i = 0; i < a.songs; i++) {
      const n = t++;
      // Rahul's songs carry his collaborators; Joshua Singh composes Neha Verma's first three songs; Amit Kumar wrote Riya Sen's first song.
      const collab: [string, string][] = a.id === 'A001' ? rahulCredits(i) : a.id === 'A004' ? (i < 3 ? a.collab! : []) : a.id === 'A018' ? (i === 0 ? [['A003', 'Lyricist']] : []) : (a.collab ?? []);
      rows.push(row({
        artist_id: a.id, artist_name: a.name, artist_role: a.role, track_id: `T${n}`, release_id: `R${a.id.slice(1)}${Math.floor(i / 6) + 1}`, release_title: `${a.name} ${a.id === 'A001' ? 'Vol. 1' : 'Singles'}`,
        title: a.id === 'A001' ? RAHUL_SONGS[i] : a.titles?.[i] ?? title(), version: i === 4 && a.songs > 5 ? 'Unplugged' : '', isrc: isrc(n), label: a.label, distributor: a.dist, language: a.lang,
        release_date: a.id === 'A001' ? `2025-${String(1 + i).padStart(2, '0')}-10` : date(),
        credits: collab.map(([id, role]) => `${id}|${byId.get(id)!.name}|${role}`).join('; '),
      }));
    }
  }
  // Bulk fictional artists: unique first x last name pairs, each with 1-4 songs and sometimes a collaborator from the same pool.
  const pairs: string[] = [];
  for (const f of FIRST) for (const l of LAST) pairs.push(`${f} ${l}`);
  for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
  const bulkCount = TOTAL_CASES - new Set(DETAILED.map(a => a.id)).size;
  const bulk = pairs.slice(0, bulkCount).map((name, i) => ({ id: `A${1001 + i}`, name }));
  for (const a of bulk) {
    const songs = 1 + Math.floor(r() * 4);
    const label = pick(LABELS), dist = pick(DISTRIBUTORS), lang = pick(LANGS), role = pick(['Singer', 'Singer', 'Performer', 'Composer']);
    for (let i = 0; i < songs; i++) {
      const n = t++;
      const credits: string[] = [];
      if (r() < 0.35) { const c = pick(bulk); if (c.id !== a.id) credits.push(`${c.id}|${c.name}|${pick(['Composer', 'Lyricist', 'Producer'])}`); }
      rows.push(row({ artist_id: a.id, artist_name: a.name, artist_role: role, track_id: `T${n}`, release_id: `R${a.id.slice(1)}`, release_title: `${a.name} Singles`, title: title(), isrc: isrc(n), label, distributor: dist, language: lang, release_date: date(), credits: credits.join('; ') }));
    }
  }
  // Two broken rows so the exception queue is not empty: they are kept visible, never silently dropped.
  rows.push(row({ artist_id: '', artist_name: 'Unknown Singer', artist_role: 'Singer', track_id: `T${t++}`, title: 'Mehfil Mein', isrc: isrc(t), label: 'Taal Tunes', distributor: 'Raag Distribution', language: 'Hindi' }));
  rows.push(row({ artist_id: 'A1999', artist_name: 'Navya Sodhi', artist_role: 'Singer', track_id: '', title: 'Hawa Ka Geet', label: 'Indigo Beats', distributor: 'SoundBridge India', language: 'Punjabi' }));
  return rows;
}
export function toStandardCsv(rows: CatalogRow[]): string { return toCsv([STANDARD_COLUMNS, ...rows.map(r => STANDARD_COLUMNS.map(c => r[c]))]); }

const B002_NEW: [string, string, string][] = [
  ['T9001', 'Dil Ka Safar 2', 'A030|Joshua Singh|Producer'],
  ['T9002', 'Pehli Udaan', 'A003|Amit Kumar|Lyricist'],
  ['T9003', 'Sawan Ki Dhun', 'A040|Sameer Mehta|Producer'],
  ['T9004', 'Jugnu Re', ''],
  ['T9005', 'Hawa Mein', 'A003|Amit Kumar|Lyricist; A018|Riya Sen|Singer'],
];
/** Batch 002 (walkthrough): Rahul's 12 known songs again + 5 genuinely new ones. One new song credits Joshua Singh. */
export function batch002Rows(): CatalogRow[] {
  const rows = batch001Rows().filter(x => x.artist_id === 'A001');
  for (const [id, title, credits] of B002_NEW) rows.push(row({ artist_id: 'A001', artist_name: 'Rahul Sharma', artist_role: 'Singer', track_id: id, release_id: 'R9000', release_title: 'Rahul Sharma Vol. 2', title, isrc: isrc(Number(id.slice(1))), label: 'Nadaan Music Co.', distributor: 'Raag Distribution', language: 'Hindi', release_date: '2026-09-28', credits }));
  return rows;
}
/** Batch 004 (other import outcomes): new song for a waiting artist, a new artist, a metadata change,
 *  new evidence on a do-not-contact case and one row without an artist ID. `fixed` is the corrected re-upload. */
export function batch004Rows(fixed = false): CatalogRow[] {
  const all = batch001Rows();
  const rows: CatalogRow[] = [];
  rows.push(row({ artist_id: 'A009', artist_name: 'Aditya Joshi', artist_role: 'Performer', track_id: 'T9010', release_id: 'R9010', release_title: 'Aditya Joshi Singles', title: 'Sitaare Ke Paar', isrc: isrc(9010), label: 'Taal Tunes', distributor: 'Raag Distribution', language: 'Hindi', release_date: '2026-09-20' }));
  rows.push(row({ artist_id: 'A3001', artist_name: 'Farhan Ali', artist_role: 'Singer', track_id: 'T9011', release_id: 'R9011', release_title: 'Farhan Ali Singles', title: 'Saagar Ki Baatein', isrc: isrc(9011), label: 'Monsoon Melodies', distributor: 'SoundBridge India', language: 'Urdu', release_date: '2026-09-25' }));
  rows.push({ ...all.find(x => x.artist_id === 'A003')!, version: 'Remastered 2026' });
  rows.push(row({ artist_id: 'A027', artist_name: 'Lata Joshi', artist_role: 'Singer', track_id: 'T9012', release_id: 'R9012', release_title: 'Lata Joshi Singles', title: 'Chandni Ki Khushboo', isrc: isrc(9012), label: 'Rangmanch Audio', distributor: 'Raag Distribution', language: 'Hindi', release_date: '2026-09-26', credits: 'A030|Joshua Singh|Composer' }));
  rows.push(row({ artist_id: fixed ? 'A3002' : '', artist_name: 'Zoya Merchant', artist_role: 'Singer', track_id: 'T9013', release_id: 'R9013', release_title: 'Zoya Merchant Singles', title: 'Mausam Ka Jaadu', isrc: isrc(9013), label: 'Indigo Beats', distributor: 'Pulse Digital Distribution', language: 'Hindi', release_date: '2026-09-27' }));
  return rows;
}
// ------------------------------------------------------------------ v2 fixture: a media-library export in the distributor layout
type MediaRow = Partial<Record<(typeof MEDIA_COLUMNS)[number], string>>;
const media = (i: number, r: MediaRow): string[] => {
  const full: MediaRow = { index: String(i), 'Date Submitted': '15/09/2026', 'Audio Duration (mm:sec)': '03:45', 'Content Type': 'Audio', 'Vocal / Instrumental': 'Vocal', 'Territory Rights': 'Worldwide', 'Go Live Date': '01/10/2026', ...r };
  if (!full['Audio folder (path)'] && full.ISRC) full['Audio folder (path)'] = `/fixtures/audio/${full.ISRC}.wav`;
  return MEDIA_COLUMNS.map(c => full[c] ?? '');
};
/**
 * The v2 fixture upload (fictional): two songs Rahul Sharma already has (recognised by ISRC, nothing duplicated), new artists
 * with several names in one cell, a duo kept as one artist, a Unicode name, credited lyricists and composers, a
 * look-alike “Rahul Sharma Music”, an artist name with extra spaces, new songs for artists already worked on, one
 * duplicate row and one row without a song title.
 */
export function fixtureMediaLibraryRows(): string[][] {
  const rows: string[][] = [MEDIA_COLUMNS];
  let i = 0;
  const add = (r: MediaRow) => rows.push(media(++i, r));
  add({ ISRC: isrc(1001), UPC: '8901000000011', 'Album Name': 'Rahul Sharma Vol. 1', 'Track Name': 'Dil Mera', 'Release Date': '10/01/2025', 'Artist Name': 'Rahul Sharma', Language: 'Hindi', Genre: 'Indipop', 'Lyric Writer': 'Amit Kumar', Label: 'Nadaan Music Co.' });
  add({ ISRC: isrc(1002), UPC: '8901000000011', 'Album Name': 'Rahul Sharma Vol. 1', 'Track Name': 'Baarish Ki Raat', 'Release Date': '10/02/2025', 'Artist Name': 'Rahul Sharma', Language: 'Hindi', Genre: 'Indipop', Label: 'Nadaan Music Co.' });
  add({ ISRC: 'INXDM2600101', UPC: '8901000000101', 'Album cat. No.': 'SSM-101', 'Album Name': 'Kabir Rathore Singles', 'Track Name': 'Pehli Baarish', 'Release Date': '20/09/2026', 'Artist Name': 'Kabir Rathore', Language: 'Hindi', Genre: 'Indipop', 'Lyric Writer': 'Devika Rao', Composer: 'Arnav Sood', Label: 'Saffron Strings Music' });
  add({ ISRC: 'INXDM2600102', UPC: '8901000000102', 'Album cat. No.': 'SSM-102', 'Album Name': 'Rang, Raag aur Raat', 'Track Name': 'Saath Chalein', 'Release Date': '22/09/2026', 'Artist Name': 'Kabir Rathore,Tara Sethi', Language: 'Hindi', Genre: 'Indipop', 'Lyric Writer': 'Devika Rao', Composer: 'Arnav Sood', Label: 'Saffron Strings Music' });
  add({ ISRC: 'INXDM2600103', UPC: '8901000000102', 'Album cat. No.': 'SSM-102', 'Album Name': 'Rang, Raag aur Raat', 'Track Name': 'Neela Aasman', 'Release Date': '22/09/2026', 'Artist Name': 'Tara Sethi', Language: 'Hindi', Genre: 'Indipop', 'Lyric Writer': 'Devika Rao', Composer: 'Kabir Rathore', Label: 'Saffron Strings Music' });
  add({ ISRC: 'INXDM2600104', UPC: '8901000000104', 'Album Name': 'Raag Bahar', 'Track Name': 'Raag Bahar', 'Release Date': '18/09/2026', 'Artist Name': 'Sur & Saaz', 'Vocal / Instrumental': 'Instrumental', Language: 'Instrumental', Genre: 'Classical Fusion', Label: 'Saffron Strings Music' });
  add({ ISRC: 'INXDM2600105', UPC: '8901000000105', 'Album Name': 'Bhakti Sandhya', 'Track Name': 'Shiv Vandana', 'Release Date': '05/09/2026', 'Artist Name': 'Meher Ali', Language: 'Hindi', Genre: 'Devotional', 'Lyric Writer': 'Pandit Raghav Joshi', 'God Name': 'Shiva', Label: 'Bhakti Dhara Records' });
  add({ ISRC: 'INXDM2600106', UPC: '8901000000105', 'Album Name': 'Bhakti Sandhya', 'Track Name': 'Ganpati Aarti', 'Release Date': '05/09/2026', 'Artist Name': 'Meher Ali', Language: 'Hindi', Genre: 'Devotional', 'Lyric Writer': 'Pandit Raghav Joshi', 'God Name': 'Ganesha', Label: 'Bhakti Dhara Records' });
  add({ ISRC: 'INXDM2600107', UPC: '8901000000107', 'Album Name': 'Monsoon Kathakal', 'Track Name': 'Monsoon Kathakal', 'Release Date': '25/09/2026', 'Artist Name': '  Kavya   Nair ', Language: 'Malayalam', Genre: 'Indipop', Label: 'Indigo Beats' });
  add({ ISRC: 'INXDM2600108', UPC: '8901000000108', 'Album Name': 'Unplugged Covers', 'Track Name': 'Dil Mera (Unplugged Cover)', 'Release Date': '26/09/2026', 'Artist Name': 'Rahul Sharma Music', Language: 'Hindi', Genre: 'Indipop', 'Lyric Writer': 'Amit Kumar', Label: 'Nadaan Music Co.' });
  add({ ISRC: 'INXDM2600109', UPC: '8901000000109', 'Album Name': 'Chandni Raat', 'Track Name': 'Chandni Raat', 'Release Date': '27/09/2026', 'Artist Name': 'स्वरा मेहता', Language: 'Hindi', Genre: 'Ghazal', Label: 'Saffron Strings Music' });
  add({ ISRC: 'INXDM2600101', UPC: '8901000000101', 'Album cat. No.': 'SSM-101', 'Album Name': 'Kabir Rathore Singles', 'Track Name': 'Pehli Baarish', 'Release Date': '20/09/2026', 'Artist Name': 'Kabir Rathore', Language: 'Hindi', Genre: 'Indipop', 'Lyric Writer': 'Devika Rao', Composer: 'Arnav Sood', Label: 'Saffron Strings Music' });
  add({ ISRC: 'INXDM2600110', UPC: '8901000000110', 'Album Name': 'Untitled', 'Track Name': '', 'Release Date': '28/09/2026', 'Artist Name': 'Tara Sethi', Language: 'Hindi', Label: 'Saffron Strings Music' });
  add({ ISRC: 'INXDM2600111', UPC: '8901000000111', 'Album Name': 'Kabir Rathore Singles', 'Track Name': 'Jugnu Jaise', 'Release Date': '29/09/2026', 'Artist Name': 'Kabir Rathore', Language: 'Hindi', Genre: 'Indipop', Composer: 'Joshua Singh', Label: 'Saffron Strings Music' });
  add({ ISRC: 'INXDM2600112', UPC: '8901000000112', 'Album Name': 'Bhorer Alo', 'Track Name': 'Bhorer Alo', 'Release Date': '30/09/2026', 'Artist Name': 'Riya Sen', Language: 'Bengali', Genre: 'Indipop', 'Lyric Writer': 'Amit Kumar', Label: 'Monsoon Melodies' });
  return rows;
}
export const FIXTURE_MEDIA = { filename: 'media_library_export.csv', xlsxFilename: 'media_library_export.xlsx', title: 'Media library export (15 rows)', expect: '6 new artists, 3 new collaborators, Rahul recognised by ISRC, 1 possible duplicate, 1 duplicate row skipped, 1 row to review, existing artists reopened' };

export const FIXTURE_FILES = {
  b001: 'goongoonalo_export_batch_001.csv',
  b002: 'goongoonalo_export_batch_002.csv',
  b003: 'goongoonalo_export_batch_003.csv',
  b004: 'goongoonalo_export_batch_004.csv',
};
export type FixtureFileKind = 'b002' | 'b003' | 'b004' | 'b004fix';
export const FIXTURE_FILE_INFO: Record<FixtureFileKind, { title: string; expect: string }> = {
  b002: { title: 'Batch 002: Rahul Sharma, 17 songs', expect: '5 new songs incl. “Dil Ka Safar 2” (Joshua Singh). Rahul reopens if still waiting; a verified Rahul gets targeted discovery instead' },
  b003: { title: 'Batch 003: exact copy of Batch 002', expect: 'Repeat upload detected. Nothing duplicated.' },
  b004: { title: 'Batch 004: mixed changes', expect: 'New artist, new song, metadata change, do-not-contact protected, 1 row quarantined' },
  b004fix: { title: 'Batch 004 corrected', expect: 'Same file name, fixed row: becomes version 2, history kept' },
};
/** Excel fixture: an extract with three known artists. Unchanged rows are skipped; the result lists each artist with Find artist. */
export const FIXTURE_XLSX = { filename: 'goongoonalo_artist_extract.xlsx', title: 'Excel: Rahul Sharma, Priya Shah, Amit Kumar', expect: '3 known artists: no duplicates. Each shows its discovery status with Find artist, or Verified artist found' };
export function fixtureXlsxRows(): string[][] {
  const rows = batch001Rows().filter(r => ['A001', 'A002', 'A003'].includes(r.artist_id));
  return [STANDARD_COLUMNS, ...rows.map(r => STANDARD_COLUMNS.map(c => r[c]))];
}
/** Batch 003 is byte-for-byte Batch 002, so the checksum matches and nothing is processed twice. */
export function fixtureFile(kind: FixtureFileKind): { filename: string; csv: string } {
  switch (kind) {
    case 'b002': return { filename: FIXTURE_FILES.b002, csv: toStandardCsv(batch002Rows()) };
    case 'b003': return { filename: FIXTURE_FILES.b003, csv: toStandardCsv(batch002Rows()) };
    case 'b004': return { filename: FIXTURE_FILES.b004, csv: toStandardCsv(batch004Rows(false)) };
    case 'b004fix': return { filename: FIXTURE_FILES.b004, csv: toStandardCsv(batch004Rows(true)) };
  }
}
export function templateCsv(): string {
  return toStandardCsv([row({ artist_id: 'A001', artist_name: 'Rahul Sharma', artist_role: 'Singer', track_id: 'T1001', release_id: 'R333', release_title: 'Rahul Sharma Vol. 1', title: 'Dil Mera', version: '', isrc: 'INGAM2601001', label: 'Nadaan Music Co.', distributor: 'Raag Distribution', language: 'Hindi', release_date: '2025-01-10', credits: 'A003|Amit Kumar|Lyricist; A040|Sameer Mehta|Producer' })]);
}
