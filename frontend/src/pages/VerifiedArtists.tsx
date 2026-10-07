// Verified Artists (v2 §20-21): identity verified by a person. Here the operator decides the Goongoonalo status.
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { GOONGOONALO_INFO, GOONGOONALO_STATUSES } from '@domain/constants';
import { useActions } from '../components/actions';
import { PlatformBadge } from '../components/discovery/bits';
import { IdentityBadge } from '../components/status';
import { Button, Card, DataTable, Empty, ErrorBox, PageHeader, Pagination, Pill, PillBar } from '../components/ui';
import { useApp, useDebounced, useQuery } from '../lib/app';
import { fmtAgo, fmtDate, num } from '../lib/format';

interface Row {
  id: string; name: string; sourceIds: string[]; songs: number; artistStatus: string; goongoonaloStatus: string; goongoonaloAt: string | null; goongoonaloBy: string | null;
  platforms: { platform: string; username: string | null; url: string }[]; verifiedVia: string; lastVerified: string | null; stage: string; claimStatus: string; activationStatus: string; reopen: number;
}
interface Data { rows: Row[]; total: number; page: number; pageSize: number; counts: Record<string, number> }

export default function VerifiedArtists() {
  const [sp, setSp] = useSearchParams();
  const g = sp.get('goongoonalo') ?? 'ALL';
  const page = Number(sp.get('page') ?? 1);
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q.trim(), 250);
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v); else n.delete(k); if (!('page' in patch)) n.delete('page'); setSp(n, { replace: true }); };
  useEffect(() => { if ((sp.get('q') ?? '') !== dq) set({ q: dq || null }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error, loading } = useQuery<Data>('verifiedArtists', { goongoonalo: g, q: dq, page });
  const navigate = useNavigate();
  const { open } = useActions();
  const app = useApp();
  const quick = async (r: Row, status: string) => {
    if (status === 'REJECTED' || status === 'DO_NOT_CONTACT') { open('setGoongoonalo', { caseId: r.id, preset: { status } }); return; }
    await app.run('setGoongoonaloStatus', { caseId: r.id, status, reason: status === 'GOONGOONALO' ? 'Joined Goongoonalo' : 'Back to pending' });
  };
  return (
    <>
      <PageHeader title="Verified Artists" subtitle="Artists whose identity a person has verified. Decide their Goongoonalo status here: it never changes on its own, and it never changes the verification." />
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
          empty={<Empty title="No verified artists here yet." text="Open an artist, click Find artist and verify the right profiles. Verified artists appear here." action={<Link to="/artists?status=NEEDS_REVIEW"><Button>Artists that need review</Button></Link>} />}
          columns={[
            { key: 'n', header: 'Artist', render: r => <span className="font-medium text-ink">{r.name}<span className="mono block text-2xs font-normal text-muted">{r.id}{r.sourceIds.length ? ` · source ${r.sourceIds.join(', ')}` : ''}</span></span> },
            { key: 'p', header: 'Verified platforms', render: r => r.platforms.length ? <span className="flex flex-wrap gap-1">{r.platforms.map(p => <PlatformBadge key={p.url} platform={p.platform} size="sm" />)}</span> : <span className="text-xs text-muted">{r.verifiedVia}</span> },
            { key: 's', header: 'Songs', render: r => num(r.songs), className: 'tnum text-right', headClass: 'text-right', hide: 'xl' },
            { key: 'i', header: 'Identity', render: r => <IdentityBadge status={r.artistStatus} /> },
            { key: 'g', header: 'Goongoonalo status', render: r => (
              <span className="block min-w-[180px]" onClick={e => e.stopPropagation()}>
                <select aria-label={`Goongoonalo status for ${r.name}`} className="field !min-h-9 !w-auto !py-1 text-sm" value={r.goongoonaloStatus} onChange={e => quick(r, e.target.value)}>
                  {GOONGOONALO_STATUSES.map(s => <option key={s} value={s}>{GOONGOONALO_INFO[s].label}</option>)}
                </select>
                {r.goongoonaloAt && <span className="block text-2xs text-muted">{fmtAgo(r.goongoonaloAt)}{r.goongoonaloBy ? ` · ${r.goongoonaloBy}` : ''}</span>}
              </span>
            ) },
            { key: 'v', header: 'Last verified', render: r => <span className="whitespace-nowrap">{fmtDate(r.lastVerified)}</span> },
            { key: 'x', header: '', render: r => <span onClick={e => e.stopPropagation()}><Link to={`/artists/${r.id}`}><Button size="sm">Open</Button></Link></span> },
          ]} />
        {data && data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={p => set({ page: String(p) })} />}
      </Card>
    </>
  );
}
