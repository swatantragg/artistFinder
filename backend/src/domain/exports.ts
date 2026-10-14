// Export of the verified artists (V2.7.2), laid out like the artist directory it came from (Admin Studio export: one sheet
// per letter pair, the same columns), except that "Social link" holds one column per platform with the artist's verified
// profile on it (blank = none verified there) and Songs is today's count. The server turns this into an .xlsx file.
import type { Model } from './model';
import { userName } from './ops';
import { isVerified } from './status';
import type { Ctx } from './types';
import { nameKey } from './util';
import { songCounts } from './views';

/** The social-link sub-columns, in this order; any other platform goes under "Other". */
export const EXPORT_PLATFORMS = ['Instagram', 'Facebook', 'X', 'YouTube', 'Spotify', 'Apple Music', 'JioSaavn', 'SoundCloud', 'Gaana', 'Website', 'Other'] as const;
export const LETTER_SHEETS = ['A-B', 'C-D', 'E-F', 'G-H', 'I-J', 'K-L', 'M-N', 'O-P', 'Q-R', 'S-T', 'U-V', 'W-X', 'Y-Z', '0-9 & Other'] as const;

export interface ExportRow {
  sheet: string; name: string; artistId: string;
  links: Record<string, string[]>;   // platform → verified profile URLs
  confidence: number | null; basis: string; songs: number; followers: number | null; listeners: number | null; verified: boolean; core: boolean;
  titles: string[];
}
const alphaKey = (name: string) => name.replace(/^[^\p{L}\p{N}]+/u, '') || name;
const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
/** "A-B" for Asha and Bansi, … "0-9 & Other" for names that do not start with a Latin letter (as in the directory). */
export function sheetOf(name: string): string {
  const ch = alphaKey(name).normalize('NFKD').charAt(0).toUpperCase();
  const i = ch >= 'A' && ch <= 'Z' ? Math.floor((ch.charCodeAt(0) - 65) / 2) : -1;
  return i >= 0 ? LETTER_SHEETS[i] : '0-9 & Other';
}

export function verifiedExport(m: Model, ctx: Ctx) {
  const songs = songCounts(m);
  const rows: ExportRow[] = m.all('cases')
    .filter(c => !c.mergedIntoId && !c.rejectedAt && isVerified(c))
    .sort((a, b) => byName(alphaKey(a.canonicalName), alphaKey(b.canonicalName)))
    .map(c => {
      const links: Record<string, string[]> = {};
      for (const v of m.familyItems('verifiedProfiles', c.id)) {
        if (v.verificationStatus !== 'VERIFIED') continue;
        const col = (EXPORT_PLATFORMS as readonly string[]).includes(v.platform) ? v.platform : 'Other';
        const list = (links[col] ??= []);
        if (!list.includes(v.url)) list.push(v.url);
      }
      const titles = new Map<string, string>();
      for (const id of m.family(c.id)) for (const tid of m.trackIdsOfCase(id)) { const t = m.get('tracks', tid); if (t && !titles.has(nameKey(t.title))) titles.set(nameKey(t.title), t.title); }
      const d = c.directory ?? null;
      return {
        sheet: sheetOf(c.canonicalName), name: c.canonicalName, artistId: c.id, links,
        confidence: d?.confidence ?? null, basis: d?.basis ?? '', songs: songs.get(c.id) ?? titles.size, followers: d ? d.followers : null, listeners: d ? d.listeners : null,
        verified: !!d?.verified, core: !!d?.core, titles: [...titles.values()].sort((a, b) => byName(a, b)),
      };
    });
  return { generatedAt: ctx.now, by: userName(m, ctx.userId), platforms: [...EXPORT_PLATFORMS], rows };
}
export type VerifiedExport = ReturnType<typeof verifiedExport>;
