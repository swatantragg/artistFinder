// URL normalisation: different providers return the same profile in different shapes
// (instagram.com/rahulsharma/, https://www.instagram.com/rahulsharma?hl=en, m.instagram.com/rahulsharma). They must become one candidate.
import type { Platform } from '../constants';

export interface NormalizedUrl { url: string; normalized: string; platform: Platform; username: string | null; host: string }

const SOCIAL: { host: RegExp; platform: Platform; canonical: string }[] = [
  { host: /(^|\.)instagram\.com$/, platform: 'Instagram', canonical: 'instagram.com' },
  { host: /(^|\.)(youtube\.com|youtu\.be)$/, platform: 'YouTube', canonical: 'youtube.com' },
  { host: /(^|\.)(facebook\.com|fb\.com)$/, platform: 'Facebook', canonical: 'facebook.com' },
  { host: /(^|\.)spotify\.com$/, platform: 'Spotify', canonical: 'open.spotify.com' },
  { host: /(^|\.)soundcloud\.com$/, platform: 'SoundCloud', canonical: 'soundcloud.com' },
  { host: /(^|\.)(twitter\.com|x\.com)$/, platform: 'X', canonical: 'x.com' },
  { host: /(^|\.)music\.apple\.com$/, platform: 'Apple Music', canonical: 'music.apple.com' },
  { host: /(^|\.)jiosaavn\.com$/, platform: 'JioSaavn', canonical: 'jiosaavn.com' },
  { host: /(^|\.)gaana\.com$/, platform: 'Gaana', canonical: 'gaana.com' },
  { host: /(^|\.)deezer\.com$/, platform: 'Deezer', canonical: 'deezer.com' },
];
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv']);
const FB_RESERVED = new Set(['pg', 'pages', 'people']);

/** Returns null for anything that is not a public http(s) URL. */
export function normalizeProfileUrl(raw: string, hint?: Platform): NormalizedUrl | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const rawHost = u.hostname.toLowerCase().replace(/\.$/, '');
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const social = SOCIAL.find(x => x.host.test(rawHost));
  if (!social) {
    const path = parts.join('/').replace(/\/?index\.html?$/i, '').toLowerCase();
    const h = rawHost.replace(/^(www|m)\./, '');
    const platform: Platform = hint === 'Label website' ? 'Label website' : 'Website';
    return { url: `https://${h}/${path}`, normalized: `${h}${path ? `/${path}` : ''}`, platform, username: null, host: h };
  }
  let path = '';
  let username: string | null = null;
  switch (social.platform) {
    case 'Instagram': {
      const h = (parts[0] ?? '').toLowerCase();
      if (h && !IG_RESERVED.has(h)) { username = h.replace(/^@/, ''); path = username; } else path = parts.slice(0, 2).join('/');
      break;
    }
    case 'YouTube': {
      if (rawHost.endsWith('youtu.be') && parts[0]) { path = `watch?v=${parts[0]}`; break; }
      const p0 = parts[0] ?? '';
      if (p0.startsWith('@')) { username = p0.slice(1).toLowerCase(); path = `@${username}`; }
      else if (['channel', 'c', 'user'].includes(p0.toLowerCase()) && parts[1]) { username = p0.toLowerCase() === 'channel' ? parts[1] : parts[1].toLowerCase(); path = `${p0.toLowerCase()}/${username}`; }
      else if (p0 === 'watch' && u.searchParams.get('v')) path = `watch?v=${u.searchParams.get('v')}`;
      else path = parts.join('/');
      break;
    }
    case 'Facebook': {
      const meaningful = parts.filter(x => !FB_RESERVED.has(x.toLowerCase()));
      if (meaningful[0] === 'profile.php' && u.searchParams.get('id')) { username = u.searchParams.get('id'); path = `profile.php?id=${username}`; }
      else if (meaningful[0]) { username = meaningful[0].toLowerCase(); path = username; }
      break;
    }
    case 'Spotify': {
      const rest = parts[0]?.startsWith('intl-') ? parts.slice(1) : parts;
      if (rest[0] && rest[1]) { path = `${rest[0].toLowerCase()}/${rest[1]}`; username = rest[1]; } else path = rest.join('/');
      break;
    }
    case 'X': case 'SoundCloud': case 'JioSaavn': case 'Apple Music': case 'Gaana': case 'Deezer': default: {
      if (parts[0]) { username = parts[0].toLowerCase().replace(/^@/, ''); path = parts.length > 1 && social.platform !== 'X' ? parts.map(x => x.toLowerCase()).join('/') : username; }
      break;
    }
  }
  const normalized = `${social.canonical}${path ? `/${path}` : ''}`;
  return { url: `https://${normalized}`, normalized, platform: social.platform, username, host: social.canonical };
}

const FB_CONTENT = new Set(['watch', 'photo.php', 'photos', 'photo', 'story.php', 'permalink.php', 'events', 'groups', 'hashtag', 'search', 'sharer', 'sharer.php', 'share', 'reel', 'reels', 'videos', 'login', 'marketplace', 'notes', 'media', 'gaming', 'help', 'policies', 'privacy', 'business', 'ads', 'l.php']);
const X_RESERVED = new Set(['search', 'hashtag', 'i', 'home', 'explore', 'intent', 'share', 'login', 'signup', 'settings', 'tos', 'privacy', 'messages', 'notifications']);
const SC_RESERVED = new Set(['discover', 'search', 'charts', 'stream', 'you', 'upload', 'pages', 'mobile', 'tags', 'people', 'imprint', 'terms-of-use', 'popular', 'feed']);

/**
 * The artist's own profile behind a search result, or null when the link is not one: songs, videos, tracks, albums,
 * playlists, posts and articles are dropped (a SoundCloud track or an X post still names its account, which is kept).
 * Websites count only as their home page (an official site); anything deeper is an article or a song page.
 */
export function artistProfileUrl(raw: string, hint?: Platform): NormalizedUrl | null {
  const n = normalizeProfileUrl(raw, hint);
  if (!n) return null;
  const path = n.normalized.slice(n.host.length).replace(/^\//, '');
  const seg = path.split('/').filter(Boolean);
  const noHandle = (x: NormalizedUrl): NormalizedUrl => ({ ...x, username: null });
  switch (n.platform) {
    case 'Instagram': return n.username ? n : null;
    case 'YouTube': return /^(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)$/.test(path) ? n : null;
    case 'Facebook': return n.username && !FB_CONTENT.has(n.username) ? n : null;
    case 'X': return n.username && !X_RESERVED.has(n.username) ? n : null;
    case 'Spotify': return seg[0] === 'artist' && seg[1] ? n : null;
    case 'SoundCloud': {
      const user = seg[0];
      if (!user || SC_RESERVED.has(user)) return null;
      return { ...n, url: `https://soundcloud.com/${user}`, normalized: `soundcloud.com/${user}`, username: user };
    }
    case 'Apple Music': return seg.includes('artist') ? noHandle(n) : null;
    case 'JioSaavn': case 'Gaana': return seg[0] === 'artist' && seg[1] ? noHandle(n) : null;
    case 'Deezer': return seg.includes('artist') ? noHandle(n) : null;
    case 'Label website': return n;
    case 'Website': return seg.length === 0 ? n : null;
    default: return null;
  }
}

/** The artist name in a music-service address (gaana.com/artist/raju-singh → "raju singh"), or null. */
export function slugName(normalizedUrl: string, platform: string): string | null {
  const seg = normalizedUrl.split('/').slice(1);
  const at = seg.indexOf('artist');
  const raw = platform === 'SoundCloud' ? seg[0] : ['Gaana', 'JioSaavn', 'Apple Music'].includes(platform) && at >= 0 ? seg[at + 1] : null;
  if (!raw) return null;
  return decodeURIComponent(raw).replace(/-songs$/i, '').replace(/[-_.]+/g, ' ').trim() || null;
}

/** A readable profile name: music services' web titles ("Sonu Nigam on Apple Music", "X Songs: Listen …") give way to the name in the address. */
export function profileName(platform: string, normalizedUrl: string, shown: string): string {
  const slug = ['Gaana', 'JioSaavn', 'Apple Music'].includes(platform) ? slugName(normalizedUrl, platform) : null;
  return slug ? slug.replace(/\b\p{L}/gu, ch => ch.toUpperCase()) : shown;
}

export function platformOf(url: string): Platform { return normalizeProfileUrl(url)?.platform ?? 'Website'; }
export const normalizeQuery = (q: string) => q.trim().replace(/\s+/g, ' ').toLowerCase();

/** Accent- and punctuation-insensitive text used for evidence matching. */
export function foldText(s: string | null | undefined): string {
  return ` ${String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}
/** True when `phrase` appears as whole words inside `folded` (both from foldText). */
export function hasPhrase(folded: string, phrase: string): boolean {
  const p = foldText(phrase);
  return p.trim().length > 0 && folded.includes(p);
}
/** Handle without separators, used to spot the same account name across platforms. */
export const handleKey = (u: string | null) => (u ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
