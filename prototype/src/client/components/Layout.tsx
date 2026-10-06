// App shell: sidebar navigation, top bar (global search, notifications, acting user) and toasts.
import {
  Activity, BadgeCheck, Bell, CheckCircle2, ChevronDown, CopyCheck, FileUp, LayoutDashboard, Loader2, Menu as MenuIcon, Search, Settings, Users, X, XCircle, Info,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useApp, useDebounced, useQuery } from '../lib/app';
import { fmtAgo, num } from '../lib/format';
import { VERSION } from '../lib/version';
import { Avatar, Badge, cx } from './ui';
import { WhatsNew, showWhatsNew } from './WhatsNew';

type BadgeKey = 'needsReview' | 'dedupe' | 'goongoonaloPending' | 'exceptions';
/** Five places, all organised around the artist (v2 §10). Tasks, routes, claims and activation live inside each artist. */
const NAV: { to: string; label: string; icon: ReactNode; badge?: BadgeKey; hint: string }[] = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={18} />, hint: 'Overview and your next actions' },
  { to: '/artists', label: 'Artists', icon: <Users size={18} />, badge: 'needsReview', hint: 'Every artist: find, verify, review' },
  { to: '/deduplicate', label: 'Deduplicate', icon: <CopyCheck size={18} />, badge: 'dedupe', hint: 'Possible duplicate artists' },
  { to: '/verified', label: 'Verified Artists', icon: <BadgeCheck size={18} />, badge: 'goongoonaloPending', hint: 'Verified artists and their Goongoonalo status' },
  { to: '/imports', label: 'Imports', icon: <FileUp size={18} />, badge: 'exceptions', hint: 'Upload exports, see what changed' },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { meta } = useApp();
  return (
    <nav className="flex h-full flex-col border-r border-nav-line bg-nav text-nav-text">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-3 px-4 pb-5 pt-4">
        <span className="brand-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold shadow-[0_4px_14px_-4px_rgb(137_44_220/0.7)]">AF</span>
        <span className="min-w-0 leading-tight">
          <span className="block text-base font-semibold text-white">ArtistFinder</span>
          <span className="block truncate text-2xs text-nav-muted">Goongoonalo · G Amplify</span>
        </span>
      </Link>
      <div className="scroll-thin flex-1 overflow-y-auto px-2.5">
        <ul className="space-y-1">{NAV.map(n => <NavItem key={n.to} n={n} onNavigate={onNavigate} />)}</ul>
        <p className="px-3 pt-6 text-2xs leading-snug text-nav-muted">Upload a file → open an artist → <b className="font-medium text-lavender">Find artist</b> → verify. The software remembers.</p>
      </div>
      <div className="border-t border-white/10 px-2.5 py-2.5">
        <NavLink to="/settings" onClick={onNavigate} className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-nav-active font-medium text-white' : 'hover:bg-nav-2 hover:text-white')}>
          <Settings size={18} className="opacity-80" />Settings
        </NavLink>
        <p className="px-3 pt-2 text-2xs leading-snug text-nav-muted">Saved in PostgreSQL · {meta?.discoveryBlocked ? 'Find artist is off' : 'live artist search'}</p>
      </div>
    </nav>
  );
}

function NavItem({ n, onNavigate }: { n: (typeof NAV)[number]; onNavigate?: () => void }) {
  const { meta } = useApp();
  const count = n.badge ? meta?.badges[n.badge] ?? 0 : 0;
  const searching = n.to === '/artists' && (meta?.badges.searching ?? 0) > 0;
  return (
    <li title={n.hint}>
      <NavLink to={n.to} end={n.to === '/'} onClick={onNavigate}
        className={({ isActive }) => cx('relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-nav-active font-medium text-white before:absolute before:-left-2.5 before:top-2 before:bottom-2 before:w-1 before:rounded-r before:bg-lavender' : 'text-nav-text hover:bg-nav-2 hover:text-white')}>
        <span className="opacity-85">{n.icon}</span>
        <span className="flex-1">{n.label}</span>
        {searching && <Loader2 size={14} className="animate-spin text-lavender" aria-label="Searching" />}
        {count > 0 && <span className={cx('min-w-6 rounded-full px-1.5 text-center text-2xs font-semibold tnum', n.badge === 'needsReview' || n.badge === 'dedupe' ? 'bg-lavender text-black' : 'bg-white/10 text-nav-text')}>{num(count)}</span>}
      </NavLink>
    </li>
  );
}

/** Discovery runs in the background: poll its status, toast when a search finishes, refresh the screens. */
function JobWatcher() {
  const { toast, refresh, meta } = useApp();
  const [fast, setFast] = useState(false);
  const { data } = useQuery<{ active: number; recent: { jobId: string; text: string; status: string }[] }>('discoveryStatus', {}, { poll: fast ? 1500 : 12000 });
  const seen = useRef<Set<string> | null>(null);
  const wasActive = useRef(0);
  useEffect(() => { setFast((data?.active ?? 0) > 0 || (meta?.badges.searching ?? 0) > 0); }, [data?.active, meta?.badges.searching]);
  useEffect(() => {
    if (!data) return;
    if (!seen.current) { seen.current = new Set(data.recent.map(r => r.jobId)); wasActive.current = data.active; return; }
    let changed = false;
    for (const r of data.recent) if (!seen.current.has(r.jobId)) { seen.current.add(r.jobId); toast(r.text, r.status === 'FAILED' ? 'error' : 'info'); changed = true; }
    if (wasActive.current > 0 && data.active === 0) changed = true;
    wasActive.current = data.active;
    if (changed) refresh();
  }, [data, toast, refresh]);
  if (!data?.active) return null;
  return <Link to="/artists?status=SEARCHING" className="mr-1 hidden items-center gap-1.5 rounded-full border border-[var(--t-blue-bd)] px-3 py-1 text-xs text-[var(--t-blue)] sm:inline-flex"><Loader2 size={13} className="animate-spin" />Searching {data.active}</Link>;
}

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const dq = useDebounced(q.trim(), 200);
  const { data } = useQuery<{ type: string; id: string; caseId: string | null; label: string; sub: string }[]>(dq.length >= 2 ? 'search' : null, { q: dq });
  const ref = useRef<HTMLInputElement>(null);
  const results = dq.length >= 2 ? data ?? [] : [];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName))) { e.preventDefault(); ref.current?.focus(); setOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setSel(0), [dq]);
  const go = (r: (typeof results)[number]) => {
    setOpen(false); setQ(''); ref.current?.blur();
    if (r.type === 'Contact' && !r.caseId) navigate('/routes?tab=contacts');
    else if (r.caseId) navigate(`/artists/${r.caseId}${r.type === 'Song' ? '?tab=songs' : r.type === 'Route' ? '?tab=routes' : ''}`);
  };
  return (
    <div className="relative min-w-0 flex-1 md:max-w-[560px]">
      <Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
      <input ref={ref} value={q} onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(results.length - 1, s + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
          if (e.key === 'Enter' && results[sel]) go(results[sel]);
          if (e.key === 'Escape') { setOpen(false); ref.current?.blur(); }
        }}
        placeholder="Search artist, artist ID, song, ISRC, contact, task…" aria-label="Global search"
        className="h-10 w-full rounded-lg border border-line bg-surface-2 pl-10 pr-3 text-sm text-ink placeholder:text-faint focus:border-[var(--focus)] focus:bg-surface focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_22%,transparent)] focus:outline-none sm:pr-16" />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-surface px-1.5 font-sans text-2xs text-faint sm:block">Ctrl K</kbd>
      {open && dq.length >= 2 && (
        <div className="fadein scroll-thin absolute left-0 right-0 top-12 z-40 max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-lg)]">
          {!data && <p className="px-3 py-2 text-sm text-muted">Searching…</p>}
          {data && !results.length && <p className="px-3 py-2 text-sm text-muted">No artist, song, contact, task or route matches “{dq}”.</p>}
          {results.map((r, i) => (
            <button key={r.type + r.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => go(r)} onMouseEnter={() => setSel(i)}
              className={cx('flex w-full items-center gap-3 px-3 py-2 text-left', i === sel && 'bg-hover')}>
              <Badge tone={r.type === 'Artist' ? 'violet' : r.type === 'Song' ? 'blue' : r.type === 'Task' ? 'gold' : 'neutral'} className="w-[72px] shrink-0 justify-center">{r.type}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{r.label}</span>
                <span className="block truncate text-xs text-muted">{r.sub}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { meta, run } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { data } = useQuery<{ unread: number; items: { id: string; type: string; text: string; caseId: string | null; at: string; read: boolean }[] }>(open ? 'notifications' : null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const unread = meta?.badges.notifications ?? 0;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={`Notifications (${unread} unread)`} onClick={() => setOpen(o => !o)} className="relative inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink">
        <Bell size={19} />
        {unread > 0 && <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-accent px-1 text-3xs font-semibold leading-[18px] text-accent-ink">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="fadein z-40 rounded-xl border border-line bg-surface shadow-[var(--shadow-lg)] max-sm:fixed max-sm:inset-x-3 max-sm:top-[4.25rem] sm:absolute sm:right-0 sm:top-12 sm:w-[400px]">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-sm font-semibold">Alerts</span>
            {unread > 0 && <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => run('markNotificationsRead', {}, { quiet: true })}>Mark all read</button>}
          </div>
          <ul className="scroll-thin max-h-[60vh] overflow-y-auto">
            {!data && <li className="px-4 py-3 text-sm text-muted">Loading…</li>}
            {data && !data.items.length && <li className="px-4 py-6 text-center text-sm text-muted">No alerts yet.</li>}
            {data?.items.map(n => (
              <li key={n.id}>
                <button type="button" onClick={() => { setOpen(false); if (!n.read) run('markNotificationsRead', { ids: [n.id] }, { quiet: true }); if (n.caseId) navigate(`/artists/${n.caseId}`); else if (n.type === 'Import') navigate('/imports'); else if (n.type === 'Identity conflict') navigate('/deduplicate'); }}
                  className={cx('flex w-full gap-2.5 border-b border-line px-4 py-3 text-left last:border-0 hover:bg-hover', !n.read && 'bg-accent-soft/50')}>
                  <span className={cx('mt-2 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-accent-strong')} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-muted">{n.type} · {fmtAgo(n.at)}</span>
                    <span className="block text-sm text-ink">{n.text}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { meta, userId, setUserId, toast } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const me = meta?.me;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-hover">
        <Avatar name={me?.name ?? '?'} size={32} />
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-sm font-medium text-ink">{me?.name ?? '…'}</span>
          <span className="block text-2xs text-muted">{me?.role}</span>
        </span>
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <div className="fadein absolute right-0 top-12 z-40 w-[290px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-lg)]">
          <p className="px-3 pb-1 pt-1.5 text-xs text-muted">Act as (prototype role switch, no passwords)</p>
          {meta?.users.filter(u => u.role !== 'Automation').map(u => (
            <button key={u.id} type="button" onClick={() => { setUserId(u.id); setOpen(false); toast(`Now acting as ${u.name} (${u.role}).`, 'info'); }}
              className={cx('flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-hover', u.id === userId && 'bg-hover')}>
              <Avatar name={u.name} size={28} />
              <span className="flex-1 leading-tight"><span className="block text-sm text-ink">{u.name}</span><span className="block text-2xs text-muted">{u.role}</span></span>
              {u.id === userId && <CheckCircle2 size={16} className="text-[var(--t-green)]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-[60] flex w-[400px] max-w-[calc(100vw-24px)] flex-col gap-2 sm:bottom-4 sm:right-4" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={cx('fadein pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface px-4 py-3 text-sm shadow-[var(--shadow-lg)]', t.tone === 'error' ? 'border-[var(--t-red-bd)]' : 'border-line')}>
          {t.tone === 'error' ? <XCircle size={18} className="mt-0.5 shrink-0 text-[var(--t-red)]" /> : t.tone === 'info' ? <Info size={18} className="mt-0.5 shrink-0 text-[var(--t-blue)]" /> : <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-[var(--t-green)]" />}
          <span className="flex-1 text-ink">{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="mt-0.5 text-faint hover:text-ink"><X size={16} /></button>
        </div>
      ))}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const { meta } = useApp();
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => { setDrawer(false); main.current?.scrollTo({ top: 0 }); }, [loc.pathname]);
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block"><Sidebar /></aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-[var(--backdrop)]" />
          <aside className="fadein absolute left-0 top-0 h-full w-[272px] max-w-[85vw] shadow-[var(--shadow-lg)]" onClick={e => e.stopPropagation()}><Sidebar onNavigate={() => setDrawer(false)} /></aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:gap-3 sm:px-4 lg:px-5">
          <button type="button" aria-label="Open navigation" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink lg:hidden" onClick={() => setDrawer(true)}><MenuIcon size={21} /></button>
          <GlobalSearch />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <JobWatcher />
            {meta && <Link to="/settings" title={meta.discoveryBlocked ?? 'Find artist searches the web, Spotify and YouTube live'} className={cx('mr-2 hidden items-center gap-1.5 text-xs xl:inline-flex', meta.discoveryBlocked ? 'text-[var(--t-orange)]' : 'text-muted hover:text-ink')}><Activity size={14} className={meta.discoveryBlocked ? '' : 'text-[var(--t-green)]'} />{meta.discoveryBlocked ? 'Find artist is off' : 'Live search'}</Link>}
            <Notifications />
            <UserMenu />
          </div>
        </header>
        <main ref={main} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="w-full px-3 py-4 sm:px-4 lg:px-5 lg:py-5">{children}</div>
          <footer className="w-full px-3 pb-4 pt-2 text-right text-2xs tracking-wide text-faint sm:px-4 lg:px-5"><button type="button" onClick={showWhatsNew} className="hover:text-ink hover:underline" title="What’s new in this version">{VERSION}</button></footer>
        </main>
      </div>
      <Toasts />
      <WhatsNew />
    </div>
  );
}
