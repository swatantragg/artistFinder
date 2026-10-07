// Dossier tabs about who the artist is and how to reach them: overview, songs & credits, collaborators, routes, research.
import { matchesText } from '@domain/search';
import { ChevronRight, ExternalLink, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CHECKLIST_STATUSES } from '@domain/constants';
import { useActions } from '../../components/actions';
import { RouteChain, TaskCard } from '../../components/case-bits';
import { Badge, Button, Card, DataTable, Empty, KeyVal, Modal, Notice, Pagination, SkeletonRows, StageBadge, StatusBadge, cx } from '../../components/ui';
import { useApp, useQuery } from '../../lib/app';
import { fmtAgo, fmtDate, fmtDateTime, num } from '../../lib/format';
import type { CaseDetail } from './Dossier';
import { IdentityBadge } from '../../components/status';

// ------------------------------------------------------------------ overview
export function OverviewTab({ d }: { d: CaseDetail }) {
  const c = d.case;
  const { open } = useActions();
  return (
    <div className="space-y-4">
      <Notice tone="neutral" title="Why this case exists">{d.whyExists}</Notice>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Identity">
          <KeyVal items={[
            ['Canonical name', c.canonicalName],
            ['Aliases', c.aliases.join(', ')],
            ['Backend IDs', c.backendProfileIds.length ? <span className="mono">{c.backendProfileIds.join(', ')}</span> : null],
            ['Profile URLs', c.profileUrls.length ? <span className="flex flex-col">{c.profileUrls.map(u => <a key={u} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 truncate underline decoration-line-strong">{u}<ExternalLink size={11} /></a>)}</span> : null],
            ['Roles', <RolesFor id={c.id} key="r" />],
            ['Language', c.language],
            ['Identity status', <StatusBadge key="i" value={c.identityStatus} />],
            ['Identity evidence', c.identityEvidence],
            ...(d.mergedChildren.length ? [['Merged duplicates', d.mergedChildren.map(m => `${m.name} (${m.backendIds.join(', ') || m.id})`).join('; ')] as [string, string]] : []),
          ]} />
        </Card>
        <Card title="Case">
          <KeyVal items={[
            ['Lifecycle stage', <StageBadge key="s" stage={c.lifecycleStage} />],
            ['Why', c.stageReason],
            ['Work reason', c.workReason],
            ['Owner', d.ownerName],
            ['Contact preference', `${c.contactPreference}${c.contactPreferenceUntil ? ` until ${fmtDate(c.contactPreferenceUntil)}` : ''}`],
            ['First seen', `${fmtDate(c.firstSeen)}${c.firstSeenBatchId ? ` (batch ${c.firstSeenBatchId})` : ''}`],
            ['Last seen', fmtDate(c.lastSeen)],
            ['Last evidence change', c.lastEvidenceChange ? `${fmtAgo(c.lastEvidenceChange)}: ${c.lastEvidenceNote ?? ''}` : null],
            ['Next action', c.nextAction],
            ['Evidence summary', <ul key="e" className="list-inside list-disc text-ink-2">{d.evidence.map(e => <li key={e}>{e}</li>)}</ul>],
            ...(c.closedReason ? [['Closed because', c.closedReason] as [string, string]] : []),
          ]} />
        </Card>
      </div>
      {c.waiting && c.lifecycleStage === 'Waiting for Evidence' && <WaitingCard w={c.waiting} />}
      <Card title={`Open tasks (${d.openTasks.length})`} actions={<Button size="sm" icon={<Plus size={14} />} onClick={() => open('createTask', { caseId: c.id })}>Create task</Button>}>
        {d.openTasks.length ? <div className="space-y-2">{d.openTasks.map(t => <TaskCard key={t.id} t={t} showArtist={false} />)}</div>
          : <Empty compact title="No open tasks." text={c.lifecycleStage === 'Closed' ? 'Closed cases keep their history.' : 'Use the main action above, or create a task.'} />}
      </Card>
    </div>
  );
}
function RolesFor({ id }: { id: string }) {
  const { data } = useQuery<any[]>('caseSongs', { id });
  if (!data) return <span className="text-faint">…</span>;
  const roles = [...new Set(data.flatMap(s => s.roles))];
  return <span>{roles.join(', ') || '—'}</span>;
}
export function WaitingCard({ w }: { w: NonNullable<CaseDetail['case']['waiting']> }) {
  return (
    <Card title="Waiting for evidence" subtitle="Kept visible with its blocker. It reopens by itself when new evidence arrives.">
      <KeyVal cols={2} items={[
        ['Blocker', w.blocker], ['Research coverage', w.coverage],
        ['Routes tested', w.routesTested.length ? <ul key="r" className="list-inside list-disc">{w.routesTested.map(r => <li key={r}>{r}</li>)}</ul> : 'None'],
        ['Last review', fmtDate(w.lastReview)], ['Would reopen on', w.futureTrigger], ['Next review', fmtDate(w.nextReviewDate)],
      ]} />
    </Card>
  );
}

// ------------------------------------------------------------------ songs & credits
interface Credit { id: string; name: string; role: string; caseId: string | null; isPrimary: boolean; status: string; statusReason: string | null; source: string; self: boolean }
interface Song { id: string; backendTrackId: string; title: string; version: string; isrc: string; label: string; distributor: string; language: string; source: string; release: string; album: string; releaseDate: string; flags: string[]; firstBatchId: string; sourceFile: string; history: { at: string; batchId: string; field: string; from: string; to: string }[]; roles: string[]; collaborators: { name: string; role: string; caseId: string | null }[]; credits: Credit[] }
type SongSort = 'release' | 'title' | 'imported';
const PAGE = 50;
/** The artist's songs: search, sort and open one for its details. */
export function SongsTab({ id }: { id: string }) {
  const { data } = useQuery<Song[]>('caseSongs', { id });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SongSort>('release');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const { open } = useActions();
  const addBtn = <Button size="sm" icon={<Plus size={15} />} onClick={() => open('addSong', { caseId: id })}>Link a song</Button>;
  if (!data) return <SkeletonRows />;
  if (!data.length) return <Empty title="No linked songs." text="Songs arrive through imports, or link one found in research." action={addBtn} />;
  const needle = q.trim();
  const hit = (s: Song) => !needle || matchesText(needle, s.title, s.version, s.isrc, s.album, s.label, ...s.credits.map(c => c.name));
  const list = data.filter(hit).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'imported' ? 0 : (b.releaseDate || '').localeCompare(a.releaseDate || '') || a.title.localeCompare(b.title));
  const pages = Math.max(1, Math.ceil(list.length / PAGE)), cur = Math.min(page, pages);
  const shown = list.slice((cur - 1) * PAGE, cur * PAGE);
  const song = data.find(s => s.id === openId) ?? null;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[min(100%,260px)] flex-1">
          <Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="field !pl-10" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Search songs: title, ISRC, album, label or a person" aria-label="Search songs" />
        </div>
        <select className="field !w-auto" value={sort} onChange={e => setSort(e.target.value as SongSort)} aria-label="Sort songs">
          <option value="release">Newest release first</option><option value="title">Title A–Z</option><option value="imported">Order imported</option>
        </select>
        {addBtn}
      </div>
      <p className="mb-2 text-xs text-muted">{needle ? `${num(list.length)} of ${num(data.length)} songs match “${q.trim()}”` : `${num(data.length)} songs`} · click a song for its details</p>
      <div className="overflow-hidden rounded-lg border border-line">
        <DataTable rows={shown} rowKey={s => s.id} onRowClick={s => setOpenId(s.id)} empty={<Empty compact title={`No song matches “${q.trim()}”.`} />}
          columns={[
            { key: 't', header: 'Song', render: s => <span className="block min-w-[180px]"><span className="font-medium text-ink">{s.title}</span>{s.version && <span className="text-muted"> ({s.version})</span>}{s.album && s.album !== s.title && <span className="block text-xs text-muted">{s.album}</span>}</span> },
            { key: 'i', header: 'ISRC', render: s => <span className="mono whitespace-nowrap">{s.isrc || '—'}</span> },
            { key: 'd', header: 'Released', render: s => <span className="whitespace-nowrap">{s.releaseDate ? fmtDate(s.releaseDate) : '—'}</span> },
            { key: 'r', header: 'Role', render: s => s.roles.join(', ') || '—' },
            { key: 'l', header: 'Label', render: s => s.label || '—', hide: 'lg' },
            { key: 'x', header: '', label: '', render: s => <ChevronRight size={16} className="text-muted" aria-label={`Open ${s.title}`} />, className: 'w-8' },
          ]} />
        {list.length > PAGE && <Pagination page={cur} pageSize={PAGE} total={list.length} onPage={setPage} />}
      </div>
      {song && <SongDetails song={song} caseId={id} onClose={() => setOpenId(null)} />}
    </>
  );
}

const ROLE_ORDER = ['Singer', 'Performer', 'Composer', 'Lyricist', 'Producer', 'Other'];
interface SongDetail { sources: { batchId: string; file: string; rowNumber: number; status: string; reason: string | null; raw: Record<string, string> | null; mapped: Record<string, string> | null }[] }
/** One song: its details, who did what on it (by role) and the import rows it came from. */
function SongDetails({ song: s, caseId, onClose }: { song: Song; caseId: string; onClose: () => void }) {
  const { open } = useActions();
  const roles = [...new Set(s.credits.map(c => c.role))].sort((a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99));
  return (
    <Modal open onClose={onClose} width={760} title={<span>{s.title}{s.version && <span className="font-normal text-muted"> ({s.version})</span>}</span>} description={[s.album && s.album !== s.title ? `Album ${s.album}` : null, s.releaseDate && `released ${fmtDate(s.releaseDate)}`].filter(Boolean).join(' · ') || undefined}
      footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Song</h3>
          <KeyVal cols={2} items={[
            ['ISRC', s.isrc ? <span key="i" className="mono">{s.isrc}</span> : null], ['Album', s.album], ['Release date', s.releaseDate ? fmtDate(s.releaseDate) : null], ['Language', s.language],
            ['Label', s.label], ['Distributor', s.distributor], ['Track ID', s.backendTrackId ? <span key="k" className="mono break-all">{s.backendTrackId}</span> : null], ...(s.flags.length ? [['Notes', s.flags.join(' · ')] as [string, string]] : []),
          ]} />
        </section>
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Credits</h3>
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => { onClose(); open('addCredit', { caseId, preset: { trackId: s.id } }); }}>Add credit</Button>
          </div>
          <dl className="divide-y divide-line rounded-lg border border-line">
            {roles.map(r => (
              <div key={r} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 px-3 py-2 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="text-muted">{r}</dt>
                <dd className="flex flex-wrap gap-x-3 gap-y-1">
                  {s.credits.filter(c => c.role === r).map(c => (
                    <span key={c.id} className={cx('inline-flex items-center gap-1.5', c.status !== 'Active' && 'opacity-60')}>
                      {c.caseId && !c.self ? <Link to={`/artists/${c.caseId}`} onClick={onClose} className="font-medium text-ink underline decoration-line-strong hover:decoration-ink">{c.name}</Link> : <span className="font-medium text-ink">{c.name}</span>}
                      {c.self && <Badge tone="violet">This artist</Badge>}
                      {c.isPrimary && !c.self && <Badge>Lead</Badge>}
                      {!c.caseId && <Badge tone="orange" title="This name is not linked to an artist record yet">Not linked</Badge>}
                      {c.status !== 'Active' && <Badge>{c.status}</Badge>}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <SongSources trackId={s.id} />
        {s.history.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Changed by later imports</h3>
            <ul className="space-y-1 text-sm text-ink-2">{s.history.map((h, i) => <li key={i}><span className="mono text-xs">{h.batchId}</span> · {h.field}: “{h.from || '—'}” → “{h.to}”</li>)}</ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
/** Where this song came from: every import row, with the original values one click away. */
function SongSources({ trackId }: { trackId: string }) {
  const { data } = useQuery<SongDetail | null>('songDetail', { id: trackId });
  const [openRow, setOpenRow] = useState<string | null>(null);
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Where it came from</h3>
      {!data ? <SkeletonRows rows={2} /> : !data.sources.length ? <p className="text-sm text-muted">Added by hand (no import row).</p> : (
        <ul className="space-y-2">
          {data.sources.map(src => {
            const key = src.batchId + src.rowNumber;
            const values = src.raw ?? src.mapped;
            return (
              <li key={key} className="rounded-lg border border-line">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <span className="text-ink">{src.file}</span>
                  <span className="text-muted">row {num(src.rowNumber)}</span>
                  <Link to={`/imports/${src.batchId}`} className="mono text-xs text-muted underline">{src.batchId}</Link>
                  <StatusBadge value={src.status} />
                  {values ? <button type="button" className="ml-auto text-xs text-accent-text underline" onClick={() => setOpenRow(openRow === key ? null : key)}>{openRow === key ? 'Hide the row' : 'Show the original row'}</button>
                    : <span className="ml-auto text-xs text-muted">Original values not kept for this older import</span>}
                </div>
                {openRow === key && values && (
                  <dl className="grid gap-x-4 gap-y-1 border-t border-line bg-surface-2 px-3 py-2 text-xs sm:grid-cols-2">
                    {Object.entries(values).filter(([, v]) => v !== '' && v != null).map(([k, v]) => <div key={k} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2"><dt className="text-muted">{k}</dt><dd className="break-words text-ink">{v}</dd></div>)}
                  </dl>
                )}
                {src.reason && <p className="border-t border-line px-3 py-1.5 text-xs text-muted">{src.reason}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ collaborators
interface Collab { name: string; caseId: string | null; roles: string[]; songs: { id: string; title: string }[]; identity: string; artistStatus: string | null; kind: string | null; stage: string | null; contact: string; contactId: string | null; potentialRoute: boolean; routeId: string | null; routeState: string | null }
export function CollaboratorsTab({ id }: { id: string }) {
  const { data } = useQuery<Collab[]>('caseCollaborators', { id });
  const { open } = useActions();
  if (!data) return <SkeletonRows />;
  return (
    <>
      <Notice tone="neutral">People credited on this artist’s songs. A shared song is a professional (catalogue) connection, not proof that they know each other personally, and it gives no authority to claim the profile.</Notice>
      <div className="mt-3">
        <DataTable rows={data} rowKey={r => r.caseId ?? r.name}
          empty={<Empty compact title="No collaborators credited on this artist’s songs." />}
          columns={[
            { key: 'n', header: 'Collaborator', render: r => r.caseId ? <Link to={`/artists/${r.caseId}`} className="font-medium text-ink underline decoration-line-strong hover:decoration-ink">{r.name}</Link> : <span className="font-medium">{r.name}</span> },
            { key: 'r', header: 'Credited as', render: r => r.roles.join(', ') },
            { key: 's', header: 'Connection', render: r => <span className="block max-w-[300px] truncate text-ink-2" title={r.songs.map(s => s.title).join(', ')}>Credited on {r.songs.length === 1 ? `“${r.songs[0].title}”` : `${r.songs.length} songs (“${r.songs[0].title}” …)`}</span> },
            { key: 'i', header: 'Identity', render: r => r.artistStatus ? <IdentityBadge status={r.artistStatus} /> : <span className="text-xs text-muted">Not linked</span> },
            { key: 'c', header: 'Contact', render: r => <Badge tone={r.contact === 'Verified contact' ? 'green' : r.contact === 'Unverified contact' ? 'orange' : 'neutral'} dot>{r.contact}</Badge> },
            { key: 'rt', header: 'Route', render: r => r.routeId ? <span className="mono">{r.routeId} <StatusBadge value={r.routeState} /></span> : r.potentialRoute && r.contactId ? <Button size="sm" onClick={() => open('addRoute', { caseId: id, preset: { values: { kind: 'Directory contact', contactId: r.contactId, state: 'Verified', evidence: `${r.name} (${r.roles.join(', ')}) on “${r.songs[0]?.title}” has a verified contact` } } })}>Add as route</Button> : <span className="text-faint">—</span> },
          ]} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ routes
interface RouteV { id: string; state: string; chain: { kind: string; label: string; sub?: string }[]; targetName: string; songTitle: string | null; collaboratorName: string | null; organisation: string | null; contactName: string | null; contactValue: string | null; contactVerified: boolean; sourceUrl: string | null; confidence: number; lastChecked: string | null; rejectionReason: string | null; ownerName: string; origin: string; evidence: string; ranking: number }
export function RoutesTab({ d }: { d: CaseDetail }) {
  const { data } = useQuery<RouteV[]>('caseRoutes', { id: d.case.id });
  const { open } = useActions();
  const add = <Button size="sm" icon={<Plus size={14} />} onClick={() => open('addRoute', { caseId: d.case.id })}>Add route</Button>;
  if (!data) return <SkeletonRows />;
  const closed = ['Closed', 'Claimed', 'Activation Pending', 'Activated', 'Ongoing ARM'].includes(d.case.lifecycleStage);
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">A route is a path to the artist. Failed routes are kept with the reason, so nobody repeats them.</p>
        {!closed && add}
      </div>
      {!data.length ? <Empty title="No verified routes found." text="Research the artist’s profiles and credits, then add a route." action={!closed ? add : undefined} /> : (
        <div className="space-y-2.5">
          {data.map(r => (
            <div key={r.id} className={cx('rounded-lg border px-4 py-3', r.state === 'Selected' ? 'border-[var(--t-green-bd)] bg-[var(--t-green-bg)]/40' : 'border-line', (r.state === 'Rejected' || r.state === 'Exhausted') && 'opacity-75')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex items-center gap-2"><span className="mono text-sm font-medium">{r.id}</span><StatusBadge value={r.state} /><span className="text-xs text-muted">Confidence {r.confidence}% · from {r.origin}</span></div>
                  <RouteChain chain={r.chain} />
                </div>
                {!closed && (
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    {(r.state === 'Verified' || r.state === 'Selected') && <Button size="sm" variant={r.state === 'Verified' ? 'primary' : 'secondary'} onClick={() => open('recordContact', { caseId: d.case.id, routeId: r.id })}>Record contact</Button>}
                    {r.state === 'Verified' && <Button size="sm" onClick={() => open('selectRoute', { caseId: d.case.id, routeId: r.id })}>Select</Button>}
                    {r.state === 'Candidate' && <Button size="sm" onClick={() => open('verifyRoute', { caseId: d.case.id, routeId: r.id })}>Mark verified</Button>}
                    {!['Rejected', 'Exhausted'].includes(r.state) && <Button size="sm" variant="ghost" onClick={() => open('rejectRoute', { caseId: d.case.id, routeId: r.id })}>Reject</Button>}
                    {['Verified', 'Selected'].includes(r.state) && <Button size="sm" variant="ghost" onClick={() => open('exhaustRoute', { caseId: d.case.id, routeId: r.id })}>Exhausted</Button>}
                  </div>
                )}
              </div>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
                {([
                  ['Target artist', r.targetName], ['Song', r.songTitle], ['Collaborator', r.collaboratorName], ['Organisation', r.organisation],
                  ['Contact', r.contactName ? `${r.contactName}${r.contactValue ? ` · ${r.contactValue}` : ''} (${r.contactVerified ? 'verified' : 'unverified'})` : null], ['Source URL', r.sourceUrl],
                  ['Last checked', r.lastChecked ? fmtDateTime(r.lastChecked) : null], ['Owner', r.ownerName],
                ] as [string, string | null][]).map(([k, v]) => (
                  <div key={k} className="min-w-0"><dt className="text-muted">{k}</dt><dd className="truncate text-ink" title={v ?? ''}>{v || '—'}</dd></div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-ink-2"><span className="text-muted">Evidence: </span>{r.evidence}</p>
              {r.rejectionReason && <p className="mt-0.5 text-xs text-[var(--t-red)]">{r.state}: {r.rejectionReason}</p>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ research
interface ResearchData { checklist: { step: number; status: string; note: string; title: string; help: string; updatedAt: string | null; updatedByName: string | null }[]; activities: { id: string; source: string; query: string; url: string; result: string; evidence: string; confidence: number; researcherName: string; date: string; minutes: number; checklistStep: number | null }[]; totalMinutes: number; waiting: CaseDetail['case']['waiting'] }
export function ResearchTab({ d }: { d: CaseDetail }) {
  const { data } = useQuery<ResearchData>('caseResearch', { id: d.case.id });
  const { open } = useActions();
  const locked = ['Identity Review', 'Closed'].includes(d.case.lifecycleStage) || !!d.case.mergedIntoId;
  if (!data) return <SkeletonRows />;
  const done = data.checklist.filter(x => x.status === 'Complete').length;
  return (
    <div className="space-y-4">
      {d.case.lifecycleStage === 'Identity Review' && <Notice tone="orange" title="Potential identity conflict requires review">Research starts after the identity decision.</Notice>}
      <Card title={`Research checklist · ${done}/8 complete`} subtitle="Work top to bottom. Each step can be Not Started, In Progress, Complete or Blocked.">
        <ol className="divide-y divide-line">
          {data.checklist.map(x => <ChecklistRow key={x.step} caseId={d.case.id} x={x} locked={locked} />)}
        </ol>
      </Card>
      {data.waiting && <WaitingCard w={data.waiting} />}
      <Card title={`Research activity · ${num(data.activities.length)} records · ${num(data.totalMinutes)} min`} actions={!locked && <Button size="sm" icon={<Plus size={14} />} onClick={() => open('addResearch', { caseId: d.case.id })}>Add research</Button>} pad={false}>
        <DataTable rows={data.activities} rowKey={r => r.id}
          empty={<Empty compact title="No research activity yet." action={!locked ? <Button size="sm" onClick={() => open('addResearch', { caseId: d.case.id })}>Add research</Button> : undefined} />}
          columns={[
            { key: 'd', header: 'Date', render: r => <span className="whitespace-nowrap">{fmtDateTime(r.date)}</span> },
            { key: 's', header: 'Source', render: r => r.source },
            { key: 'q', header: 'Query', render: r => <span className="block max-w-[200px] truncate" title={r.query}>{r.query || '—'}</span> },
            { key: 'u', header: 'URL', render: r => r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="block max-w-[180px] truncate underline decoration-line-strong" title={r.url} onClick={e => e.stopPropagation()}>{r.url.replace(/^https?:\/\//, '')}</a> : '—' },
            { key: 'r', header: 'Result', render: r => r.result },
            { key: 'e', header: 'Evidence', render: r => <span className="block max-w-[240px] text-ink-2">{r.evidence || '—'}</span> },
            { key: 'c', header: 'Conf.', render: r => `${r.confidence}%`, className: 'tnum' },
            { key: 'w', header: 'Researcher', render: r => r.researcherName },
            { key: 'm', header: 'Time', render: r => `${r.minutes} min`, className: 'tnum whitespace-nowrap' },
          ]} />
      </Card>
    </div>
  );
}
function ChecklistRow({ caseId, x, locked }: { caseId: string; x: ResearchData['checklist'][number]; locked: boolean }) {
  const { run } = useApp();
  const [note, setNote] = useState(x.note);
  const [err, setErr] = useState<string | null>(null);
  const save = async (status: string, n = note) => {
    if (status === 'Blocked' && !n.trim()) { setErr('Say what blocks this step, then choose Blocked.'); return; }
    setErr(null);
    await run('updateChecklist', { caseId, step: x.step, status, note: n }, { quiet: true });
  };
  return (
    <li className="grid gap-2 py-2.5 md:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{x.step}. {x.title}</p>
        <p className="text-xs text-muted">{x.help}</p>
        <input className="field mt-1.5 !min-h-[30px] !py-1 text-sm" placeholder="Note (what you checked or found)" value={note} disabled={locked}
          onChange={e => setNote(e.target.value)} onBlur={() => { if (note !== x.note) save(x.status === 'Not Started' ? 'In Progress' : x.status); }} />
        {err && <p className="mt-1 text-xs text-[var(--t-red)]">{err}</p>}
        {x.updatedAt && <p className="mt-1 text-2xs text-faint">Updated {fmtAgo(x.updatedAt)} by {x.updatedByName}</p>}
      </div>
      <div className="flex flex-wrap items-start gap-1">
        {CHECKLIST_STATUSES.map(s => (
          <button key={s} type="button" disabled={locked} onClick={() => save(s)}
            className={cx('rounded-md border px-2 py-1 text-xs disabled:opacity-50', x.status === s ? (s === 'Complete' ? 'tone-green badge font-medium' : s === 'Blocked' ? 'tone-red badge font-medium' : s === 'In Progress' ? 'tone-blue badge font-medium' : 'border-sel-line bg-accent-soft font-medium text-ink') : 'border-line text-muted hover:bg-hover')}>{s}</button>
        ))}
      </div>
    </li>
  );
}
