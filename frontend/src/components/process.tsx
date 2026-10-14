// Contact and Claim as guided processes: a step bar with the next step highlighted, one clear "next step" card, and
// undo / reset. Undo puts back everything the last step changed; reset undoes every step (after typing RESET). Both
// keep the history: the undone steps stay in the timeline, marked.
import { ArrowRight, Check, Circle, CircleDot, RotateCcw, Undo2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useApp } from '../lib/app';
import { fmtDateTime } from '../lib/format';
import { Badge, Button, ErrorBox, Field, Modal, Notice, cx } from './ui';

export type StepState = 'done' | 'active' | 'todo';
export interface ProcessSide { steps: { at: string; label: string; by: string }[]; canUndo: string | null; canReset: string | null }

/** The steps of a process; the next one is highlighted (ring and "Next"). Optional click to look at a step. */
export function StepBar({ steps, next, selected, onPick, label }: { steps: { label: string; state: StepState }[]; next: number; selected?: number; onPick?: (i: number) => void; label: string }) {
  return (
    <ol className={cx('grid gap-2', steps.length > 4 ? 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6' : 'grid-cols-2 lg:grid-cols-4')} aria-label={label}>
      {steps.map((s, i) => {
        const isNext = i === next;
        const body = (
          <>
            <span className="flex items-center gap-2 text-base font-medium">
              {s.state === 'done' ? <Check size={17} className="shrink-0 text-[var(--t-green)]" /> : isNext || s.state === 'active' ? <CircleDot size={17} className="shrink-0 text-accent-text" /> : <Circle size={17} className="shrink-0 text-faint" />}
              <span className={s.state === 'todo' && !isNext ? 'text-faint' : 'text-ink'}>{i + 1}. {s.label}</span>
            </span>
            <span className={cx('mt-1 block text-xs', isNext ? 'font-semibold text-accent-text' : 'text-muted')}>{isNext ? 'Next step' : s.state === 'done' ? 'Done' : s.state === 'active' ? 'Now' : 'Later'}</span>
          </>
        );
        const cls = cx('block h-full w-full rounded-xl border px-3.5 py-3 text-left',
          isNext ? 'border-accent bg-accent-soft ring-2 ring-[var(--accent)]/60 ring-offset-2 ring-offset-[var(--surface)]' : s.state === 'done' ? 'border-line bg-surface' : 'border-line bg-surface-2',
          selected === i && 'shadow-[inset_0_-3px_0_var(--accent)]', onPick && 'hover:bg-hover');
        return <li key={s.label}>{onPick ? <button type="button" className={cls} aria-pressed={selected === i} onClick={() => onPick(i)}>{body}</button> : <div className={cls}>{body}</div>}</li>;
      })}
    </ol>
  );
}

/** The one thing to do next, with its button. */
export function NextStep({ text, action, tone = 'accent' }: { text: ReactNode; action?: ReactNode; tone?: 'accent' | 'red' }) {
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 px-4 py-3.5', tone === 'red' ? 'border-[var(--t-red-bd)] bg-[var(--t-red-bg)]/40' : 'border-accent bg-accent-soft/60')}>
      <p className="flex min-w-0 items-start gap-2 text-base text-ink"><ArrowRight size={19} className={cx('mt-0.5 shrink-0', tone === 'red' ? 'text-[var(--t-red)]' : 'text-accent-text')} /><span><b>Next step: </b>{text}</span></p>
      {action && <span className="flex shrink-0 flex-wrap gap-2">{action}</span>}
    </div>
  );
}

/** Undo the last step / reset the whole process, each with a confirmation (reset: type RESET). */
export function ProcessControls({ caseId, process, side, name, undoFirst }: { caseId: string; process: 'contact' | 'claim' | 'all'; side: ProcessSide; name: string; undoFirst?: boolean }) {
  const [mode, setMode] = useState<'undo' | 'reset' | null>(null);
  const last = side.steps[side.steps.length - 1];
  const word = process === 'claim' ? 'claim ' : process === 'contact' ? 'contact ' : '';   // 'all' = the whole process
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
      <p className="min-w-0 text-sm text-ink-2">{last ? <>Last step: <b className="text-ink">{last.label}</b> <span className="text-muted">· {last.by} · {fmtDateTime(last.at)}</span></> : <span className="text-muted">No {word}step yet.</span>}</p>
      <span className="flex flex-wrap gap-2">
        <Button size="sm" variant={undoFirst ? 'primary' : 'secondary'} icon={<Undo2 size={15} />} disabled={!!side.canUndo} title={side.canUndo ?? 'Put back everything the last step changed'} onClick={() => setMode('undo')}>Undo last step</Button>
        <Button size="sm" variant="ghost" icon={<RotateCcw size={15} />} disabled={!!side.canReset} title={side.canReset ?? `Undo every ${word}step and start again`} onClick={() => setMode('reset')}>Reset the whole {word}process</Button>
      </span>
      {last && side.canUndo && <p className="w-full text-xs text-muted">Undo is not available: {side.canUndo}</p>}
      {mode && <UndoModal caseId={caseId} process={process} side={side} name={name} mode={mode} onClose={() => setMode(null)} />}
    </div>
  );
}

function UndoModal({ caseId, process, side, name, mode, onClose }: { caseId: string; process: 'contact' | 'claim' | 'all'; side: ProcessSide; name: string; mode: 'undo' | 'reset'; onClose: () => void }) {
  const { run } = useApp();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const word = process === 'claim' ? 'claim ' : process === 'contact' ? 'contact ' : '';   // 'all' = the whole process
  const last = side.steps[side.steps.length - 1];
  const ok = reason.trim().length > 0 && (mode === 'undo' || typed.trim().toUpperCase() === 'RESET');
  const go = async () => {
    setBusy(true); setError(null);
    const res = await run(mode === 'undo' ? 'undoStep' : 'resetProcess', { caseId, process, reason, confirm: typed });
    setBusy(false);
    if (res) onClose(); else setError('Not done: see the message at the bottom of the screen.');
  };
  return (
    <Modal open onClose={onClose} title={mode === 'undo' ? `Undo the last ${word}step?` : `Reset the whole ${word}process for ${name}?`}
      description={mode === 'undo' ? 'Everything this step changed is put back: stage, contact preference, claim status, routes and tasks. The step stays in the timeline, marked as undone.' : (word ? `Every ${word}step is undone, newest first, and the ${word.trim()} starts again from the beginning.` : 'Every step (contact, claim and activation) is undone, newest first, and the process starts again from the first message.') + ' The steps stay in the timeline, marked as undone. The Goongoonalo answer and the routes stay.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={mode === 'reset' ? 'danger' : 'primary'} loading={busy} disabled={!ok} onClick={go}>{mode === 'undo' ? 'Yes, undo this step' : `Yes, reset the ${word}process`}</Button></>}>
      <div className="space-y-4">
        {mode === 'undo' && last && <Notice tone="orange" title={last.label}>{last.by} · {fmtDateTime(last.at)}</Notice>}
        {mode === 'reset' && (
          <Notice tone="red" title={`${side.steps.length} step${side.steps.length === 1 ? '' : 's'} will be undone`}>
            <ul className="mt-1 list-inside list-disc text-sm">{[...side.steps].reverse().map(s => <li key={s.at}>{s.label} <span className="text-muted">({fmtDateTime(s.at)})</span></li>)}</ul>
          </Notice>
        )}
        <Field label={mode === 'undo' ? 'Why undo it?' : 'Why reset it?'} required help="Kept in the timeline with the undo.">
          <input className="field" value={reason} onChange={e => setReason(e.target.value)} placeholder={mode === 'undo' ? 'e.g. Clicked “Not interested” by mistake' : 'e.g. Start again with another profile'} autoFocus />
        </Field>
        {mode === 'reset' && (
          <Field label="Type RESET to confirm" required>
            <input className="field mono" value={typed} onChange={e => setTyped(e.target.value)} placeholder="RESET" />
          </Field>
        )}
        {error && <ErrorBox text={error} />}
        {mode === 'reset' && typed && typed.trim().toUpperCase() !== 'RESET' && <Badge tone="orange">Type the word RESET exactly</Badge>}
      </div>
    </Modal>
  );
}
