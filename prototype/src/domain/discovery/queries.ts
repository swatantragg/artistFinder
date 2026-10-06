// Step 1 of Find Artist: read everything the catalogue knows about the artist, then turn it into search queries.
// Only the artist is searched (name with platforms and role), to find the artist's own profiles; songs, ISRCs, labels and
// collaborators are used as evidence when scoring what comes back. ISRCs go to Spotify only, which answers with artist pages.
import type { DiscoveryMode, Platform } from '../constants';
import type { Model } from '../model';
import type { QueryKind } from '../types';
import { nameKey } from '../util';
import { normalizeProfileUrl, normalizeQuery } from './normalize';

export interface SongFact { trackId: string; title: string; isrc: string; label: string; distributor: string; releaseDate: string; roles: string[]; isNew: boolean; collaborators: string[] }
export interface CollabFact { key: string; name: string; caseId: string | null; roles: string[]; songs: string[]; verifiedProfiles: number; verifiedContacts: number; isNew: boolean }
export interface OtherArtist { caseId: string; name: string; artistId: string | null; songTitles: string[]; isrcs: string[] }
export interface CaseFacts {
  caseId: string;
  name: string;
  aliases: string[];
  artistIds: string[];
  roles: string[];
  language: string | null;
  songs: SongFact[];
  labels: string[];
  distributors: string[];
  collaborators: CollabFact[];
  profileUrls: string[];
  otherSameName: OtherArtist[];
  rejected: Map<string, string>;        // normalized URL -> why it was rejected before
  verifiedUrls: Map<string, string>;    // normalized URL -> verified profile id
  stats: { songs: number; credits: number; collaborators: number; isrcs: number; labels: number; releases: number };
}

export interface SearchRequest {
  query: string;
  kind: QueryKind;
  priority: number;
  platform?: Platform;
  isrc?: string;
  subject: 'artist' | 'collaborator';
  subjectName: string;
  subjectKey: string;                    // collaborator key (case id or name key)
}

const ROLE_WORD: Record<string, string> = { Singer: 'singer', Performer: 'artist', Composer: 'composer', Lyricist: 'lyricist', Producer: 'producer', Other: 'music' };
/** Web searches for the artist's own pages, most useful first (the web search budget per artist is small). */
const SITE_QUERIES: { site: string; platform: Platform }[] = [
  { site: 'instagram.com', platform: 'Instagram' },
  { site: 'youtube.com', platform: 'YouTube' },
  { site: 'facebook.com', platform: 'Facebook' },
  { site: 'x.com', platform: 'X' },
  { site: 'jiosaavn.com/artist', platform: 'JioSaavn' },
  { site: 'soundcloud.com', platform: 'SoundCloud' },
  { site: 'music.apple.com', platform: 'Apple Music' },
];

export function buildFacts(m: Model, caseId: string, focusTrackIds: string[] = []): CaseFacts {
  const c = m.must('cases', caseId);
  const fam = new Set(m.family(caseId));
  const focus = new Set(focusTrackIds);
  const songs: SongFact[] = [];
  const collabs = new Map<string, CollabFact>();
  let credits = 0;
  const releases = new Set<string>();
  for (const tid of m.trackIdsOfCase(caseId)) {
    const t = m.get('tracks', tid);
    if (!t) continue;
    if (t.releaseId) releases.add(t.releaseId);
    const all = m.creditsOfTrack(tid).filter(cr => cr.status === 'Active');
    credits += all.length;
    const mine = all.filter(cr => cr.caseId && fam.has(cr.caseId));
    const others = all.filter(cr => !(cr.caseId && fam.has(cr.caseId)));
    songs.push({ trackId: tid, title: t.title, isrc: t.isrc, label: t.label, distributor: t.distributor, releaseDate: t.releaseDate, roles: mine.map(x => x.role), isNew: focus.has(tid), collaborators: others.map(o => o.personName) });
    for (const o of others) {
      const key = o.caseId ? m.canonical(o.caseId) : `name:${nameKey(o.personName)}`;
      const x = collabs.get(key) ?? { key, name: o.caseId ? m.get('cases', m.canonical(o.caseId))?.canonicalName ?? o.personName : o.personName, caseId: o.caseId ? m.canonical(o.caseId) : null, roles: [], songs: [], verifiedProfiles: 0, verifiedContacts: 0, isNew: false };
      if (!x.roles.includes(o.role)) x.roles.push(o.role);
      if (!x.songs.includes(t.title)) x.songs.push(t.title);
      if (focus.has(tid)) x.isNew = true;
      collabs.set(key, x);
    }
  }
  for (const x of collabs.values()) {
    if (x.caseId) {
      x.verifiedProfiles = m.byCase('verifiedProfiles', x.caseId).filter(v => v.verificationStatus === 'VERIFIED').length;
      x.verifiedContacts = m.contactsFor(x.caseId).filter(k => k.verified).length;
    } else x.verifiedContacts = m.contactsNamed(x.name).filter(k => k.verified).length;
  }
  songs.sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.collaborators.length - a.collaborators.length || (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  const roles = [...new Set(songs.flatMap(s => s.roles))];
  // Same or similar names elsewhere in the catalogue: their songs help tell the people apart.
  const otherSameName: OtherArtist[] = [];
  for (const o of [...m.casesNamed(c.canonicalName), ...m.casesSimilar(c.canonicalName)]) {
    if (o.id === caseId || fam.has(o.id) || otherSameName.some(x => x.caseId === o.id)) continue;
    const tracks = m.trackIdsOfCase(o.id).map(id => m.get('tracks', id)!).filter(Boolean);
    otherSameName.push({ caseId: o.id, name: o.canonicalName, artistId: o.backendProfileIds[0] ?? null, songTitles: tracks.map(t => t.title), isrcs: tracks.map(t => t.isrc).filter(Boolean) });
  }
  const rejected = new Map<string, string>();
  for (const p of m.byCase('profiles', caseId)) if (p.verificationStatus === 'REJECTED') rejected.set(p.normalizedUrl, p.rejectionReason ?? 'Rejected before');
  for (const r of m.byCase('routes', caseId)) if (r.sourceUrl && r.state === 'Rejected') { const n = normalizeProfileUrl(r.sourceUrl); if (n) rejected.set(n.normalized, `Route ${r.id} rejected: ${r.rejectionReason ?? 'wrong person'}`); }
  const verifiedUrls = new Map<string, string>();
  for (const v of m.byCase('verifiedProfiles', caseId)) if (v.verificationStatus === 'VERIFIED') { const n = normalizeProfileUrl(v.url); if (n) verifiedUrls.set(n.normalized, v.id); }
  return {
    caseId, name: c.canonicalName, aliases: c.aliases, artistIds: c.backendProfileIds, roles, language: c.language, songs,
    labels: [...new Set(songs.map(s => s.label).filter(Boolean))], distributors: [...new Set(songs.map(s => s.distributor).filter(Boolean))],
    collaborators: [...collabs.values()].sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.songs.length - a.songs.length || a.name.localeCompare(b.name)),
    profileUrls: c.profileUrls, otherSameName, rejected, verifiedUrls,
    stats: { songs: songs.length, credits, collaborators: collabs.size, isrcs: songs.filter(s => s.isrc).length, labels: new Set(songs.map(s => s.label).filter(Boolean)).size, releases: releases.size },
  };
}

const q = (s: string) => `"${s.replace(/"/g, '')}"`;
const LIMITS: Record<DiscoveryMode | 'bulk', { artist: number; collab: number }> = {
  full: { artist: 22, collab: 6 }, refresh: { artist: 22, collab: 6 }, targeted: { artist: 8, collab: 4 }, bulk: { artist: 11, collab: 2 },
};

/**
 * Artist queries: the name alone (also answered by the Spotify and YouTube APIs), the name on each platform, the name with
 * the role, and ISRCs for Spotify (they point at the right artist page). Deduplicated and capped to control search cost.
 * A targeted search after an import only checks the new songs' ISRCs on Spotify (no web search).
 */
export function artistQueries(f: CaseFacts, mode: DiscoveryMode, bulk = false): SearchRequest[] {
  const out: SearchRequest[] = [];
  const add = (query: string, kind: QueryKind, priority: number, extra: Partial<SearchRequest> = {}) => out.push({ query, kind, priority, subject: 'artist', subjectName: f.name, subjectKey: f.caseId, ...extra });
  const name = q(f.name);
  const role = ROLE_WORD[f.roles[0] ?? 'Singer'] ?? 'singer';
  const withIsrc = f.songs.filter(s => s.isrc);
  if (mode === 'targeted') {
    for (const s of withIsrc.filter(x => x.isNew).slice(0, 3)) add(q(s.isrc), 'isrc', 1, { isrc: s.isrc });
  } else {
    add(name, 'name', 1);
    SITE_QUERIES.slice(0, 3).forEach((p, i) => add(`${name} site:${p.site}`, 'site', 2 + i, { platform: p.platform }));
    add(`${name} ${role}`, 'role', 5);
    add(`${name} official`, 'platform', 6);
    SITE_QUERIES.slice(3).forEach((p, i) => add(`${name} site:${p.site}`, 'site', 7 + i, { platform: p.platform }));
    for (const s of withIsrc.slice(0, 2)) add(q(s.isrc), 'isrc', 11, { isrc: s.isrc });
    for (const a of f.aliases.slice(0, 2)) add(q(a), 'alias', 12);
  }
  return dedupe(out).sort((a, b) => a.priority - b.priority).slice(0, LIMITS[bulk ? 'bulk' : mode].artist);
}

/** Collaborators are not searched: only the artist is (their own profiles are found when they are searched as artists). */
export function collaboratorQueries(_f: CaseFacts, _mode: DiscoveryMode, _bulk = false): SearchRequest[] {
  return [];
}

function dedupe(list: SearchRequest[]): SearchRequest[] {
  const seen = new Set<string>();
  return list.filter(r => { const k = normalizeQuery(r.query); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Pull quoted phrases, site: filters and loose words out of a query string (used by providers and logs). */
export function parseQuery(query: string): { phrases: string[]; site: string | null; words: string[] } {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map(x => x[1]);
  const rest = query.replace(/"[^"]*"/g, ' ');
  const site = /site:(\S+)/i.exec(rest)?.[1]?.toLowerCase() ?? null;
  const words = rest.replace(/site:\S+/gi, ' ').split(/\s+/).map(w => w.trim()).filter(Boolean);
  return { phrases, site, words };
}
