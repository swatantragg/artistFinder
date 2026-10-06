// Dossier v2 tabs: Overview (summary, statuses, sources, tasks, history) and Profiles (verified knowledge).
import { AlertTriangle, ExternalLink, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ARTIST_STATUS_INFO, GOONGOONALO_INFO, type ArtistStatus, type GoongoonaloStatus } from '../../../domain/constants';
import { useActions } from '../../components/actions';
import { ProgressTrack, TaskCard } from '../../components/case-bits';
import { useDiscovery } from '../../components/discovery/DiscoveryPanel';
import { PlatformBadge, ProfileLink, handleOf } from '../../components/discovery/bits';
import { GoongoonaloBadge, IdentityBadge } from '../../components/status';
import { Badge, Button, Card, Empty, KeyVal, SkeletonRows, StageBadge } from '../../components/ui';
import { fmtAgo, fmtDate, fmtDateTime, num } from '../../lib/format';
import type { CaseDetail } from './Dossier';
import { WaitingCard } from './tabs-identity';

function SummaryTile({ label, value, onClick }: { label: string; value: number | string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className="rounded-md border border-line bg-surface-2 px-3 py-2 text-left enabled:hover:border-line-strong">
      <span className="block text-xs text-muted">{label}</span>
      <span className="block text-xl font-semibold tnum text-ink">{typeof value === 'number' ? num(value) : value}</span>
    </button>
  );
}

export function OverviewTab({ d, onTab }: { d: CaseDetail; onTab: (t: string) => void }) {
  const c = d.case, v = d.v2, s = v.summary;
  const { open } = useActions();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryTile label="Songs" value={s.songs} onClick={() => onTab('songs')} />
        <SummaryTile label="Albums" value={s.albums} onClick={() => onTab('songs')} />
        <SummaryTile label="Collaborators" value={s.collaborators} onClick={() => onTab('collaborators')} />
        <SummaryTile label="Labels" value={s.labels.length} />
        <SummaryTile label="Verified profiles" value={s.verifiedProfiles} onClick={() => onTab('profiles')} />
        <SummaryTile label="Possible routes" value={s.possibleRoutes} onClick={() => onTab('graph')} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Where the artist stands">
          <KeyVal items={[
            ['Identity status', <span key="i" className="flex flex-wrap items-center gap-2"><IdentityBadge status={v.artistStatus} /><span className="text-xs text-muted">{ARTIST_STATUS_INFO[v.artistStatus as ArtistStatus]?.meaning}</span></span>],
            ['Verified', v.verified ? `${v.verifiedVia ?? 'Yes'}${v.firstVerifiedAt ? ` · first on ${fmtDate(v.firstVerifiedAt)}` : ''}` : 'Not yet'],
            ['Discovery', d.discovery.active ? `Searching (step ${d.discovery.active.step + 1} of 7)` : `${d.discovery.status}${v.lastDiscovery ? ` · last search ${fmtDateTime(v.lastDiscovery)}` : ''}`],
            ['Goongoonalo status', <span key="g" className="flex flex-wrap items-center gap-2"><GoongoonaloBadge status={v.goongoonaloStatus} /><span className="text-xs text-muted">{v.goongoonaloAt ? `by ${v.goongoonaloBy} on ${fmtDate(v.goongoonaloAt)}` : GOONGOONALO_INFO[v.goongoonaloStatus as GoongoonaloStatus]?.meaning}</span></span>],
            ['Outreach', <span key="o" className="flex flex-wrap items-center gap-2"><StageBadge stage={c.lifecycleStage} /><span className="text-xs text-muted">{c.stageReason}</span></span>],
            ['Owner', d.ownerName],
            ['Next action', c.nextAction ? `${c.nextAction}${c.nextActionDate ? ` · due ${fmtDate(c.nextActionDate)}` : ''}` : null],
          ]} />
        </Card>
        <Card title="Record">
          <KeyVal items={[
            ['Artist ID', <span key="a" className="mono">{c.id}</span>],
            ['Source IDs', c.backendProfileIds.length ? <span key="s" className="mono">{c.backendProfileIds.join(', ')}</span> : 'None (matched by songs and name)'],
            ['Aliases', c.aliases.join(', ')],
            ['Type', v.kind === 'Collaborator' ? 'Collaborator (credited as composer, lyricist, producer …)' : 'Artist'],
            ['Language', c.language],
            ['Labels', s.labels.join(', ')],
            ['First seen', fmtDate(c.firstSeen)],
            ['Last seen', fmtDate(c.lastSeen)],
            ['Last evidence update', c.lastEvidenceChange ? `${fmtAgo(c.lastEvidenceChange)}: ${c.lastEvidenceNote ?? ''}` : null],
            ['Came from', v.sources.length ? <span key="f" className="flex flex-col">{v.sources.map(b => <Link key={b.id} to={`/imports/${b.id}`} className="underline decoration-line-strong hover:decoration-ink">{b.id} · {b.file} · {fmtDate(b.date)}</Link>)}</span> : d.whyExists],
            ...(d.mergedChildren.length ? [['Merged records', d.mergedChildren.map(x => `${x.name} (${x.backendIds.join(', ') || x.id})`).join('; ')] as [string, string]] : []),
          ]} />
        </Card>
      </div>
      {c.waiting && c.lifecycleStage === 'Waiting for Evidence' && <WaitingCard w={c.waiting} />}
      <Card title={`Open tasks (${d.openTasks.length})`} actions={<Button size="sm" icon={<Plus size={14} />} onClick={() => open('createTask', { caseId: c.id })}>Create task</Button>}>
        {d.openTasks.length ? <div className="space-y-2">{d.openTasks.map(t => <TaskCard key={t.id} t={t} showArtist={false} />)}</div>
          : <Empty compact title="No open tasks." text="The next step above is always the most useful thing to do." />}
      </Card>
      {c.lifecycleStage !== 'Unresearched' && <Card title="Outreach progress" subtitle="Route, contact, claim and activation for this artist"><ProgressTrack steps={d.progress} /></Card>}
      <Card title="Status history" subtitle="Identity and Goongoonalo status changes, with who and when">
        {!v.history.length ? <Empty compact title="No status changes yet." /> : (
          <ul className="space-y-1.5 text-sm">
            {v.history.map(e => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <span className="w-32 shrink-0 text-xs text-muted">{fmtDateTime(e.at)}</span>
                <Badge>{e.kind === 'goongoonalo' ? 'Goongoonalo' : 'Identity'}</Badge>
                <span className="text-ink">{e.from ? `${label(e.kind, e.from)} → ` : ''}<b>{label(e.kind, e.to)}</b></span>
                <span className="text-xs text-muted">{e.byName}{e.reason ? ` · ${e.reason}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
const label = (kind: string, s: string) => (kind === 'goongoonalo' ? GOONGOONALO_INFO[s as GoongoonaloStatus]?.label : ARTIST_STATUS_INFO[s as ArtistStatus]?.label) ?? s;

interface Verified { id: string; platform: string; url: string; username: string | null; displayName: string; verifiedAt: string; verifiedBy: string; lastCheckedAt: string; daysSinceCheck: number; stale: boolean; source: string; evidence: string; profileId: string | null; notFound: boolean; change: unknown }

/** Verified knowledge first; candidates stay in Evidence, history is never lost. */
export function ProfilesTab({ d, onTab }: { d: CaseDetail; onTab: (t: string) => void }) {
  const { data } = useDiscovery(d.case.id);
  if (!data) return <SkeletonRows rows={4} />;
  const verified = data.verified as Verified[];
  const replaced = (data.replaced ?? []) as { id: string; platform: string; username: string | null; url: string; reviewNote: string | null }[];
  const onFile = d.case.profileUrls.filter(u => !verified.some(v => v.url === u));
  const open = data.candidates.length;
  return (
    <div className="space-y-4">
      {verified.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {verified.map(v => (
            <div key={v.id} className="rounded-lg border border-line p-3">
              <div className="flex items-start gap-3">
                <PlatformBadge platform={v.platform} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-base font-semibold text-ink">{v.platform}{handleOf(v.platform, v.username) && <span className="font-normal text-ink-2">{handleOf(v.platform, v.username)}</span>}<Badge tone="green" dot>Verified</Badge></p>
                  <p className="truncate text-xs text-muted">{v.displayName} · <span className="mono">{v.url.replace(/^https?:\/\//, '')}</span></p>
                  <p className="mt-1 text-xs text-muted">Verified by {v.verifiedBy} on {fmtDate(v.verifiedAt)} · last checked {fmtAgo(v.lastCheckedAt)}{v.stale && <span className="ml-1 font-medium text-[var(--t-orange)]">· stale, refresh it</span>}</p>
                  {v.notFound && <p className="mt-1 flex items-center gap-1 text-xs text-[var(--t-orange)]"><AlertTriangle size={12} />Not found in the latest search: review the profile change in Evidence</p>}
                </div>
                <ProfileLink url={v.url} label="Open" small />
              </div>
            </div>
          ))}
        </div>
      ) : <Empty title="No verified profiles yet." text={open ? `${open} profile${open === 1 ? '' : 's'} found: verify the right ones in Evidence.` : 'Click Find artist: it looks for the artist’s own profiles on Spotify, YouTube, Instagram and more.'} action={<Button variant="primary" onClick={() => onTab('evidence')}>{open ? 'Review candidates' : 'Go to Evidence'}</Button>} />}
      {verified.length > 0 && open > 0 && <p className="text-sm text-ink-2">{open} more profile{open === 1 ? '' : 's'} found to review in <button type="button" className="underline" onClick={() => onTab('evidence')}>Evidence</button>.</p>}
      {onFile.length > 0 && (
        <Card title="Profile links on file" subtitle="From imports or earlier research, not verified through discovery">
          <ul className="space-y-1 text-sm">{onFile.map(u => <li key={u}><a href={u} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all underline decoration-line-strong">{u}<ExternalLink size={11} /></a></li>)}</ul>
        </Card>
      )}
      {replaced.length > 0 && (
        <Card title="Earlier profiles" subtitle="Replaced after a profile change; kept for history">
          <ul className="space-y-1 text-sm">{replaced.map(p => <li key={p.id} className="text-ink-2">{p.platform} {handleOf(p.platform, p.username) ?? p.url} <span className="text-xs text-muted">{p.reviewNote}</span></li>)}</ul>
        </Card>
      )}
    </div>
  );
}
