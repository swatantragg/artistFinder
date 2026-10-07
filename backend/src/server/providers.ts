// Live discovery providers (server only; they need credentials). Without credentials Find artist is off and says why.
//   SEARCH_PROVIDER=brave   + SEARCH_PROVIDER_API_KEY            Brave Search API
//   SEARCH_PROVIDER=google  + SEARCH_PROVIDER_API_KEY + GOOGLE_CSE_ID   Google Programmable Search
//   SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET                     Spotify Web API (client credentials)
//   YOUTUBE_API_KEY                                               YouTube Data API v3
//   CRAWLER_ENABLED=0 to switch off the public web crawler (on by default in live mode)
// Usage limits (protect free tiers; counted in the database, 0 = no limit), see limitsFromEnv below.
// Only public data through official APIs or pages that allow automated access. No logins, no CAPTCHAs, no private accounts.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { normalizeProfileUrl, platformOf } from '../domain/discovery/normalize';
import { InternalCatalogueProvider, offProviderSet, ProviderError, type CrawlResult, type DiscoveryProvider, type ProviderHit, type ProviderLimits, type ProviderSet } from '../domain/discovery/providers';
import { parseQuery, type SearchRequest } from '../domain/discovery/queries';
import type { Model } from '../domain/model';

type Fetch = typeof fetch;
const UA = 'GAmplifyDiscoveryBot/1.0 (+internal artist research; respects robots.txt)';

async function getJson(fetchFn: Fetch, url: string, init: RequestInit = {}, label = 'Provider'): Promise<any> {
  let res: Response;
  try { res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(9000) }); }
  catch (e) { throw new ProviderError(`${label} unreachable: ${(e as Error).message}`, true); }
  if (res.status === 429 || res.status >= 500) throw new ProviderError(`${label} returned ${res.status}`, true);
  if (!res.ok) throw new ProviderError(`${label} returned ${res.status}${res.status === 401 || res.status === 403 ? ' (check the API key)' : ''}`, false);
  return res.json();
}
const strip = (s: unknown) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const nameFromTitle = (t: string) => t.split(/\s[|·•–-]\s|\s\(@/)[0].trim();

export class BraveSearchProvider implements DiscoveryProvider {
  id = 'brave'; label = 'Brave Search API'; kind = 'web' as const;
  constructor(private key: string, private fetchFn: Fetch = fetch) {}
  /** Every artist query except ISRCs (those go to Spotify). */
  handles(q: SearchRequest) { return q.kind !== 'isrc'; }
  async search(q: SearchRequest): Promise<ProviderHit[]> {
    const data = await getJson(this.fetchFn, `https://api.search.brave.com/res/v1/web/search?count=10&q=${encodeURIComponent(q.query)}`, { headers: { Accept: 'application/json', 'X-Subscription-Token': this.key } }, this.label);
    return (data?.web?.results ?? []).map((r: any) => ({ url: r.url, title: strip(r.title), snippet: strip(r.description), description: strip(r.description), displayName: nameFromTitle(strip(r.title)), platform: platformOf(r.url) }));
  }
}
export class GoogleSearchProvider implements DiscoveryProvider {
  id = 'google-cse'; label = 'Google Programmable Search'; kind = 'web' as const;
  constructor(private key: string, private cx: string, private fetchFn: Fetch = fetch) {}
  /** Every artist query except ISRCs (those go to Spotify). */
  handles(q: SearchRequest) { return q.kind !== 'isrc'; }
  async search(q: SearchRequest): Promise<ProviderHit[]> {
    const data = await getJson(this.fetchFn, `https://www.googleapis.com/customsearch/v1?num=10&key=${encodeURIComponent(this.key)}&cx=${encodeURIComponent(this.cx)}&q=${encodeURIComponent(q.query)}`, {}, this.label);
    return (data?.items ?? []).map((r: any) => {
      const og = r.pagemap?.metatags?.[0] ?? {};
      return { url: r.link, title: strip(r.title), snippet: strip(r.snippet), description: strip(og['og:description'] ?? r.snippet), displayName: nameFromTitle(strip(og['og:title'] ?? r.title)), platform: platformOf(r.link) };
    });
  }
}

/** Spotify Web API: artists, and their tracks with ISRCs (strong catalogue evidence). */
export class SpotifyProvider implements DiscoveryProvider {
  id = 'spotify'; label = 'Spotify Web API'; kind = 'api' as const;
  private token: { value: string; until: number } | null = null;
  constructor(private clientId: string, private secret: string, private fetchFn: Fetch = fetch) {}
  /** The artist's name (artist search) and ISRCs (the artist pages behind the catalogue's tracks). */
  handles(q: SearchRequest) { return ['name', 'alias', 'isrc'].includes(q.kind); }
  private async auth(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 30000) return this.token.value;
    const basic = Buffer.from(`${this.clientId}:${this.secret}`).toString('base64');
    const data = await getJson(this.fetchFn, 'https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }, 'Spotify login');
    this.token = { value: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
  private async api(path: string) { return getJson(this.fetchFn, `https://api.spotify.com/v1/${path}`, { headers: { Authorization: `Bearer ${await this.auth()}` } }, this.label); }
  async search(q: SearchRequest): Promise<ProviderHit[]> {
    const { phrases } = parseQuery(q.query);
    const artistName = phrases[0] ?? q.subjectName;
    const byArtist = new Map<string, ProviderHit>();
    const addTrack = (t: any) => {
      for (const a of t.artists ?? []) {
        const url = a.external_urls?.spotify; if (!url) continue;
        const hit: ProviderHit = byArtist.get(a.id) ?? { url, title: `${a.name} · Spotify`, snippet: 'Spotify artist', displayName: a.name, platform: 'Spotify', tracks: [] };
        hit.tracks!.push({ title: t.name, isrc: t.external_ids?.isrc ?? null });
        byArtist.set(a.id, hit);
      }
    };
    if (q.kind === 'isrc' && q.isrc) {
      for (const t of (await this.api(`search?type=track&limit=5&q=${encodeURIComponent(`isrc:${q.isrc}`)}`))?.tracks?.items ?? []) addTrack(t);
    } else {
      const song = q.kind === 'song' ? phrases[1] : undefined;
      const query = song ? `track:"${song}" artist:"${artistName}"` : `artist:"${artistName}"`;
      for (const t of (await this.api(`search?type=track&limit=10&q=${encodeURIComponent(query)}`))?.tracks?.items ?? []) addTrack(t);
      if (!song) for (const a of (await this.api(`search?type=artist&limit=5&q=${encodeURIComponent(artistName)}`))?.artists?.items ?? []) {
        const hit: ProviderHit = byArtist.get(a.id) ?? { url: a.external_urls?.spotify, title: `${a.name} · Spotify`, snippet: '', displayName: a.name, platform: 'Spotify', tracks: [] };
        hit.snippet = `Artist · ${a.followers?.total ?? 0} followers${a.genres?.length ? ` · ${a.genres.slice(0, 3).join(', ')}` : ''}`;
        hit.description = hit.snippet; hit.followers = a.followers?.total ?? null;
        if (hit.url) byArtist.set(a.id, hit);
      }
    }
    return [...byArtist.values()].slice(0, 6);
  }
}

/** YouTube Data API: the artist's channels (channel search by name; videos are never candidates). */
export class YouTubeProvider implements DiscoveryProvider {
  id = 'youtube'; label = 'YouTube Data API'; kind = 'api' as const;
  constructor(private key: string, private fetchFn: Fetch = fetch) {}
  handles(q: SearchRequest) { return q.kind === 'name' || q.kind === 'alias'; }
  async search(q: SearchRequest): Promise<ProviderHit[]> {
    const text = q.query.replace(/\s+(YouTube|site:youtube\.com)$/i, '');
    const data = await getJson(this.fetchFn, `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=6&type=channel&q=${encodeURIComponent(text)}&key=${encodeURIComponent(this.key)}`, {}, this.label);
    const byChannel = new Map<string, ProviderHit>();
    for (const it of data?.items ?? []) {
      const s = it.snippet ?? {};
      const id = s.channelId ?? it.id?.channelId;
      if (!id) continue;
      const hit: ProviderHit = byChannel.get(id) ?? { url: `https://www.youtube.com/channel/${id}`, title: `${strip(s.channelTitle ?? s.title)} · YouTube`, snippet: strip(s.description), description: strip(s.description), displayName: strip(s.channelTitle ?? s.title), platform: 'YouTube', tracks: [] };
      byChannel.set(id, hit);
    }
    return [...byChannel.values()];
  }
}

// ------------------------------------------------------------------ public web crawler
const SOCIAL = /(^|\.)(instagram|facebook|fb|youtube|youtu|spotify|soundcloud|twitter|x|tiktok|linkedin|threads)\.(com|be|net)$/i;
function privateAddress(ip: string): boolean {
  if (ip.includes(':')) { const v = ip.toLowerCase(); return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.'); }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export function robotsAllows(robots: string, path: string, agent = 'GAmplifyDiscoveryBot'): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null, lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (key === 'allow' || key === 'disallow') && (val || key === 'allow')) cur.rules.push({ allow: key === 'allow', path: val });
  }
  const mine = groups.find(g => g.agents.some(a => a !== '*' && agent.toLowerCase().includes(a))) ?? groups.find(g => g.agents.includes('*'));
  if (!mine) return true;
  const hits = mine.rules.filter(r => r.path && path.startsWith(r.path.replace(/\*.*$/, ''))).sort((a, b) => b.path.length - a.path.length);
  return hits.length ? hits[0].allow : true;
}
export function extractPage(html: string, baseUrl: string): Omit<CrawlResult, 'url' | 'blocked'> {
  const pick = (re: RegExp) => strip(re.exec(html)?.[1] ?? '') || null;
  const meta = (name: string) => pick(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i')) ?? pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'));
  const links = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) { try { const u = new URL(m[1], baseUrl).toString(); if (SOCIAL.test(new URL(u).hostname)) links.add(u); } catch { /* ignore bad links */ } }
  let ldName: string | null = null;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      for (const node of Array.isArray(data) ? data : [data]) {
        if (typeof node?.name === 'string' && !ldName) ldName = node.name;
        for (const s of [].concat(node?.sameAs ?? [])) if (typeof s === 'string') links.add(s);
      }
    } catch { /* invalid JSON-LD is ignored */ }
  }
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? '';
  return { title, description: meta('og:description') ?? meta('description') ?? '', links: [...links].slice(0, 30), displayName: ldName ?? meta('og:title') ?? (title ? nameFromTitle(title) : null), location: null, language: pick(/<html[^>]+lang=["']([^"']+)["']/i) };
}

/** Reads public pages found by search, only where robots.txt allows it. Never social networks, logins or private addresses. */
export class PublicWebCrawler implements DiscoveryProvider {
  id = 'crawler'; label = 'Public web crawler'; kind = 'crawler' as const;
  private robotsCache = new Map<string, { text: string; at: number }>();
  private lastHit = new Map<string, number>();
  constructor(private opts: { allowPrivate?: boolean; maxBytes?: number; fetchFn?: Fetch } = {}) {}
  handles() { return false; }
  private async guard(host: string) {
    if (this.opts.allowPrivate) return;
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addrs.some(a => privateAddress(a.address))) throw new ProviderError(`Refusing to crawl a private address (${host})`, false);
  }
  private async robots(origin: string): Promise<string> {
    const c = this.robotsCache.get(origin);
    if (c && Date.now() - c.at < 3600000) return c.text;
    let text = '';
    try { const r = await (this.opts.fetchFn ?? fetch)(`${origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) }); if (r.ok) text = (await r.text()).slice(0, 100000); } catch { /* no robots.txt: allowed */ }
    this.robotsCache.set(origin, { text, at: Date.now() });
    return text;
  }
  async crawl(url: string): Promise<CrawlResult | null> {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || SOCIAL.test(u.hostname)) return null;   // platform terms: use their APIs, not scraping
    for (let hop = 0; hop < 4; hop++) {
      await this.guard(u.hostname);
      if (!robotsAllows(await this.robots(u.origin), u.pathname)) return { url, blocked: 'robots.txt disallows automated access to this page, so it was not crawled' };
      const wait = 1000 - (Date.now() - (this.lastHit.get(u.host) ?? 0));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastHit.set(u.host, Date.now());
      const res = await (this.opts.fetchFn ?? fetch)(u.toString(), { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(8000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location')!, u); if (!/^https?:$/.test(u.protocol) || SOCIAL.test(u.hostname)) return null; continue; }
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return null;
      const reader = res.body?.getReader();
      let html = '', size = 0;
      const max = this.opts.maxBytes ?? 1_500_000;
      if (reader) { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; html += dec.decode(value, { stream: true }); if (size > max) { await reader.cancel(); break; } } }
      return { url: u.toString(), blocked: null, ...extractPage(html, u.toString()) };
    }
    return null;
  }
}

/**
 * Usage limits from .env. Defaults keep well inside the free tiers:
 *   web search (Brave free: 1,000 requests/month, 1 per second) → 500 a month, 8 per artist, 1.1 s apart
 *   YouTube (10,000 units/day, a search costs 100)               → 500 a month, 50 a day, 3 per artist
 *   Spotify (no fixed quota, rate-limited per 30 s window)       → no monthly limit, 6 per artist, 0.25 s apart
 */
export function limitsFromEnv(env: NodeJS.ProcessEnv) {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : d; };
  const web: ProviderLimits = { perMonth: n(env.SEARCH_MONTHLY_LIMIT, 500), perDay: n(env.SEARCH_DAILY_LIMIT, 0), perArtist: n(env.SEARCH_QUERIES_PER_ARTIST, 8), minIntervalMs: n(env.SEARCH_MIN_INTERVAL_MS, 1100) };
  const youtube: ProviderLimits = { perMonth: n(env.YOUTUBE_MONTHLY_LIMIT, 500), perDay: n(env.YOUTUBE_DAILY_LIMIT, 50), perArtist: n(env.YOUTUBE_SEARCHES_PER_ARTIST, 3), minIntervalMs: n(env.YOUTUBE_MIN_INTERVAL_MS, 250) };
  const spotify: ProviderLimits = { perMonth: n(env.SPOTIFY_MONTHLY_LIMIT, 0), perDay: n(env.SPOTIFY_DAILY_LIMIT, 0), perArtist: n(env.SPOTIFY_SEARCHES_PER_ARTIST, 6), minIntervalMs: n(env.SPOTIFY_MIN_INTERVAL_MS, 250) };
  return { web, youtube, spotify };
}

/** Live providers for every credential in the environment; none configured → discovery is off (never invented results). */
export function serverProviders(getModel: () => Model, env: NodeJS.ProcessEnv = process.env): ProviderSet {
  const live: DiscoveryProvider[] = [];
  const limits = limitsFromEnv(env);
  const key = env.SEARCH_PROVIDER_API_KEY?.trim();
  const which = (env.SEARCH_PROVIDER ?? 'brave').toLowerCase();
  const limit = <P extends DiscoveryProvider>(p: P, l: ProviderLimits) => { p.limits = l; return p; };
  if (key && which === 'brave') live.push(limit(new BraveSearchProvider(key), limits.web));
  // Google's free tier is per day (100 queries): half of it unless SEARCH_DAILY_LIMIT says otherwise.
  if (key && which === 'google' && env.GOOGLE_CSE_ID) live.push(limit(new GoogleSearchProvider(key, env.GOOGLE_CSE_ID), env.SEARCH_DAILY_LIMIT === undefined ? { ...limits.web, perDay: 50 } : limits.web));
  if (env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET) live.push(limit(new SpotifyProvider(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET), limits.spotify));
  if (env.YOUTUBE_API_KEY) live.push(limit(new YouTubeProvider(env.YOUTUBE_API_KEY), limits.youtube));
  if (!live.length) return offProviderSet(getModel);
  if (env.CRAWLER_ENABLED !== '0') live.push(new PublicWebCrawler());
  return { mode: 'live', providers: [new InternalCatalogueProvider(getModel), ...live], notes: [`Live search with ${live.map(p => p.label).join(', ')}. Only public data and permitted APIs are used.`] };
}
export { normalizeProfileUrl };
