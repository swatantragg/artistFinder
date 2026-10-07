// Artists: the operational workspace (v2 §12-13). One master list; statuses are filters of it, not separate pages.
import { Search, SearchX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ARTIST_STATUSES, ARTIST_STATUS_INFO } from '@domain/constants';
import { useActions } from '../components/actions';
import { DiscoveryChip, PlatformBadge, SearchBudget, type DiscoveryConfigV } from '../components/discovery/bits';
import { GoongoonaloBadge, IdentityBadge, KindBadge } from '../components/status';
import { Button, Card, DataTable, Empty, ErrorBox, Notice, PageHeader, Pagination, Pill, PillBar, Segmented } from '../components/ui';
import { useApp, useDebounced, useQuery } from '../lib/app';
import { fmtAgo, fmtDateTime, num } from '../lib/format';
import { BulkCard, BulkConfirm, type Bulk } from './Discovery';

export interface ArtistRow {
  id: string; name: string; aliases: string[]; sourceIds: string[]; kind: string; songs: number; collaborators: number; artistStatus: string; discoveryStatus: string;
  goongoonaloStatus: string; lastDiscovery: string | null; lastEvidence: string | null; lastEvidenceNote: string | null; action: { id: string; label: string } | null;
  matched: string | null; owner: string; reopenReasons: number; verifiedPlatforms: string[];
}
interface ArtistsData { rows: ArtistRow[]; total: number; page: number; pageSize: number; counts: Record<string, number>; kinds: { Artist: number; Collaborator: number } }
const TABS = ['ALL', ...ARTIST_STATUSES] as const;
const label = (s: string) => (s === 'ALL' ? 'All' : ARTIST_STATUS_INFO[s as keyof typeof ARTIST_STATUS_INFO].label);
/** Short button text for the row's next step (the full text is the tooltip). */
const SHORT: Record<string, string> = { findArtist: 'Find artist', reviewCandidates: 'Review', reviewChanges: 'Review changes', viewDiscovery: 'Progress', retrySearch: 'Retry search', setGoongoonalo: 'Goongoonalo…', openArtist: 'Open' };

export default function Artists() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? 'ALL';
  const kind = sp.get('kind') ?? 'Artist';
  const page = Number(sp.get('page') ?? 1);
  const sort = sp.get('sort') ?? '';
  const stage = sp.get('stage');   // drill-down from Reports (outreach stage)
  const urlQ = sp.get('q') ?? '';
  const [q, setQ] = useState(urlQ);
  const dq = useDebounced(q.trim(), 250);
  // The search box follows links that change ?q= while the page stays open (e.g. from another artist list).
  const pushedQ = useRef(urlQ);
  useEffect(() => { if (urlQ !== pushedQ.current) { pushedQ.current = urlQ; setQ(urlQ); } }, [urlQ]);
  const app = useApp();
  const navigate = useNavigate();
  const { open } = useActions();
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v); else n.delete(k); if (!('page' in patch)) n.delete('page'); setSp(n, { replace: true }); };
  useEffect(() => { if (urlQ !== dq) { pushedQ.current = dq; set({ q: dq || null }); } }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const searching = (app.meta?.badges.searching ?? 0) > 0;
  const { data, error, loading } = useQuery<ArtistsData>('artists', { status, kind, q: dq, stage: stage ?? undefined, page, sort: sort || undefined, dir: ['name', 'id'].includes(sort) ? 'asc' : 'desc' }, { poll: searching ? 2500 : false });
  const cfg = useQuery<DiscoveryConfigV>('discoveryConfig');
  const overview = useQuery<{ eligible: number; budgetArtists: number | null; blocked: string | null; limit: string | null; bulk: Bulk | null }>('discoveryOverview', { pageSize: 1 }, { poll: searching ? 2500 : false });
  const [confirm, setConfirm] = useState(false);
  const blocked = app.meta?.discoveryBlocked ?? null;
  const act = (r: ArtistRow) => { if (r.action) open(r.action.id === 'setGoongoonalo' ? 'setGoongoonalo' : r.action.id, { caseId: r.id }); };

  return (
    <>
      <PageHeader title="Artists"
        subtitle="Every artist from your imports, in one list. Open an artist and click Find artist: the software searches and organises the evidence, you verify, it remembers."
        actions={app.can('bulkDiscovery') && overview.data ? <Button icon={<Search size={17} />} disabled={!overview.data.eligible || !!blocked} title={blocked ?? undefined} onClick={() => setConfirm(true)}>Find all not yet searched ({num(overview.data.eligible)})</Button> : undefined} />
      {blocked && <div className="mb-3"><Notice tone="red" icon={<SearchX size={18} />} title="Find artist is off for this catalogue">{blocked}</Notice></div>}
      {cfg.data && <div className="mb-3"><SearchBudget cfg={cfg.data} compact /></div>}
      {overview.data?.bulk && !overview.data.bulk.done && <div className="mb-3 -mt-1"><BulkCard bulk={overview.data.bulk} /></div>}

      <Card pad={false}>
        <div className="space-y-3 border-b border-line p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[min(100%,260px)] flex-1">
              <Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
              <input className="field !pl-10" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, alias, Artist ID, ISRC, song, album, label or profile…" aria-label="Search artists" />
            </div>
            <Segmented options={[{ id: 'Artist', label: `Artists${data ? ` ${num(data.kinds.Artist)}` : ''}` }, { id: 'Collaborator', label: `Collaborators${data ? ` ${num(data.kinds.Collaborator)}` : ''}` }, { id: 'all', label: 'Everyone' }]} value={kind} onChange={v => set({ kind: v === 'Artist' ? null : v })} />
          </div>
          {stage && (
            <p className="flex items-center gap-2 text-sm text-ink-2">Showing outreach stage
              <button type="button" onClick={() => set({ stage: null })} className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2.5 py-0.5 font-medium text-ink hover:bg-hover" title="Show every stage">{stage}<X size={12} /></button>
            </p>
          )}
          <PillBar label="Status">
            {TABS.map(s => (
              <Pill key={s} active={status === s} onClick={() => set({ status: s === 'ALL' ? null : s })} title={s === 'ALL' ? 'Every artist' : ARTIST_STATUS_INFO[s].meaning} count={data ? num(data.counts[s] ?? 0) : ''}>{label(s)}</Pill>
            ))}
          </PillBar>
        </div>
        {error && <div className="p-3"><ErrorBox text={error} /></div>}
        <DataTable rows={data?.rows} loading={loading && !data} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.id}`)}
          sort={sort ? { key: sort, dir: ['name', 'id'].includes(sort) ? 'asc' : 'desc' } : undefined} onSort={k => set({ sort: sort === k ? null : k })}
          empty={<Empty title={dq ? `Nothing matches “${dq}”.` : 'No artists here.'} text={dq ? 'Try an ISRC, a song title, an album or a label.' : status === 'ALL' ? 'Upload an export on the Imports page: artists are extracted automatically.' : 'Pick another status above.'} action={!dq && status === 'ALL' ? <Link to="/imports"><Button variant="primary">Go to Imports</Button></Link> : undefined} />}
          columns={[
            { key: 'name', header: 'Artist', sort: 'name', render: r => (
              <div className="min-w-[170px]">
                <span className="flex flex-wrap items-center gap-1.5"><span className="font-medium text-ink">{r.name}</span><KindBadge kind={r.kind} />{r.verifiedPlatforms.slice(0, 4).map(p => <PlatformBadge key={p} platform={p} size="sm" />)}</span>
                {r.matched && <span className="block text-xs text-accent-text">{r.matched}</span>}
                {!r.matched && r.aliases.length > 0 && <span className="block text-xs text-muted">aka {r.aliases.join(', ')}</span>}
              </div>
            ) },
            { key: 'id', header: 'Artist ID', sort: 'id', render: r => <span className="mono whitespace-nowrap">{r.id}{r.sourceIds.length > 0 && <span className="block text-2xs text-muted">source {r.sourceIds.join(', ')}</span>}</span> },
            { key: 'songs', header: 'Songs', sort: 'songs', render: r => num(r.songs), className: 'tnum text-right', headClass: 'text-right' },
            { key: 'collab', header: 'Collab.', label: 'Collaborators', render: r => num(r.collaborators), className: 'tnum text-right', headClass: 'text-right', hide: '3xl' },
            { key: 'identity', header: 'Identity', render: r => <IdentityBadge status={r.artistStatus} /> },
            { key: 'disc', header: 'Discovery', render: r => <DiscoveryChip status={r.discoveryStatus} /> },
            { key: 'g', header: 'Goongoonalo', render: r => <GoongoonaloBadge status={r.goongoonaloStatus} /> },
            { key: 'lastDiscovery', header: 'Last discovery', sort: 'lastDiscovery', hide: '3xl', render: r => r.lastDiscovery ? <span title={fmtDateTime(r.lastDiscovery)} className="whitespace-nowrap">{fmtAgo(r.lastDiscovery)}</span> : <span className="text-faint">Never</span> },
            { key: 'lastEvidence', header: 'Last evidence', sort: 'lastEvidence', hide: '2xl', render: r => r.lastEvidence ? <span title={r.lastEvidenceNote ?? ''} className="whitespace-nowrap">{fmtAgo(r.lastEvidence)}</span> : <span className="text-faint">—</span> },
            { key: 'act', header: 'Action required', label: '', stick: true, render: r => (
              <span className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                {r.action ? <Button size="sm" variant={['findArtist', 'reviewCandidates', 'reviewChanges', 'retrySearch', 'setGoongoonalo'].includes(r.action.id) ? 'primary' : 'secondary'}
                  disabled={!!blocked && ['findArtist', 'retrySearch'].includes(r.action.id)} title={blocked && ['findArtist', 'retrySearch'].includes(r.action.id) ? blocked : r.action.label}
                  onClick={() => act(r)}>{SHORT[r.action.id] ?? 'Open'}</Button> : <Link to={`/artists/${r.id}`}><Button size="sm" variant="ghost">Open</Button></Link>}
              </span>
            ) },
          ]} />
        {data && data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={p => set({ page: String(p) })} />}
      </Card>
      {confirm && overview.data && <BulkConfirm count={overview.data.eligible} room={overview.data.budgetArtists} onClose={() => setConfirm(false)} />}
    </>
  );
}
