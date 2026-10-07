// Search text matching, shared by every search box (server and web app). Case, spaces, dots, dashes and accents never
// matter: "k.krishna kumar", "K Krishna Kumar" and "kkrishnakumar" all find "K. Krishna Kumar"; words may come in any
// order ("kumar krishna"). Results are ranked: exact, starts with, a word starts with, contains, all words, similar spelling.

const KEYS = new Map<string, string>();
/**
 * Search key: lower case, Latin accents removed, only letters, marks and digits kept (spaces and punctuation dropped).
 * Indian scripts keep their vowel signs, so different words never collapse into one. Keys are cached (names repeat a lot).
 */
export function searchKey(s: string | null | undefined): string {
  const text = s ?? '';
  let k = KEYS.get(text);
  if (k === undefined) {
    k = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
    if (KEYS.size > 400_000) KEYS.clear();
    KEYS.set(text, k);
  }
  return k;
}
const WORDS = new Map<string, string[]>();
/** The words of a text as search keys ("K. Krishna-Kumar" → k, krishna, kumar). Cached like the keys. */
export function searchWords(s: string | null | undefined): string[] {
  const text = s ?? '';
  let w = WORDS.get(text);
  if (w === undefined) {
    w = text.split(/[^\p{L}\p{M}\p{N}]+/u).map(searchKey).filter(Boolean);
    if (WORDS.size > 200_000) WORDS.clear();
    WORDS.set(text, w);
  }
  return w;
}
/** Does a query word start at a word of the text ("ks" in "K. S. Chithra", "chith" in "K.S. Chithra", not "ks" in "Nakshathram")? */
function startsAtWord(words: string[], w: string): boolean {
  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith(w)) return true;
    if (w.startsWith(words[i])) { let joined = words[i]; for (let j = i + 1; j < words.length && joined.length < w.length; j++) joined += words[j]; if (joined.startsWith(w)) return true; }
  }
  return false;
}
/**
 * Similar spelling: doubled letters and common ways of writing Indian names in Latin letters are treated as one
 * ("Ishitaa" ~ "Ishita", "Swathi Thirunal" ~ "Swati Tirunal", "Shreya" ~ "Sreya", "Vani" ~ "Wani"). Only the lowest tier.
 */
const LOOSE: [RegExp, string][] = [[/th/g, 't'], [/dh/g, 'd'], [/bh/g, 'b'], [/kh/g, 'k'], [/gh/g, 'g'], [/ph/g, 'f'], [/sh/g, 's'], [/ee/g, 'i'], [/oo/g, 'u'], [/w/g, 'v'], [/z/g, 'j']];
function looseKey(key: string): string { let k = key; for (const [re, to] of LOOSE) k = k.replace(re, to); return k.replace(/(.)\1+/g, '$1'); }

export interface SearchQuery { raw: string; key: string; words: string[]; loose: string }
export function searchQuery(raw: string | null | undefined): SearchQuery {
  const text = (raw ?? '').trim().replace(/^@/, '');
  const key = searchKey(text);
  return { raw: text, key, words: searchWords(text), loose: looseKey(key) };
}

/** Match tiers (lower = better). */
export const TIER = { EXACT: 1, PREFIX: 2, WORD_PREFIX: 3, CONTAINS: 4, ALL_WORDS: 5, SIMILAR: 6 } as const;

/** How well one text matches the query: a tier (1 = exact … 6 = similar spelling), or 0 when it does not match. */
export function matchTier(q: SearchQuery, text: string | null | undefined, opts: { similar?: boolean } = {}): number {
  if (!q.key || !text) return 0;
  const key = searchKey(text);
  if (!key) return 0;
  if (key === q.key) return TIER.EXACT;
  if (key.startsWith(q.key)) return TIER.PREFIX;
  if (key.includes(q.key)) {
    // "krishna kumar" in "K. Krishna Kumar": the match starts where a word starts.
    const words = searchWords(text);
    for (let i = 1; i < words.length; i++) if (words.slice(i).join('').startsWith(q.key)) return TIER.WORD_PREFIX;
    return TIER.CONTAINS;
  }
  if (q.words.length > 1) { const words = searchWords(text); if (q.words.every(w => startsAtWord(words, w))) return TIER.ALL_WORDS; }
  if (opts.similar !== false && q.key.length >= 4 && looseKey(key).includes(q.loose)) return TIER.SIMILAR;
  return 0;
}

/** Best tier over several texts (0 = none matches). */
export function bestTier(q: SearchQuery, texts: (string | null | undefined)[], opts?: { similar?: boolean }): number {
  let best = 0;
  for (const t of texts) { const n = matchTier(q, t, opts); if (n && (!best || n < best)) best = n; if (best === TIER.EXACT) break; }
  return best;
}

/** Identifiers (artist ID, source ID, ISRC, task ID …): equal once case, spaces and dashes are ignored. */
export function sameId(q: SearchQuery, id: string | null | undefined): boolean { return !!q.key && !!id && searchKey(id) === q.key; }

/** Simple yes/no filter for lists in the web app (songs tab, connection graph, …). */
export function matchesText(raw: string, ...texts: (string | null | undefined)[]): boolean {
  const q = searchQuery(raw);
  return !q.key || texts.some(t => matchTier(q, t, { similar: false }) > 0) || (q.words.length > 1 && q.words.every(w => texts.some(t => startsAtWord(searchWords(t), w))));
}
