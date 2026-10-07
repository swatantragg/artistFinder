// Search-all confirmation and progress, used on the Artists page and in import results.
import { Loader2, Square } from 'lucide-react';
import { useState } from 'react';
import { Button, Modal, cx } from '../components/ui';
import { useApp } from '../lib/app';
import { fmtAgo, num } from '../lib/format';

export interface Bulk { id: string; total: number; queued: number; running: number; completed: number; needsReview: number; failed: number; stopped: number; done: boolean; startedAt: string | null }
export function BulkConfirm({ count, caseIds, room = null, onClose }: { count: number; caseIds?: string[]; room?: number | null; onClose: () => void }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="Start discovery?" description="Searches run in the background queue, a few at a time, so costs and rate limits stay under control."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); await app.run('startBulkDiscovery', caseIds ? { caseIds } : {}); setBusy(false); onClose(); }}>Start</Button></>}>
      <p className="text-sm text-ink-2">Artists requiring discovery: <b className="text-ink">{num(count)}</b></p>
      {room !== null && room < count && <p className="mt-2 text-sm text-ink-2">Search limits leave room for about <b className="text-ink">{num(room)}</b> complete artist search{room === 1 ? '' : 'es'} in this period, so only {num(Math.max(0, room))} will be queued now. The rest stay <i>Not started</i>.</p>}
      <p className="mt-2 text-xs text-muted">Only artists that were never searched or whose search failed are queued. Verified artists are not searched again. You can keep working and stop the remaining searches at any time.</p>
    </Modal>
  );
}

export function BulkCard({ bulk }: { bulk: Bulk }) {
  const app = useApp();
  const finished = bulk.completed + bulk.failed;
  return (
    <section className={cx('mt-4 rounded-lg border px-4 py-3', bulk.done ? 'border-line bg-surface' : 'border-[var(--t-blue-bd)] bg-surface')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">{!bulk.done && <Loader2 size={14} className="animate-spin text-[var(--t-blue)]" />}{bulk.done ? `Search all unverified: ${bulk.stopped ? 'stopped' : 'finished'}` : `Searching: ${num(finished + bulk.running)} / ${num(bulk.total - bulk.stopped)}`}</p>
        {!bulk.done && <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={() => app.run('stopBulkDiscovery', { bulkId: bulk.id })}>Stop remaining</Button>}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover"><div className="h-full rounded-full bg-[var(--t-blue)] transition-all" style={{ width: `${bulk.total - bulk.stopped ? (finished / (bulk.total - bulk.stopped)) * 100 : 100}%` }} /></div>
      <p className="mt-1.5 text-xs text-muted tnum">Completed {num(bulk.completed)} · Needs verification {num(bulk.needsReview)} · Failed {num(bulk.failed)} · {bulk.stopped ? `Stopped before starting ${num(bulk.stopped)} · ` : ''}Waiting {num(bulk.queued)}{bulk.startedAt ? ` · started ${fmtAgo(bulk.startedAt)}` : ''}</p>
    </section>
  );
}

/** One artist's discovery page: evidence, verification, graph and possible connections together. */
