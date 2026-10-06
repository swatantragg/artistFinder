// Import summary (v2 §37): what was received, how the file was read, which artists were found or created, possible
// duplicates, reopened artists and the rows that need a person. Every row keeps its raw values.
import { CheckCircle2, Copy, Loader2, ScanSearch, XCircle } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useActions } from '../components/actions';
import { DiscoveryChip, PlatformBadge } from '../components/discovery/bits';
import { IdentityBadge } from '../components/status';
import { Badge, Button, Card, DataTable, Empty, ErrorBox, KeyVal, Notice, PageHeader, Pagination, Skeleton, Stat, StatusBadge, Tabs, cx } from '../components/ui';
import { useApp, useQuery } from '../lib/app';
import { BulkConfirm } from './Discovery';
import { fmtDate, fmtDateTime, num } from '../lib/format';

interface Res {
  batch: {
    id: string; originalFilename: string; source: string; format: string; exportDate: string; uploadDate: string; uploaderName: string; importType: string; checksum: string; version: number; versionOfId: string | null; repeatOfId: string | null;
    rowCount: number; acceptedCount: number; quarantinedCount: number; skippedCount: number; status: string;
    summary: {
      artistsCreated: number; artistsUpdated: number; newSongs: number; updatedSongs: number; newCredits: number; reopenedCases: number; newTasks: number; newRoutes: number; claimChanges: number; activationChanges: number; identityExceptions: number;
      errors: string[]; warnings: string[]; classes: Record<string, number>; targetedJobIds?: string[]; artistCaseIds?: string[];
      artistsFound?: number; newCollaborators?: number; possibleDuplicates?: number; reopenedArtistIds?: string[]; mapping?: { field: string; column: string }[]; unmappedColumns?: string[]; headerRow?: number; encoding?: string;
    };
  };
  counts: Record<'Accepted' | 'Quarantined' | 'Skipped', number>;
  rows: { id: string; rowNumber: number; status: string; classification: string | null; reason: string | null; caseIds: string[]; caseNames: string[]; track: string | null; raw: Record<string, string> | null; mapped: Record<string, string> | null }[];
  total: number; page: number; pageSize: number;
  newArtists: { id: string; name: string; stage: string; artistId: string }[];
  newCollaborators: { id: string; name: string; stage: string; artistId: string }[];
  updated: { id: string; name: string; stage: string; artistId: string }[];
  reopenedArtists: { id: string; name: string; status: string; reasons: string[] }[];
  duplicates: { id: string; kind: string; status: string; names: string[] }[];
  tasks: { id: string; step: string; caseId: string; caseName: string; due: string; status: string }[];
}
const FIELD_LABEL: Record<string, string> = { trackId: 'Song ID', rowIndex: 'Row number', isrc: 'ISRC', upc: 'UPC', title: 'Song title', version: 'Version', album: 'Album', albumId: 'Album ID', catalogNo: 'Catalogue no.', artists: 'Artists', artistId: 'Artist ID', artistRole: 'Artist role', composer: 'Composer', lyricist: 'Lyricist', producer: 'Producer', credits: 'Credits', musicianCredits: 'Musicians', label: 'Label', distributor: 'Distributor', publisher: 'Publisher', language: 'Language', genre: 'Genre', releaseDate: 'Release date', goLiveDate: 'Go-live date', dateSubmitted: 'Date submitted', duration: 'Duration', contentType: 'Content type', vocalInstrumental: 'Vocal / instrumental', territory: 'Territory', godName: 'God name', audioPath: 'Audio path', profileUrl: 'Profile URL', claimStatus: 'Claim status', activity: 'Activity' };

export default function ImportResult() {
  const { id = '' } = useParams();
  const [tab, setTab] = useState('artists');
  const [page, setPage] = useState(1);
  const rowTab = tab === 'review' ? 'Quarantined' : tab === 'accepted' ? 'Accepted' : tab === 'skipped' ? 'Skipped' : tab;
  const { data, error } = useQuery<Res | null>('importBatch', { id, tab: rowTab, page });
  const navigate = useNavigate();
  if (error) return <ErrorBox text={error} />;
  if (data === null) return <Empty title="Import not found." />;
  if (!data) return <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-40" /><Skeleton className="h-80" /></div>;
  const b = data.batch, s = b.summary;
  const ok = b.status === 'Processed';
  const headline = b.status === 'Repeat' ? 'Repeat upload detected. Existing batch retained. No duplicate work created.'
    : b.status === 'Failed' ? `Import failed: ${s.errors[0] ?? 'unknown layout'}` : `Import ${b.id} complete`;
  const caseTable = (list: { id: string; name: string; artistId: string }[], empty: string) => (
    <DataTable rows={list} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.id}`)} empty={<Empty compact title={empty} />}
      columns={[{ key: 'n', header: 'Name', render: r => <span className="font-medium">{r.name}</span> }, { key: 'i', header: 'Artist ID', render: r => <span className="mono">{r.id}</span> }, { key: 'a', header: 'Source ID', render: r => <span className="mono">{r.artistId || '—'}</span> }]} />
  );
  const review = b.quarantinedCount;
  return (
    <>
      <PageHeader back={{ to: '/imports', label: 'Imports' }} title={<span className="flex items-center gap-2">{ok ? <CheckCircle2 className="text-[var(--t-green)]" size={22} /> : b.status === 'Repeat' ? <Copy className="text-[var(--t-orange)]" size={22} /> : <XCircle className="text-[var(--t-red)]" size={22} />}{headline}</span>}
        subtitle={`${b.originalFilename} · ${b.format} · uploaded ${fmtDateTime(b.uploadDate)} by ${b.uploaderName}`} />

      {b.status === 'Repeat' && <Notice tone="orange" title={`Same file content as import ${b.repeatOfId}`}>Nothing was created: no new artists, songs, credits, routes or tasks. <Link className="underline" to={`/imports/${b.repeatOfId}`}>Open {b.repeatOfId}</Link></Notice>}
      {b.versionOfId && <Notice tone="blue" title={`Version ${b.version} of ${b.versionOfId}`}>A corrected file with the same name. The earlier import and its evidence are kept; credits it no longer lists are marked superseded, not deleted.</Notice>}
      {s.warnings.map(w => <div key={w} className="mt-2"><Notice tone="neutral">{w}</Notice></div>)}
      {(s.targetedJobIds?.length ?? 0) > 0 && <div className="mt-2"><Notice tone="blue" icon={<ScanSearch size={16} />} title={`Targeted discovery started for ${s.targetedJobIds!.length} artist${s.targetedJobIds!.length === 1 ? '' : 's'} already searched`}>New songs or collaborators arrived for artists the software already researched. Only the new evidence is searched; verified profiles and earlier results are kept.</Notice></div>}
      {b.status === 'Repeat' && (s.artistCaseIds?.length ?? 0) > 0 && <div className="mt-4"><ImportArtists batchId={b.id} repeat /></div>}

      {b.status !== 'Repeat' && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
          <Stat label="Rows received" value={b.rowCount} />
          <Stat label="Rows accepted" value={b.acceptedCount} tone="green" />
          <Stat label="Rows skipped" value={b.skippedCount} />
          <Stat label="Rows to review" value={review} tone={review ? 'red' : 'neutral'} onClick={review ? () => setTab('review') : undefined} />
          <Stat label="Artists found" value={s.artistsFound ?? s.artistCaseIds?.length ?? 0} onClick={() => setTab('artists')} />
          <Stat label="New artists" value={s.artistsCreated} onClick={() => setTab('new')} />
          <Stat label="Existing artists updated" value={s.artistsUpdated} onClick={() => setTab('updated')} />
          <Stat label="New songs" value={s.newSongs} />
          <Stat label="New collaborators" value={s.newCollaborators ?? 0} onClick={() => setTab('collaborators')} />
          <Stat label="Possible duplicates" value={s.possibleDuplicates ?? 0} tone={s.possibleDuplicates ? 'orange' : undefined} onClick={() => setTab('duplicates')} />
          <Stat label="Reopened artists" value={s.reopenedArtistIds?.length ?? 0} tone={s.reopenedArtistIds?.length ? 'violet' : undefined} onClick={() => setTab('reopened')} />
          <Stat label="Errors" value={review + s.errors.filter(e => !/row\(s\) need review/.test(e)).length} tone={review ? 'red' : undefined} />
        </div>
      )}

      {b.status !== 'Repeat' && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.3fr]">
          <Card title="Import record">
            <KeyVal items={[
              ['Import ID', <span key="i" className="mono">{b.id}</span>], ['Status', <StatusBadge key="s" value={b.status} />], ['File', b.originalFilename], ['File type', `${b.format}${s.encoding ? ` · ${s.encoding}` : ''}`],
              ['Uploader', b.uploaderName], ['Uploaded', fmtDateTime(b.uploadDate)], ['Export date', fmtDate(b.exportDate)], ['Source', b.source], ['Import version', b.version > 1 ? `${b.version} (of ${b.versionOfId})` : '1'],
              ['Checksum', <span key="c" className="mono text-xs break-all">{b.checksum}</span>],
            ]} />
          </Card>
          <Card title="How the file was read" subtitle={s.headerRow ? `Header found on row ${s.headerRow}. Columns are matched by name; nothing missing is invented.` : 'G Amplify standard columns'}>
            {s.mapping?.length ? (
              <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">{s.mapping.map(m => <li key={m.field} className="flex justify-between gap-3"><span className="text-muted">{FIELD_LABEL[m.field] ?? m.field}</span><span className="truncate text-right text-ink" title={m.column}>“{m.column}”</span></li>)}</ul>
            ) : <p className="text-sm text-ink-2">artist_id, artist_name, artist_role, track_id, title, label, distributor, credits …</p>}
            {(s.unmappedColumns?.length ?? 0) > 0 && <p className="mt-2 text-xs text-muted">Kept in the raw rows only: {s.unmappedColumns!.join(', ')}</p>}
          </Card>
        </div>
      )}

      {b.status !== 'Processed' ? null : <div className="mt-4 rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
        <div className="px-2">
          <Tabs value={tab} onChange={t => { setTab(t); setPage(1); }} tabs={[
            { id: 'artists', label: 'Artists in this file', count: s.artistCaseIds?.length ?? null },
            { id: 'new', label: 'New artists', count: data.newArtists.length }, { id: 'collaborators', label: 'New collaborators', count: data.newCollaborators.length },
            { id: 'updated', label: 'Updated', count: data.updated.length }, { id: 'duplicates', label: 'Possible duplicates', count: data.duplicates.length }, { id: 'reopened', label: 'Reopened', count: data.reopenedArtists.length },
            { id: 'review', label: 'Rows to review', count: data.counts.Quarantined }, { id: 'accepted', label: 'Accepted rows', count: data.counts.Accepted }, { id: 'skipped', label: 'Skipped rows', count: data.counts.Skipped },
            { id: 'tasks', label: 'Tasks', count: data.tasks.length },
          ]} />
        </div>
        {tab === 'artists' && <div className="p-3"><ImportArtists batchId={b.id} /></div>}
        {['review', 'accepted', 'skipped'].includes(tab) && <RowTable data={data} tab={rowTab} page={page} setPage={setPage} />}
        {tab === 'new' && caseTable(data.newArtists, 'No new artists in this file.')}
        {tab === 'collaborators' && caseTable(data.newCollaborators, 'No new collaborators in this file.')}
        {tab === 'updated' && caseTable(data.updated, 'No existing artist was updated.')}
        {tab === 'duplicates' && (!data.duplicates.length ? <Empty compact title="No possible duplicates from this file." /> : (
          <ul className="divide-y divide-line">{data.duplicates.map(x => <li key={x.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm"><Badge>{x.kind}</Badge><span className="text-ink">{x.names.join(' ↔ ')}</span><span className="text-xs text-muted">{x.status}</span><Link to="/deduplicate" className="ml-auto"><Button size="sm">Review in Deduplicate</Button></Link></li>)}</ul>
        ))}
        {tab === 'reopened' && (!data.reopenedArtists.length ? <Empty compact title="No artists reopened by this file." text="Artists reopen when new songs or collaborators arrive for artists a person already worked on." /> : (
          <ul className="divide-y divide-line">
            {data.reopenedArtists.map(r => (
              <li key={r.id} className="px-4 py-3">
                <span className="flex flex-wrap items-center gap-2"><Link to={`/artists/${r.id}`} className="text-base font-semibold text-ink hover:underline">{r.name}</Link><IdentityBadge status={r.status} /></span>
                <ul className="mt-1 list-inside list-disc text-sm text-ink-2">{r.reasons.map(x => <li key={x}>{x}</li>)}</ul>
              </li>
            ))}
          </ul>
        ))}
        {tab === 'tasks' && (
          <DataTable rows={data.tasks} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.caseId}`)} empty={<Empty compact title="No tasks created." text="Imports only create tasks for meaningful new evidence, never for unchanged rows." />}
            columns={[{ key: 'id', header: 'Task', render: r => <span className="mono">{r.id}</span> }, { key: 'c', header: 'Artist', render: r => r.caseName }, { key: 's', header: 'Step', render: r => r.step }, { key: 'd', header: 'Due', render: r => fmtDate(r.due) }, { key: 'st', header: 'Status', render: r => <StatusBadge value={r.status} /> }]} />
        )}
      </div>}
    </>
  );
}

/** Import rows with what was understood; the original values are one click away. */
function RowTable({ data, tab, page, setPage }: { data: Res; tab: string; page: number; setPage: (p: number) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-xs text-muted">
        <span>{tab === 'Quarantined' ? 'Rows that need a person: the original values and the reason are kept. Nothing is dropped.' : 'Click a row for all its values.'}</span>
        <button type="button" className="underline" onClick={() => setRaw(r => !r)}>{raw ? 'Show as read' : 'Show original values'}</button>
      </div>
      <DataTable rows={data.rows} rowKey={r => r.id} dense onRowClick={r => setOpenId(openId === r.id ? null : r.id)} empty={<Empty compact title="No rows here." />}
        columns={[
          { key: 'n', header: 'Row', render: r => <span className="tnum">{r.rowNumber}</span> },
          { key: 't', header: 'Song', render: r => r.track ?? r.mapped?.title ?? r.raw?.title ?? '—' },
          { key: 'a', header: 'Artists', render: r => r.caseIds.length ? r.caseIds.map((id, i) => <Link key={id} to={`/artists/${id}`} onClick={e => e.stopPropagation()} className="mr-2 underline decoration-line-strong hover:decoration-ink">{r.caseNames[i]}</Link>) : <span className="text-muted">{r.mapped?.artists ?? '—'}</span> },
          { key: 'c', header: tab === 'Accepted' ? 'What changed' : 'Reason', render: r => tab === 'Accepted' ? <Badge tone={r.classification === 'New Evidence (route)' ? 'gold' : r.classification === 'New Artist' ? 'blue' : 'neutral'}>{r.classification}</Badge> : <span className={tab === 'Quarantined' ? 'text-[var(--t-red)]' : 'text-muted'}>{r.reason}</span> },
          { key: 'v', header: raw ? 'Original values' : 'Values as read', render: r => {
            const values = raw ? r.raw : r.mapped ?? r.raw;
            const text = values ? Object.entries(values).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ') : '—';
            return openId === r.id && values ? <dl className="grid max-w-[560px] grid-cols-[auto_1fr] gap-x-3 text-xs">{Object.entries(values).filter(([, v]) => v).map(([k, v]) => <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="break-words">{v}</dd></Fragment>)}</dl> : <code className={cx('mono block max-w-[440px] truncate text-xs')} title={text}>{text}</code>;
          } },
        ]} />
      {data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      {tab === 'Quarantined' && data.counts.Quarantined > 0 && <p className="border-t border-line px-3 py-2 text-xs text-muted">Resolve these rows on the Imports page (Rows to review), or upload a corrected file with the same name: it becomes a new version.</p>}
    </>
  );
}

interface ArtistsData { total: number; page: number; pageSize: number; counts: { verified: number; notStarted: number; needsVerification: number; searching: number }; eligible: number; caseIds: string[]; rows: { id: string; name: string; artistId: string; songsInFile: number | null; songs: number; stage: string; status: string; verified: { platform: string; username: string | null; url: string }[]; lastVerifiedAt: string | null; candidates: number; active: { step: number; status: string } | null }[] }
/** Artists named in the file: verified artists are reused (no full search); the others get Find artist. */
function ImportArtists({ batchId, repeat }: { batchId: string; repeat?: boolean }) {
  const [page, setPage] = useState(1);
  const [fast, setFast] = useState(false);
  const { data } = useQuery<ArtistsData | null>('importArtists', { id: batchId, page }, { poll: fast ? 1500 : false });
  const { open } = useActions();
  const app = useApp();
  const navigate = useNavigate();
  const [bulk, setBulk] = useState(false);
  const searching = !!data?.rows.some(r => r.active);
  useEffect(() => { setFast(searching); }, [searching]);
  if (!data) return <Skeleton className="h-32" />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">{repeat ? 'Repeat import: nothing was processed again. The artists in this file: ' : ''}<b>{num(data.total)}</b> artist{data.total === 1 ? '' : 's'} · <span className="text-[var(--t-green)]">{num(data.counts.verified)} verified (profiles reused, no full search)</span> · {num(data.counts.notStarted)} not searched yet · {num(data.counts.needsVerification)} need verification</p>
        {data.eligible > 0 && app.can('bulkDiscovery') && <Button size="sm" variant="primary" icon={<ScanSearch size={14} />} onClick={() => setBulk(true)}>Find all {num(data.eligible)} unverified</Button>}
      </div>
      <DataTable rows={data.rows} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.id}`)} empty={<Empty compact title="No known artists in this file." />}
        columns={[
          { key: 'n', header: 'Artist', render: r => <span className="font-medium text-ink">{r.name}</span> },
          { key: 'a', header: 'Artist ID', render: r => <span className="mono">{r.artistId}</span> },
          { key: 's', header: 'Songs', render: r => <span className="tnum">{r.songsInFile != null ? `${r.songsInFile} in file · ` : ''}{r.songs} total</span> },
          { key: 'd', header: 'Discovery', render: r => r.active ? <span className="inline-flex items-center gap-1.5 text-sm text-[var(--t-blue)]"><Loader2 size={12} className="animate-spin" />{r.active.status === 'QUEUED' ? 'Queued' : `Searching ${r.active.step + 1}/7`}</span>
            : r.verified.length ? (
              <span className="flex flex-wrap items-center gap-1.5"><Badge tone="green" dot>Verified artist found</Badge>{r.verified.map(v => <PlatformBadge key={v.url} platform={v.platform} size="sm" />)}<span className="text-xs text-muted">last verified {fmtDate(r.lastVerifiedAt)}</span></span>
            ) : <DiscoveryChip status={r.status} extra={r.candidates ? `(${r.candidates})` : undefined} /> },
          { key: 'x', header: '', render: r => (
            <span className="flex gap-1.5" onClick={e => e.stopPropagation()}>
              {r.verified.length > 0 ? <>
                <Button size="sm" onClick={() => navigate(`/artists/${r.id}?tab=evidence`)}>View profile</Button>
                <Button size="sm" variant="ghost" disabled={!!app.meta?.discoveryBlocked} title={app.meta?.discoveryBlocked ?? undefined} onClick={() => open('refreshSearch', { caseId: r.id })}>Refresh search</Button>
              </> : r.status === 'Not started' || r.status === 'Failed' ? <Button size="sm" variant="primary" disabled={!!app.meta?.discoveryBlocked} title={app.meta?.discoveryBlocked ?? undefined} onClick={() => open('findArtist', { caseId: r.id })}>{r.status === 'Failed' ? 'Retry' : 'Find artist'}</Button>
                : <Button size="sm" onClick={() => navigate(`/artists/${r.id}?tab=evidence`)}>{r.status === 'Needs verification' ? 'Review' : 'View results'}</Button>}
            </span>
          ) },
        ]} />
      {data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      {bulk && <BulkConfirm count={data.eligible} caseIds={data.caseIds} onClose={() => setBulk(false)} />}
    </div>
  );
}
