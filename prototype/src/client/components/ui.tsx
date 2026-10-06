// Reusable building blocks. Every screen is composed from these so the app looks and behaves the same everywhere.
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, MoreHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { STAGE_INFO, type LifecycleStage, type Tone } from '../../domain/constants';
import { initials, num } from '../lib/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------ buttons
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark';
const BTN: Record<BtnVariant, string> = {
  primary: 'bg-accent text-accent-ink border-accent hover:bg-accent-hover hover:border-accent-hover font-semibold shadow-[var(--shadow)]',
  secondary: 'bg-surface text-ink-2 border-line-strong hover:bg-hover hover:border-accent-line',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-hover',
  danger: 'bg-surface text-[var(--t-red)] border-[var(--t-red-bd)] hover:bg-[var(--t-red-bg)]',
  dark: 'bg-sel text-sel-ink border-sel-line hover:opacity-90',
};
export function Button({ variant = 'secondary', size = 'md', icon, loading, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; icon?: ReactNode; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg border text-center leading-tight transition-colors sm:whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed', size === 'sm' ? 'min-h-8 px-3 py-1 text-sm' : 'min-h-10 px-4 py-1.5 text-sm', BTN[variant], className)}
    >
      {loading ? <Loader2 size={15} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" aria-label={label} title={label} {...rest} className={cx('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink', className)}>{children}</button>;
}

// ------------------------------------------------------------------ badges
export function Badge({ tone = 'neutral', children, dot, title, className }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string; className?: string }) {
  return (
    <span title={title} className={cx(`tone-${tone} badge inline-flex items-center gap-1.5 rounded-full px-2.5 py-[1px] text-xs font-medium whitespace-nowrap leading-5`, className)}>
      {dot && <span className="tone-dot h-1.5 w-1.5 rounded-full" />}
      {children}
    </span>
  );
}
export function StageBadge({ stage }: { stage: LifecycleStage }) {
  const info = STAGE_INFO[stage];
  return <Badge tone={info?.tone ?? 'neutral'} dot title={info?.meaning}>{stage}</Badge>;
}
const TONES: Record<string, Tone> = {
  // claim
  'Not Invited': 'neutral', Invited: 'violet', Submitted: 'violet', 'In Review': 'violet', Approved: 'blue', Completed: 'green', Rejected: 'red',
  // activation
  'Not Started': 'neutral', 'Access Verified': 'orange', 'Feature Selected': 'orange', Activated: 'green',
  // contact preference
  Allowed: 'neutral', Later: 'orange', Declined: 'red', 'Do Not Contact': 'red',
  // task status
  Queued: 'neutral', 'In Progress': 'blue', Waiting: 'orange', Cancelled: 'neutral',
  // route state
  Candidate: 'neutral', Verified: 'blue', Selected: 'green', Exhausted: 'orange',
  // priority
  High: 'red', Medium: 'gold', Low: 'neutral',
  // identity
  Provisional: 'orange', 'Under Review': 'orange',
  // import
  Processed: 'green', Repeat: 'orange', Failed: 'red', Accepted: 'green', Quarantined: 'red', Skipped: 'neutral', Open: 'orange', Resolved: 'green', Dismissed: 'neutral', Decided: 'green', Deferred: 'orange',
  // work reason
  'New Lead': 'gold', 'New Artist': 'neutral', 'Follow-up': 'blue', 'Metadata Gap': 'orange', 'Technical Issue': 'red', 'Re-engagement': 'violet',
};
export function StatusBadge({ value, label, dot = true }: { value: string | null | undefined; label?: string; dot?: boolean }) {
  if (!value) return <span className="text-faint">—</span>;
  return <Badge tone={TONES[value] ?? 'neutral'} dot={dot}>{label ? `${label}: ${value}` : value}</Badge>;
}
export const toneOf = (v: string): Tone => TONES[v] ?? 'neutral';
/** Quiet text for the default value (nothing happened yet), a badge once something changed. Keeps tables calm. */
const DEFAULTS = new Set(['Not Invited', 'Not Started', 'Allowed']);
export function SoftStatus({ value }: { value: string }) {
  return DEFAULTS.has(value) ? <span className="whitespace-nowrap text-sm text-muted">{value}</span> : <StatusBadge value={value} />;
}

export function Avatar({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  return <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full border border-accent-line bg-accent-soft font-semibold text-accent-text', className)} style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials(name)}</span>;
}

// ------------------------------------------------------------------ layout pieces
export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="mb-4 sm:mb-5">
      {back && <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ChevronLeft size={16} />{back.label}</Link>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1 basis-[22rem]">
          <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink sm:text-2xl">{title}</h1>
          {subtitle && <p className="mt-1 max-w-4xl text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
export function Card({ title, subtitle, actions, children, className, pad = true, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; id?: string }) {
  return (
    <section id={id} className={cx('min-w-0 rounded-lg border border-line bg-surface shadow-[var(--shadow)]', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}
export function Empty({ icon, title, text, action, compact }: { icon?: ReactNode; title: string; text?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'py-6' : 'py-12')}>
      {icon && <div className="mb-2 text-faint">{icon}</div>}
      <p className="text-base font-medium text-ink-2">{title}</p>
      {text && <p className="mt-1 max-w-lg text-sm text-muted">{text}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
export function Skeleton({ className }: { className?: string }) { return <div className={cx('skeleton', className ?? 'h-4 w-full')} />; }
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return <div className="space-y-2.5 p-4">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-5" />)}</div>;
}
export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="tone-red tone-box flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm">
      <span className="tone-text">{text}</span>
      {onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}
export function Notice({ tone = 'neutral', icon, title, children, action }: { tone?: Tone; icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx(`tone-${tone} tone-box flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-4 py-3 sm:flex-nowrap`)}>
      {icon && <span className="tone-text mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1 basis-56 text-sm text-ink-2">
        {title && <p className="font-semibold text-ink">{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0 max-sm:w-full max-sm:pl-8">{action}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ data display
export function KeyVal({ items, cols = 1 }: { items: [string, ReactNode][]; cols?: 1 | 2 }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-2.5', cols === 2 && 'sm:grid-cols-2')}>
      {items.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v === null || v === undefined || v === '' ? <span className="text-faint">—</span> : v}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Stat({ label, value, sub, to, tone, onClick }: { label: string; value: number | string; sub?: ReactNode; to?: string; tone?: Tone; onClick?: () => void }) {
  const body = (
    <>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">{tone && <span className={`tone-${tone} tone-dot h-1.5 w-1.5 rounded-full`} />}{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tnum text-ink">{typeof value === 'number' ? num(value) : value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </>
  );
  const cls = 'block min-w-0 rounded-lg border border-line bg-surface px-4 py-3.5 shadow-[var(--shadow)] text-left';
  if (to) return <Link to={to} className={cx(cls, 'hover:border-accent-line hover:bg-surface-2')}>{body}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cx(cls, 'w-full hover:border-accent-line')}>{body}</button>;
  return <div className={cls}>{body}</div>;
}
/** Horizontal bars: the only chart type the app needs (funnels, distributions, workloads). */
export function Bars({ data, max, tone = 'blue', onPick, format = num }: { data: { label: string; value: number; hint?: string }[]; max?: number; tone?: Tone; onPick?: (label: string) => void; format?: (n: number) => string }) {
  const top = max ?? Math.max(1, ...data.map(d => d.value));
  return (
    <div className="space-y-1.5">
      {data.map(d => (
        <button key={d.label} type="button" disabled={!onPick} onClick={() => onPick?.(d.label)} className={cx('grid w-full grid-cols-[minmax(96px,38%)_1fr_auto] items-center gap-3 rounded px-1 py-1 text-left text-sm', onPick && 'hover:bg-hover')}>
          <span className="truncate text-ink-2" title={d.hint ?? d.label}>{d.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-hover"><span className={`tone-${tone} tone-dot block h-full rounded-full`} style={{ width: `${(d.value / top) * 100}%`, minWidth: d.value ? 3 : 0 }} /></span>
          <span className="w-12 text-right font-medium tnum text-ink">{format(d.value)}</span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ tabs
export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string; count?: number | null }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="scroll-thin flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line">
      {tabs.map(t => (
        <button key={t.id} role="tab" type="button" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium', value === t.id ? 'border-accent-strong text-ink' : 'border-transparent text-muted hover:text-ink')}>
          {t.label}
          {t.count != null && <span className={cx('rounded-full px-1.5 text-2xs font-semibold tnum', value === t.id ? 'bg-accent-soft text-accent-text' : 'bg-hover text-muted')}>{num(t.count)}</span>}
        </button>
      ))}
    </div>
  );
}
export function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="scroll-none inline-flex max-w-full overflow-x-auto rounded-lg border border-line-strong bg-surface p-0.5">
      {options.map(o => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} className={cx('shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm', value === o.id ? 'bg-sel font-medium text-sel-ink' : 'text-ink-2 hover:bg-hover')}>{o.label}</button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ filter pills
/** One status filter of a list, with its count. Pills scroll sideways on phones instead of wrapping into many lines. */
export function Pill({ active, onClick, title, count, children }: { active: boolean; onClick: () => void; title?: string; count?: string; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} title={title}
      className={cx('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm', active ? 'border-sel-line bg-sel font-medium text-sel-ink' : 'border-line-strong text-ink-2 hover:border-accent-line hover:bg-hover')}>
      {children}{count !== undefined && <span className={cx('tnum text-xs', active ? 'opacity-80' : 'text-muted')}>{count}</span>}
    </button>
  );
}
export function PillBar({ label, children }: { label: string; children: ReactNode }) {
  return <div role="tablist" aria-label={label} className="scroll-none -mx-3 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">{children}</div>;
}

// ------------------------------------------------------------------ table
/** `hide` drops a secondary column below that screen width; `stick` keeps a column (the row action) in view while a wide
 *  table scrolls sideways. On phones (below md) every table becomes stacked cards: the first column is the card title and
 *  every other cell is labelled with its header (or `label`). */
export interface Column<T> { key: string; header: ReactNode; render: (row: T) => ReactNode; sort?: string; className?: string; headClass?: string; label?: string; hide?: 'md' | 'lg' | 'xl' | '2xl' | '3xl'; stick?: boolean }
const HIDE = { md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell', '2xl': 'hidden 2xl:table-cell', '3xl': 'hidden 3xl:table-cell' } as const;
const STICK = 'md:sticky md:right-0 md:z-[1] md:shadow-[inset_1px_0_0_var(--border)]';
export function DataTable<T>({ columns, rows, rowKey, onRowClick, sort, onSort, empty, loading, dense }: {
  columns: Column<T>[]; rows: T[] | undefined; rowKey: (r: T) => string; onRowClick?: (r: T) => void; sort?: { key: string; dir: 'asc' | 'desc' }; onSort?: (key: string) => void; empty?: ReactNode; loading?: boolean; dense?: boolean;
}) {
  if (!rows) return <SkeletonRows rows={8} />;
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className={cx('dt-stack w-full text-left text-sm', loading && 'opacity-60')}>
        <thead>
          <tr className="border-b border-line bg-surface-2">
            {columns.map(c => (
              <th key={c.key} scope="col" className={cx('px-3 py-2.5 align-bottom text-xs font-semibold text-muted', c.headClass?.includes('whitespace-normal') ? '' : 'whitespace-nowrap', c.hide && HIDE[c.hide], c.stick && `${STICK} md:bg-surface-2`, c.headClass)}>
                {c.sort && onSort ? (
                  <button type="button" onClick={() => onSort(c.sort!)} className="inline-flex items-center gap-1 hover:text-ink">
                    {c.header}
                    {sort?.key === c.sort && <ChevronDown size={13} className={sort.dir === 'asc' ? 'rotate-180' : ''} />}
                  </button>
                ) : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx('group border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-hover')}>
              {columns.map(c => (
                <td key={c.key} data-label={c.label ?? (typeof c.header === 'string' ? c.header : '')} className={cx('px-3 align-top', dense ? 'py-2' : 'py-3', c.hide && HIDE[c.hide], c.stick && `${STICK} md:bg-surface`, c.stick && onRowClick && 'md:group-hover:bg-hover', c.className)}>
                  <div>{c.render(r)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (empty ?? <Empty title="Nothing to show" compact />)}
    </div>
  );
}
export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0, to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-sm text-muted">
      <span className="tnum">{num(from)}–{num(to)} of {num(total)}</span>
      <div className="flex items-center gap-1">
        <IconButton label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)} className="disabled:opacity-30"><ChevronLeft size={18} /></IconButton>
        <span className="tnum px-1">Page {page} of {pages}</span>
        <IconButton label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)} className="disabled:opacity-30"><ChevronRight size={18} /></IconButton>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ overlays
export function Modal({ open, onClose, title, description, children, footer, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--backdrop)] px-3 py-[5vh] sm:px-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" className="fadein w-full rounded-xl border border-line bg-surface shadow-[var(--shadow-lg)]" style={{ maxWidth: width }}>
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-md font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div className="px-4 py-4 sm:px-5">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 rounded-b-xl border-t border-line bg-surface-2 px-4 py-3 sm:px-5">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem { label: string; onClick: () => void; disabled?: string | boolean; danger?: boolean; icon?: ReactNode; divider?: boolean }
export function Menu({ items, label = 'More actions', trigger, align = 'right' }: { items: MenuItem[]; label?: string; trigger?: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <span onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
        {trigger ?? <IconButton label={label} aria-expanded={open}><MoreHorizontal size={18} /></IconButton>}
      </span>
      {open && (
        <div className={cx('fadein absolute z-40 mt-1 w-max min-w-[230px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-lg)]', align === 'right' ? 'right-0' : 'left-0')}>
          {items.map((it, i) => (
            <div key={it.label + i}>
              {it.divider && <div className="my-1 border-t border-line" />}
              <button type="button" disabled={!!it.disabled} title={typeof it.disabled === 'string' ? it.disabled : undefined}
                onClick={e => { e.stopPropagation(); setOpen(false); it.onClick(); }}
                className={cx('flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm disabled:opacity-40 disabled:cursor-not-allowed', it.danger ? 'text-[var(--t-red)] hover:bg-[var(--t-red-bg)]' : 'text-ink-2 hover:bg-hover')}>
                {it.icon}{it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ forms
export function Field({ label, required, help, children, className }: { label: string; required?: boolean; help?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 block text-sm font-medium text-ink-2">{label}{required && <span className="text-[var(--t-red)]"> *</span>}</span>
      {children}
      {help && <span className="mt-1 block text-xs text-muted">{help}</span>}
    </label>
  );
}

export function Steps({ steps, current, failed }: { steps: readonly string[]; current: number; failed?: boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? (failed ? 'failed' : 'active') : 'todo';
        return (
          <li key={s} className="flex items-center gap-2">
            <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
              state === 'done' && 'tone-green badge', state === 'active' && 'tone-violet badge font-medium', state === 'failed' && 'tone-red badge', state === 'todo' && 'border-line text-faint')}>
              {state === 'active' && <Loader2 size={13} className="animate-spin" />}
              {s}
            </span>
            {i < steps.length - 1 && <span className="text-faint">→</span>}
          </li>
        );
      })}
    </ol>
  );
}
