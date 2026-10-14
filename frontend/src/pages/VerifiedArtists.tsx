// Verified Artists (v2 §20-21): identity verified by a person. Here the operator decides the Goongoonalo status.
// V2.7.2: artists whose search started leave Artists and are followed here, first under “In progress” (searching, to
// review, passed away: continue or remove?), then under “Verified”.
import { Download, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { GOONGOONALO_INFO, GOONGOONALO_STATUSES } from '@domain/constants';
import { useActions } from '../components/actions';
import { DiscoveryChip, PlatformBadge } from '../components/discovery/bits';
import { diedText } from '@domain/life';
import type { LifeCheck } from '@domain/types';
import { IdentityBadge } from '../components/status';
import { Badge, Button, Card, DataTable, Empty, ErrorBox, Notice, PageHeader, Pagination, Pill, PillBar, Select, StatusBadge, Tabs, buttonClass } from '../components/ui';
import { useApp, useDebounced, useQuery } from '../lib/app';
import { fmtAgo, fmtDate, num } from '../lib/format';

interface Row {
  id: string; name: string; sourceIds: string[]; songs: number; artistStatus: string; goongoonaloStatus: string; goongoonaloAt: string | null; goongoonaloBy: string | null;
  platforms: { platform: string; username: string | null; url: string }[]; verifiedVia: string; lastVerified: string | null; stage: string; claimStatus: string; activationStatus: string; reopen: number;
  optOut: 'Not interested' | 'Do not disturb' | null; greetings: 'Unknown' | 'Yes' | 'No'; outreach: string | null; life: LifeCheck | null;
}
interface ProgressRow { id: string; name: string; sourceIds: string[]; songs: number; rank: number | null; artistStatus: string; discoveryStatus: string; action: { id: string; label: string } | null; lastDiscovery: string | null; life: LifeCheck | null; owner: string }
interface Views { progress: number; verified: number; decide: number }
interface Data { rows: Row[]; total: number; page: number; pageSize: number; counts: Record<string, number>; views: Views }
interface ProgressData { rows: ProgressRow[]; total: number; page: number; pageSize: number; counts: Record<string, number>; views: Views }
const PROGRESS: { id: string; label: string }[] = [
  { id: 'ALL', label: 'All' }, { id: 'DECIDE', label: 'Passed away: decide' }, { id: 'NEEDS_REVIEW', label: 'Needs review' }, { id: 'SEARCHING', label: 'Searching' }, { id: 'PENDING', label: 'No match yet' },
];
const SHORT: Record<string, string> = { reviewCandidates: 'Review', viewDiscovery: 'Progress', retrySearch: 'Retry search', findArtist: 'Find artist', reviewChanges: 'Review changes', openArtist: 'Open' };

export default function VerifiedArtists() {
  const [sp, setSp] = useSearchParams();
  const g = sp.get('goongoonalo') ?? 'ALL';
  const page = Number(sp.get('page') ?? 1);
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q.trim(), 250);
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v); else n.delete(k); if (!('page' in patch)) n.delete('page'); setSp(n, { replace: true }); };
  useEffect(() => { if ((sp.get('q') ?? '') !== dq) set({ q: dq || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const { meta } = useApp();
  const view = sp.get('view') === 'progress' ? 'progress' : 'verified';
  const status = sp.get('status') ?? 'ALL';
  const { data, error, loading } = useQuery<Data>(view === 'verified' ? 'verifiedArtists' : null, { goongoonalo: g, q: dq, page, status: status === 'REOPENED' ? status : undefined });
  const progress = useQuery<ProgressData>(view === 'progress' ? 'verifiedArtists' : null, { view: 'progress', status, q: dq, page }, { poll: (meta?.badges.searching ?? 0) > 0 ? 2500 : false });
  const views = data?.views ?? progress.data?.views;
  const navigate = useNavigate();
  const { open } = useActions();
  const app = useApp();
  const quick = async (r: Row, status: string) => {
    if (status === 'REJECTED' || status === 'DO_NOT_CONTACT') { open('setGoongoonalo', { caseId: r.id, preset: { status } }); return; }
    await app.run('setGoongoonaloStatus', { caseId: r.id, status, reason: status === 'GOONGOONALO' ? 'Joined Goongoonalo' : status === 'NOT_MEMBER' ? 'Not on Goongoonalo yet' : 'Back to pending' });
  };
  return (
    <>
      <PageHeader title="Verified Artists" subtitle="Artists you started (Find artist) move here from Artists: first “In progress” while the search runs and you review, then “Verified”. Decide the Goongoonalo status of verified artists here."
        actions={<a href="/api/export/verified-artists.xlsx" download className={buttonClass('secondary')} title="Every verified artist, in the artist directory’s layout: one column per platform under Social link, today’s song count"><Download size={16} />Download Excel</a>} />
      <Tabs value={view} onChange={t => set({ view: t === 'verified' ? null : t, status: null, goongoonalo: null })}
        tabs={[{ id: 'progress', label: 'In progress', count: views?.progress ?? null }, { id: 'verified', label: 'Verified', count: views?.verified ?? null }]} />
      {views && views.decide > 0 && view === 'verified' && (
        <div className="mt-3"><Notice tone="orange" title={`${views.decide} artist${views.decide === 1 ? '' : 's'} passed away: continue or remove?`} action={<Button size="sm" onClick={() => set({ view: 'progress', status: 'DECIDE' })}>Decide</Button>}>Find artist stopped before searching. Open the artist to decide.</Notice></div>
      )}
      <div className="mt-4">
      {view === 'progress' ? <ProgressList data={progress.data} error={progress.error} loading={progress.loading} q={q} setQ={setQ} status={status} set={set} /> : (
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          <div className="relative min-w-[min(100%,240px)] flex-1">
            <Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input className="field !pl-10" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, ID, song, ISRC or profile…" aria-label="Search verified artists" />
          </div>
          <PillBar label="Goongoonalo status">
            {(['ALL', ...GOONGOONALO_STATUSES] as const).map(s => (
              <Pill key={s} active={g === s} onClick={() => set({ goongoonalo: s === 'ALL' ? null : s })} count={data ? num(data.counts[s] ?? 0) : ''}>{s === 'ALL' ? 'All' : GOONGOONALO_INFO[s].label}</Pill>
            ))}
          </PillBar>
        </div>
        {error && <div className="p-3"><ErrorBox text={error} /></div>}
        <DataTable rows={data?.rows} loading={loading && !data} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.id}`)}
          empty={<Empty title="No verified artists here yet." text="Open an artist, click Find artist and verify the right profiles. Verified artists appear here." action={<Button onClick={() => set({ view: 'progress', status: 'NEEDS_REVIEW' })}>Artists that need review</Button>} />}
          columns={[
            { key: 'n', header: 'Artist', render: r => <span className="font-medium text-ink">{r.name}{r.life?.status === 'Deceased' && <Badge tone={r.life.decision ? 'neutral' : 'orange'} dot className="ml-1.5" title={r.life.description ?? ''}>Passed away</Badge>}<span className="mono block text-2xs font-normal text-muted">{r.id}{r.sourceIds.length ? ` · source ${r.sourceIds.join(', ')}` : ''}</span></span> },
            { key: 'p', header: 'Verified platforms', render: r => r.platforms.length ? <span className="flex flex-wrap gap-1">{r.platforms.map(p => <PlatformBadge key={p.url} platform={p.platform} size="sm" />)}</span> : <span className="text-xs text-muted">{r.verifiedVia}</span> },
            { key: 's', header: 'Songs', render: r => num(r.songs), className: 'tnum text-right', headClass: 'text-right', hide: 'xl' },
            { key: 'i', header: 'Identity', render: r => <IdentityBadge status={r.artistStatus} /> },
            { key: 'g', header: 'Goongoonalo status', render: r => (
              <span className="block min-w-[180px]" onClick={e => e.stopPropagation()}>
                <Select size="sm" className="!w-auto min-w-[12rem]" ariaLabel={`Goongoonalo status for ${r.name}`} value={r.goongoonaloStatus} onChange={v => quick(r, v)} options={GOONGOONALO_STATUSES.map(s => ({ value: s, label: GOONGOONALO_INFO[s].label, hint: GOONGOONALO_INFO[s].meaning }))} />
                {r.goongoonaloAt && <span className="block text-2xs text-muted">{fmtAgo(r.goongoonaloAt)}{r.goongoonaloBy ? ` · ${r.goongoonaloBy}` : ''}</span>}
              </span>
            ) },
            { key: 'o', header: 'Messages', render: r => (
              <span className="block min-w-[150px]" onClick={e => e.stopPropagation()}>
                {r.optOut ? <Badge tone="red" dot title="The artist opted out: nobody can message them">Opted out · {r.optOut}</Badge>
                  : r.outreach ? <Link to="/messages?tab=waiting" className="text-xs text-ink-2 hover:underline">{r.outreach}</Link> : <span className="text-xs text-faint">Not messaged</span>}
                {r.goongoonaloStatus === 'GOONGOONALO' && !r.optOut && (
                  <span className="mt-1 block"><Select size="sm" className="!w-auto min-w-[12rem]" ariaLabel={`Festival greetings for ${r.name}`} value={r.greetings} onChange={v => app.run('setGreetings', { caseId: r.id, consent: v, reason: 'Set in Verified Artists' })} options={[{ value: 'Unknown', label: 'Greetings: not asked' }, { value: 'Yes', label: 'Greetings: yes' }, { value: 'No', label: 'Greetings: no' }]} /></span>
                )}
              </span>
            ) },
            { key: 'c', header: 'Claim', render: r => <span onClick={e => e.stopPropagation()}><Link to={`/artists/${r.id}?tab=claims`} title="Open the claim steps: what each one means and what happened"><StatusBadge value={r.claimStatus} /></Link></span> },
            { key: 'v', header: 'Last verified', render: r => <span className="whitespace-nowrap">{fmtDate(r.lastVerified)}</span> },
            { key: 'x', header: '', render: r => <span onClick={e => e.stopPropagation()}><Link to={`/artists/${r.id}`}><Button size="sm">Open</Button></Link></span> },
          ]} />
        {data && data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={p => set({ page: String(p) })} />}
      </Card>
      )}
      </div>
    </>
  );
}

/** In progress: the search started, not verified yet. One button per row for the next step; passed away first. */
function ProgressList({ data, error, loading, q, setQ, status, set }: { data?: ProgressData | null; error?: string | null; loading: boolean; q: string; setQ: (v: string) => void; status: string; set: (p: Record<string, string | null>) => void }) {
  const navigate = useNavigate();
  const { open } = useActions();
  const act = (r: ProgressRow) => { if (!r.action || r.action.id === 'openArtist' || r.life?.status === 'Deceased') navigate(`/artists/${r.id}`); else open(r.action.id, { caseId: r.id }); };
  return (
    <Card pad={false}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
        <div className="relative min-w-[min(100%,240px)] flex-1">
          <Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="field !pl-10" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, ID, song, ISRC or profile…" aria-label="Search artists in progress" />
        </div>
        <PillBar label="Where the search stands">
          {PROGRESS.filter(p => p.id !== 'DECIDE' || (data?.counts.DECIDE ?? 0) > 0 || status === 'DECIDE').map(p => (
            <Pill key={p.id} active={status === p.id} onClick={() => set({ status: p.id === 'ALL' ? null : p.id })} count={data ? num(data.counts[p.id] ?? 0) : ''}>{p.label}</Pill>
          ))}
        </PillBar>
      </div>
      {error && <div className="p-3"><ErrorBox text={error} /></div>}
      <DataTable rows={data?.rows} loading={loading && !data} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.id}`)}
        empty={<Empty title="No artist in progress." text="Open an artist in Artists and click Find artist: it moves here while the search runs and you review what it found." action={<Link to="/artists"><Button>Go to Artists</Button></Link>} />}
        columns={[
          { key: 'n', header: 'Artist', render: r => (
            <span className="flex flex-wrap items-center gap-1.5">
              {r.rank != null && <span className="tnum min-w-[2.25rem] text-xs text-muted" title={`Rank ${r.rank}: by songs released`}>#{num(r.rank)}</span>}
              <span className="font-medium text-ink">{r.name}</span>
              {r.life?.status === 'Deceased' && <Badge tone="orange" dot title={r.life.description ?? ''}>Passed away · {diedText(r.life)}</Badge>}
              <span className="mono block w-full pl-[2.6rem] text-2xs font-normal text-muted">{r.id}</span>
            </span>
          ) },
          { key: 's', header: 'Songs', render: r => num(r.songs), className: 'tnum text-right', headClass: 'text-right' },
          { key: 'i', header: 'Identity', render: r => <IdentityBadge status={r.artistStatus} /> },
          { key: 'd', header: 'Search', render: r => <DiscoveryChip status={r.discoveryStatus} /> },
          { key: 'l', header: 'Last search', hide: 'xl', render: r => r.lastDiscovery ? <span className="whitespace-nowrap">{fmtAgo(r.lastDiscovery)}</span> : <span className="text-faint">{r.discoveryStatus === 'Searching' || r.discoveryStatus === 'Queued' ? 'Running' : 'From the directory'}</span> },
          { key: 'x', header: 'Next step', stick: true, render: r => (
            <span onClick={e => e.stopPropagation()}>
              <Button size="sm" variant={r.life?.status === 'Deceased' || r.artistStatus === 'NEEDS_REVIEW' ? 'primary' : 'secondary'} title={r.action?.label} onClick={() => act(r)}>
                {r.life?.status === 'Deceased' && !r.life.decision ? 'Decide' : r.action ? SHORT[r.action.id] ?? 'Open' : 'Open'}
              </Button>
            </span>
          ) },
        ]} />
      {data && data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={p => set({ page: String(p) })} />}
    </Card>
  );
}
