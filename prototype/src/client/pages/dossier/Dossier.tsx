// Artist Detail / Dossier (v2 §22): the single source of truth for one artist. The header answers who it is, where it
// stands (identity, discovery and Goongoonalo shown separately), what the software found and what to do next.
import { AlertTriangle, Ban, GitMerge, RotateCcw, SearchX, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { LifecycleStage } from '../../../domain/constants';
import { useActions } from '../../components/actions';
import { PeopleGraph } from '../../components/discovery/PeopleGraph';
import { PossibleConnections, type PathV } from '../../components/discovery/Connections';
import { DiscoveryPanel, useDiscovery } from '../../components/discovery/DiscoveryPanel';
import { DiscoveryChip } from '../../components/discovery/bits';
import { GoongoonaloBadge, IdentityBadge, KindBadge } from '../../components/status';
import { Avatar, Button, Empty, ErrorBox, Menu, Notice, Skeleton, Tabs } from '../../components/ui';
import { useApp, useQuery } from '../../lib/app';
import { fmtAgo, fmtDate, fmtDateTime, num } from '../../lib/format';
import { CollaboratorsTab, ResearchTab, RoutesTab, SongsTab } from './tabs-identity';
import { ActivationTab, AttemptsTab, ClaimsTab, TimelineTab } from './tabs-work';
import { OverviewTab, ProfilesTab } from './tabs-v2';

export interface CaseV2 {
  kind: string; artistStatus: string; statusInfo: { label: string; meaning: string }; goongoonaloStatus: string; goongoonaloInfo: { label: string; meaning: string };
  goongoonaloAt: string | null; goongoonaloBy: string | null; verified: boolean; verifiedVia: string | null; firstVerifiedAt: string | null;
  rejected: { at: string; reason: string | null } | null;
  reopen: { at: string; by: string; previousStatus: string; reasons: { kind: string; text: string; at: string }[] } | null;
  summary: { songs: number; albums: number; collaborators: number; labels: string[]; verifiedProfiles: number; possibleRoutes: number };
  lastDiscovery: string | null; sources: { id: string; file: string; date: string }[];
  history: { id: string; kind: string; from: string | null; to: string; at: string; byName: string; reason: string | null }[];
  action: { id: string; label: string } | null; canSetGoongoonalo: boolean;
}
export interface CaseDetail {
  case: {
    id: string; canonicalName: string; aliases: string[]; backendProfileIds: string[]; profileUrls: string[]; roles: string[]; language: string | null; identityStatus: string; identityEvidence: string | null;
    lifecycleStage: LifecycleStage; previousStage: string | null; stageReason: string; stageSince: string; workReason: string; contactPreference: string; contactPreferenceUntil: string | null; ownerId: string | null;
    nextAction: string | null; nextActionDate: string | null; firstSeen: string; lastSeen: string; lastEvidenceChange: string | null; lastEvidenceNote: string | null; claimStatus: string; activationStatus: string;
    priority: string; priorityScore: number; mergedIntoId: string | null; closedReason: string | null; waiting: { blocker: string; routesTested: string[]; coverage: string; lastReview: string; futureTrigger: string; nextReviewDate: string } | null;
    arm: unknown; firstSeenBatchId: string | null;
  };
  ownerName: string; artistId: string | null; songs: number;
  counts: Record<'songs' | 'collaborators' | 'routes' | 'research' | 'attempts' | 'claims' | 'activation' | 'tasks' | 'timeline', number>;
  progress: { label: string; state: 'done' | 'active' | 'todo'; note: string }[];
  whyExists: string; evidence: string[]; openTasks: any[]; actions: { id: string; label: string; primary?: boolean; disabled?: string }[];
  conflicts: { id: string; reason: string }[]; mergedInto: { id: string; name: string } | null; mergedChildren: { id: string; name: string; backendIds: string[] }[];
  reopen: { date: string; oldStage: string; newStage: string; evidence: string; why: string; routeId: string | null; taskId: string | null; batchId: string | null } | null;
  stageMeaning: string; tried: { routesClosed: string[]; attempts: number; research: number };
  discovery: { status: string; verified: { platform: string; username: string | null; stale: boolean }[]; open: number; lastSearchAt: string | null; lastVersion: number; active: { id: string; step: number; label: string; status: string } | null; paths: number };
  routesForForms: { id: string; state: string; chain: { kind: string; label: string; sub?: string }[] }[];
  v2: CaseV2;
}

const PRIMARY_V2 = new Set(['findArtist', 'retrySearch', 'reviewCandidates', 'viewDiscovery', 'setGoongoonalo']);

export default function Dossier() {
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const { data: d, error } = useQuery<CaseDetail | null>('caseDetail', { id });
  const { open } = useActions();
  const navigate = useNavigate();
  const { meta } = useApp();

  if (error) return <ErrorBox text={error} />;
  if (d === null) return <Empty title="Artist not found." text={`No artist with ID ${id}.`} action={<Button onClick={() => navigate('/artists')}>Back to Artists</Button>} />;
  if (!d) return <div className="space-y-3"><Skeleton className="h-36" /><Skeleton className="h-16" /><Skeleton className="h-80" /></div>;

  const c = d.case, v = d.v2;
  const ctx = { caseId: c.id };
  const blocked = meta?.discoveryBlocked ?? null;
  // One obvious next step: the discovery / verification step when there is one, otherwise the outreach step.
  const v2Primary = v.action && PRIMARY_V2.has(v.action.id) ? { id: v.action.id, label: v.action.label, disabled: blocked && ['findArtist', 'retrySearch'].includes(v.action.id) ? blocked : undefined } : v.reopen ? { id: 'markReopenReviewed', label: 'Mark changes reviewed', disabled: undefined } : null;
  const lifecyclePrimary = d.actions.find(a => a.primary && !['findArtist', 'reviewCandidates', 'viewDiscovery', 'findConnection'].includes(a.id));
  // An open outreach task (access, first use …) comes before the Goongoonalo decision, which stays one click away in More.
  const primary = (v2Primary?.id === 'setGoongoonalo' && lifecyclePrimary ? lifecyclePrimary : v2Primary) ?? lifecyclePrimary ?? d.actions.find(a => a.id === 'findConnection') ?? null;
  const extra = [
    ...(v.canSetGoongoonalo && primary?.id !== 'setGoongoonalo' ? [{ id: 'setGoongoonalo', label: 'Set Goongoonalo status' }] : []),
    ...(!v.verified && !v.rejected ? [{ id: 'confirmIdentity', label: 'Confirm identity by hand…' }] : []),
    ...(v.verified && !v.reopen ? [{ id: 'reopenArtist', label: 'Reopen for review…' }] : []),
    ...(v.rejected ? [{ id: 'restoreArtist', label: 'Restore artist record' }] : [{ id: 'rejectArtist', label: 'Reject artist record…' }]),
  ];
  const menu = [...d.actions.filter(a => a.id !== primary?.id), ...extra.map(x => ({ ...x, primary: false, disabled: undefined as string | undefined }))];
  const relevant = {
    routes: d.counts.routes + d.counts.attempts > 0 || v.verified || !['Unresearched', 'Researching', 'Identity Review'].includes(c.lifecycleStage),
    claims: v.verified || c.claimStatus !== 'Not Invited' || d.counts.claims > 0 || !['Unresearched', 'Researching', 'Identity Review', 'Waiting for Evidence', 'Route Ready'].includes(c.lifecycleStage),
    activation: c.claimStatus === 'Completed' || d.counts.activation > 0,
  };
  const tabs = [
    { id: 'overview', label: 'Overview', count: null },
    { id: 'profiles', label: 'Profiles', count: v.summary.verifiedProfiles || null },
    { id: 'songs', label: 'Songs', count: d.counts.songs || null },
    { id: 'collaborators', label: 'Collaborators', count: d.counts.collaborators || null },
    { id: 'evidence', label: 'Evidence', count: d.discovery.open || null },
    { id: 'graph', label: 'Connection Graph', count: d.discovery.paths || null },
    ...(relevant.routes ? [{ id: 'routes', label: 'Routes', count: d.counts.routes || null }] : []),
    ...(relevant.claims ? [{ id: 'claims', label: 'Claims', count: d.counts.claims || null }] : []),
    ...(relevant.activation ? [{ id: 'activation', label: 'Activation', count: d.counts.activation || null }] : []),
    { id: 'timeline', label: 'Timeline', count: null },
  ];
  const asked = sp.get('tab') ?? 'overview';
  const tab = tabs.some(t => t.id === asked) ? asked : asked === 'discovery' ? 'evidence' : 'overview';

  return (
    <>
      <Link to="/artists" className="mb-2 inline-flex text-sm text-muted hover:text-ink">← Artists</Link>
      <section className="rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
        <div className="flex flex-wrap items-start gap-3 p-3 sm:gap-4 sm:p-4">
          <Avatar name={c.canonicalName} size={56} className="max-sm:hidden" />
          <div className="@container min-w-[200px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">{c.canonicalName}</h1>
              <KindBadge kind={v.kind} />
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <span>Artist ID <span className="mono text-ink">{c.id}</span></span>
              {c.backendProfileIds.length > 0 && <span>Source ID <span className="mono text-ink">{c.backendProfileIds.join(', ')}</span></span>}
              <span>{num(v.summary.songs)} songs</span>
              <span>{num(v.summary.collaborators)} collaborators</span>
              {c.aliases.length > 0 && <span>aka {c.aliases.join(', ')}</span>}
            </p>
            <div className="mt-3 grid gap-2 @min-[34rem]:grid-cols-3">
              <StatusBlock label="Identity" help={v.statusInfo.meaning}>
                <IdentityBadge status={v.artistStatus} />
                <span className="block text-xs text-muted">{v.verified ? `Verified · ${v.verifiedVia ?? ''}` : v.statusInfo.meaning.split('.')[0]}</span>
              </StatusBlock>
              <StatusBlock label="Discovery" help="What the software has searched and found">
                <button type="button" onClick={() => setSp({ tab: 'evidence' })} className="text-left">{d.discovery.active ? <DiscoveryChip status="Searching" extra={`${d.discovery.active.step + 1}/7`} /> : <DiscoveryChip status={d.discovery.status} extra={d.discovery.open ? `(${d.discovery.open})` : undefined} />}</button>
                <span className="block text-xs text-muted">{v.lastDiscovery ? `Last search ${fmtAgo(v.lastDiscovery)}` : 'Never searched'}</span>
              </StatusBlock>
              <StatusBlock label="Goongoonalo" help={v.goongoonaloInfo.meaning}>
                {v.canSetGoongoonalo ? (
                  <button type="button" onClick={() => open('setGoongoonalo', ctx)} className="rounded-full" title="Change the Goongoonalo status"><GoongoonaloBadge status={v.goongoonaloStatus} /> <span className="text-xs text-muted">▾ change</span></button>
                ) : <GoongoonaloBadge status={v.goongoonaloStatus} />}
                <span className="block text-xs text-muted">{v.goongoonaloAt ? `${v.goongoonaloBy ?? ''} · ${fmtDate(v.goongoonaloAt)}` : v.canSetGoongoonalo ? 'Not decided yet' : 'Decided once the artist is verified'}</span>
              </StatusBlock>
            </div>
          </div>
          {/* Beside the artist on wide screens; below it (text left, buttons right) when there is less room. */}
          <div className="@container w-full rounded-lg border border-accent-line bg-accent-soft/60 p-3.5 2xl:w-[340px]">
            <div className="flex flex-col gap-3 @xl:flex-row @xl:items-center @xl:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted">Next step · Owner {d.ownerName}</p>
                <p className="mt-0.5 text-base font-medium text-ink">{primary?.label ?? c.nextAction ?? 'Nothing to do right now'}</p>
                {c.nextAction && primary && c.nextAction !== primary.label && <p className="text-xs text-muted">Task: {c.nextAction}{c.nextActionDate ? ` · due ${fmtDate(c.nextActionDate)}` : ''}</p>}
              </div>
              <div className="flex items-center gap-2 @xl:shrink-0">
                {primary && <Button variant="primary" className="flex-1 @xl:flex-none" disabled={!!primary.disabled} title={primary.disabled} onClick={() => open(primary.id, ctx)}>{primary.label}</Button>}
                {menu.length > 0 && <Menu items={menu.map(a => ({ label: a.label, disabled: a.disabled, onClick: () => open(a.id, ctx), danger: a.id === 'closeCase' || a.id === 'rejectArtist' }))} trigger={<Button>More</Button>} />}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-3 space-y-2">
        {v.reopen && (
          <Notice tone="violet" icon={<RotateCcw size={18} />} title={`Reopened ${fmtAgo(v.reopen.at)}: something changed since the last review`}
            action={<span className="flex flex-wrap gap-1.5"><Button size="sm" variant="primary" onClick={() => open('markReopenReviewed', ctx)}>Mark reviewed</Button>{d.discovery.lastSearchAt && <Button size="sm" onClick={() => open('refreshSearch', ctx)}>Refresh search</Button>}</span>}>
            <ul className="list-inside list-disc">{v.reopen.reasons.map(r => <li key={r.at + r.text}>{r.text} <span className="text-xs text-muted">({fmtDateTime(r.at)})</span></li>)}</ul>
            <span className="mt-1 block text-xs text-muted">Earlier verification and evidence are kept{v.verified ? ' (still verified)' : ''}.</span>
          </Notice>
        )}
        {v.rejected && <Notice tone="red" icon={<Trash2 size={18} />} title="Rejected artist record" action={<Button size="sm" onClick={() => open('restoreArtist', ctx)}>Restore</Button>}>{v.rejected.reason} · {fmtDate(v.rejected.at)}. Kept with its history; not searched or contacted.</Notice>}
        {blocked && ['NEW', 'PENDING'].includes(v.artistStatus) && <Notice tone="red" icon={<SearchX size={18} />} title="Find artist is off for this catalogue">{blocked}</Notice>}
        {d.mergedInto && <Notice tone="neutral" icon={<GitMerge size={18} />} title={`Merged into ${d.mergedInto.name}`} action={<Button size="sm" onClick={() => navigate(`/artists/${d.mergedInto!.id}`)}>Open {d.mergedInto.id}</Button>}>This record was confirmed as a duplicate. Its history is kept here; work continues on the other artist.</Notice>}
        {d.conflicts.length > 0 && <Notice tone="orange" icon={<AlertTriangle size={18} />} title="Possible duplicate" action={<Button size="sm" onClick={() => navigate('/deduplicate')}>Open Deduplicate</Button>}>{d.conflicts[0].reason}</Notice>}
        {(c.contactPreference === 'Do Not Contact' || c.contactPreference === 'Declined') && <Notice tone="red" icon={<Ban size={18} />} title={c.contactPreference === 'Do Not Contact' ? 'Do not contact' : 'Artist declined'}>Outreach is blocked. Imports and discovery can still add songs, credits and profiles, but never create outreach.</Notice>}
      </div>

      <div className="mt-4 rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
        <div className="px-2"><Tabs tabs={tabs} value={tab} onChange={t => setSp(t === 'overview' ? {} : { tab: t }, { replace: true })} /></div>
        <div className="p-3 sm:p-4">
          {tab === 'overview' && <OverviewTab d={d} onTab={t => setSp({ tab: t })} />}
          {tab === 'profiles' && <ProfilesTab d={d} onTab={t => setSp({ tab: t })} />}
          {tab === 'songs' && <SongsTab id={c.id} />}
          {tab === 'collaborators' && <CollaboratorsTab id={c.id} />}
          {tab === 'evidence' && <EvidenceTab d={d} />}
          {tab === 'graph' && <GraphTab caseId={c.id} />}
          {tab === 'routes' && <><RoutesTab d={d} /><div className="mt-5"><p className="mb-2 text-sm font-semibold text-ink">Contact attempts</p><AttemptsTab d={d} /></div></>}
          {tab === 'claims' && <ClaimsTab d={d} />}
          {tab === 'activation' && <ActivationTab d={d} />}
          {tab === 'timeline' && <TimelineTab id={c.id} />}
        </div>
      </div>
    </>
  );
}

function StatusBlock({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-line px-2.5 py-2" title={help}>
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/** What the software found (candidates, evidence, conflicts, history), with manual research as the optional fallback. */
function EvidenceTab({ d }: { d: CaseDetail }) {
  const [manual, setManual] = useState(d.counts.research > 0 && d.discovery.status === 'Not started');
  return (
    <div className="space-y-4">
      <DiscoveryPanel caseId={d.case.id} />
      <div className="rounded-lg border border-line">
        <button type="button" onClick={() => setManual(x => !x)} className="flex w-full items-center justify-between px-4 py-3 text-left">
          <span><span className="text-sm font-semibold text-ink">Manual research</span><span className="block text-xs text-muted">Optional, for difficult cases: the research checklist and notes ({num(d.counts.research)} record{d.counts.research === 1 ? '' : 's'}).</span></span>
          <span className="text-xs text-muted">{manual ? 'Hide' : 'Show'}</span>
        </button>
        {manual && <div className="border-t border-line p-4"><ResearchTab d={d} /></div>}
      </div>
    </div>
  );
}

function GraphTab({ caseId }: { caseId: string }) {
  const { data } = useDiscovery(caseId);
  const app = useApp();
  const [finding, setFinding] = useState(false);
  const paths = (data?.paths ?? []) as PathV[];
  const find = async () => { setFinding(true); await app.run('findConnection', { caseId }); setFinding(false); };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Who this artist works with: everyone credited on the artist’s songs, with the song and their role. Find connection looks for a possible path to a person with a verified contact (evidence of working together, never proof that people know each other).</p>
      <PeopleGraph caseId={caseId} />
      <PossibleConnections caseId={caseId} paths={paths} onFind={find} finding={finding} />
    </div>
  );
}
