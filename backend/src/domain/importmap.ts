// Understanding an uploaded catalogue file (v2 §3-4): decode the text, find the delimiter and the header row, and map
// whatever the columns are called onto known fields. Nothing is tied to one file name or one exact column list:
// missing optional columns are fine, unknown columns are kept in the raw row, and no value is ever invented.
import { clean, parseCsv } from './util';

export type Field =
  | 'trackId' | 'rowIndex' | 'isrc' | 'upc' | 'title' | 'version' | 'album' | 'albumId' | 'catalogNo' | 'artists' | 'artistId' | 'artistRole'
  | 'composer' | 'lyricist' | 'producer' | 'credits' | 'musicianCredits' | 'label' | 'distributor' | 'publisher' | 'language' | 'genre'
  | 'releaseDate' | 'goLiveDate' | 'dateSubmitted' | 'duration' | 'contentType' | 'vocalInstrumental' | 'territory' | 'godName' | 'audioPath'
  | 'profileUrl' | 'claimStatus' | 'activity';

/** Columns of the media-library export the operators receive (v2 §3). Shown on the Imports page as guidance. */
export const MEDIA_COLUMNS = ['index', 'ISRC', 'Date Submitted', 'UPC', 'Album cat. No.', 'Album Name', 'Track Name', 'Release Date', 'Artist Name', 'Audio Duration (mm:sec)', 'Content Type', 'Vocal / Instrumental', 'Language', 'Genre', 'Lyric Writer', 'Composer', 'Territory Rights', 'God Name', 'Audio folder (path)', 'Go Live Date', 'Label'];

/** Column names seen in Goongoonalo exports and distributor sheets (compared without case, spaces or punctuation). */
const SYNONYMS: Record<Field, string[]> = {
  trackId: ['track_id', 'track id', 'id', 'song id', 'content id', 'asset id'],
  rowIndex: ['index', 'record #', 'record no', 's no', 'sr no', 'sl no', '#'],
  isrc: ['isrc', 'isrc code', 'isrccode'],
  upc: ['upc', 'upc code', 'upccode', 'ean'],
  title: ['title', 'track name', 'track title', 'song', 'song name', 'song title', 'track'],
  version: ['version', 'track version', 'mix'],
  album: ['album name', 'album', 'release title', 'release name', 'album title'],
  albumId: ['release_id', 'release id', 'album id'],
  catalogNo: ['album cat. no.', 'album cat no', 'catalog number', 'catalogue number', 'cat no', 'catalog no'],
  artists: ['artist name', 'artist_name', 'leadartists', 'lead artists', 'lead artist', 'artists', 'artist', 'primary artist', 'main artist', 'singer', 'singers'],
  artistId: ['artist_id', 'artist id'],
  artistRole: ['artist_role', 'artist role'],
  composer: ['composer', 'composers', 'music director', 'music by', 'music composer'],
  lyricist: ['lyric writer', 'lyricist', 'lyricists', 'lyrics by', 'lyrics writer', 'writer'],
  producer: ['producer', 'producers', 'music producer'],
  credits: ['credits', 'audiocredits', 'audio credits'],
  musicianCredits: ['musiciancredits', 'musician credits'],
  label: ['label', 'record label', 'label name', 'copyrightlabel', 'copyright label'],
  distributor: ['distributor', 'distribution'],
  publisher: ['publisher', 'copyrightpublisher', 'copyright publisher'],
  language: ['language', 'languages', 'lang'],
  genre: ['genre', 'genres'],
  releaseDate: ['release date', 'release_date', 'releasedate', 'original release date'],
  goLiveDate: ['go live date', 'golive date', 'live date'],
  dateSubmitted: ['date submitted', 'submission date', 'submitted on'],
  duration: ['audio duration (mm:sec)', 'audio duration', 'audioduration', 'duration'],
  contentType: ['content type', 'contenttype'],
  vocalInstrumental: ['vocal / instrumental', 'vocal/instrumental', 'vocal instrumental', 'musictype', 'music type'],
  territory: ['territory rights', 'territory', 'territories'],
  godName: ['god name', 'deity'],
  audioPath: ['audio folder (path)', 'audio folder', 'audio path', 'audiourl', 'audio url', 'file path'],
  profileUrl: ['profile_url', 'profile url'],
  claimStatus: ['claim_status', 'claim status'],
  activity: ['activity'],
};
const squash = (h: string) => clean(h).toLowerCase().replace(/[^\p{L}\p{N}#]+/gu, '');
const LOOKUP = new Map<string, Field>();
for (const [f, names] of Object.entries(SYNONYMS) as [Field, string[]][]) for (const n of names) if (!LOOKUP.has(squash(n))) LOOKUP.set(squash(n), f);
/** Columns that look like people but are not credits (revenue partners, cast) are never mapped to artists. */
const NEVER_PEOPLE = new Set(['collaborators', 'starcast', 'revenueshare', 'revenuesplit']);

export interface ColumnMap {
  index: Partial<Record<Field, number>>;
  mapping: { field: Field; column: string }[];
  unmapped: string[];
  header: string[];
}
export function mapHeader(header: string[]): ColumnMap {
  const index: Partial<Record<Field, number>> = {};
  const mapping: { field: Field; column: string }[] = [];
  const unmapped: string[] = [];
  header.forEach((h, i) => {
    const k = squash(h);
    const f = NEVER_PEOPLE.has(k) ? undefined : LOOKUP.get(k);
    if (f && index[f] === undefined) { index[f] = i; mapping.push({ field: f, column: clean(h) }); }
    else if (clean(h)) unmapped.push(clean(h));
  });
  return { index, mapping, unmapped, header: header.map(h => clean(h)) };
}
const score = (m: ColumnMap) => m.mapping.length + (m.index.title !== undefined ? 3 : 0) + (m.index.artists !== undefined ? 3 : 0);

/** The header is the first row (within the first 15) that names a song title and an artist column. */
export function findHeader(rows: unknown[][]): { row: number; map: ColumnMap } | null {
  let best: { row: number; map: ColumnMap } | null = null;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const map = mapHeader((rows[i] ?? []).map(v => String(v ?? '')));
    if (map.index.title === undefined || map.index.artists === undefined) continue;
    if (!best || score(map) > score(best.map)) best = { row: i, map };
  }
  return best;
}

/** Text from bytes: UTF-8 (with or without BOM), UTF-16 by BOM, or Windows-1252 when UTF-8 is clearly wrong. */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16 LE' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16 BE' };
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > 3 && bad > utf8.length / 2000) {
    try { return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' }; } catch { /* decoder not available */ }
  }
  return { text: utf8.charCodeAt(0) === 0xfeff ? utf8.slice(1) : utf8, encoding: bad ? 'UTF-8 (some invalid bytes)' : 'UTF-8' };
}
/** Comma, semicolon or tab: whichever splits the first line into the most columns outside quotes. */
export function sniffDelimiter(text: string): ',' | ';' | '\t' {
  const nl = text.search(/\r?\n/);
  const line = text.slice(0, nl < 0 ? 4000 : nl);
  const count = (d: string) => { let n = 0, q = false; for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch === d) n++; } return n; };
  const c = count(','), s = count(';'), t = count('\t');
  return t > c && t >= s ? '\t' : s > c ? ';' : ',';
}
export function parseDelimited(text: string): { rows: string[][]; delimiter: string } {
  const d = sniffDelimiter(text);
  return { rows: parseCsv(text, d), delimiter: d === '\t' ? 'tab' : d };
}

/**
 * Several artists in one cell ("Harish Raghavendra,Harini", "A feat. B") become separate names; the raw value is kept
 * in the import row. "&" and "and" stay inside one name: duos and bands are usually one credited entity.
 */
export function splitArtists(v: unknown): string[] {
  const out: string[] = [];
  for (const part of String(v ?? '').split(/\s*(?:[,;|]|\s\/\s|\bfeat\.?|\bft\.|\bfeaturing\b)\s*/i)) {
    const x = clean(part).replace(/^(?:and|&)\s+/i, '');
    if (x && !out.some(o => o.toLowerCase() === x.toLowerCase())) out.push(x);
  }
  return out;
}
/** "composer: A, B | singer: C | label: L" (Media Library) → role → names. */
export function parseRoleCredits(v: unknown): { role: string; names: string[] }[] {
  const out: { role: string; names: string[] }[] = [];
  for (const part of String(v ?? '').split('|')) {
    const k = part.indexOf(':');
    if (k < 0) continue;
    const role = clean(part.slice(0, k)).toLowerCase();
    const names = splitArtists(part.slice(k + 1));
    if (role && names.length) out.push({ role, names });
  }
  return out;
}
/** Dates such as "2026-09-24 00:00:00", "24/09/2026" or Excel serials, as YYYY-MM-DD; anything unclear stays as written. */
export function normDate(v: unknown): string {
  const s = clean(v);
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 864e5); return d.toISOString().slice(0, 10); }
  return s;
}
