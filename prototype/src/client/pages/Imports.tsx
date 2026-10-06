// Imports: upload an export (CSV/XLSX). The upload returns at once with an import job; progress is shown while the
// rows are processed in the background, then the import summary opens.
import { CheckCircle2, Download, FileSpreadsheet, FileUp, Loader2, Upload, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { templateCsv } from '../../domain/importer';
import { MEDIA_COLUMNS } from '../../domain/importmap';
import type { ImportJobView } from '../api/backend';
import { useActions } from '../components/actions';
import { Button, Card, DataTable, Empty, ErrorBox, Field, Notice, PageHeader, Segmented, StatusBadge, Tabs, cx } from '../components/ui';
import { useApp, useQuery } from '../lib/app';
import { download, fmtDateTime, fmtShort, num, todayLocal } from '../lib/format';

export default function Imports() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'batches';
  const { meta } = useApp();
  return (
    <>
      <PageHeader title="Imports" subtitle="Upload the media-library export (CSV or Excel). Artists, songs, ISRCs, albums, labels and credits are extracted automatically; known artists are recognised and nothing is duplicated." />
      {meta && !meta.permissions.import ? (
        <Notice tone="orange" title={`${meta.me?.name} (${meta.me?.role}) cannot upload imports.`}>Switch to the System Owner, a G Amplify Lead or an Admin (top right) to upload. You can still review imports below.</Notice>
      ) : <Uploader />}
      <div className="mt-5 rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
        <div className="px-2"><Tabs tabs={[{ id: 'batches', label: 'Imports' }, { id: 'exceptions', label: 'Rows to review', count: meta?.badges.exceptions ?? null }]} value={tab} onChange={t => setSp(t === 'batches' ? {} : { tab: t }, { replace: true })} /></div>
        {tab === 'batches' ? <Batches /> : <Exceptions />}
      </div>
    </>
  );
}

function JobCard({ job, error }: { job: ImportJobView | null; error: string | null }) {
  if (!job && !error) return null;
  const failed = !!error || job?.status === 'FAILED';
  const done = job?.status === 'COMPLETED';
  return (
    <div className={cx('mt-4 rounded-md border px-3.5 py-3', failed ? 'border-[var(--t-red-bd)]' : done ? 'border-[var(--t-green-bd)]' : 'border-[var(--t-blue-bd)]')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {failed ? <XCircle size={16} className="text-[var(--t-red)]" /> : done ? <CheckCircle2 size={16} className="text-[var(--t-green)]" /> : <Loader2 size={16} className="animate-spin text-[var(--t-blue)]" />}
        <b className="text-ink">{failed ? 'Import failed' : done ? 'Import complete' : 'Import started'}</b>
        {job && <span className="mono text-xs text-muted">Job {job.id}</span>}
        {job && <span className="text-xs text-muted">· {job.status === 'QUEUED' ? 'Waiting' : job.status === 'PROCESSING' ? `Processing: ${job.step}` : job.status === 'COMPLETED' ? 'Done' : 'Failed'}</span>}
        {job && job.rows > 0 && <span className="text-xs text-muted">· {num(job.done)} / {num(job.rows)} rows</span>}
        {job && <span className="ml-auto text-md font-semibold tnum text-ink">{job.percent}%</span>}
      </div>
      {job && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover"><div className={cx('h-full rounded-full transition-all', failed ? 'bg-[var(--t-red)]' : 'bg-[var(--t-blue)]')} style={{ width: `${job.percent}%` }} /></div>}
      {(error || job?.error) && <p className="mt-2 text-sm text-[var(--t-red)]">{error ?? job?.error}</p>}
      {!failed && !done && <p className="mt-1.5 text-xs text-muted">Runs in the background: you can keep working; the summary opens when it is done.</p>}
    </div>
  );
}

function Uploader() {
  const app = useApp();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; size: number } | null>(null);
  const [opts, setOpts] = useState({ importType: 'Incremental' as 'Full' | 'Incremental', exportDate: todayLocal(), source: 'Goongoonalo media library export' });
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const busy = !!job && (job.status === 'QUEUED' || job.status === 'PROCESSING') && !error;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(csv|xlsx|xls)$/i.test(f.name)) { setError('Choose a .csv or .xlsx file.'); return; }
    setError(null); setJob(null);
    setFile({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), size: f.size });
  };
  const process = async (f = file) => {
    if (!f) return;
    setError(null); setJob(null);
    try {
      const done = await app.backend.upload(f, opts, app.userId, setJob);
      app.refresh();
      if (done.status === 'FAILED' || !done.batchId) { setError(done.error ?? 'Import failed.'); if (done.batchId) navigate(`/imports/${done.batchId}`); return; }
      app.toast(`Import ${done.id} complete.`, 'ok');
      navigate(`/imports/${done.batchId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <Card title="Upload export" subtitle="CSV or XLSX · the media-library export or any sheet with song title and artist columns (Track Name, Artist Name, ISRC, Album Name, Label, Lyric Writer, Composer …)">
        <div
          onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
          onClick={() => !busy && input.current?.click()}
          className={cx('flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors', drag ? 'border-accent-strong bg-accent-soft' : 'border-accent-line hover:border-accent-strong hover:bg-accent-soft/60')}>
          <span className="mb-2.5 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent-text"><FileUp size={24} /></span>
          {file ? (
            <p className="break-all text-sm text-ink"><FileSpreadsheet size={16} className="mr-1 inline" /><b>{file.name}</b> · {num(Math.round(file.size / 1024))} KB · <span className="text-muted underline">choose another</span></p>
          ) : (
            <p className="text-sm text-ink-2"><b className="text-ink">Drop the export file here</b> or click to choose it</p>
          )}
          <input ref={input} type="file" accept=".csv,.xlsx,.xls" hidden onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-xs text-muted">Export details (optional)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <Field label="Export date"><input type="date" className="field" value={opts.exportDate} onChange={e => setOpts(o => ({ ...o, exportDate: e.target.value }))} /></Field>
            <Field label="Source"><input className="field" value={opts.source} onChange={e => setOpts(o => ({ ...o, source: e.target.value }))} /></Field>
            <Field label="Type" help={opts.importType === 'Full' ? 'Songs missing from a full export are flagged, never deleted.' : 'Only the rows in the file are compared.'}>
              <Segmented options={[{ id: 'Incremental', label: 'Incremental' }, { id: 'Full', label: 'Full' }]} value={opts.importType} onChange={v => setOpts(o => ({ ...o, importType: v }))} />
            </Field>
          </div>
        </details>
        <JobCard job={job} error={error} />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 basis-60 text-xs text-muted">Import ID, uploader ({app.meta?.me?.name}), time, checksum, every raw row and how each row was read are kept.</p>
          <Button variant="primary" icon={<Upload size={17} />} disabled={!file || busy} loading={busy} onClick={() => process()}>Process file</Button>
        </div>
      </Card>

      <Card title="What the file can contain" subtitle="Columns are recognised by name, in any order. Missing optional columns are fine; extra columns are kept with the row.">
        <ul className="space-y-2 text-sm text-ink-2">
          <li><b className="text-ink">Needed:</b> a song title column (Track Name, Song, Title …) and an artist column (Artist Name, Lead Artists, Singer …).</li>
          <li><b className="text-ink">Used when present:</b> ISRC, UPC, Album Name, Album cat. No., Label, Language, Genre, Release Date, Lyric Writer, Composer, Producer.</li>
          <li>Several artists in one cell (“A, B”, “A feat. B”) become separate artists; “A &amp; B” stays one credited name.</li>
          <li>Lyric writers, composers and producers become collaborators. Known artists are recognised by source ID, ISRC and songs, so nothing is duplicated.</li>
          <li>Uploading the same file again creates nothing; a corrected file with the same name becomes version 2.</li>
        </ul>
        <details className="mt-3 border-t border-line pt-2.5 text-xs text-muted">
          <summary className="cursor-pointer text-sm font-medium text-ink-2">Media-library export layout</summary>
          <p className="mt-1.5"><span className="mono">{MEDIA_COLUMNS.join(', ')}</span></p>
        </details>
        <div className="mt-3"><Button size="sm" icon={<Download size={15} />} onClick={() => download('g_amplify_import_template.csv', templateCsv())}>Blank template (CSV)</Button></div>
      </Card>
    </div>
  );
}


interface BatchRow { id: string; originalFilename: string; version: number; versionOfId: string | null; repeatOfId: string | null; uploadDate: string; uploaderName: string; exportDate: string; source: string; importType: string; rowCount: number; acceptedCount: number; quarantinedCount: number; skippedCount: number; status: string; summary: { reopenedCases: number; newTasks: number; artistsFound?: number; artistsCreated?: number; reopenedArtistIds?: string[] } }
function Batches() {
  const { data } = useQuery<BatchRow[]>('imports');
  const navigate = useNavigate();
  return (
    <DataTable rows={data} rowKey={r => r.id} onRowClick={r => navigate(`/imports/${r.id}`)}
      empty={<Empty title="No imports yet." text="Upload a backend export above." />}
      columns={[
        { key: 'id', header: 'Import', render: r => <span className="mono font-medium">{r.id}</span> },
        { key: 'f', header: 'File', render: r => <span className="block max-w-[260px] truncate" title={r.originalFilename}>{r.originalFilename}{r.version > 1 && <span className="ml-1 text-xs text-muted">v{r.version} of {r.versionOfId}</span>}{r.repeatOfId && <span className="ml-1 text-xs text-muted">repeat of {r.repeatOfId}</span>}</span> },
        { key: 'u', header: 'Uploaded', render: r => <span className="whitespace-nowrap">{fmtDateTime(r.uploadDate)}<span className="block text-xs text-muted">{r.uploaderName}</span></span> },
        { key: 'e', header: 'Export date', render: r => fmtShort(r.exportDate), hide: '2xl' },
        { key: 't', header: 'Type', render: r => r.importType, hide: 'xl' },
        { key: 'rows', header: 'Rows', render: r => num(r.rowCount), className: 'tnum text-right', headClass: 'text-right' },
        { key: 'a', header: 'Accepted', render: r => num(r.acceptedCount), className: 'tnum text-right', headClass: 'text-right' },
        { key: 'q', header: 'To review', render: r => num(r.quarantinedCount), className: 'tnum text-right', headClass: 'text-right' },
        { key: 's', header: 'Skipped', render: r => num(r.skippedCount), className: 'tnum text-right', headClass: 'text-right', hide: 'xl' },
        { key: 'ar', header: 'Artists', render: r => num(r.summary.artistsFound ?? 0), className: 'tnum text-right', headClass: 'text-right' },
        { key: 'na', header: 'New', render: r => num(r.summary.artistsCreated ?? 0), className: 'tnum text-right', headClass: 'text-right' },
        { key: 'ro', header: 'Reopened', render: r => num(r.summary.reopenedArtistIds?.length ?? r.summary.reopenedCases), className: 'tnum text-right', headClass: 'text-right' },
        { key: 'st', header: 'Status', render: r => <StatusBadge value={r.status} /> },
      ]} />
  );
}

interface Exc { id: string; batchId: string; file: string; rowNumber: number; raw: Record<string, string> | null; reason: string | null; ownerName: string; exceptionStatus: string | null; resolution: string | null }
function Exceptions() {
  const [status, setStatus] = useState<'Open' | ''>('Open');
  const { data, error } = useQuery<Exc[]>('exceptions', { status });
  const { open } = useActions();
  const { can } = useApp();
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-3 py-2">
        <p className="text-xs text-muted">Rows that need a person are kept here with the original values and the reason. Nothing is silently dropped.</p>
        <Segmented options={[{ id: 'Open', label: 'Open' }, { id: '', label: 'All' }]} value={status} onChange={v => setStatus(v as 'Open' | '')} />
      </div>
      {error && <div className="p-3"><ErrorBox text={error} /></div>}
      <DataTable rows={data} rowKey={r => r.id} empty={<Empty compact title="No open import exceptions." />}
        columns={[
          { key: 'b', header: 'Batch', render: r => <span className="mono">{r.batchId}</span> },
          { key: 'r', header: 'Row', render: r => <span className="tnum">Row {r.rowNumber}</span> },
          { key: 'o', header: 'Original row', render: r => <code className="mono block max-w-[360px] truncate text-xs text-ink-2" title={JSON.stringify(r.raw)}>{r.raw ? Object.entries(r.raw).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' · ') : '—'}</code> },
          { key: 'reason', header: 'Reason', render: r => <span className="text-[var(--t-red)]">{r.reason}</span> },
          { key: 'own', header: 'Owner', render: r => r.ownerName },
          { key: 's', header: 'Status', render: r => <StatusBadge value={r.exceptionStatus ?? 'Open'} /> },
          { key: 'res', header: 'Resolution', render: r => r.resolution ?? <span className="text-faint">—</span> },
          { key: 'x', header: '', render: r => r.exceptionStatus === 'Open' ? <Button size="sm" disabled={!can('resolveException')} title={can('resolveException') ? undefined : 'Needs Lead, Admin or System Owner'} onClick={() => open('resolveImportException', { rowId: r.id })}>Resolve</Button> : null },
        ]} />
    </>
  );
}
