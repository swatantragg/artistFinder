// Connection graph: the artist in the middle and the people credited on the artist's songs around it. Each card says how
// they are connected: a shared song and their role on it (e.g. “Dil Ka Safar” · Composer). Click a card for every song.
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowRight, BadgeCheck, Search, Star, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Empty, Skeleton, buttonClass, cx } from '../ui';
import { useQuery } from '../../lib/app';
import { num, plural } from '../../lib/format';

interface SharedSong { id: string; title: string; album: string; roles: string[]; mine: string[] }
interface Person { key: string; name: string; caseId: string | null; kind: string; verified: boolean; roles: string[]; songCount: number; songs: SharedSong[] }
interface Network { center: { id: string; name: string; artistId: string | null; verified: boolean }; people: Person[] }

const FIRST = 16;            // people shown before "Show all" (readable without zooming)
const PER_COLUMN = 8, COL = 300, ROW = 86, GAP = 340;

type CenterNode = Node<{ name: string; artistId: string | null; verified: boolean; count: number }, 'center'>;
type PersonNode = Node<{ p: Person; side: 'left' | 'right'; selected: boolean }, 'person'>;

function CenterCard({ data }: NodeProps<CenterNode>) {
  return (
    <div className="w-[250px] rounded-xl border-2 border-accent-strong bg-accent-soft px-3.5 py-2.5 shadow-[var(--shadow)]">
      <Handle id="l" type="source" position={Position.Left} style={{ opacity: 0 }} />
      <Handle id="r" type="source" position={Position.Right} style={{ opacity: 0 }} />
      <p className="flex items-center gap-1.5 text-base font-semibold text-ink"><Star size={15} className="shrink-0 text-accent-text" /><span className="truncate">{data.name}</span>{data.verified && <BadgeCheck size={15} className="shrink-0 text-[var(--t-green)]" />}</p>
      <p className="text-xs text-muted">This artist{data.artistId ? ` · ${data.artistId}` : ''} · {plural(data.count, 'person', 'people')}</p>
    </div>
  );
}
function PersonCard({ data }: NodeProps<PersonNode>) {
  const p = data.p;
  const first = p.songs[0];
  return (
    <div className={cx('w-[250px] cursor-pointer rounded-xl border bg-surface px-3.5 py-2.5 text-left shadow-[var(--shadow)]', data.selected ? 'border-2 border-accent-strong' : 'border-line-strong hover:border-accent-line')}>
      <Handle id="t" type="target" position={data.side === 'right' ? Position.Left : Position.Right} style={{ opacity: 0 }} />
      <p className="flex items-center gap-1.5 text-sm font-semibold text-ink"><User size={14} className="shrink-0 text-muted" /><span className="truncate" title={p.name}>{p.name}</span>{p.verified && <BadgeCheck size={14} className="shrink-0 text-[var(--t-green)]" aria-label="Verified artist" />}</p>
      {first && <p className="truncate text-xs text-ink-2" title={`${first.title} · ${first.roles.join(', ')}`}>“{first.title}” · {first.roles.join(', ')}</p>}
      {p.songCount > 1 && <p className="text-xs text-muted">+{plural(p.songCount - 1, 'more song')}</p>}
    </div>
  );
}
const nodeTypes = { center: CenterCard, person: PersonCard };

export function PeopleGraph({ caseId, height = 620 }: { caseId: string; height?: number }) {
  return <ReactFlowProvider><Graph caseId={caseId} height={height} /></ReactFlowProvider>;
}

function Graph({ caseId, height }: { caseId: string; height: number }) {
  const { data } = useQuery<Network | null>('artistNetwork', { id: caseId });
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const flow = useReactFlow();
  const theme = typeof document !== 'undefined' ? (document.documentElement.dataset.theme as 'light' | 'dark' | undefined) ?? 'system' : 'system';
  const needle = q.trim().toLowerCase();
  const matching = useMemo(() => (data?.people ?? []).filter(p => !needle || p.name.toLowerCase().includes(needle) || p.songs.some(s => s.title.toLowerCase().includes(needle))), [data, needle]);
  const shown = all || needle ? matching : matching.slice(0, FIRST);
  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const nodes: Node[] = [{ id: 'center', type: 'center', position: { x: -125, y: -30 }, data: { name: data.center.name, artistId: data.center.artistId, verified: data.center.verified, count: data.people.length }, draggable: false }];
    const edges: Edge[] = [];
    const sides = { right: shown.filter((_, i) => i % 2 === 0), left: shown.filter((_, i) => i % 2 === 1) };
    for (const side of ['right', 'left'] as const) {
      const list = sides[side];
      list.forEach((p, i) => {
        const c = Math.floor(i / PER_COLUMN), r = i % PER_COLUMN, inCol = Math.min(PER_COLUMN, list.length - c * PER_COLUMN);
        const x = side === 'right' ? GAP + c * COL - 125 : -GAP - c * COL - 125;
        nodes.push({ id: p.key, type: 'person', position: { x, y: (r - (inCol - 1) / 2) * ROW - 30 }, data: { p, side, selected: sel === p.key } });
        edges.push({ id: `e-${p.key}`, source: 'center', sourceHandle: side === 'right' ? 'r' : 'l', target: p.key, targetHandle: 't', style: { stroke: sel === p.key ? 'var(--accent-strong)' : p.verified ? 'var(--t-green)' : 'var(--faint)', strokeWidth: Math.min(3.2, 1.2 + (p.songCount - 1) * 0.4) } });
      });
    }
    return { nodes, edges };
  }, [data, shown, sel]);
  useEffect(() => { const t = setTimeout(() => flow.fitView({ padding: 0.12, maxZoom: 1, duration: 200 }), 60); return () => clearTimeout(t); }, [nodes.length, flow]);
  const person = data?.people.find(p => p.key === sel) ?? null;

  if (!data) return <Skeleton className="h-96" />;
  if (!data.people.length) return <Empty title="No connections yet." text="People appear here when songs credit other singers, composers, lyricists or producers next to this artist." />;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <div className="relative min-w-[min(100%,240px)] flex-1 sm:max-w-sm">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="field !min-h-9 !py-1.5 !pl-9" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a person or a song" aria-label="Find a person or a song" />
        </div>
        <span className="text-xs text-muted">{needle ? `${num(matching.length)} of ${num(data.people.length)} people match` : `${num(shown.length)} of ${plural(data.people.length, 'person', 'people')}, most shared songs first`}</span>
        {!needle && data.people.length > FIRST && <Button size="sm" variant="ghost" onClick={() => setAll(a => !a)}>{all ? `Show the first ${FIRST}` : `Show all ${num(data.people.length)}`}</Button>}
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
        <div style={{ height: `min(${height}px, 72vh)` }} className="relative min-w-0">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.1} maxZoom={1.6} nodesDraggable nodesConnectable={false} colorMode={theme}
            onNodeClick={(_, n) => setSel(n.id === 'center' ? null : n.id)} onPaneClick={() => setSel(null)} proOptions={{ hideAttribution: true }}>
            <Background gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className="border-t border-line p-4 text-sm lg:border-l lg:border-t-0">
          {person ? (
            <div className="space-y-3">
              <div>
                <p className="flex items-center gap-1.5 text-md font-semibold text-ink">{person.name}{person.verified && <BadgeCheck size={16} className="text-[var(--t-green)]" />}</p>
                <p className="text-xs text-muted">{person.kind === 'Not linked' ? 'Not linked to an artist record' : person.kind} · {plural(person.songCount, 'song')} with {data.center.name}</p>
              </div>
              {person.caseId && (
                <Link to={`/artists/${person.caseId}?tab=graph`} className={cx(buttonClass('primary', 'md', true), 'min-w-0')} title={`Open ${person.name}’s artist page`}>
                  <span className="truncate">Open {person.name}</span><ArrowRight size={16} className="shrink-0" />
                </Link>
              )}
              <p className="border-t border-line pt-3 text-xs font-semibold uppercase tracking-wide text-muted">Shared songs · {person.songs.length}</p>
              <ul className="scroll-thin max-h-[44vh] space-y-2 overflow-y-auto">
                {person.songs.map(s => (
                  <li key={s.id} className="rounded-lg border border-line px-3 py-2">
                    <p className="font-medium text-ink">“{s.title}”{s.album && s.album !== s.title && <span className="font-normal text-muted"> · {s.album}</span>}</p>
                    <p className="text-xs text-ink-2">{person.name}: {s.roles.join(', ')}</p>
                    {s.mine.length > 0 && <p className="text-xs text-muted">{data.center.name}: {s.mine.join(', ')}</p>}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-2 text-xs text-ink-2">
              <p className="text-sm font-semibold text-ink">How to read it</p>
              <p>Each card is a person credited on {data.center.name}’s songs, with a shared song and their role on it.</p>
              <p><Badge tone="green">green line</Badge> the person is a verified artist · thicker line = more songs together.</p>
              <p>Click a card for every shared song and each person’s role on it.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
