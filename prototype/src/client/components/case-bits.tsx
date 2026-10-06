// Case-specific widgets reused across the dossier, the queue and the overview pages.
import { ArrowDown, Check, Circle, CircleDot, Clock, Link2, Music2, User, Building2, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/app';
import { fmtDate, fmtDue, fmtShort, fmtTime } from '../lib/format';
import { useActions, type TaskLite } from './actions';
import { Badge, Button, Menu, StageBadge, StatusBadge, cx, type MenuItem } from './ui';

export function ProgressTrack({ steps }: { steps: { label: string; state: 'done' | 'active' | 'todo'; note: string }[] }) {
  return (
    <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4 2xl:grid-cols-8">
      {steps.map(s => (
        <li key={s.label} className={cx('bg-surface px-3 py-2.5', s.state === 'active' && 'bg-accent-soft')}>
          <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide">
            {s.state === 'done' ? <Check size={13} className="text-[var(--t-green)]" /> : s.state === 'active' ? <CircleDot size={14} className="text-accent-text" /> : <Circle size={13} className="text-faint" />}
            <span className={s.state === 'todo' ? 'text-faint' : 'text-ink'}>{s.label}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted">{s.state === 'done' ? 'Done' : s.state === 'active' ? 'In progress' : 'Not started'}</p>
          <p className="text-xs text-faint">{s.note}</p>
        </li>
      ))}
    </ol>
  );
}

const CHAIN_ICON: Record<string, ReactNode> = { artist: <User size={13} />, song: <Music2 size={13} />, person: <User size={13} />, org: <Building2 size={13} />, contact: <Phone size={13} /> };
/** Artist → “Song” → Collaborator → Verified contact */
export function RouteChain({ chain, vertical }: { chain: { kind: string; label: string; sub?: string }[]; vertical?: boolean }) {
  return (
    <div className={cx('flex gap-1.5', vertical ? 'flex-col items-start' : 'flex-wrap items-center')}>
      {chain.map((n, i) => (
        <div key={i} className={cx('flex items-center gap-1.5', vertical && 'flex-col items-start')}>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm">
            <span className="text-muted">{CHAIN_ICON[n.kind] ?? <Link2 size={13} />}</span>
            <span className="font-medium text-ink">{n.label}</span>
            {n.sub && <span className="max-w-[220px] truncate text-xs text-muted" title={n.sub}>{n.sub}</span>}
          </span>
          {i < chain.length - 1 && (vertical ? <ArrowDown size={13} className="ml-3 text-faint" /> : <span className="text-faint">→</span>)}
        </div>
      ))}
    </div>
  );
}

export interface TaskRowLike extends TaskLite {
  caseName: string; artistId: string; why: string; trigger: string; evidenceChange: string | null; priority: string; status: string; ownerName: string;
  overdue: boolean; workReason: string; stage: string; notes?: { at: string; by: string; text: string; kind: string }[]; evidence?: string[]; result?: string | null; completedAt?: string | null;
}

export function taskMenu(open: (id: string, ctx: object) => void, t: TaskRowLike, run: (n: string, p: object) => void): MenuItem[] {
  const c = { taskId: t.id, task: t, caseId: t.caseId };
  return [
    { label: 'Start task', onClick: () => run('startTask', { taskId: t.id }), disabled: t.status === 'In Progress' ? 'Already in progress' : false },
    { label: 'Complete with outcome…', onClick: () => open('completeTask', c) },
    { label: 'Put on hold…', onClick: () => open('holdTask', c) },
    { label: 'Reschedule…', onClick: () => open('rescheduleTask', c) },
    { label: 'Reassign…', onClick: () => open('reassignTask', c) },
    { label: 'Add note…', onClick: () => open('addTaskNote', c), divider: true },
    { label: 'Add evidence…', onClick: () => open('addTaskEvidence', c) },
    { label: 'Create follow-up…', onClick: () => open('createFollowUp', c) },
    { label: 'Change next action…', onClick: () => open('changeNextAction', c) },
    { label: 'Cancel task…', onClick: () => open('cancelTask', c), danger: true, divider: true },
  ];
}

/** One task, answering: which artist, what to do, why, what changed, how urgent, when, who. */
export function TaskCard({ t, showArtist = true }: { t: TaskRowLike; showArtist?: boolean }) {
  const { open } = useActions();
  const { run } = useApp();
  const due = fmtDue(t.dueDate);
  const isOpen = ['Queued', 'In Progress', 'Waiting'].includes(t.status);
  return (
    <div className={cx('rounded-lg border bg-surface px-4 py-3', t.overdue ? 'border-[var(--t-red-bd)]' : 'border-line')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {showArtist && (
            <div className="mb-0.5 flex flex-wrap items-center gap-2">
              <Link to={`/artists/${t.caseId}`} className="text-sm font-semibold uppercase tracking-wide text-ink hover:underline">{t.caseName}</Link>
              <span className="mono text-xs text-muted">{t.artistId}</span>
              <StageBadge stage={t.stage as never} />
            </div>
          )}
          <p className="text-md font-medium text-ink">{t.step}</p>
          <p className="mt-0.5 text-sm text-ink-2"><span className="text-muted">Why: </span>{t.why}</p>
          {t.evidenceChange && <p className="mt-0.5 text-sm text-ink-2"><span className="text-muted">Evidence change: </span>{t.evidenceChange}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <StatusBadge value={t.priority} label="Priority" dot={false} />
            {t.workReason === 'New Lead' && <Badge tone="gold">New lead</Badge>}
            <StatusBadge value={t.status} />
            <span className={cx('inline-flex items-center gap-1', due.overdue && 'font-medium text-[var(--t-red)]', due.today && 'font-medium text-ink')}><Clock size={12} />Due {due.text}</span>
            <span className="inline-flex items-center gap-1"><User size={12} />{t.ownerName}</span>
            <span className="mono text-faint">{t.id}</span>
          </div>
        </div>
        {isOpen && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="primary" size="sm" onClick={() => open('doTask', { task: t, taskId: t.id, caseId: t.caseId })}>Do it</Button>
            <Menu items={taskMenu(open, t, (n, p) => run(n, p))} />
          </div>
        )}
      </div>
    </div>
  );
}

export interface AuditRow { id: string; at: string; userName: string; action: string; field: string | null; from: string | null; to: string | null; reason: string | null; evidence: string | null; result: string | null; next: string | null; caseName?: string | null; caseId?: string | null; entity: string }
/** Who did what, when, why, with which evidence, result and next step. */
export function Timeline({ events, showCase }: { events: AuditRow[]; showCase?: boolean }) {
  let lastDay = '';
  return (
    <ol className="relative">
      {events.map(e => {
        const day = e.at.slice(0, 10);
        const head = day !== lastDay ? (lastDay = day, <li key={`d-${day}-${e.id}`} className="pb-1 pt-3 text-xs font-semibold text-muted first:pt-0">{fmtDate(day)}</li>) : null;
        return [head, (
          <li key={e.id} className="relative ml-1.5 grid grid-cols-[56px_minmax(0,1fr)] gap-3 border-l border-line pb-3 pl-4">
            <span className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full border border-line-strong bg-surface" />
            <span className="pt-px text-xs tnum text-muted">{fmtTime(e.at)}</span>
            <div className="min-w-0 text-sm">
              <p className="text-ink">
                <span className="font-medium">{e.action}</span>
                {e.field === 'lifecycleStage' && e.from && e.to ? <> · {e.from} → <b>{e.to}</b></> : e.to ? <> · <span className="text-ink-2">{e.from ? `${e.from} → ` : ''}{e.to}</span></> : null}
                {showCase && e.caseName && <> · <Link className="text-ink-2 underline decoration-line-strong hover:text-ink" to={`/artists/${e.caseId}`}>{e.caseName}</Link></>}
              </p>
              <p className="text-xs text-muted">
                {e.userName}
                {e.reason && <> · Why: {e.reason}</>}
              </p>
              {(e.evidence || e.result || e.next) && (
                <p className="text-xs text-muted">
                  {e.evidence && <>Evidence: {e.evidence}</>}
                  {e.result && <>{e.evidence ? ' · ' : ''}Result: {e.result}</>}
                  {e.next && <>{e.evidence || e.result ? ' · ' : ''}Next: {e.next}</>}
                </p>
              )}
            </div>
          </li>
        )];
      })}
    </ol>
  );
}

export function DueText({ date }: { date: string | null }) {
  const d = fmtDue(date);
  if (!date) return <span className="text-faint">—</span>;
  return <span className={cx('tnum', d.overdue && 'font-medium text-[var(--t-red)]')} title={fmtShort(date)}>{d.text}</span>;
}
