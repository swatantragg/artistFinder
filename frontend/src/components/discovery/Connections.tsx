// Possible connection paths from Find connection: create a candidate route, reject the path, or show it on the graph.
import { Route as RouteIcon, Share2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useActions } from '../actions';
import { Badge, Button, Card, Empty, cx } from '../ui';
import { useApp } from '../../lib/app';
import { fmtAgo } from '../../lib/format';

export interface PathV {
  id: string; steps: { nodeId: string; kind: string; label: string; sub?: string | null; via?: string | null }[]; strength: string; strengthLabel: string; score: number; edgeCount: number;
  evidence: string[]; status: string; note: string | null; reason: string | null; foundAt: string; lastFoundAt: string; isNew: boolean; route: { id: string; state: string } | null;
  contact: { name: string; channel: string; willingIntroducer: boolean } | null; decidedBy: string | null; targetType: string;
}

export function PossibleConnections({ caseId, paths, onShow, onFind, finding }: { caseId: string; paths: PathV[]; onShow?: (id: string) => void; onFind?: () => void; finding?: boolean }) {
  const app = useApp();
  const { open } = useActions();
  const [showClosed, setShowClosed] = useState(false);
  const usable = paths.filter(p => p.status !== 'REJECTED' && !p.note);
  const closed = paths.filter(p => p.status === 'REJECTED' || p.note);
  return (
    <Card title={<span className="flex items-center gap-2"><Share2 size={14} />Possible connections</span>} subtitle="Paths to a verified contact through shared catalogue relationships. A path is evidence, not a confirmed personal relationship."
      actions={onFind && <Button size="sm" variant="primary" loading={finding} onClick={onFind}>Find connection</Button>} pad={!usable.length}>
      {!usable.length ? <Empty compact title="No connection path yet." text="Find connection searches songs, collaborators, labels and verified contacts up to three hops away." /> : (
        <ul className="divide-y divide-line">
          {usable.map(p => (
            <li key={p.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-2xs font-semibold uppercase tracking-wider text-accent-text">{p.route ? 'Route created' : 'Connection found'}</p>
                <Badge tone={p.strength === 'STRONG' ? 'green' : p.strength === 'POSSIBLE' ? 'gold' : 'neutral'} dot>{p.strengthLabel}</Badge>
                <span className="text-xs text-muted">path score {p.score} · {p.edgeCount} step{p.edgeCount === 1 ? '' : 's'}</span>
                {p.isNew && <Badge tone="blue">New</Badge>}
                <span className="text-xs text-faint">found {fmtAgo(p.foundAt)}</span>
              </div>
              <ol className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm">
                {p.steps.map((s, i) => (
                  <li key={s.nodeId + i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-xs text-muted">→{s.via ? <span className="ml-0.5 text-faint">{s.via.toLowerCase()}</span> : null}</span>}
                    <span className={cx('rounded-md border px-1.5 py-0.5', i === 0 ? 'border-accent-strong bg-accent-soft font-medium' : 'border-line bg-surface-2')}>{s.label}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-1 text-xs text-muted">{p.targetType === 'profile' ? 'Direct message to the artist’s own verified profile. No introduction, so it ranks below a warm path.' : p.edgeCount > 3 ? 'Possible evidence path through shared catalogue relationships. Nobody here is confirmed to know the artist.' : 'Evidence path, not a confirmed personal relationship.'}{p.contact?.willingIntroducer ? ` ${p.contact.name} has agreed to make introductions before.` : ''}</p>
              <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-xs text-ink-2">{p.evidence.map(e => <li key={e}>{e}</li>)}</ul>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {!p.route && <Button size="sm" variant="primary" icon={<RouteIcon size={13} />} onClick={() => app.run('createRouteFromPath', { pathId: p.id })}>Create route</Button>}
                {p.route?.state === 'Candidate' && <>
                  <Button size="sm" variant="primary" onClick={() => open('verifyRouteDiscovery', { caseId, routeId: p.route!.id, preset: { path: p.steps.map(s => s.label).join(' → ') } })}>Verify route</Button>
                  <Button size="sm" variant="danger" onClick={() => open('rejectRoute', { caseId, routeId: p.route!.id })}>Reject route</Button>
                </>}
                {p.route && p.route.state !== 'Candidate' && <Link to={`/artists/${caseId}?tab=routes`}><Button size="sm">Route {p.route.id}: {p.route.state}</Button></Link>}
                {!p.route && <Button size="sm" variant="danger" onClick={() => open('rejectConnectionPath', { caseId, preset: { pathId: p.id } })}>Reject</Button>}
                {onShow && <Button size="sm" variant="ghost" onClick={() => onShow(p.id)}>Open graph</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <div className="border-t border-line px-4 py-2">
          <button type="button" className="text-xs text-muted underline" onClick={() => setShowClosed(s => !s)}>{showClosed ? 'Hide' : 'Show'} {closed.length} path{closed.length === 1 ? '' : 's'} already tried, blocked or rejected</button>
          {showClosed && <ul className="mt-2 space-y-1.5 text-xs text-ink-2">{closed.map(p => <li key={p.id}>{p.steps.map(s => s.label).join(' → ')} <span className="text-muted">· {p.note ?? `Rejected: ${p.reason}${p.decidedBy ? ` (${p.decidedBy})` : ''}`}</span></li>)}</ul>}
        </div>
      )}
    </Card>
  );
}
