// Deduplicate (v2 §36): possible duplicate artists with a match % from catalogue evidence. Names alone never merge:
// a person confirms the same artist (merge, reversible), keeps them separate, or reviews later.
import { AlertTriangle, Check, CopyCheck, ScanSearch } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useActions } from '../components/actions';
import { PlatformBadge } from '../components/discovery/bits';
import { IdentityBadge, KindBadge } from '../components/status';
import { Badge, Button, Empty, ErrorBox, Field, Modal, PageHeader, Pagination, SkeletonRows, Tabs, cx } from '../components/ui';
import { useApp, useQuery } from '../lib/app';
import { fmtAgo, fmtDate, num } from '../lib/format';

interface Side { id: string; name: string; aliases: string[]; sourceIds: string[]; kind: string; songs: number; language: string | null; sample: { title: string; isrc: string; label: string }[]; labels: string[]; artistStatus: string; verifiedPlatforms: string[]; mergedIntoId: string | null }
interface Item {
  id: string; kind: string; reason: string; status: string; createdAt: string; cases: Side[]; score: number;
  pairs: { other: string; score: number; evidence: string[]; conflicts: string[] }[];
  decision: { id: string; decision: string; by: string; at: string; reason: string; reversedAt: string | null; canonicalId: string | null } | null;
}
interface Data { items: Item[]; total: number; page: number; pageSize: number; counts: { open: number; later: number; decided: number } }

export default function Deduplicate() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') ?? 'open') as 'open' | 'later' | 'decided';
  const page = Number(sp.get('page') ?? 1);
  const { data, error } = useQuery<Data>('dedupeQueue', { status: tab, page });
  const app = useApp();
  const [deciding, setDeciding] = useState<{ item: Item; decision: 'Same Person' | 'Keep Separate' | 'Defer' } | null>(null);
  const [scanning, setScanning] = useState(false);
  const scan = async () => { setScanning(true); await app.run('scanDuplicates', {}); setScanning(false); };
  return (
    <>
      <PageHeader title="Deduplicate" subtitle="Records that may be the same artist. The match % comes from songs, ISRCs, collaborators and labels; conflicts are shown too. Nothing is merged without a person."
        actions={app.can('identityDecision') ? <Button icon={<ScanSearch size={15} />} loading={scanning} onClick={scan}>Scan all artists</Button> : undefined} />
      <div className="rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
        <div className="px-2"><Tabs tabs={[{ id: 'open', label: 'To review', count: data?.counts.open ?? null }, { id: 'later', label: 'Review later', count: data?.counts.later ?? null }, { id: 'decided', label: 'Decided', count: data?.counts.decided ?? null }]} value={tab} onChange={t => setSp(t === 'open' ? {} : { tab: t }, { replace: true })} /></div>
        {error && <div className="p-3"><ErrorBox text={error} /></div>}
        {!data ? <div className="p-4"><SkeletonRows rows={5} /></div> : !data.items.length ? (
          <Empty icon={<CopyCheck size={22} />} title={tab === 'open' ? 'No possible duplicates to review.' : tab === 'later' ? 'Nothing set aside.' : 'No decisions yet.'} text={tab === 'open' ? 'New imports are checked automatically; Scan all artists checks the whole list.' : undefined} />
        ) : (
          <ul className="divide-y divide-line">{data.items.map(x => <DuplicateCard key={x.id} item={x} onDecide={decision => setDeciding({ item: x, decision })} />)}</ul>
        )}
        {data && data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={p => setSp({ ...(tab === 'open' ? {} : { tab }), page: String(p) }, { replace: true })} />}
      </div>
      {deciding && <DecideModal {...deciding} onClose={() => setDeciding(null)} />}
    </>
  );
}

function Meter({ score }: { score: number }) {
  const tone = score >= 75 ? 'var(--t-green)' : score >= 50 ? 'var(--t-gold)' : 'var(--border-strong)';
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 w-24 overflow-hidden rounded-full bg-hover"><span className="block h-full rounded-full" style={{ width: `${score}%`, background: tone }} /></span>
      <span className="text-md font-semibold tnum text-ink">{score}%</span>
    </span>
  );
}

function DuplicateCard({ item, onDecide }: { item: Item; onDecide: (d: 'Same Person' | 'Keep Separate' | 'Defer') => void }) {
  const { can } = useApp();
  const { open } = useActions();
  const top = item.pairs[0];
  const shown = item.cases.slice(0, 3);
  const decided = item.status === 'Decided';
  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-2xs font-semibold uppercase tracking-wider text-muted">Possible match</p>
        <Meter score={item.score} />
        <Badge>{item.kind}</Badge>
        <span className="text-xs text-faint">found {fmtAgo(item.createdAt)}</span>
      </div>
      <div className={cx('mt-3 grid gap-3', shown.length >= 3 ? 'lg:grid-cols-3' : 'md:grid-cols-2')}>
        {shown.map((c, i) => (
          <div key={c.id} className="min-w-0 rounded-md border border-line bg-surface-2 p-3">
            <p className="text-2xs font-semibold uppercase tracking-wide text-muted">Artist {String.fromCharCode(65 + i)}</p>
            <Link to={`/artists/${c.id}`} className="mt-0.5 flex flex-wrap items-center gap-1.5 text-md font-semibold text-ink hover:underline">{c.name}<KindBadge kind={c.kind} /></Link>
            <p className="mono text-xs text-muted">{c.id}{c.sourceIds.length ? ` · source ${c.sourceIds.join(', ')}` : ''}{c.mergedIntoId ? ` · merged into ${c.mergedIntoId}` : ''}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><IdentityBadge status={c.artistStatus} />{c.verifiedPlatforms.map(p => <PlatformBadge key={p} platform={p} size="sm" />)}</div>
            <p className="mt-1.5 text-xs text-ink-2">{num(c.songs)} song{c.songs === 1 ? '' : 's'}{c.language ? ` · ${c.language}` : ''}{c.labels.length ? ` · ${c.labels.join(', ')}` : ''}</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted">{c.sample.map(s => <li key={s.isrc || s.title} className="truncate">“{s.title}”{s.isrc && <span className="mono"> {s.isrc}</span>}</li>)}</ul>
          </div>
        ))}
      </div>
      {item.cases.length > 3 && <p className="mt-1 text-xs text-muted">+ {item.cases.length - 3} more with the same name</p>}
      {top && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-muted">Evidence</p>
            <ul className="space-y-0.5 text-sm">{top.evidence.map(e => <li key={e} className="flex items-start gap-1.5 text-[var(--t-green)]"><Check size={14} className="mt-0.5 shrink-0" /><span className="text-ink">{e}</span></li>)}</ul>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-muted">Conflicts</p>
            {top.conflicts.length ? <ul className="space-y-0.5 text-sm">{top.conflicts.map(e => <li key={e} className="flex items-start gap-1.5 text-[var(--t-orange)]"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span className="text-ink">{e}</span></li>)}</ul> : <p className="text-sm text-muted">None found</p>}
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">{item.reason}</p>
      {decided && item.decision ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={item.decision.decision === 'Same Person' ? 'violet' : 'green'} dot>{item.decision.decision === 'Same Person' ? 'Confirmed same artist' : 'Kept separate'}</Badge>
          <span className="text-muted">by {item.decision.by}, {fmtDate(item.decision.at)}: {item.decision.reason}</span>
          {item.decision.reversedAt ? <Badge>Reversed</Badge> : can('identityDecision') && <Button size="sm" variant="ghost" onClick={() => open('reverseIdentityDecision', { decisionId: item.decision!.id })}>Reverse</Button>}
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button variant="primary" size="sm" disabled={!can('identityDecision')} title={can('identityDecision') ? undefined : 'Needs a User or Admin account'} onClick={() => onDecide('Same Person')}>Confirm same artist</Button>
          <Button size="sm" disabled={!can('identityDecision')} onClick={() => onDecide('Keep Separate')}>Keep separate</Button>
          {item.status !== 'Deferred' && <Button size="sm" variant="ghost" disabled={!can('identityDecision')} onClick={() => onDecide('Defer')}>Review later</Button>}
        </div>
      )}
    </li>
  );
}

function DecideModal({ item, decision, onClose }: { item: Item; decision: 'Same Person' | 'Keep Separate' | 'Defer'; onClose: () => void }) {
  const app = useApp();
  const live = item.cases.filter(c => !c.mergedIntoId);
  const best = live.slice().sort((a, b) => b.sourceIds.length - a.sourceIds.length || b.verifiedPlatforms.length - a.verifiedPlatforms.length || b.songs - a.songs)[0];
  const [canonicalId, setCanonicalId] = useState(best?.id ?? '');
  const [reason, setReason] = useState(decision === 'Same Person' ? 'Same artist: the catalogue evidence matches' : decision === 'Keep Separate' ? 'Different artists' : 'Not sure yet');
  const [busy, setBusy] = useState(false);
  const evidence = item.pairs[0] ? [...item.pairs[0].evidence, ...item.pairs[0].conflicts.map(c => `Conflict: ${c}`)].join('; ') : item.reason;
  const save = async () => {
    setBusy(true);
    const r = await app.run('decideIdentity', { conflictId: item.id, decision, reason, evidence, canonicalId: decision === 'Same Person' ? canonicalId : undefined });
    setBusy(false);
    if (r) onClose();
  };
  const title = decision === 'Same Person' ? 'Confirm same artist' : decision === 'Keep Separate' ? 'Keep as separate artists' : 'Review later';
  return (
    <Modal open onClose={onClose} title={title} description={decision === 'Same Person' ? 'The records are merged into one artist. Source IDs, songs and history are kept, and the decision can be reversed.' : decision === 'Keep Separate' ? 'They stay two artists and this pair is not flagged again.' : 'Kept in “Review later”.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!reason.trim()} onClick={save}>{title}</Button></>}>
      <div className="space-y-3 text-sm">
        {decision === 'Same Person' && (
          <Field label="Keep this record (the other is merged into it)">
            <div className="space-y-1">{live.map(c => (
              <label key={c.id} className="flex items-center gap-2"><input type="radio" name="canonical" checked={canonicalId === c.id} onChange={() => setCanonicalId(c.id)} />{c.name} <span className="mono text-xs text-muted">{c.id}{c.sourceIds.length ? ` · ${c.sourceIds.join(', ')}` : ''} · {num(c.songs)} songs</span></label>
            ))}</div>
          </Field>
        )}
        <Field label="Reason" required><input className="field" value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <p className="text-xs text-muted">Evidence saved with the decision: {evidence}</p>
      </div>
    </Modal>
  );
}
