// Usage limits for search APIs with free or paid quotas (e.g. Brave: 1,000 requests a month on the free plan).
// Every call is counted in the database before it is made, inside the engine's serialized write, so parallel jobs
// and restarts can never go over a limit. Cached answers cost nothing. A limit of 0 means "no limit".
import type { Model } from '../model';
import type { Ctx } from '../types';
import { addDays } from '../util';
import type { DiscoveryProvider } from './providers';

type Period = 'month' | 'day';
const periodKey = (period: Period, today: string) => (period === 'month' ? today.slice(0, 7) : today);
const metaKey = (id: string, period: Period, today: string) => `usage:${id}:${periodKey(period, today)}`;
const usedIn = (m: Model, id: string, period: Period, today: string) => Number(m.getMeta(metaKey(id, period, today)) ?? 0);
export const firstOfNextMonth = (today: string) => {
  const [y, mo] = today.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

const limited = (p: DiscoveryProvider) => !!p.limits && !!(p.limits.perMonth || p.limits.perDay);

/** Why this provider may not make another call now, or null. */
export function limitReached(m: Model, p: DiscoveryProvider, today: string): string | null {
  const l = p.limits;
  if (!l) return null;
  if (l.perMonth && usedIn(m, p.id, 'month', today) >= l.perMonth) return `${p.label}: monthly limit reached (${l.perMonth}/${l.perMonth}, resets ${short(firstOfNextMonth(today))})`;
  if (l.perDay && usedIn(m, p.id, 'day', today) >= l.perDay) return `${p.label}: daily limit reached (${l.perDay}/${l.perDay}, resets ${short(addDays(today, 1))})`;
  return null;
}

/** Counts one call before it is made. Returns why it is refused, or null when the call may go ahead. */
export function reserveCall(m: Model, p: DiscoveryProvider, today: string): string | null {
  const why = limitReached(m, p, today);
  if (why || !p.limits) return why;
  if (p.limits.perMonth) m.setMeta(metaKey(p.id, 'month', today), String(usedIn(m, p.id, 'month', today) + 1));
  if (p.limits.perDay) m.setMeta(metaKey(p.id, 'day', today), String(usedIn(m, p.id, 'day', today) + 1));
  return null;
}

/** Calls left today and this month (the smaller one counts), or null without a limit. */
function remaining(m: Model, p: DiscoveryProvider, today: string): number | null {
  const l = p.limits;
  if (!limited(p)) return null;
  const left = [l!.perMonth ? l!.perMonth - usedIn(m, p.id, 'month', today) : Infinity, l!.perDay ? l!.perDay - usedIn(m, p.id, 'day', today) : Infinity];
  return Math.max(0, Math.min(...left));
}

export interface UsageView {
  id: string; label: string; perArtist: number | null; minIntervalMs: number | null; remaining: number | null;
  month: { used: number; limit: number; resetsOn: string } | null;
  day: { used: number; limit: number; resetsOn: string } | null;
}
export function usageOf(m: Model, providers: DiscoveryProvider[], today: string): UsageView[] {
  return providers.filter(p => p.limits).map(p => ({
    id: p.id, label: p.label, perArtist: p.limits!.perArtist || null, minIntervalMs: p.limits!.minIntervalMs || null, remaining: remaining(m, p, today),
    month: p.limits!.perMonth ? { used: usedIn(m, p.id, 'month', today), limit: p.limits!.perMonth, resetsOn: firstOfNextMonth(today) } : null,
    day: p.limits!.perDay ? { used: usedIn(m, p.id, 'day', today), limit: p.limits!.perDay, resetsOn: addDays(today, 1) } : null,
  }));
}

/**
 * What the search budget still allows. Web search is the main source, so its limit decides (an API such as YouTube
 * only when there is no web search). `artists` = complete artist searches left; `exhausted` = why nothing can run.
 */
export function searchBudget(m: Model, providers: DiscoveryProvider[], today: string): NonNullable<Ctx['searchBudget']> | null {
  const search = providers.filter(p => p.kind === 'web' || p.kind === 'api');
  const primary = search.some(p => p.kind === 'web') ? search.filter(p => p.kind === 'web') : search;
  if (!primary.length || primary.some(p => !limited(p))) return null;
  const left = primary.map(p => ({ p, n: remaining(m, p, today)! }));
  const artists = Math.max(...left.map(({ p, n }) => Math.floor(n / Math.max(1, p.limits!.perArtist || 10))));
  const exhausted = left.every(x => x.n <= 0) ? `Search limit reached: ${left.map(({ p }) => limitReached(m, p, today)).join('; ')}. Nothing was searched; try again after the reset or raise the limit in .env.` : null;
  return { artists, exhausted };
}
