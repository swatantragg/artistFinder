// Discovery providers: one interface for web search, official music APIs, a compliant public-page crawler and internal data.
// Live providers live on the server (they need credentials). Without credentials discovery is off ('off' mode): it never
// invents results.
import type { Platform } from '../constants';
import type { Model } from '../model';
import type { ProfileTrack } from '../types';
import { nameKey } from '../util';
import { normalizeProfileUrl } from './normalize';
import type { SearchRequest } from './queries';

export interface ProviderHit {
  url: string;
  title: string;
  snippet: string;
  displayName?: string | null;
  username?: string | null;
  platform?: Platform;
  description?: string;
  location?: string | null;
  language?: string | null;
  links?: string[];
  tracks?: ProfileTrack[];
  followers?: number | null;
}
export interface CrawlResult { url: string; blocked: string | null; title?: string; description?: string; links?: string[]; displayName?: string | null; location?: string | null; language?: string | null; tracks?: ProfileTrack[] }
export interface SearchContext { jobId: string; caseId: string; version: number; attempt: number; bulk: boolean }

export type ProviderKind = 'web' | 'api' | 'crawler' | 'internal';
/** Usage limits for an API with a quota (0 or missing = no limit). Counted in the database, see budget.ts. */
export interface ProviderLimits {
  perMonth?: number;      // calls per calendar month
  perDay?: number;        // calls per day
  perArtist?: number;     // calls one artist search may use (the most useful queries first)
  minIntervalMs?: number; // spacing between two calls (e.g. Brave free plan: 1 request per second)
}
export interface DiscoveryProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  limits?: ProviderLimits;
  /** Which queries this provider can answer (an API only takes the queries it supports). */
  handles(q: SearchRequest): boolean;
  search?(q: SearchRequest, ctx: SearchContext): Promise<ProviderHit[]>;
  /** Crawler only: fetch one public page that automated access is allowed for. */
  crawl?(url: string, ctx: SearchContext): Promise<CrawlResult | null>;
}
/** 'live' = search providers are configured; 'off' = none are, so Find artist is switched off with the reason. */
export interface ProviderSet { mode: 'live' | 'off'; providers: DiscoveryProvider[]; notes: string[] }

/** A provider that cannot answer (outage, quota, credentials). Never means "artist not found". */
export class ProviderError extends Error {
  constructor(message: string, public transient = true) { super(message); }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Run tasks with a concurrency limit (cost and rate control). */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Existing internal knowledge: profile links already on file (e.g. from an artist directory import) and verified profiles. */
export class InternalCatalogueProvider implements DiscoveryProvider {
  id = 'internal';
  label = 'Internal catalogue';
  kind = 'internal' as const;
  constructor(private getModel: () => Model) {}
  handles(q: SearchRequest) { return q.kind === 'name' && q.subject === 'artist'; }
  /** Profile links already on file (e.g. from an artist directory import) that are not yet candidates. Verified profiles are reused, not re-found. */
  async search(q: SearchRequest): Promise<ProviderHit[]> {
    const m = this.getModel();
    const c = m.get('cases', q.subjectKey);
    if (!c) return [];
    const out: ProviderHit[] = [];
    for (const url of c.profileUrls) {
      const n = normalizeProfileUrl(url);
      if (!n || m.profileAt(c.id, null, n.normalized)) continue;
      out.push({ url: n.url, title: `${c.canonicalName} · link on file`, snippet: `Profile link already recorded on case ${c.id} (${c.backendProfileIds[0] ?? 'no artist ID'}), e.g. from an artist directory import.`, displayName: c.canonicalName, username: n.username, platform: n.platform });
    }
    const seen = new Set<string>();
    return out.filter(h => { const k = nameKey(h.url); if (seen.has(k)) return false; seen.add(k); return true; });
  }
}

/** Message shown wherever Find artist is unavailable because no live search provider is configured. */
export const NOT_CONFIGURED = 'Live search is not configured on the server. Add SEARCH_PROVIDER_API_KEY (Brave Search, or Google with GOOGLE_CSE_ID) and optionally SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and YOUTUBE_API_KEY to prototype/.env, then restart the API (npm run dev).';
/** No live provider: only internal knowledge, and Find artist says why it is off. */
export const offProviderSet = (getModel: () => Model): ProviderSet => ({ mode: 'off', providers: [new InternalCatalogueProvider(getModel)], notes: [NOT_CONFIGURED] });
