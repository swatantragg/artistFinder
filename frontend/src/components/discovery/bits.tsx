// Small discovery widgets shared by the dossier, the Artist Discovery page, the queue and import results.
import { Building2, ExternalLink, Globe, Loader2, Music2 } from 'lucide-react';
import { siApplemusic, siDeezer, siFacebook, siInstagram, siSoundcloud, siSpotify, siX, siYoutube } from 'simple-icons';
import { Badge, cx } from '../ui';
import { num } from '../../lib/format';

// Platform logos (Simple Icons, CC0) so a Spotify, YouTube or Instagram link is recognised at a glance. Brands without a
// Simple Icons mark get a note or globe in their colour; black marks (X) follow the text colour so they show in dark mode.
const BRAND: Record<string, { path: string; hex: string }> = {
  Spotify: siSpotify, YouTube: siYoutube, Instagram: siInstagram, Facebook: siFacebook, SoundCloud: siSoundcloud, X: siX, 'Apple Music': siApplemusic, Deezer: siDeezer,
};
const FALLBACK: Record<string, { Icon: typeof Globe; hex: string | null }> = {
  JioSaavn: { Icon: Music2, hex: '2BC5B4' }, Gaana: { Icon: Music2, hex: 'E72C30' }, Website: { Icon: Globe, hex: null }, 'Label website': { Icon: Building2, hex: null },
};
const SIZES = { sm: [24, 15], md: [32, 18], lg: [40, 22] } as const;
export function PlatformBadge({ platform, size = 'md' }: { platform: string; size?: 'sm' | 'md' | 'lg' }) {
  const [box, icon] = SIZES[size];
  const brand = BRAND[platform];
  const fb = FALLBACK[platform] ?? { Icon: Globe, hex: null };
  const hex = brand ? brand.hex : fb.hex;
  const color = !hex || hex === '000000' ? 'var(--text)' : `#${hex}`;
  return (
    <span role="img" aria-label={platform} title={platform} className="inline-flex shrink-0 items-center justify-center rounded-lg border"
      style={{ width: box, height: box, color, background: `color-mix(in srgb, ${color} 9%, var(--surface))`, borderColor: `color-mix(in srgb, ${color} 22%, var(--border))` }}>
      {brand ? <svg viewBox="0 0 24 24" width={icon} height={icon} fill="currentColor" aria-hidden="true"><path d={brand.path} /></svg> : <fb.Icon size={icon} aria-hidden="true" />}
    </span>
  );
}
/** Match % of a found profile: green from 80, blue from 50, orange below (shown only when nothing better was found). */
export function MatchPill({ score }: { score: number }) {
  const tone = score >= 80 ? 'green' : score >= 50 ? 'blue' : 'orange';
  return <Badge tone={tone} title="How well the profile matches the artist (name, handle, platform, songs). A person still decides.">{score}% match</Badge>;
}
const DISC_TONE: Record<string, 'neutral' | 'blue' | 'orange' | 'green' | 'red' | 'gold'> = { 'Not started': 'neutral', Queued: 'blue', Searching: 'blue', 'Needs verification': 'gold', Verified: 'green', 'No candidate': 'orange', Failed: 'red' };
export function DiscoveryChip({ status, extra }: { status: string; extra?: string }) {
  if (status === 'Not started') return <span className="whitespace-nowrap text-sm text-muted">Not started</span>;
  return (
    <Badge tone={DISC_TONE[status] ?? 'neutral'} dot>
      {(status === 'Searching' || status === 'Queued') && <Loader2 size={11} className="animate-spin" />}
      {status === 'No candidate' ? 'No profile found' : status}{extra ? ` ${extra}` : ''}
    </Badge>
  );
}


// ------------------------------------------------------------------ profile links
/** Opens the real profile in a new tab. */
export function ProfileLink({ url, label = 'Open profile', small }: { url: string; label?: string; small?: boolean }) {
  const cls = cx('inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface font-medium text-ink-2 hover:bg-hover', small ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm');
  return <a href={url} target="_blank" rel="noopener noreferrer" className={cls}>{label}<ExternalLink size={12} /></a>;
}
/** A readable handle (@name), or null when the platform's "username" is an internal ID (Spotify artist IDs, YouTube channel IDs). */
const NO_HANDLE = new Set(['Spotify', 'Apple Music', 'JioSaavn', 'Gaana', 'Deezer', 'Website', 'Label website']);
export const handleOf = (platform: string, username: string | null | undefined): string | null =>
  !username || NO_HANDLE.has(platform) || /^UC[\w-]{20,}$/.test(username) ? null : `@${username}`;

// ------------------------------------------------------------------ search budget (API usage limits from .env)
interface Usage { id: string; label: string; perArtist: number | null; remaining: number | null; month: { used: number; limit: number; resetsOn: string } | null; day: { used: number; limit: number; resetsOn: string } | null }
export interface DiscoveryConfigV { mode: string; notes: string[]; providers: { id: string; label: string; kind: string }[]; staleDays: number; perPersonDaily: number; running: number; blocked: string | null; usage: Usage[]; budget: { artists: number; exhausted: string | null } | null }
const pct = (used: number, limit: number) => Math.min(100, Math.round((used / limit) * 100));
/** Used / limit per search API, with a bar per period; `compact` puts everything on one line. */
export function SearchBudget({ cfg, compact }: { cfg: DiscoveryConfigV; compact?: boolean }) {
  if (!cfg.usage?.length) return null;
  const periods = (u: Usage) => [u.day && { name: 'today', ...u.day }, u.month && { name: 'this month', ...u.month }].filter(Boolean) as { name: string; used: number; limit: number; resetsOn: string }[];
  if (compact) return (
    <p className="text-xs text-muted tnum">
      Search limits: {cfg.usage.map(u => `${u.label} ${periods(u).map(p => `${num(p.used)}/${num(p.limit)} ${p.name}`).join(', ') || 'no limit'}`).join(' · ')}
      {cfg.budget && <> · <span className={cfg.budget.exhausted ? 'font-medium text-[var(--t-red)]' : 'text-ink-2'}>{cfg.budget.exhausted ? 'limit reached' : `room for about ${num(cfg.budget.artists)} more artist search${cfg.budget.artists === 1 ? '' : 'es'}`}</span></>}
    </p>
  );
  return (
    <ul className="space-y-2.5">
      {cfg.usage.map(u => (
        <li key={u.id} className="text-sm">
          <p className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-medium text-ink">{u.label}</span>{u.perArtist && <span className="text-xs text-muted">at most {u.perArtist} per artist</span>}</p>
          {periods(u).map(p => (
            <div key={p.name} className="mt-1">
              <div className="flex justify-between text-xs text-muted tnum"><span>{num(p.used)} / {num(p.limit)} {p.name}</span><span>resets {p.resetsOn}</span></div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-hover"><div className={cx('h-full rounded-full', p.used >= p.limit ? 'bg-[var(--t-red)]' : pct(p.used, p.limit) >= 80 ? 'bg-[var(--t-orange)]' : 'bg-[var(--t-green)]')} style={{ width: `${pct(p.used, p.limit)}%` }} /></div>
            </div>
          ))}
          {!periods(u).length && <p className="text-xs text-muted">No monthly or daily limit</p>}
        </li>
      ))}
      {cfg.budget && <li className={cx('text-xs', cfg.budget.exhausted ? 'font-medium text-[var(--t-red)]' : 'text-muted')}>{cfg.budget.exhausted ?? `Room for about ${num(cfg.budget.artists)} more complete artist search${cfg.budget.artists === 1 ? '' : 'es'} in this period.`}</li>}
    </ul>
  );
}
