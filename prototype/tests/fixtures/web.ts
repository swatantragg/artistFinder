// Test fixtures: a small fictional "public web" built from the fictional fixture catalogue, plus providers that search it
// with real query matching, so the discovery pipeline can be tested offline (no API keys, no quota). Every page is invented.
// Used by the tests only; the app searches live providers.
import type { Platform } from '../../src/domain/constants';
import type { Model } from '../../src/domain/model';
import type { ProfileTrack } from '../../src/domain/types';
import { nameKey, rng } from '../../src/domain/util';
import { foldText, hasPhrase, normalizeProfileUrl } from '../../src/domain/discovery/normalize';
import { ProviderError, sleep, type CrawlResult, type DiscoveryProvider, type ProviderHit, type SearchContext } from '../../src/domain/discovery/providers';
import { parseQuery, type SearchRequest } from '../../src/domain/discovery/queries';
/** Ends a sentence without doubling a full stop ("Nadaan Music Co."). */
const end = (t: string) => (t.endsWith('.') ? t : `${t}.`);

export interface FixturePage {
  url: string;
  platform: Platform;
  displayName: string;
  username?: string | null;
  title: string;
  text: string;
  location?: string;
  language?: string;
  links?: string[];
  tracks?: ProfileTrack[];
  followers?: number;
  owner: string;                 // who the fictional page belongs to
  fromVersion?: number;          // the fictional web changes between search versions (profile change test)
  untilVersion?: number;
  robots?: 'disallow';           // the crawler must skip this page
}

interface CaseLite { caseId: string; artistId: string | null; name: string; role: string; language: string; label: string; distributor: string; songs: { title: string; isrc: string }[]; collaborators: string[] }
type Archetype = 'findable' | 'ambiguous' | 'partial' | 'stagename' | 'none';

const CITY: Record<string, string> = { Hindi: 'Mumbai', Punjabi: 'Amritsar', Bengali: 'Kolkata', Tamil: 'Chennai', Telugu: 'Hyderabad', Marathi: 'Pune', Malayalam: 'Kochi', Kannada: 'Bengaluru', Gujarati: 'Ahmedabad', Bhojpuri: 'Patna', Urdu: 'Lucknow' };
const OTHER_JOBS = ['Fitness coach', 'Software engineer', 'Chef', 'Travel photographer', 'Cricket coach', 'Real-estate agent'];
const ROLE_LABEL: Record<string, string> = { Singer: 'Singer', Performer: 'Performing artist', Composer: 'Composer', Lyricist: 'Lyricist', Producer: 'Music producer', Other: 'Musician' };
/** Fixture artists with a fixed outcome, so the walkthrough is predictable. */
const FORCED: Record<string, Archetype> = { A016: 'none', A040: 'none', A004: 'findable', A010: 'findable', A008: 'findable', A012: 'ambiguous', A002: 'findable', A214: 'findable', A018: 'findable', A027: 'findable', A009: 'partial', A005: 'findable', A024: 'findable' };

function hashOf(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const slugOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').trim().split(/\s+/).join('.');

// ------------------------------------------------------------------ hand-made pages for the walkthrough artists
function fixturesFor(c: CaseLite): FixturePage[] | null {
  const s = c.songs.map(x => x.title);
  const tracks = (n: number) => c.songs.slice(0, n).map(x => ({ title: x.title, isrc: x.isrc }));
  switch (c.artistId) {
    case 'A001': {
      const ig1 = 'https://www.instagram.com/rahulsharma.sings/', ig2 = 'https://www.instagram.com/rahulsharma.sings2/';
      const yt = 'https://www.youtube.com/@rahulsharmamusic', sp = 'https://open.spotify.com/artist/2DemoRahulSharmaA001';
      const fb = 'https://www.facebook.com/RahulSharmaOfficialPage', web = 'https://rahulsharma-music.example/';
      const owner = 'Rahul Sharma (A001), the singer in the fixture catalogue';
      const site = (links: string[], from?: number, until?: number): FixturePage => ({ url: web, platform: 'Website', displayName: 'Rahul Sharma', title: 'Rahul Sharma · Official website', text: `Hindi singer. Songs: ${s[0]}, ${s[3]}, Dil Ka Safar (produced by Joshua Singh). Label: ${end(c.label)} Distribution: ${end(c.distributor)}`, links, language: 'Hindi', location: 'Mumbai', owner, fromVersion: from, untilVersion: until });
      return [
        { url: ig1, platform: 'Instagram', displayName: 'Rahul Sharma', username: 'rahulsharma.sings', title: 'Rahul Sharma (@rahulsharma.sings) · Instagram', text: `Singer. “${s[0]}” and “${s[1]}” out now on ${end(c.label)} Lyrics with Amit Kumar. Bookings through the website.`, location: 'Mumbai', language: 'Hindi', links: [web, yt], followers: 18400, owner, untilVersion: 1 },
        { url: ig2, platform: 'Instagram', displayName: 'Rahul Sharma', username: 'rahulsharma.sings2', title: 'Rahul Sharma (@rahulsharma.sings2) · Instagram', text: `New account, previously @rahulsharma.sings. Singer. “Dil Ka Safar” out now on ${end(c.label)}`, location: 'Mumbai', language: 'Hindi', links: [web], followers: 2100, owner: `${owner} (simulated account change)`, fromVersion: 2 },
        { url: yt, platform: 'YouTube', displayName: 'Rahul Sharma Music', username: 'rahulsharmamusic', title: 'Rahul Sharma Music · YouTube', text: `Official audio uploads. “${s[0]}” (Official Audio).`, tracks: [{ title: `${s[0]} (Official Audio)` }], language: 'Hindi', owner },
        { url: sp, platform: 'Spotify', displayName: 'Rahul Sharma', title: 'Rahul Sharma · Spotify', text: 'Artist · 2.1K monthly listeners', tracks: tracks(4), language: 'Hindi', owner },
        { url: fb, platform: 'Facebook', displayName: 'Rahul Sharma Official', username: 'rahulsharmaofficialpage', title: 'Rahul Sharma Official · Facebook', text: `Musician. ${c.label} artist. New music soon.`, location: 'Delhi', owner },
        site([ig1, yt, sp, fb], undefined, 1),
        site([ig2, yt, sp, fb], 2),
        { url: 'https://nadaan-music.example/artists/rahul-sharma', platform: 'Label website', displayName: 'Rahul Sharma', title: `Rahul Sharma · ${c.label} artists`, text: `${c.label} roster: Rahul Sharma, singer. Releases: ${s[0]}, ${s[1]}.`, links: [ig1], owner: `${c.label} (fictional label site)`, robots: 'disallow' },
      ];
    }
    case 'A099': {
      const sp = 'https://open.spotify.com/artist/2DemoDJRahulSharmaA099';
      const owner = 'Rahul Sharma (A099), a different DJ with the same name';
      return [
        { url: 'https://www.instagram.com/djrahulsharma/', platform: 'Instagram', displayName: 'DJ Rahul Sharma', username: 'djrahulsharma', title: 'DJ Rahul Sharma (@djrahulsharma) · Instagram', text: `DJ & producer from Ludhiana. “${s[0]}” out now on ${end(c.label)}`, location: 'Ludhiana', language: 'Punjabi', links: [sp], followers: 9200, owner },
        { url: sp, platform: 'Spotify', displayName: 'DJ Rahul Sharma', title: 'DJ Rahul Sharma · Spotify', text: 'Artist · 4.8K monthly listeners', tracks: tracks(3), language: 'Punjabi', owner },
      ];
    }
    case 'A030': {
      const ig = 'https://www.instagram.com/joshuasingh.music/', web = 'https://joshuasingh-music.example/';
      const owner = 'Joshua Singh (A030), composer and producer';
      return [
        { url: ig, platform: 'Instagram', displayName: 'Joshua Singh', username: 'joshuasingh.music', title: 'Joshua Singh (@joshuasingh.music) · Instagram', text: `Composer & producer. Produced “Dil Ka Safar” for Rahul Sharma; “Dil Ka Safar 2” coming soon. Composer for Neha Verma. ${end(c.label)}`, location: 'Mumbai', language: 'Hindi', links: [web], followers: 6400, owner },
        { url: web, platform: 'Website', displayName: 'Joshua Singh', title: 'Joshua Singh · composer and producer', text: 'Credits: Dil Ka Safar (Rahul Sharma), Neha Verma singles. Composer and producer. Bookings through his manager.', links: [ig], language: 'Hindi', location: 'Mumbai', owner },
      ];
    }
    case 'A003':
      return [{ url: 'https://www.instagram.com/amitkumar.lyrics/', platform: 'Instagram', displayName: 'Amit Kumar | Lyricist', username: 'amitkumar.lyrics', title: 'Amit Kumar | Lyricist (@amitkumar.lyrics) · Instagram', text: `Lyricist. Words for Rahul Sharma’s “Dil Mera” and “Pehli Udaan”. ${end(c.label)}`, location: 'Mumbai', language: 'Hindi', followers: 1200, owner: 'Amit Kumar (A003), lyricist' }];
    default: return null;
  }
}
/** Same-name people who are not in the catalogue at all (the reason names alone never decide identity). */
const NAMESAKES: Record<string, FixturePage[]> = {
  'rahul sharma': [
    { url: 'https://www.instagram.com/rahulsharma.official/', platform: 'Instagram', displayName: 'Rahul Sharma', username: 'rahulsharma.official', title: 'Rahul Sharma (@rahulsharma.official) · Instagram', text: 'Actor & model. Films, fitness and travel. Delhi.', location: 'Delhi', language: 'Hindi', followers: 51000, owner: 'An actor called Rahul Sharma (not in the catalogue)' },
    { url: 'https://www.youtube.com/@rahulsharmavlogs', platform: 'YouTube', displayName: 'Rahul Sharma Vlogs', username: 'rahulsharmavlogs', title: 'Rahul Sharma Vlogs · YouTube', text: 'Travel vlogger. New videos every Sunday from the mountains.', language: 'Hindi', owner: 'A travel vlogger called Rahul Sharma (not in the catalogue)' },
  ],
  'amit kumar': [
    { url: 'https://www.instagram.com/amitkumar.photography/', platform: 'Instagram', displayName: 'Amit Kumar Photography', username: 'amitkumar.photography', title: 'Amit Kumar Photography · Instagram', text: 'Wedding and travel photographer. Pune.', location: 'Pune', owner: 'A photographer called Amit Kumar (not in the catalogue)' },
  ],
};

function generatedFor(c: CaseLite): FixturePage[] {
  const r = rng(hashOf(c.artistId ?? c.caseId));
  const roll = r();
  const arche: Archetype = (c.artistId && FORCED[c.artistId]) || (roll < 0.45 ? 'findable' : roll < 0.6 ? 'ambiguous' : roll < 0.75 ? 'partial' : roll < 0.8 ? 'stagename' : 'none');
  if (arche === 'none' || !c.songs.length) return [];
  const slug = slugOf(c.name), flat = slug.replace(/\./g, '');
  const city = CITY[c.language] ?? 'Mumbai';
  const role = ROLE_LABEL[c.role] ?? 'Musician';
  const s = c.songs;
  const owner = `${c.name} (${c.artistId ?? c.caseId}) in the fixture catalogue`;
  const ig = `https://www.instagram.com/${slug}.music/`, sp = `https://open.spotify.com/artist/2Demo${flat}${c.artistId ?? ''}`, yt = `https://www.youtube.com/@${flat}music`;
  const withYoutube = r() < 0.5;
  const findable: FixturePage[] = [
    { url: ig, platform: 'Instagram', displayName: c.name, username: `${slug}.music`, title: `${c.name} (@${slug}.music) · Instagram`, text: `${role} · “${s[0].title}”${s[1] ? ` & “${s[1].title}”` : ''} out now · ${c.label}`, location: city, language: c.language, links: withYoutube ? [sp, yt] : [sp], followers: 300 + Math.floor(r() * 20000), owner },
    { url: sp, platform: 'Spotify', displayName: c.name, title: `${c.name} · Spotify`, text: `Artist · ${Math.ceil(r() * 9)}.${Math.floor(r() * 9)}K monthly listeners`, tracks: s.slice(0, 3).map(x => ({ title: x.title, isrc: x.isrc })), language: c.language, owner },
    ...(withYoutube ? [{ url: yt, platform: 'YouTube' as Platform, displayName: c.name, username: `${flat}music`, title: `${c.name} · YouTube`, text: `Official channel. “${s[0].title}” (Official Video).`, tracks: [{ title: `${s[0].title} (Official Video)` }], language: c.language, owner }] : []),
  ];
  switch (arche) {
    case 'findable': return findable;
    case 'ambiguous': return [...findable, { url: `https://www.instagram.com/${slug}/`, platform: 'Instagram', displayName: c.name, username: slug, title: `${c.name} (@${slug}) · Instagram`, text: `${OTHER_JOBS[Math.floor(r() * OTHER_JOBS.length)]}. ${Object.values(CITY)[Math.floor(r() * 11)]}.`, owner: `Someone else called ${c.name} (not in the catalogue)` }];
    case 'partial': return [{ url: `https://www.instagram.com/${slug}.official/`, platform: 'Instagram', displayName: c.name, username: `${slug}.official`, title: `${c.name} (@${slug}.official) · Instagram`, text: `${role} | ${c.language} music | DM for collaborations`, location: city, language: c.language, owner }];
    case 'stagename': { const first = c.name.split(' ')[0]; return [{ url: `https://www.instagram.com/${first.toLowerCase()}beats.music/`, platform: 'Instagram', displayName: `${first} Beats`, username: `${first.toLowerCase()}beats.music`, title: `${first} Beats · Instagram`, text: `“${s[0].title}” out now · ${c.label} · ${city}`, location: city, language: c.language, owner: `${owner} (stage name)` }]; }
    default: return [];
  }
}

// ------------------------------------------------------------------ the fictional web
export class FixtureWeb {
  private pagesByCase = new Map<string, FixturePage[]>();
  private byUrl = new Map<string, FixturePage[]>();
  private isrcIndex = new Map<string, string>();
  private titleIndex = new Map<string, string[]>();
  private indexedTracks = -1;
  constructor(private m: Model) {
    for (const list of Object.values(NAMESAKES)) for (const p of list) this.register(p);
  }
  private register(p: FixturePage) {
    const n = normalizeProfileUrl(p.url)!.normalized;
    const list = this.byUrl.get(n) ?? [];
    if (!list.includes(p)) list.push(p);
    this.byUrl.set(n, list);
  }
  private lite(caseId: string): CaseLite | null {
    const m = this.m, c = m.get('cases', caseId);
    if (!c) return null;
    const tracks = m.trackIdsOfCase(caseId).map(id => m.get('tracks', id)!).filter(Boolean).sort((a, b) => a.backendTrackId.localeCompare(b.backendTrackId, undefined, { numeric: true }));
    const mine = m.creditsOfCase(caseId).filter(cr => cr.status === 'Active');
    return {
      caseId, artistId: c.backendProfileIds[0] ?? null, name: c.canonicalName, role: mine.find(cr => cr.isPrimary)?.role ?? mine[0]?.role ?? 'Singer', language: c.language ?? tracks[0]?.language ?? 'Hindi',
      label: tracks[0]?.label ?? '', distributor: tracks[0]?.distributor ?? '', songs: tracks.map(t => ({ title: t.title, isrc: t.isrc })), collaborators: [],
    };
  }
  pagesFor(caseId: string): FixturePage[] {
    const hit = this.pagesByCase.get(caseId);
    if (hit) return hit;
    const c = this.lite(caseId);
    const pages = c ? fixturesFor(c) ?? generatedFor(c) : [];
    this.pagesByCase.set(caseId, pages);
    for (const p of pages) this.register(p);
    return pages;
  }
  private indexTracks() {
    if (this.indexedTracks === this.m.count('tracks')) return;
    this.isrcIndex.clear(); this.titleIndex.clear();
    for (const t of this.m.data.tracks.values()) {
      if (t.isrc) this.isrcIndex.set(t.isrc.toUpperCase(), t.id);
      const k = nameKey(t.title);
      const l = this.titleIndex.get(k) ?? []; l.push(t.id); this.titleIndex.set(k, l);
    }
    this.indexedTracks = this.m.count('tracks');
  }
  /** Pages that could answer a query: everyone named in it, the people on any song or ISRC in it, and known namesakes. */
  private candidates(phrases: string[]): FixturePage[] {
    this.indexTracks();
    const caseIds = new Set<string>();
    const extra: FixturePage[] = [];
    for (const ph of phrases) {
      for (const c of this.m.casesNamed(ph)) caseIds.add(c.id);
      const stage = /^dj\s+(.+)$/i.exec(ph)?.[1];
      if (stage) for (const c of this.m.casesNamed(stage)) caseIds.add(c.id);
      extra.push(...(NAMESAKES[nameKey(ph)] ?? []));
      const tid = this.isrcIndex.get(ph.toUpperCase());
      for (const t of [...(tid ? [tid] : []), ...(this.titleIndex.get(nameKey(ph)) ?? [])]) for (const cr of this.m.creditsOfTrack(t)) if (cr.caseId) caseIds.add(this.m.canonical(cr.caseId));
    }
    const out = new Set<FixturePage>(extra);
    for (const id of caseIds) for (const p of this.pagesFor(id)) out.add(p);
    return [...out];
  }
  search(query: string, opts: { version: number; platforms?: Platform[]; limit?: number }): FixturePage[] {
    const { phrases, site, words } = parseQuery(query);
    const wanted = new Set<Platform>();
    for (const w of words) { const p = ({ instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook', spotify: 'Spotify', soundcloud: 'SoundCloud' } as Record<string, Platform>)[w.toLowerCase()]; if (p) wanted.add(p); }
    const scored: { p: FixturePage; score: number }[] = [];
    for (const p of this.candidates(phrases)) {
      if ((p.fromVersion ?? 1) > opts.version || (p.untilVersion ?? Infinity) < opts.version) continue;
      if (opts.platforms && !opts.platforms.includes(p.platform)) continue;
      if (site && !normalizeProfileUrl(p.url)!.host.endsWith(site.replace(/^www\./, ''))) continue;
      if (wanted.size && !wanted.has(p.platform)) continue;
      const hay = foldText([p.title, p.displayName, p.username, p.text, p.location, ...(p.tracks ?? []).map(t => `${t.title} ${t.isrc ?? ''}`)].join(' '));
      if (!phrases.every(ph => hasPhrase(hay, ph))) continue;
      const loose = words.filter(w => !/^(instagram|youtube|facebook|spotify|soundcloud)$/i.test(w) && hasPhrase(hay, w)).length;
      scored.push({ p, score: phrases.length * 10 + loose * 2 + (hasPhrase(foldText(p.displayName), phrases[0] ?? '') ? 5 : 0) });
    }
    return scored.sort((a, b) => b.score - a.score || a.p.url.localeCompare(b.p.url)).slice(0, opts.limit ?? 6).map(x => x.p);
  }
  page(url: string, version: number): FixturePage | null {
    const n = normalizeProfileUrl(url);
    const list = n ? this.byUrl.get(n.normalized) ?? [] : [];
    return list.find(p => (p.fromVersion ?? 1) <= version && (p.untilVersion ?? Infinity) >= version) ?? null;
  }
}

// ------------------------------------------------------------------ fixture providers
const webs = new WeakMap<Model, FixtureWeb>();
export function fixtureWebFor(m: Model): FixtureWeb { let w = webs.get(m); if (!w) { w = new FixtureWeb(m); webs.set(m, w); } return w; }

function toHit(p: FixturePage, withTracks: boolean): ProviderHit {
  const n = normalizeProfileUrl(p.url)!;
  return {
    url: n.url, title: p.title, snippet: p.text.length > 160 ? `${p.text.slice(0, 157)}…` : p.text, displayName: p.displayName, username: p.username ?? n.username, platform: p.platform,
    description: p.text, location: p.location ?? null, language: p.language ?? null, links: p.links ?? [], tracks: withTracks ? p.tracks ?? [] : [], followers: p.followers ?? null,
  };
}
abstract class FixtureProvider implements DiscoveryProvider {
  abstract id: string; abstract label: string; abstract kind: 'web' | 'api' | 'crawler';
  constructor(protected getModel: () => Model, protected latency: (bulk: boolean, key: string) => number) {}
  abstract handles(q: SearchRequest): boolean;
  protected async gate(ctx: SearchContext, key: string) {
    await sleep(this.latency(ctx.bulk, key));
    if (this.getModel().getMeta('fixtures.outage') === 'on') throw new ProviderError(`${this.label} unavailable (simulated outage)`);
    if (ctx.bulk && ctx.attempt === 1 && hashOf(ctx.caseId) % 29 === 0) throw new ProviderError(`${this.label} timed out (simulated network failure)`);
  }
  protected web() { return fixtureWebFor(this.getModel()); }
}
export class FixtureWebSearchProvider extends FixtureProvider {
  id = 'fixture-web'; label = 'Web search (test fixtures)'; kind = 'web' as const;
  handles(q: SearchRequest) { return q.kind !== 'isrc'; }
  async search(q: SearchRequest, ctx: SearchContext) { await this.gate(ctx, q.query); return this.web().search(q.query, { version: ctx.version }).map(p => toHit(p, false)); }
}
export class FixtureSpotifyProvider extends FixtureProvider {
  id = 'fixture-spotify'; label = 'Spotify API (test fixtures)'; kind = 'api' as const;
  handles(q: SearchRequest) { return ['name', 'alias', 'isrc'].includes(q.kind); }
  async search(q: SearchRequest, ctx: SearchContext) {
    await this.gate(ctx, `sp${q.query}`);
    const text = q.kind === 'role' || q.kind === 'collaborator' ? q.query.replace(/\s+(singer|composer|lyricist|producer|artist|music)$/i, '') : q.query.replace(/\s+Spotify$/i, '');
    return this.web().search(text, { version: ctx.version, platforms: ['Spotify'], limit: 4 }).map(p => toHit(p, true));
  }
}
export class FixtureYouTubeProvider extends FixtureProvider {
  id = 'fixture-youtube'; label = 'YouTube API (test fixtures)'; kind = 'api' as const;
  handles(q: SearchRequest) { return q.kind === 'name' || q.kind === 'alias'; }
  async search(q: SearchRequest, ctx: SearchContext) {
    await this.gate(ctx, `yt${q.query}`);
    return this.web().search(q.query.replace(/\s+(YouTube|site:youtube\.com)$/i, ''), { version: ctx.version, platforms: ['YouTube'], limit: 4 }).map(p => toHit(p, true));
  }
}
export class FixtureCrawler extends FixtureProvider {
  id = 'fixture-crawler'; label = 'Public web crawler (test fixtures)'; kind = 'crawler' as const;
  handles() { return false; }
  async crawl(url: string, ctx: SearchContext): Promise<CrawlResult | null> {
    await sleep(this.latency(ctx.bulk, url));
    const p = this.web().page(url, ctx.version);
    if (!p || (p.platform !== 'Website' && p.platform !== 'Label website')) return null;
    if (p.robots === 'disallow') return { url, blocked: 'robots.txt disallows automated access to this page, so it was not crawled' };
    return { url, blocked: null, title: p.title, description: p.text, links: p.links ?? [], displayName: p.displayName, location: p.location ?? null, language: p.language ?? null, tracks: p.tracks ?? [] };
  }
}

export function fixtureProviders(getModel: () => Model, opts: { slow?: boolean } = {}): DiscoveryProvider[] {
  const latency = (bulk: boolean, key: string) => (opts.slow === false ? 0 : bulk ? 2 : 50 + (hashOf(key) % 70));
  return [new FixtureWebSearchProvider(getModel, latency), new FixtureSpotifyProvider(getModel, latency), new FixtureYouTubeProvider(getModel, latency), new FixtureCrawler(getModel, latency)];
}
