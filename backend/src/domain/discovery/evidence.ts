// Evidence for each candidate profile: is this the artist's own profile? The score is the match % shown to people
// (0-100): mostly identity signals (name, handle, an artist page on a music service, links from the artist's other
// profiles), raised by catalogue evidence (songs, ISRCs, label) and lowered by conflicts. It is never an identity decision.
import type { DiscoveryStrength, EvidenceKind, Platform } from '../constants';
import type { ProfileTrack } from '../types';
import { foldText, handleKey, hasPhrase, normalizeProfileUrl, slugName } from './normalize';
import type { CaseFacts } from './queries';

export interface EvidenceItem { kind: EvidenceKind; polarity: 'match' | 'conflict'; detail: string; weight: number; hard?: boolean }
export interface ProfileInput {
  normalizedUrl: string;
  platform: Platform;
  displayName: string;
  username: string | null;
  title: string;
  description: string;
  location: string | null;
  language: string | null;
  links: string[];               // normalized
  tracks: ProfileTrack[];
}
export interface Scored { items: EvidenceItem[]; score: number; strength: DiscoveryStrength; matchedSongs: string[]; otherCaseId: string | null; specific: boolean }

/** Candidates at or above this match are shown to people; below it only when nothing better was found. */
export const MATCH_THRESHOLD = 50;

const ROLE_WORDS: Record<string, RegExp> = {
  Singer: /\b(singer|vocalist|playback)\b/, Composer: /\b(composer|music director)\b/, Lyricist: /\b(lyricist|lyrics writer|words for)\b/,
  Producer: /\b(producer|produced|beatmaker)\b/, Performer: /\b(artist|performer|musician)\b/,
};
const MUSIC_PLATFORMS = new Set<Platform>(['Spotify', 'Apple Music', 'JioSaavn', 'Gaana', 'Deezer', 'SoundCloud']);
const MUSIC_WORDS = /\b(singer|vocalist|playback|music|musician|artist|composer|lyricist|producer|band|songs|official|vevo|records|topic)\b/;
/** Words that make a page about the artist rather than the artist's own: fan pages, compilations, covers, lyrics, edits. */
const FAN_WORDS = /\b(fan|fans|fanpage|fanclub|fc|tribute|cover|covers|karaoke|lyrics|status|ringtone|ringtones|hits|jukebox|mashup|mashups|unofficial|parody|collection|best of|universe|galaxy|world|army|lovers|forever|idol|legend|legends|eternal|stylish|edits|edit|shayari|quotes|whatsapp|clips|devotees|followers)\b/;
/** Words around a name that do not make it a different name (“Sonu Nigam Official”, “Singer Raju Singh”, “X - Topic”). */
const NAME_NOISE = /\b(official|offical|music|musics|topic|vevo|tv|india|band|live|channel|page|the|singer|composer|lyricist|producer|musician|artist)\b/g;
const MUSIC_SIGNALS = new Set<EvidenceKind>(['Music profile', 'Role match', 'Song match', 'ISRC match', 'Catalogue match', 'Label match', 'Collaborator match', 'Cross-platform match', 'Official website match']);
const OTHER_PROFESSION = /\b(actor|actress|model|vlogger|photographer|chef|cricketer|cricket|fitness|software|engineer|coach|real estate|influencer)\b/;
const clean = (s: string) => foldText(s).replace(NAME_NOISE, ' ').replace(/\s+/g, ' ').trim();

export function scoreProfile(p: ProfileInput, f: CaseFacts, linkedFromStrong: string[] = []): Scored {
  const items: EvidenceItem[] = [];
  const add = (kind: EvidenceKind, detail: string, weight: number, polarity: 'match' | 'conflict' = 'match', hard = false) => items.push({ kind, detail, weight, polarity, hard });
  const nameHay = foldText(`${p.displayName} ${p.title}`);
  const hay = foldText([p.title, p.displayName, p.username, p.description, ...p.tracks.map(t => t.title)].join(' '));
  const target = clean(f.name);
  // name: the profile's own name (on a music service also the name in its address, e.g. gaana.com/artist/raju-singh)
  const names = [clean(p.displayName || p.title), clean(slugName(p.normalizedUrl, p.platform) ?? '')].filter(Boolean);
  let exact = false;
  if (names.includes(target)) { exact = true; add('Name match', `Name is “${f.name}”`, 35); }
  else if (hasPhrase(nameHay, f.name)) add('Name match', `Name contains “${f.name}” with other words`, 20);
  else {
    const alias = f.aliases.find(a => hasPhrase(nameHay, a));
    if (alias) { exact = names.includes(clean(alias)); add('Alias match', `${exact ? 'Name is' : 'Name contains'} the alias “${alias}”`, exact ? 35 : 20); }
    else {
      const parts = f.name.split(/\s+/).filter(x => x.length >= 3);
      if (parts.some(x => hasPhrase(nameHay, x)) || (p.username && parts.some(x => handleKey(p.username).includes(x.toLowerCase())))) add('Partial name match', `Part of the name appears (“${p.displayName}”)`, 5);
      else add('Name differs', `Name is “${p.displayName}”`, -25, 'conflict');
    }
  }
  // handle or domain made of the name
  const nk = handleKey(f.name);
  if (nk.length >= 5) {
    if (p.platform === 'Website' || p.platform === 'Label website') { if (handleKey(p.normalizedUrl.split('/')[0]).includes(nk)) add('Official website match', `Web address ${p.normalizedUrl.split('/')[0]} carries the name`, 20); }
    else if (p.username && handleKey(p.username).includes(nk)) add('Handle match', `Handle @${p.username} matches the name`, 10);
  }
  // a link the catalogue already holds for this artist (e.g. from an artist directory import)
  if (f.profileUrls.some(u => normalizeProfileUrl(u)?.normalized === p.normalizedUrl)) add('Cross-platform match', 'Link already on file for this artist', 40);
  // a music profile: an artist page on a music service (or a YouTube "Topic" artist channel), or a profile about music
  const role = f.roles.find(r => ROLE_WORDS[r]?.test(hay));
  if (MUSIC_PLATFORMS.has(p.platform)) add('Music profile', `Artist page on ${p.platform}`, 20);
  else if (p.platform === 'YouTube' && /\btopic\b/.test(nameHay)) add('Music profile', 'YouTube artist channel (Topic)', 20);
  else if (role) add('Role match', `${role} role matches`, 15);
  else if (MUSIC_WORDS.test(hay)) add('Music profile', 'Describes music', 10);
  // catalogue evidence
  const matchedSongs: string[] = [];
  for (const s of f.songs) if (s.title.length >= 5 && hasPhrase(hay, s.title) && !matchedSongs.includes(s.title)) matchedSongs.push(s.title);
  for (const t of matchedSongs.slice(0, 2)) add('Song match', `Song “${t}” listed`, 10);
  const isrcs = new Map(f.songs.filter(s => s.isrc).map(s => [s.isrc.toUpperCase(), s.title]));
  const isrcHit = p.tracks.find(t => t.isrc && isrcs.has(t.isrc.toUpperCase()));
  if (isrcHit) { add('ISRC match', `ISRC ${isrcHit.isrc} matches “${isrcs.get(isrcHit.isrc!.toUpperCase())}”`, 30); if (!matchedSongs.includes(isrcs.get(isrcHit.isrc!.toUpperCase())!)) matchedSongs.push(isrcs.get(isrcHit.isrc!.toUpperCase())!); }
  if (matchedSongs.length >= 3) add('Catalogue match', `${matchedSongs.length} catalogue songs listed`, 5);
  const label = f.labels.find(l => hasPhrase(hay, l));
  if (label) add('Label match', `Same label: ${label}`, 5);
  const collabs = f.collaborators.filter(c => hasPhrase(hay, c.name)).slice(0, 2);
  for (const c of collabs) add('Collaborator match', `Mentions collaborator ${c.name}`, 5);
  if (f.language && p.language && p.language.toLowerCase() !== f.language.toLowerCase()) add('Different language', `Profile language ${p.language}, catalogue ${f.language}`, -5, 'conflict');
  // linked from the artist's other profiles (or listed on the official website)
  for (const from of linkedFromStrong.slice(0, 1)) add(from.startsWith('website:') ? 'Official website match' : 'Cross-platform match', from.startsWith('website:') ? `Listed on the artist's website (${from.slice(8)})` : `Linked from ${from}`, 15);
  // conflicts: a page about the artist rather than theirs, another person, another artist with the same name
  const specific = matchedSongs.length > 0 || !!isrcHit || !!label || collabs.length > 0;
  if (!exact && FAN_WORDS.test(nameHay)) add('Fan or compilation page', `Looks like a fan or compilation page (“${p.displayName || p.title}”)`, -25, 'conflict');
  const profession = OTHER_PROFESSION.exec(hay)?.[1];
  if (profession && !specific && !MUSIC_PLATFORMS.has(p.platform)) add('Different profession', `Profile describes ${/^[aeiou]/.test(profession) ? 'an' : 'a'} ${profession}, with no music from the catalogue`, -40, 'conflict', true);
  let otherCaseId: string | null = null;
  for (const o of f.otherSameName) {
    const hits = o.songTitles.filter(t => t.length >= 5 && hasPhrase(hay, t));
    const isrcOther = p.tracks.some(t => t.isrc && o.isrcs.includes(t.isrc));
    if ((hits.length || isrcOther) && !specific) {
      otherCaseId = o.caseId;
      add('Songs of another artist', `Songs match ${o.name} (${o.artistId ?? o.caseId}), a different artist with the same name${hits[0] ? `: “${hits[0]}”` : ''}`, -45, 'conflict', true);
      break;
    }
  }
  const rejected = f.rejected.get(p.normalizedUrl);
  if (rejected) add('Previously rejected', rejected, -60, 'conflict', true);
  let score = Math.max(0, Math.min(100, items.reduce((n, x) => n + x.weight, 0)));
  // Another name is someone else (e.g. a co-artist on the same tracks), and a social profile with no sign of music at
  // all is most likely a namesake: neither may reach the 50% that puts a profile in front of people.
  if (items.some(x => x.kind === 'Name differs')) score = Math.min(score, 35);
  if (!MUSIC_PLATFORMS.has(p.platform) && !items.some(x => x.polarity === 'match' && MUSIC_SIGNALS.has(x.kind))) score = Math.min(score, 45);
  const hard = items.some(x => x.hard);
  const strength: DiscoveryStrength = hard ? 'WEAK' : score >= 75 ? 'STRONG' : score >= MATCH_THRESHOLD ? 'POSSIBLE' : 'WEAK';
  return { items, score, strength, matchedSongs, otherCaseId, specific };
}

/** Location conflicts are only visible across a candidate group (one person, several profiles). */
export function locationConflicts(members: { id: string; platform: string; location: string | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  const located = members.filter(x => x.location);
  const counts = new Map<string, number>();
  for (const x of located) counts.set(x.location!, (counts.get(x.location!) ?? 0) + 1);
  if (counts.size < 2) return out;
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (const x of located) if (x.location !== main) out.set(x.id, `Different city: ${x.location} on ${x.platform}, ${main} on other profiles`);
  return out;
}

/** Union-find grouping of profiles that probably belong to one person: cross-links, same handle, shared songs, same other artist. */
export function groupProfiles<T extends { id: string; normalizedUrl: string; username: string | null; links: string[]; matchedSongs: string[]; otherCaseId: string | null; evidenceScore: number; verificationStatus: string }>(list: T[]): Map<string, string> {
  const parent = new Map(list.map(p => [p.id, p.id]));
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const byUrl = new Map(list.map(p => [p.normalizedUrl, p.id]));
  for (const p of list) for (const l of p.links) { const q = byUrl.get(l); if (q && q !== p.id) union(p.id, q); }
  const byHandle = new Map<string, string>();
  for (const p of list) { const h = handleKey(p.username); if (h.length >= 6) { const q = byHandle.get(h); if (q) union(p.id, q); else byHandle.set(h, p.id); } }
  const bySong = new Map<string, string>();
  for (const p of list) if (!p.otherCaseId) for (const s of p.matchedSongs) { const q = bySong.get(s); if (q) union(p.id, q); else bySong.set(s, p.id); }
  const byOther = new Map<string, string>();
  for (const p of list) if (p.otherCaseId) { const q = byOther.get(p.otherCaseId); if (q) union(p.id, q); else byOther.set(p.otherCaseId, p.id); }
  // Group labels: the group holding a verified profile first, then by best evidence.
  const groups = new Map<string, T[]>();
  for (const p of list) { const r = find(p.id); groups.set(r, [...(groups.get(r) ?? []), p]); }
  const ordered = [...groups.values()].sort((a, b) => Number(b.some(x => x.verificationStatus === 'VERIFIED')) - Number(a.some(x => x.verificationStatus === 'VERIFIED')) || Math.max(...b.map(x => x.evidenceScore)) - Math.max(...a.map(x => x.evidenceScore)));
  const out = new Map<string, string>();
  ordered.forEach((g, i) => { const label = groupLetter(i); for (const p of g) out.set(p.id, label); });
  return out;
}
export const groupLetter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`);
