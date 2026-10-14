// "Is the artist alive?" (V2.7.2). Find artist checks it first, on Wikidata (public, free, no key): a human working in
// music whose name is exactly the artist's name, with a date of death or not. When the artist has passed away the search
// stops before spending any search quota, and a person decides: continue anyway, or remove the artist (the next artist by
// songs then joins the top 250). Pure logic here; the server fetches the two Wikidata answers (server/providers.ts).
import { foldText } from './discovery/normalize';
import type { ArtistCase, LifeCheck } from './types';

/** Occupations that make a Wikidata person a music person (singer, composer, lyricist, …). */
const MUSIC_OCCUPATIONS = new Set([
  'Q177220', 'Q639669', 'Q36834', 'Q2643890', 'Q822146', 'Q753110', 'Q488205', 'Q183945', 'Q2252262', 'Q1198887', 'Q1415090', 'Q855091', 'Q486748',
  'Q386854', 'Q1259917', 'Q158852', 'Q12800682', 'Q2490358', 'Q1327329', 'Q4351403', 'Q5716684', 'Q130857', 'Q1028181',
]);
const MUSIC_WORDS = /\b(singer|music|musician|composer|lyricist|rapper|vocalist|songwriter|playback|guitarist|pianist|drummer|percussionist|flautist|violinist|tabla|sitar|sarod|santoor|veena|carnatic|hindustani|qawwal|ghazal|band|instrumentalist|dj)\b/i;

interface Snak { mainsnak?: { datavalue?: { value?: unknown } } }
export interface WdEntity {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  aliases?: Record<string, { value: string }[]>;
  claims?: Record<string, Snak[]>;
  sitelinks?: Record<string, { title: string }>;
}
const ids = (e: WdEntity, p: string) => (e.claims?.[p] ?? []).map(s => (s.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id).filter((x): x is string => !!x);
/** Wikidata time "+1929-09-28T00:00:00Z" (precision 11 = day, 10 = month, 9 = year) → "1929-09-28" / "1929-09" / "1929". */
function dateOf(e: WdEntity, p: string): string | null {
  const v = e.claims?.[p]?.[0]?.mainsnak?.datavalue?.value as { time?: string; precision?: number } | undefined;
  const m = v?.time?.match(/^[+-]?(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return e.claims?.[p]?.length ? 'unknown date' : null;   // "unknown value": a date of death exists, not known
  const prec = v?.precision ?? 11;
  return prec >= 11 ? `${m[1]}-${m[2]}-${m[3]}` : prec === 10 ? `${m[1]}-${m[2]}` : m[1];
}

/**
 * The best matching music person for the artist's name (or an alias) among the Wikidata entities, and whether a date of
 * death is on record. Only exact names count (case, accents and dots ignored), so "Shaan" never matches "Shaan Rahman".
 */
export function pickLife(names: string[], entities: WdEntity[], now: string): LifeCheck {
  const wanted = new Set(names.map(n => foldText(n)).filter(n => n.trim().length > 1));
  const people = entities.filter(e => {
    if (!ids(e, 'P31').includes('Q5')) return false;   // a human
    const names = [e.labels?.en?.value, ...Object.values(e.labels ?? {}).map(l => l.value), ...(e.aliases?.en ?? []).map(a => a.value)].filter(Boolean) as string[];
    if (!names.some(n => wanted.has(foldText(n)))) return false;
    return ids(e, 'P106').some(o => MUSIC_OCCUPATIONS.has(o)) || MUSIC_WORDS.test(e.descriptions?.en?.value ?? '');
  });
  const base: LifeCheck = { status: 'Unknown', deathDate: null, birthDate: null, label: null, description: null, source: null, others: 0, checkedAt: now, decision: null, decidedBy: null, decidedAt: null };
  if (!people.length) return base;
  // the best known one first (pages in more languages), Indian artists slightly preferred (this catalogue)
  const score = (e: WdEntity) => Object.keys(e.sitelinks ?? {}).length + (/\bindia/i.test(e.descriptions?.en?.value ?? '') ? 20 : 0);
  const best = [...people].sort((a, b) => score(b) - score(a))[0];
  const death = dateOf(best, 'P570'), birth = dateOf(best, 'P569');
  const wiki = best.sitelinks?.enwiki?.title;
  return {
    ...base, status: death ? 'Deceased' : 'Alive', deathDate: death, birthDate: birth,
    label: best.labels?.en?.value ?? Object.values(best.labels ?? {})[0]?.value ?? null, description: best.descriptions?.en?.value ?? null,
    source: wiki ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.replace(/ /g, '_'))}` : `https://www.wikidata.org/wiki/${best.id}`,
    others: people.length - 1,
  };
}

/** The search waits for a person: the artist has passed away and nobody decided yet. */
export const lifeHold = (c: ArtistCase): boolean => c.life?.status === 'Deceased' && !c.life.decision;
/** "died 6 Feb 2022" for messages. */
export function diedText(l: LifeCheck | null | undefined): string {
  if (!l?.deathDate || l.deathDate === 'unknown date') return 'date of death on record';
  const d = l.deathDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `died ${new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
  return `died ${d.slice(0, 4)}`;
}
