// One artist's discovery: Find artist, live progress, the artist's saved profiles and the profiles found, by platform.
// Only the artist's own profile links are listed (never song or video pages), with a match of 50% or more (or the best one
// or two when nothing reaches 50%). Software suggests; every Verify / Reject is a person's decision.
import { AlertTriangle, Check, ChevronRight, History, Loader2, RefreshCcw, Search, SearchX, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useActions } from '../actions';
import { Badge, Button, Card, Empty, ErrorBox, Notice, Skeleton, cx } from '../ui';
import { useApp, useQuery } from '../../lib/app';
import { fmtAgo, fmtDate, fmtDateTime, num, plural } from '../../lib/format';
import { DiscoveryChip, MatchPill, PlatformBadge, ProfileLink, handleOf } from './bits';

export interface ProfileV {
  id: string; platform: string; url: string; displayName: string; username: string | null; title: string; description: string; location: string | null; strength: string; score: number;
  matched: string[]; conflicts: string[]; status: string; discoveryStatus: string; reviewNote: string | null; rejectionReason: string | null; reviewedBy: string | null; reviewedAt: string | null;
  verifiedAt: string | null; verifiedBy: string | null; lastCheckedAt: string; groupKey: string | null; changeOfProfileId: string | null; version: number; newEvidence: boolean;
}
/** A profile found for the artist, as listed for review. */
export interface CandidateV { id: string; platform: string; url: string; displayName: string; username: string | null; score: number; status: string; followers: number | null }
interface Step { label: string; state: string; detail: string | null }
export interface JobV {
  id: string; version: number; mode: string; status: string; trigger: string; focus: string[]; requestedBy: string; step: number; steps: Step[];
  providers: { id: string; label: string; kind: string; status: string; queries: number; results: number; cached: number; error: string | null }[];
  queryCount: number; cachedCount: number; resultCount: number; profileCount: number; newProfileCount: number; groupCount: number; pathCount: number; outcome: string | null; failureReason: string | null;
  attempt: number; createdAt: string; startedAt: string | null; finishedAt: string | null; durationMs: number | null; verified: number; rejected: number; needsReview: number; bulkId: string | null;
}
export interface DiscoveryData {
  caseId: string; name: string; artistId: string | null; discoveryStatus: string; verifiedArtist: boolean; lastVerifiedAt: string | null;
  verified: { id: string; profileId: string | null; platform: string; url: string; username: string | null; displayName: string; verifiedAt: string; verifiedBy: string; lastCheckedAt: string; daysSinceCheck: number; stale: boolean; notFound: boolean; change: ProfileV | null }[];
  candidates: CandidateV[]; changes: { next: ProfileV; old: ProfileV | null }[]; rejected: ProfileV[]; replaced: ProfileV[];
  jobs: JobV[]; activeJob: JobV | null; lastJob: JobV | null; noResult: { sources: string[]; finishedAt: string | null } | null;
  paths: unknown[]; staleDays: number; staleCount: number; canFind: boolean; canRefresh: boolean; blocked: string | null; limit: string | null;
}

/** Discovery for one artist; polls quickly only while a search is running. */
export function useDiscovery(caseId: string) {
  const [fast, setFast] = useState(false);
  const q = useQuery<DiscoveryData | null>('discoveryDetail', { id: caseId }, { poll: fast ? 800 : false });
  const active = !!q.data?.activeJob;
  useEffect(() => { setFast(active); }, [active]);
  return q;
}

export function DiscoveryPanel({ caseId }: { caseId: string }) {
  const { data, error } = useDiscovery(caseId);
  const app = useApp();
  const { open } = useActions();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <ErrorBox text={error} />;
  if (data === null) return <Empty title="Artist not found." />;
  if (!data) return <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  const start = async (mode: 'full' | 'refresh') => { setBusy(mode); await app.run('startDiscovery', { caseId, mode }); setBusy(null); };
  const findConnection = async () => { setBusy('connect'); await app.run('findConnection', { caseId }); setBusy(null); navigate(`/artists/${caseId}?tab=graph`); };
  const job = data.activeJob;
  const last = data.lastJob;
  return (
    <div className="space-y-4">
      {data.limit && !data.blocked && !job && <Notice tone="orange" icon={<SearchX size={18} />} title="Search limit reached">{data.limit} Manual research stays available.</Notice>}
      {data.blocked && <Notice tone="red" icon={<SearchX size={18} />} title="Find artist is off">{data.blocked} Manual research stays available.</Notice>}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-4 shadow-[var(--shadow)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">Artist profiles</h2>
            <DiscoveryChip status={data.discoveryStatus} />
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {last ? <>Last search {last.finishedAt ? fmtAgo(last.finishedAt) : 'running'} · Spotify, YouTube, Instagram, Facebook and more</> : `Find artist looks for ${data.name}'s own profiles: Spotify, YouTube, Instagram, Facebook, SoundCloud, X, Apple Music, JioSaavn and the official website.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.canFind && <Button variant="primary" icon={<Search size={16} />} loading={busy === 'full'} disabled={!!data.blocked || !!data.limit} onClick={() => start('full')}>{data.discoveryStatus === 'Failed' ? 'Retry Find artist' : 'Find artist'}</Button>}
          {!data.canFind && data.canRefresh && <Button icon={<RefreshCcw size={15} />} loading={busy === 'refresh'} onClick={() => start('refresh')} disabled={!!job || !!data.blocked || !!data.limit}>Search again</Button>}
          {(data.verifiedArtist || last) && <Button variant="ghost" icon={<Share2 size={15} />} loading={busy === 'connect'} onClick={findConnection}>Find connection</Button>}
        </div>
      </section>

      {job && <JobProgress job={job} name={data.name} />}
      {!job && last?.status === 'FAILED' && (
        <Notice tone="red" icon={<AlertTriangle size={18} />} title="The search did not finish"
          action={<Button size="sm" variant="primary" onClick={async () => { setBusy('retry'); await app.run('retryDiscovery', { jobId: last.id }); setBusy(null); }} loading={busy === 'retry'}>Retry</Button>}>
          {last.failureReason}. This does not mean the artist does not exist.
        </Notice>
      )}

      {data.verified.length > 0 && <SavedProfiles data={data} onRefresh={() => start('refresh')} />}
      {data.candidates.length > 0 && <Candidates data={data} />}
      {!job && data.noResult && !data.candidates.length && (
        <Card>
          <Empty compact icon={<SearchX size={22} />} title={`No profile of ${data.name} found`} text={`Searched ${data.noResult.sources.join(', ') || 'the configured sources'}${data.noResult.finishedAt ? ` ${fmtAgo(data.noResult.finishedAt)}` : ''}. The artist stays in the list; nothing is deleted.`}
            action={<span className="flex flex-wrap justify-center gap-2"><Button size="sm" variant="primary" onClick={() => start('refresh')}>Search again</Button><Button size="sm" onClick={() => open('addResearch', { caseId })}>Add a profile by hand</Button><Button size="sm" variant="ghost" onClick={() => app.run('waitForNewEvidence', { caseId })}>Wait for new songs</Button></span>} />
        </Card>
      )}
      {!job && !last && !data.verifiedArtist && !data.blocked && <Card><Empty compact icon={<Search size={22} />} title="Not searched yet" text={`Click Find artist: it searches for ${data.name}'s own profiles and lists the ones that match, with the match %. You verify the right ones; they are saved with the artist.`} /></Card>}

      {(data.rejected.length > 0 || data.replaced.length > 0) && <RejectedList rejected={data.rejected} replaced={data.replaced} />}
      {data.jobs.length > 0 && <SearchHistory jobs={data.jobs} />}
    </div>
  );
}

const PLATFORM_ORDER = ['Spotify', 'YouTube', 'Instagram', 'Facebook', 'X', 'SoundCloud', 'Apple Music', 'JioSaavn', 'Gaana', 'Deezer', 'Website', 'Label website'];

/** Profiles found, one block per platform, best match first. */
function Candidates({ data }: { data: DiscoveryData }) {
  const byPlatform = new Map<string, CandidateV[]>();
  for (const c of data.candidates) byPlatform.set(c.platform, [...(byPlatform.get(c.platform) ?? []), c]);
  const platforms = [...byPlatform.keys()].sort((a, b) => Math.max(...byPlatform.get(b)!.map(x => x.score)) - Math.max(...byPlatform.get(a)!.map(x => x.score)) || PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b));
  const weak = data.candidates.every(c => c.score < 50);
  return (
    <section className="space-y-3">
      <header>
        <h3 className="text-md font-semibold text-ink">Is this {data.name}?</h3>
        <p className="text-sm text-muted">{weak ? 'No profile reached a 50% match, so the best ones found are shown. Check them carefully.' : 'Profiles with a match of 50% or more. Verify the right one for each platform: it is saved with the artist.'}</p>
      </header>
      {platforms.map(pl => (
        <div key={pl} className="overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
          <div className="flex items-center gap-2.5 border-b border-line bg-surface-2 px-4 py-2.5">
            <PlatformBadge platform={pl} size="sm" />
            <span className="text-sm font-semibold text-ink">{pl}</span>
            <span className="text-xs text-muted">{plural(byPlatform.get(pl)!.length, 'profile')}</span>
          </div>
          <ul className="divide-y divide-line">{byPlatform.get(pl)!.map(c => <CandidateRow key={c.id} c={c} caseId={data.caseId} />)}</ul>
        </div>
      ))}
    </section>
  );
}

function CandidateRow({ c, caseId }: { c: CandidateV; caseId: string }) {
  const { open } = useActions();
  const app = useApp();
  const handle = handleOf(c.platform, c.username);
  const label = `${c.platform} ${handle ?? c.displayName}`;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <PlatformBadge platform={c.platform} size="lg" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-base font-semibold text-ink">{c.displayName}</span>
          {handle && <span className="text-sm text-muted">{handle}</span>}
          <MatchPill score={c.score} />
          {c.status === 'DEFERRED' && <Badge>Later</Badge>}
        </p>
        <a href={c.url} target="_blank" rel="noopener noreferrer" className="mono block truncate text-xs text-accent-text hover:underline" title={c.url}>{c.url.replace(/^https?:\/\//, '')}</a>
        {c.followers != null && c.followers > 0 && <p className="text-xs text-muted">{compact(c.followers)} followers</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        <ProfileLink url={c.url} small />
        <Button size="sm" variant="primary" onClick={() => open('verifyProfile', { caseId, preset: { profileId: c.id, label } })}>Verify</Button>
        <Button size="sm" variant="danger" onClick={() => open('rejectProfile', { caseId, preset: { profileId: c.id } })}>Reject</Button>
        {c.status === 'UNREVIEWED' && <Button size="sm" variant="ghost" onClick={() => app.run('deferProfile', { profileId: c.id })}>Later</Button>}
      </div>
    </li>
  );
}
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : num(n));

export function JobProgress({ job, name }: { job: JobV; name: string }) {
  const n = job.steps.length;
  const current = Math.min(job.step, n - 1);
  return (
    <section className="rounded-lg border border-[var(--t-blue-bd)] bg-surface p-4 shadow-[var(--shadow)]">
      <p className="flex items-center gap-2 text-base font-semibold text-ink"><Loader2 size={16} className="animate-spin text-[var(--t-blue)]" />{job.status === 'QUEUED' ? `Queued: finding ${name}…` : `Finding ${name}… Step ${current + 1}/${n} ${job.steps[current]?.label}`}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover"><div className="h-full rounded-full bg-[var(--t-blue)] transition-all" style={{ width: `${((job.status === 'QUEUED' ? 0 : current + 0.5) / n) * 100}%` }} /></div>
      <ol className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {job.steps.map((s, i) => (
          <li key={s.label} className={cx('flex items-start gap-1.5', s.state === 'todo' && 'text-faint')}>
            {s.state === 'done' ? <Check size={14} className="mt-0.5 text-[var(--t-green)]" /> : s.state === 'running' ? <Loader2 size={14} className="mt-0.5 animate-spin text-[var(--t-blue)]" /> : s.state === 'failed' ? <AlertTriangle size={14} className="mt-0.5 text-[var(--t-red)]" /> : <span className="mt-1 h-2.5 w-2.5 rounded-full border border-line-strong" />}
            <span className={cx(s.state !== 'todo' && 'text-ink')}>{i + 1}. {s.label}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-muted">Runs in the background: you can keep working. You get a notification when it finishes.</p>
    </section>
  );
}

/** The artist's verified profiles: what is stored with the artist and reused by every later import. */
function SavedProfiles({ data, onRefresh }: { data: DiscoveryData; onRefresh: () => void }) {
  const { open } = useActions();
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--t-green-bd)] bg-surface shadow-[var(--shadow)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <p className="flex items-center gap-2 text-base font-semibold text-ink"><Check size={17} className="text-[var(--t-green)]" />Saved profiles · {data.verified.length}</p>
        <p className="text-xs text-muted">Verified by a person and stored with the artist{data.lastVerifiedAt ? ` · last on ${fmtDate(data.lastVerifiedAt)}` : ''}</p>
      </header>
      <ul className="divide-y divide-line">
        {data.verified.map(v => (
          <li key={v.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <PlatformBadge platform={v.platform} size="lg" />
              <div className="min-w-0 flex-1 basis-56">
                <p className="flex flex-wrap items-center gap-x-2"><span className="text-base font-semibold text-ink">{v.displayName}</span>{handleOf(v.platform, v.username) && <span className="text-sm text-muted">{handleOf(v.platform, v.username)}</span>}<span className="text-xs text-muted">{v.platform}</span></p>
                <a href={v.url} target="_blank" rel="noopener noreferrer" className="mono block truncate text-xs text-accent-text hover:underline" title={v.url}>{v.url.replace(/^https?:\/\//, '')}</a>
                <p className="text-xs text-muted">Verified by {v.verifiedBy} on {fmtDate(v.verifiedAt)}{v.stale ? <span className="font-medium text-[var(--t-orange)]"> · not checked for {v.daysSinceCheck} days</span> : ''}{v.notFound ? ' · not found in the latest search' : ''}</p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <ProfileLink url={v.url} small />
                {v.stale && <Button size="sm" onClick={onRefresh}>Check again</Button>}
              </div>
            </div>
            {v.change && (
              <div className="mt-2 rounded-md border border-[var(--t-orange-bd)] bg-[var(--t-orange-bg)] px-3 py-2 text-sm">
                <p className="font-semibold text-[var(--t-orange)]">Possible new {v.platform} profile</p>
                <p className="text-ink-2"><b>{handleOf(v.platform, v.change.username) ?? v.change.url}</b> was found instead of the verified one. Nothing was overwritten.</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <ProfileLink url={v.change.url} small label="Open new" />
                  <Button size="sm" variant="primary" onClick={() => open('resolveProfileChange', { caseId: data.caseId, preset: { profileId: v.change!.id, decision: 'verify_new' } })}>Use the new one</Button>
                  <Button size="sm" onClick={() => open('resolveProfileChange', { caseId: data.caseId, preset: { profileId: v.change!.id, decision: 'keep_old' } })}>Keep old</Button>
                  <Button size="sm" variant="danger" onClick={() => open('resolveProfileChange', { caseId: data.caseId, preset: { profileId: v.change!.id, decision: 'reject_new' } })}>Reject new</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RejectedList({ rejected, replaced }: { rejected: ProfileV[]; replaced: ProfileV[] }) {
  const app = useApp();
  const [show, setShow] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-surface">
      <button type="button" onClick={() => setShow(s => !s)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-ink-2 hover:bg-hover">
        <ChevronRight size={15} className={cx('text-muted transition-transform', show && 'rotate-90')} />Rejected profiles ({rejected.length + replaced.length})
      </button>
      {show && (
        <ul className="divide-y divide-line border-t border-line">
          {[...rejected, ...replaced].map(p => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <PlatformBadge platform={p.platform} size="sm" />
              <span className="min-w-0 flex-1"><span className="text-ink">{handleOf(p.platform, p.username) ?? p.displayName}</span><span className="block text-xs text-muted">{p.status === 'REPLACED' ? p.reviewNote : `Reason: ${p.rejectionReason}`}{p.reviewedBy ? ` · ${p.reviewedBy}` : ''}</span></span>
              {p.status === 'REJECTED' && <Button size="sm" variant="ghost" onClick={() => app.run('reconsiderProfile', { profileId: p.id })}>Reconsider</Button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchHistory({ jobs }: { jobs: JobV[] }) {
  const [show, setShow] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="rounded-lg border border-line bg-surface">
      <button type="button" onClick={() => setShow(s => !s)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-ink-2 hover:bg-hover">
        <ChevronRight size={15} className={cx('text-muted transition-transform', show && 'rotate-90')} /><History size={15} className="text-muted" />Search history ({jobs.length})
      </button>
      {show && (
        <ul className="divide-y divide-line border-t border-line">
          {jobs.map(j => (
            <li key={j.id}>
              <button type="button" onClick={() => setOpenId(openId === j.id ? null : j.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left text-sm hover:bg-hover">
                <span className="font-medium text-ink">v{j.version} · {j.mode === 'full' ? 'Full search' : j.mode === 'refresh' ? 'Search again' : 'After an import'}</span>
                <span className="text-muted">{fmtDateTime(j.startedAt ?? j.createdAt)}</span>
                <span className="ml-auto text-xs text-muted tnum">{j.status === 'FAILED' ? `failed: ${j.failureReason}` : `${j.queryCount} searches · ${j.profileCount} profiles`}</span>
              </button>
              {openId === j.id && <JobQueries job={j} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function JobQueries({ job }: { job: JobV }) {
  const { data } = useQuery<{ id: string; provider: string; query: string; status: string; results: number }[]>('discoveryJobQueries', { jobId: job.id });
  if (!data) return <div className="px-4 py-3"><Skeleton className="h-12" /></div>;
  return (
    <ul className="space-y-0.5 border-t border-line bg-surface-2 px-4 py-3 text-xs text-ink-2">
      {data.map(q => <li key={q.id} className="flex flex-wrap gap-x-3"><span className="mono">{q.query}</span><span className="text-muted">{q.provider} · {q.status === 'ok' ? `${q.results} results` : q.status}</span></li>)}
    </ul>
  );
}
