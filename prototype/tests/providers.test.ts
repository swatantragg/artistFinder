// Live provider adapters, tested without network access: mocked API responses and a local page server for the crawler.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Model } from '../src/domain/model';
import type { SearchRequest } from '../src/domain/discovery/queries';
import { BraveSearchProvider, GoogleSearchProvider, PublicWebCrawler, SpotifyProvider, YouTubeProvider, extractPage, robotsAllows, serverProviders } from '../src/server/providers';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
const req = (query: string, kind: SearchRequest['kind'] = 'name', extra: Partial<SearchRequest> = {}): SearchRequest => ({ query, kind, priority: 1, subject: 'artist', subjectName: 'Rahul Sharma', subjectKey: 'C0001', ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

console.log('Provider selection');
const getModel = () => new Model();
check('no keys → discovery off (never invented results)', serverProviders(getModel, {}).mode === 'off' && serverProviders(getModel, {}).providers.every(p => p.kind === 'internal'));
check('off says live search is not configured and how to fix it', serverProviders(getModel, {}).notes.some(n => /not configured/.test(n) && /SEARCH_PROVIDER_API_KEY/.test(n)));
const live = serverProviders(getModel, { SEARCH_PROVIDER_API_KEY: 'k', SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', YOUTUBE_API_KEY: 'y' });
check('keys → live mode with web, Spotify, YouTube and crawler', live.mode === 'live' && ['brave', 'spotify', 'youtube', 'crawler'].every(id => live.providers.some(p => p.id === id)));
check('one key is enough for live search (Spotify only)', serverProviders(getModel, { SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' }).mode === 'live');
const lim = (set: ReturnType<typeof serverProviders>, id: string) => set.providers.find(p => p.id === id)?.limits;
check('default limits: web search 500 a month, 8 per artist, 1.1 s apart', JSON.stringify(lim(live, 'brave')) === JSON.stringify({ perMonth: 500, perDay: 0, perArtist: 8, minIntervalMs: 1100 }), lim(live, 'brave'));
check('default limits: YouTube 500 a month, 50 a day, 3 per artist', lim(live, 'youtube')?.perMonth === 500 && lim(live, 'youtube')?.perDay === 50 && lim(live, 'youtube')?.perArtist === 3);
check('limits come from .env (0 = no limit)', lim(serverProviders(getModel, { SEARCH_PROVIDER_API_KEY: 'k', SEARCH_MONTHLY_LIMIT: '100', SEARCH_QUERIES_PER_ARTIST: '0' }), 'brave')?.perMonth === 100 && lim(serverProviders(getModel, { SEARCH_PROVIDER_API_KEY: 'k', SEARCH_QUERIES_PER_ARTIST: '0' }), 'brave')?.perArtist === 0);
check('Google free tier is per day: 50 a day unless set', lim(serverProviders(getModel, { SEARCH_PROVIDER: 'google', SEARCH_PROVIDER_API_KEY: 'k', GOOGLE_CSE_ID: 'cx' }), 'google-cse')?.perDay === 50);

console.log('\nWeb search APIs');
const brave = new BraveSearchProvider('key', (async (url: string, init: RequestInit) => {
  check('Brave: key sent in the header, query encoded', String(url).includes('q=%22Rahul%20Sharma%22%20site%3Ainstagram.com') && (init.headers as Record<string, string>)['X-Subscription-Token'] === 'key');
  return json({ web: { results: [{ url: 'https://www.instagram.com/rahulsharma.sings/', title: 'Rahul Sharma (@rahulsharma.sings) • Instagram', description: 'Singer. <strong>Dil Mera</strong> out now' }] } });
}) as typeof fetch);
const bh = await brave.search(req('"Rahul Sharma" site:instagram.com', 'site'));
check('Brave results become hits with platform and clean text', bh[0]?.platform === 'Instagram' && bh[0].snippet === 'Singer. Dil Mera out now' && bh[0].displayName === 'Rahul Sharma');
const google = new GoogleSearchProvider('key', 'cx', (async () => json({ items: [{ link: 'https://rahulsharma-music.example/', title: 'Rahul Sharma - Official', snippet: 'Hindi singer', pagemap: { metatags: [{ 'og:description': 'Hindi singer. Label: Nadaan Music Co.' }] } }] })) as typeof fetch);
const gh = await google.search(req('"Rahul Sharma"'));
check('Google CSE uses og:description when present', gh[0]?.description === 'Hindi singer. Label: Nadaan Music Co.' && gh[0].platform === 'Website');
let threw = '';
try { await new BraveSearchProvider('bad', (async () => json({}, 401)) as typeof fetch).search(req('"x"')); } catch (e) { threw = (e as Error).message; }
check('a bad key is reported clearly (not as "no results")', /401.*API key/.test(threw), threw);
let transient = false;
try { await new BraveSearchProvider('k', (async () => json({}, 503)) as typeof fetch).search(req('"x"')); } catch (e) { transient = (e as { transient?: boolean }).transient === true; }
check('server errors are retryable', transient);

console.log('\nSpotify and YouTube');
const calls: string[] = [];
const spotify = new SpotifyProvider('id', 'secret', (async (url: string) => {
  calls.push(String(url));
  if (String(url).includes('accounts.spotify.com')) return json({ access_token: 'tok', expires_in: 3600 });
  if (String(url).includes('type=track')) return json({ tracks: { items: [{ name: 'Dil Mera', external_ids: { isrc: 'INGAM2601001' }, artists: [{ id: 'a1', name: 'Rahul Sharma', external_urls: { spotify: 'https://open.spotify.com/artist/a1' } }] }] } });
  return json({ artists: { items: [{ id: 'a1', name: 'Rahul Sharma', followers: { total: 2100 }, genres: ['filmi'], external_urls: { spotify: 'https://open.spotify.com/artist/a1' } }] } });
}) as typeof fetch);
const sh = await spotify.search(req('"Rahul Sharma" singer', 'role'));
check('Spotify: one artist hit with tracks and ISRCs', sh.length === 1 && sh[0].tracks?.[0]?.isrc === 'INGAM2601001' && /2100 followers/.test(sh[0].snippet));
await spotify.search(req('"INGAM2601001"', 'isrc', { isrc: 'INGAM2601001' }));
check('Spotify ISRC search uses the isrc: filter, token reused', calls.some(c => c.includes('isrc%3AINGAM2601001')) && calls.filter(c => c.includes('accounts.spotify.com')).length === 1);
const yt = new YouTubeProvider('ykey', (async (url: string) => json(String(url).includes('type=video')
  ? { items: [{ snippet: { channelId: 'UC1', channelTitle: 'Rahul Sharma Music', title: 'Dil Mera (Official Audio)' } }, { snippet: { channelId: 'UC1', channelTitle: 'Rahul Sharma Music', title: 'Khwaab Tera' } }] }
  : { items: [{ id: { channelId: 'UC1' }, snippet: { channelId: 'UC1', title: 'Rahul Sharma Music', description: 'Official channel' } }] })) as typeof fetch);
const yv = await yt.search(req('"Rahul Sharma"', 'name'));
check('YouTube: the artist\'s channels only, never single videos', yv.length === 1 && yv[0].url === 'https://www.youtube.com/channel/UC1' && !yt.handles(req('"Rahul Sharma" "Dil Mera"', 'song')) && !yt.handles(req('"INGAM2601001"', 'isrc')));

console.log('\nCrawler');
check('robots.txt: disallowed path', !robotsAllows('User-agent: *\nDisallow: /artists', '/artists/rahul'));
check('robots.txt: allowed path', robotsAllows('User-agent: *\nDisallow: /private', '/artists/rahul'));
check('robots.txt: our own group wins, longest rule wins', robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: GAmplifyDiscoveryBot\nDisallow: /x\nAllow: /x/public', '/x/public/page'));
const page = extractPage(`<html lang="hi"><head><title>Rahul Sharma | Official</title><meta property="og:description" content="Hindi singer"><script type="application/ld+json">{"@type":"MusicGroup","name":"Rahul Sharma","sameAs":["https://www.instagram.com/rahulsharma.sings/","https://open.spotify.com/artist/a1"]}</script></head><body><a href="https://www.youtube.com/@rahulsharmamusic">YouTube</a><a href="/about">About</a></body></html>`, 'https://rahulsharma-music.example/');
check('page extraction: title, description, name, language and social links', page.title === 'Rahul Sharma | Official' && page.description === 'Hindi singer' && page.displayName === 'Rahul Sharma' && page.language === 'hi' && page.links!.length === 3);

const server = createServer((rq, rs) => {
  if (rq.url === '/robots.txt') { rs.end('User-agent: *\nDisallow: /blocked'); return; }
  if (rq.url === '/moved') { rs.writeHead(302, { location: '/artist' }); rs.end(); return; }
  if (rq.url === '/artist' || rq.url === '/blocked') { rs.writeHead(200, { 'content-type': 'text/html' }); rs.end('<title>Rahul Sharma</title><a href="https://www.instagram.com/rahulsharma.sings/">IG</a>'); return; }
  rs.writeHead(404); rs.end();
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const crawler = new PublicWebCrawler({ allowPrivate: true });
const ok = await crawler.crawl(`${base}/moved`);
check('crawler follows a redirect and reads links', ok?.blocked === null && ok.links?.[0] === 'https://www.instagram.com/rahulsharma.sings/' && ok.url.endsWith('/artist'));
const blocked = await crawler.crawl(`${base}/blocked`);
check('crawler respects robots.txt', !!blocked?.blocked && /robots\.txt/.test(blocked.blocked));
check('crawler never fetches social networks', (await crawler.crawl('https://www.instagram.com/rahulsharma.sings/')) === null);
let refused = '';
try { await new PublicWebCrawler().crawl(`${base}/artist`); } catch (e) { refused = (e as Error).message; }
check('crawler refuses private network addresses by default', /private address/.test(refused), refused);
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
