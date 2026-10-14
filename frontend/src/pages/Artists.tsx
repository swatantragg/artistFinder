// Artists: the operational workspace (v2 §12-13). V2.7.2: only artists not started yet; once Find artist runs they move
// to Verified Artists (In progress, then Verified). A search still finds every artist; Rejected shows the rejected ones.
import { ArrowRight, Search, SearchX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useActions } from '../components/actions';
import { DiscoveryChip, PlatformBadge, SearchBudget, type DiscoveryConfigV } from '../components/discovery/bits';
import { GoongoonaloBadge, IdentityBadge, KindBadge } from '../components/status';
import { Badge, Button, Card, DataTable, Empty, ErrorBox, FilterSelect, Notice, PageHeader, Pagination, Pill, PillBar } from '../components/ui';
import { useApp, useDebounced, useQuery } from '../lib/app';
import { fmtAgo, fmtDateTime, num } from '../lib/format';
import { BulkCard, BulkConfirm, type Bulk } from './Discovery';

export interface ArtistRow {
  id: string; name: string; aliases: string[]; sourceIds: string[]; kind: string; songs: number; collaborators: number; artistStatus: string; discoveryStatus: string;
  goongoonaloStatus: string; lastDiscovery: string | null; lastEvidence: string | null; lastEvidenceNote: string | null; action: { id: string; label: string } | null;
  matched: string | null; owner: string; reopenReasons: number; verifiedPlatforms: string[]; rank: number | null; followers: number | null; core?: boolean;
}
interface ArtistsData { rows: ArtistRow[]; total: number; page: number; pageSize: number; counts: Record<string, number>; kinds: { Artist: number; Collaborator: number; Label: number }; scope: 'top' | 'all'; topSize: number; everyone: number; moved: number; rejected: number }
/** Statuses that now live in Verified Artists (old links and bookmarks go there). */
const MOVED: Record<string, string> = { SEARCHING: '/verified?view=progress&status=SEARCHING', NEEDS_REVIEW: '/verified?view=progress&status=NEEDS_REVIEW', PENDING: '/verified?view=progress&status=PENDING', VERIFIED: '/verified', REOPENED: '/verified?status=REOPENED' };
/** Short button text for the row's next step (the full text is the tooltip). */
const SHORT: Record<string, string> = { findArtist: 'Find artist', reviewCandidates: 'Review', reviewChanges: 'Review changes', viewDiscovery: 'Progress', retrySearch: 'Retry search', setGoongoonalo: 'Goongoonalo…', openArtist: 'Open' };

export default function Artists() {
  const [sp, setSp] = useSearchParams();
  const asked = sp.get('status') ?? 'ALL';
  const status = asked === 'REJECTED' ? 'REJECTED' : 'ALL';
  const kind = sp.get('kind') ?? 'Artist';
  const page = Number(sp.get('page') ?? 1);
  const sort = sp.get('sort') ?? '';
  const dir = sp.get('dir') ?? (['name', 'id'].includes(sort) ? 'asc' : 'desc');
  const scope = sp.get('scope') === 'all' ? 'all' : 'top';   // the top artists first; “All artists” on request
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
  const { data, error, loading } = useQuery<ArtistsData>('artists', { status, kind, q: dq, stage: stage ?? undefined, scope, page, sort: sort || undefined, dir }, { poll: searching ? 2500 : false });
  const cfg = useQuery<DiscoveryConfigV>('discoveryConfig');
  const overview = useQuery<{ eligible: number; budgetArtists: number | null; blocked: string | null; limit: string | null; bulk: Bulk | null }>('discoveryOverview', { pageSize: 1 }, { poll: searching ? 2500 : false });
  const [confirm, setConfirm] = useState(false);
  const blocked = app.meta?.discoveryBlocked ?? null;
  const act = (r: ArtistRow) => { if (r.action) open(r.action.id === 'setGoongoonalo' ? 'setGoongoonalo' : r.action.id, { caseId: r.id }); };
  // Order: top artists (most songs, then most followers), A → Z or Z → A. A column header click shows as “By column”.
  const order = !sort ? (dq ? 'match' : 'rank') : sort === 'name' ? (dir === 'desc' ? 'za' : 'az') : 'col';
  const top = data?.scope === 'top';
  const who = kind === 'Collaborator' ? 'collaborators' : kind === 'Label' ? 'labels' : kind === 'all' ? 'people' : 'artists';
  // One choice for what to see: the top 250 by songs, everyone by songs, or everyone A → Z / Z → A
  const view = dq && !sort ? 'match' : sort === 'name' ? (dir === 'desc' ? 'za' : 'az') : sort ? 'col' : scope === 'all' ? 'all' : 'top';
  const setView = (v: string) => set(v === 'top' ? { scope: null, sort: null, dir: null } : v === 'all' ? { scope: 'all', sort: null, dir: null } : v === 'az' ? { scope: 'all', sort: 'name', dir: null } : v === 'za' ? { scope: 'all', sort: 'name', dir: 'desc' } : { sort: null, dir: null });
  // After the last page of the top list, carry on with everyone else in the same order (artist 251 onwards).
  const lastTopPage = !!data && top && order === 'rank' && status === 'ALL' && !stage && data.page * data.pageSize >= data.total && data.everyone > data.topSize;

  if (MOVED[asked]) return <Navigate to={MOVED[asked]} replace />;
  return (
    <>
      <PageHeader title="Artists"
        subtitle="Artists not started yet. Open an artist and click Find artist: it moves to Verified Artists while the software searches and you verify."
        actions={app.can('bulkDiscovery') && overview.data ? <Button icon={<Search size={17} />} disabled={!overview.data.eligible || !!blocked} title={blocked ?? undefined} onClick={() => setConfirm(true)}>Find all not yet searched ({num(overview.data.eligible)})</Button> : undefined} />
      {blocked && <div className="mb-3"><Notice tone="red" icon={<SearchX size={18} />} title="Find artist is off for this catalogue">{blocked}</Notice></div>}
      {cfg.data && <div className="mb-3"><SearchBudget cfg={cfg.data} compact /></div>}
      {overview.data?.bulk && !overview.data.bulk.done && <div className="mb-3 -mt-1"><BulkCard bulk={overview.data.bulk} /></div>}

      <Card pad={false}>
        <div className="space-y-3 border-b border-line p-3">
          <div className="relative">
            <Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input className="field !pl-10" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, alias, Artist ID, ISRC, song, album, label or profile…" aria-label="Search artists" />
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <FilterSelect label="Status" value={status} onChange={v => set({ status: v === 'ALL' ? null : v })}
              options={[{ id: 'ALL', label: 'Not started yet' }, { id: 'REJECTED', label: `Rejected${data ? ` · ${num(data.rejected)}` : ''}` }]} />
            <FilterSelect label="Who" value={kind} onChange={v => set({ kind: v === 'Artist' ? null : v })}
              options={[{ id: 'Artist', label: `Artists${data ? ` · ${num(data.kinds.Artist)}` : ''}` }, { id: 'Label', label: `Labels${data ? ` · ${num(data.kinds.Label)}` : ''}` }, { id: 'Collaborator', label: `Collaborators${data ? ` · ${num(data.kinds.Collaborator)}` : ''}` }, { id: 'all', label: 'Everyone' }]} />
          </div>
          <PillBar label="What to see">
            {dq && <Pill active={view === 'match'} onClick={() => setView('match')}>Best match</Pill>}
            <Pill active={view === 'top'} onClick={() => setView('top')} title={`The ${data?.topSize ?? 250} ${who} with the most songs`}>Top {data?.topSize ?? 250} by songs</Pill>
            <Pill active={view === 'all'} onClick={() => setView('all')}>All by songs</Pill>
            <Pill active={view === 'az'} onClick={() => setView('az')} title={`All ${who}, A to Z`}>A → Z</Pill>
            <Pill active={view === 'za'} onClick={() => setView('za')} title={`All ${who}, Z to A`}>Z → A</Pill>
            {view === 'col' && <Pill active onClick={() => setView('top')}>By column</Pill>}
          </PillBar>
          {data && !dq && (
            <p className="text-xs text-muted">{top
              ? <>The top {num(Math.min(data.topSize, data.everyone))} of {num(data.everyone)} {who}, ranked by songs released (equal songs: more followers first).{kind === 'Artist' ? ' Labels and companies have their own list (Who → Labels).' : ''}</>
              : view === 'az' || view === 'za' ? <>All {who}, {view === 'az' ? 'A → Z' : 'Z → A'}.</> : <>All {num(data.everyone)} {who}, most songs first.</>}</p>
          )}
          {data && !dq && data.moved > 0 && status === 'ALL' && (
            <p className="text-sm text-ink-2">{num(data.moved)} {data.moved === 1 ? 'artist' : 'artists'} you started {data.moved === 1 ? 'is' : 'are'} in <Link to="/verified?view=progress" className="font-medium text-accent-text underline">Verified Artists</Link> (In progress or Verified).</p>
          )}
          {stage && (
            <p className="flex items-center gap-2 text-sm text-ink-2">Showing outreach stage
              <button type="button" onClick={() => set({ stage: null })} className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2.5 py-0.5 font-medium text-ink hover:bg-hover" title="Show every stage">{stage}<X size={12} /></button>
            </p>
          )}
        </div>
        {error && <div className="p-3"><ErrorBox text={error} /></div>}
        <DataTable rows={data?.rows} loading={loading && !data} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.id}`)}
          sort={sort ? { key: sort, dir: dir === 'asc' ? 'asc' : 'desc' } : undefined} onSort={k => set({ sort: sort === k ? null : k, dir: null })}
          empty={<Empty title={dq ? `Nothing matches “${dq}”.` : 'No artists here.'} text={dq ? 'Try an ISRC, a song title, an album or a label.' : status === 'ALL' ? 'Upload an export on the Imports page: artists are extracted automatically.' : top ? `None of the top ${who} has this status. Pick Show → All ${who}, or another status.` : 'Pick another status above.'} action={!dq && status === 'ALL' ? <Link to="/imports"><Button variant="primary">Go to Imports</Button></Link> : undefined} />}
          columns={[
            { key: 'name', header: 'Artist', sort: 'name', render: r => (
              <div className="min-w-[170px]">
                <span className="flex flex-wrap items-center gap-1.5">{r.rank != null && <span className="tnum min-w-[2.25rem] text-xs text-muted" title={`Rank ${r.rank}: by songs released, then followers`}>#{num(r.rank)}</span>}<span className="font-medium text-ink">{r.name}</span><KindBadge kind={r.kind} />{r.core && <Badge tone="gold" title="Core member (artist directory)">Core member</Badge>}{r.verifiedPlatforms.slice(0, 4).map(p => <PlatformBadge key={p} platform={p} size="sm" />)}</span>
                {r.matched && <span className="block text-xs text-accent-text">{r.matched}</span>}
                {!r.matched && r.aliases.length > 0 && <span className="block text-xs text-muted">aka {r.aliases.join(', ')}</span>}
              </div>
            ) },
            { key: 'id', header: 'Artist ID', sort: 'id', render: r => <span className="mono whitespace-nowrap">{r.id}{r.sourceIds.length > 0 && <span className="block text-2xs text-muted">source {r.sourceIds.join(', ')}</span>}</span> },
            { key: 'songs', header: 'Songs', sort: 'songs', render: r => num(r.songs), className: 'tnum text-right', headClass: 'text-right' },
            ...(data?.rows.some(r => r.followers != null) ? [{ key: 'followers', header: 'Followers', render: (r: ArtistRow) => r.followers != null ? num(r.followers) : <span className="text-faint">—</span>, className: 'tnum text-right', headClass: 'text-right', hide: '2xl' as const }] : []),
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
        {lastTopPage && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-3 text-sm">
            <span className="text-ink-2">That is the top {num(data.topSize)}. The other {num(data.everyone - data.topSize)} {who} continue on the next pages.</span>
            <Button size="sm" variant="primary" icon={<ArrowRight size={15} />} onClick={() => set({ scope: 'all', page: String(Math.floor(data.topSize / data.pageSize) + 1) })}>Continue with {who} {num(data.topSize + 1)} onwards</Button>
          </div>
        )}
      </Card>
      {confirm && overview.data && <BulkConfirm count={overview.data.eligible} room={overview.data.budgetArtists} onClose={() => setConfirm(false)} />}
    </>
  );
}
