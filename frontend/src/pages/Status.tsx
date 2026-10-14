// Status: where every artist stands, at a glance. Claims (not on Goongoonalo yet: step N of 5, waiting or to do),
// members already on Goongoonalo, festival greetings, and who said stop. Click a row to continue with its next step.
import { ArrowRight, Check, Download, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PlatformBadge } from '../components/discovery/bits';
import { Badge, Button, Empty, ErrorBox, FilterSelect, PageHeader, Pagination, Pill, PillBar, SkeletonRows, Tabs, cx } from '../components/ui';
import { useDebounced, useQuery } from '../lib/app';
import { download, fmtAgo, fmtDate, num } from '../lib/format';

type Tab = 'claims' | 'members' | 'greetings' | 'stopped';
type RowState = 'todo' | 'waiting' | 'done' | 'ended';
interface Row {
  caseId: string; name: string; rank: number | null; goongoonalo: string; step: number; steps: number; stepLabel: string; doneSteps: number;
  state: RowState; stateLabel: string; next: string; route: string | null; lastStep: string | null; since: string | null; followUpDue: string | null;
  greetings: string; lastGreeting: string | null; optOut: string | null; sent: boolean; sentAt: string | null; sentWhat: string | null;
}
interface Board { tab: Tab; counts: Record<Tab, number>; waiting: number; todo: number; rows: Row[]; msg: 'all' | 'sent' | 'pending'; sent: number; pending: number; festival: { id: string; name: string; date: string | null } | null }

const TABS: { id: Tab; label: string; text: string }[] = [
  { id: 'claims', label: 'Claims', text: 'Artists not on Goongoonalo yet: asked to join and claim their profile. 5 steps.' },
  { id: 'members', label: 'On Goongoonalo', text: 'Artists already on Goongoonalo: no claim, only member messages. 4 steps.' },
  { id: 'greetings', label: 'Greetings', text: 'Members and their answer to festival greetings (only a yes gets them).' },
  { id: 'stopped', label: 'Stopped', text: 'Said not interested or asked not to be contacted. Nothing is sent to them.' },
];
const STATE_TONE: Record<RowState, 'violet' | 'orange' | 'green' | 'red'> = { todo: 'violet', waiting: 'orange', done: 'green', ended: 'red' };
const STATE_WORD: Record<RowState, string> = { todo: 'Your turn', waiting: 'Waiting', done: 'Done', ended: 'Stopped' };
const PAGE = 50;
/** The route reads "Instagram @name", "X @name" or "Facebook @name" for a direct message; anything else is a go-between. */
const routePlatform = (route: string) => ['Instagram', 'X', 'Facebook'].find(p => route.startsWith(`${p} @`)) ?? 'Go-between';

/** Step dots: filled = done, ring = the step it is on. */
function StepDots({ row }: { row: Row }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: row.steps }, (_, i) => (
        <span key={i} className={cx('h-2.5 w-2.5 rounded-full', i < row.doneSteps ? 'bg-accent' : i === row.step - 1 && row.state !== 'ended' && row.state !== 'done' ? 'bg-surface ring-2 ring-accent' : 'bg-hover')} />
      ))}
    </span>
  );
}

function csvOf(tab: Tab, rows: Row[]): string {
  const head = ['Artist', 'Artist page', 'Top 250 rank', 'Step', 'Step name', 'Status', 'Message', 'Sent on', 'What was sent', 'Next', 'Route', 'Last step', 'Since', 'Follow-up due', 'Greetings', 'Last greeting'];
  const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = rows.map(r => [r.name, `${location.origin}/#/artists/${r.caseId}?tab=claims`, r.rank ?? '', tab === 'stopped' ? '' : `${r.step} of ${r.steps}`, r.stepLabel, r.stateLabel, r.sent ? 'Sent' : 'Pending', r.sentAt ? r.sentAt.slice(0, 10) : '', r.sentWhat ?? '', r.next, r.route ?? '', r.lastStep ?? '', r.since ? r.since.slice(0, 10) : '', r.followUpDue ?? '', r.greetings, r.lastGreeting ? r.lastGreeting.slice(0, 10) : ''].map(cell).join(','));
  return [head.join(','), ...lines].join('\n');
}

export default function Status() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v); else n.delete(k); if (!('page' in patch)) n.delete('page'); setSp(n, { replace: true }); };
  const tab = (TABS.find(t => t.id === sp.get('tab'))?.id ?? 'claims') as Tab;
  const state = sp.get('state') ?? 'all', step = sp.get('step') ?? '', scope = sp.get('scope') ?? 'all', msg = sp.get('msg') ?? 'all';
  const [text, setText] = useState(sp.get('q') ?? '');
  const q = useDebounced(text, 250);
  const page = Number(sp.get('page') ?? 1);
  const board = useQuery<Board>('statusBoard', { tab, q, state, step, scope, msg });
  const info = TABS.find(t => t.id === tab)!;
  const rows = board.data?.rows ?? [];
  const steps = tab === 'claims' ? ['On Goongoonalo?', 'The route', 'Join invitation', 'Their answer', 'The claim'] : ['On Goongoonalo?', 'The route', 'Member message', 'Their answer'];
  const open = (r: Row) => navigate(tab === 'greetings' && r.greetings !== 'No' ? '/messages?kind=greeting&top=all' : `/artists/${r.caseId}?tab=claims`);
  return (
    <>
      <PageHeader title="Status" subtitle="Where each artist stands. Click an artist to continue with the next step."
        actions={<Button icon={<Download size={15} />} disabled={!rows.length} onClick={() => download(`artist-status-${tab}-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(tab, rows))}>Download CSV</Button>} />
      {board.error && <ErrorBox text={board.error} />}
      <Tabs value={tab} onChange={t => set({ tab: t === 'claims' ? null : t, step: null, state: null, msg: null })}
        tabs={TABS.map(t => ({ id: t.id, label: t.label, count: board.data?.counts[t.id] ?? null }))} />
      <p className="mt-3 text-sm text-muted">{info.text}</p>
      {tab !== 'stopped' && (
        <div className="mt-3">
          <PillBar label="Message sent or pending">
            <Pill active={msg === 'all'} onClick={() => set({ msg: null })} count={board.data ? num(board.data.sent + board.data.pending) : undefined}>Everyone</Pill>
            <Pill active={msg === 'pending'} onClick={() => set({ msg: 'pending' })} count={board.data ? num(board.data.pending) : undefined} title={tab === 'greetings' ? 'No greeting yet for the next festival' : 'The first message has not gone out yet'}>{tab === 'greetings' ? `Pending: no ${board.data?.festival?.name ?? 'festival'} greeting yet` : 'Pending: message not sent yet'}</Pill>
            <Pill active={msg === 'sent'} onClick={() => set({ msg: 'sent' })} count={board.data ? num(board.data.sent) : undefined} title="Newest first">{tab === 'greetings' ? `Sent: ${board.data?.festival?.name ?? 'festival'} greeting` : 'Sent: message went out'}</Pill>
          </PillBar>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="relative min-w-[14rem] flex-1 basis-[16rem]">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input className="field !pl-9" value={text} onChange={e => { setText(e.target.value); set({ q: e.target.value || null }); }} placeholder="Find an artist by name" aria-label="Find an artist by name" />
        </label>
        {tab !== 'stopped' && (
          <FilterSelect label="Show" value={state} onChange={v => set({ state: v === 'all' ? null : v })}
            options={[{ id: 'all', label: 'Everyone' }, { id: 'todo', label: 'Your turn (needs action)' }, { id: 'waiting', label: 'Waiting for them' }, { id: 'done', label: 'Done' }, ...(tab === 'greetings' ? [{ id: 'ended', label: 'Said no' }] : [])]} />
        )}
        {(tab === 'claims' || tab === 'members') && (
          <FilterSelect label="Step" value={step || 'any'} onChange={v => set({ step: v === 'any' ? null : v })}
            options={[{ id: 'any', label: 'Any step' }, ...steps.map((s, i) => ({ id: String(i + 1), label: `${i + 1}. ${s}` }))]} />
        )}
        <FilterSelect label="Artists" value={scope} onChange={v => set({ scope: v === 'all' ? null : v })} options={[{ id: 'all', label: 'All artists' }, { id: 'top', label: 'Top 250 only' }]} />
      </div>

      {board.data && tab !== 'stopped' && (board.data.todo > 0 || board.data.waiting > 0) && (
        <p className="mt-3 flex flex-wrap gap-2 text-sm">
          {board.data.todo > 0 && <button type="button" onClick={() => set({ state: 'todo' })}><Badge tone="violet" dot>{num(board.data.todo)} your turn</Badge></button>}
          {board.data.waiting > 0 && <button type="button" onClick={() => set({ state: 'waiting' })}><Badge tone="orange" dot>{num(board.data.waiting)} waiting for them</Badge></button>}
        </p>
      )}

      <div className="mt-4">
        {!board.data ? <SkeletonRows /> : !rows.length ? (
          <Empty title={msg === 'sent' && board.data.counts[tab] ? (tab === 'greetings' ? 'No greeting sent yet for this festival.' : 'No message sent yet in this list.') : msg === 'pending' && board.data.counts[tab] ? 'Nobody pending: everyone here got the message.' : board.data.counts[tab] ? 'No artist matches these filters.' : tab === 'claims' ? 'No claim started yet.' : tab === 'stopped' ? 'Nobody said stop.' : 'No artist on Goongoonalo yet.'}
            text={tab === 'claims' && !board.data.counts.claims ? 'Open a verified artist, tab “Claims & routes”, and answer the first question: is the artist on Goongoonalo?' : undefined} />
        ) : (
          <>
            <ul className="space-y-2">
              {rows.slice((page - 1) * PAGE, page * PAGE).map(r => (
                <li key={r.caseId}>
                  <button type="button" onClick={() => open(r)} className="grid w-full items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3 text-left shadow-[var(--shadow)] hover:border-line-strong hover:bg-hover sm:grid-cols-[minmax(10rem,1.2fr)_minmax(12rem,1.3fr)_minmax(12rem,1.5fr)_auto]">
                    <span className="min-w-0">
                      <span className="block truncate text-base font-semibold text-ink">{r.name}</span>
                      <span className="block text-xs text-muted">{r.rank && r.rank <= 250 ? `Top 250 · #${r.rank}` : 'Artist'}</span>
                      {r.route && <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-ink-2"><span className="text-muted">via</span><PlatformBadge platform={routePlatform(r.route)} size="xs" /><span className="truncate" title={r.route}>{r.route}</span></span>}
                    </span>
                    <span className="min-w-0">
                      {tab === 'stopped' ? <span className="text-sm text-ink-2">Stopped after step {r.doneSteps} of {r.steps}</span> : (
                        <>
                          <span className="flex items-center gap-2"><StepDots row={r} /><span className="text-sm font-medium text-ink">Step {r.step} of {r.steps}</span></span>
                          <span className="block text-xs text-muted">{r.stepLabel}</span>
                        </>
                      )}
                    </span>
                    <span className="min-w-0">
                      <Badge tone={STATE_TONE[r.state]} dot>{STATE_WORD[r.state]}: {r.stateLabel}</Badge>
                      {tab !== 'stopped' && (r.sent
                        ? <span className="mt-1 flex items-center gap-1 text-xs font-medium text-[var(--t-green)]"><Check size={13} />Sent {r.sentAt ? fmtAgo(r.sentAt) : ''}{r.sentWhat ? `: ${r.sentWhat}` : ''}</span>
                        : <span className="mt-1 block text-xs font-medium text-[var(--t-orange)]">{tab === 'greetings' ? 'Greeting not sent yet' : 'Message not sent yet'}</span>)}
                      <span className="mt-0.5 block text-xs text-muted">
                        {r.lastStep ? `${r.lastStep} · ${r.since ? fmtAgo(r.since) : ''}` : r.next}
                        {r.followUpDue && r.state === 'waiting' ? ` · follow-up ${fmtDate(r.followUpDue)}` : ''}
                        {tab === 'greetings' && r.lastGreeting ? ` · last greeting ${fmtAgo(r.lastGreeting)}` : ''}
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1 justify-self-start text-sm font-medium text-accent-text sm:justify-self-end">{r.state === 'ended' || r.state === 'done' ? 'Open' : 'Continue'}<ArrowRight size={15} /></span>
                  </button>
                </li>
              ))}
            </ul>
            {rows.length > PAGE && <div className="mt-3"><Pagination page={page} pageSize={PAGE} total={rows.length} onPage={p => set({ page: p > 1 ? String(p) : null })} /></div>}
          </>
        )}
      </div>
    </>
  );
}
