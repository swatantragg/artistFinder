// Cross-artist work views kept under Settings → More tools: manual research and contacts & routes.
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ROUTE_STATES } from '../../domain/constants';
import { useActions } from '../components/actions';
import { DueText, RouteChain } from '../components/case-bits';
import { Badge, Button, Card, DataTable, Empty, PageHeader, Segmented, StageBadge, StatusBadge, Tabs } from '../components/ui';
import { useQuery } from '../lib/app';
import { fmtAgo, fmtDate, fmtDateTime, num } from '../lib/format';

// ------------------------------------------------------------------ Research
interface ResearchOv {
  working: { id: string; name: string; stage: string; owner: string; songs: number; done: number; blocked: number; waiting: { blocker: string; nextReviewDate: string } | null }[];
  activities: { id: string; caseId: string; caseName: string; source: string; query: string; result: string; researcherName: string; date: string; minutes: number; confidence: number }[];
}
export function ResearchPage() {
  const { data } = useQuery<ResearchOv>('researchOverview');
  const navigate = useNavigate();
  const [view, setView] = useState<'Researching' | 'Waiting for Evidence'>('Researching');
  const rows = data?.working.filter(w => w.stage === view);
  return (
    <>
      <PageHeader title="Research" subtitle="Cases being researched and cases waiting for evidence. Every search is logged, including the ones that found nothing." />
      <Card pad={false} title="Research workload" actions={<Segmented options={[{ id: 'Researching', label: `Researching${data ? ` (${data.working.filter(w => w.stage === 'Researching').length})` : ''}` }, { id: 'Waiting for Evidence', label: `Waiting${data ? ` (${data.working.filter(w => w.stage === 'Waiting for Evidence').length})` : ''}` }]} value={view} onChange={setView} />}>
        <DataTable rows={rows} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.id}?tab=evidence`)}
          empty={<Empty compact title={view === 'Researching' ? 'Nobody is researching right now.' : 'No cases are waiting for evidence.'} action={view === 'Researching' ? <Button size="sm" onClick={() => navigate('/queue')}>Pick up an artist</Button> : undefined} />}
          columns={[
            { key: 'n', header: 'Artist', render: r => <span className="font-medium">{r.name}</span> },
            { key: 'o', header: 'Owner', render: r => r.owner },
            { key: 's', header: 'Songs', render: r => num(r.songs), className: 'tnum' },
            { key: 'c', header: 'Checklist', render: r => <span className="inline-flex items-center gap-2"><span className="h-1.5 w-20 overflow-hidden rounded-full bg-hover"><span className="tone-green tone-dot block h-full" style={{ width: `${(r.done / 8) * 100}%` }} /></span><span className="tnum text-xs">{r.done}/8</span>{r.blocked > 0 && <Badge tone="red">{r.blocked} blocked</Badge>}</span> },
            { key: 'w', header: view === 'Researching' ? 'Stage' : 'Blocker', render: r => r.waiting && view !== 'Researching' ? <span className="text-ink-2">{r.waiting.blocker}</span> : <StageBadge stage={r.stage as never} /> },
            ...(view !== 'Researching' ? [{ key: 'nr', header: 'Next review', render: (r: ResearchOv['working'][number]) => <DueText date={r.waiting?.nextReviewDate ?? null} /> }] : []),
          ]} />
      </Card>
      <Card className="mt-4" pad={false} title="Latest research activity">
        <DataTable rows={data?.activities} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.caseId}?tab=evidence`)} empty={<Empty compact title="No research activity yet." />}
          columns={[
            { key: 'd', header: 'When', render: r => <span className="whitespace-nowrap">{fmtDateTime(r.date)}</span> },
            { key: 'a', header: 'Artist', render: r => <span className="font-medium">{r.caseName}</span> },
            { key: 's', header: 'Source', render: r => r.source },
            { key: 'q', header: 'Query', render: r => <span className="block max-w-[220px] truncate">{r.query || '—'}</span> },
            { key: 'r', header: 'Result', render: r => r.result },
            { key: 'c', header: 'Conf.', render: r => `${r.confidence}%`, className: 'tnum' },
            { key: 'w', header: 'Researcher', render: r => r.researcherName },
            { key: 'm', header: 'Time', render: r => `${r.minutes} min`, className: 'tnum whitespace-nowrap' },
          ]} />
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ Contact & Routes
export function RoutesPage() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'routes';
  const { open } = useActions();
  return (
    <>
      <PageHeader title="Contact & Routes" subtitle="Routes to artists, the verified contact directory, and every outreach attempt. Contact identity is separate from artist identity and from claim authority."
        actions={tab === 'contacts' ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => open('addContact')}>Add contact</Button> : undefined} />
      <div className="rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
        <div className="px-2"><Tabs tabs={[{ id: 'routes', label: 'Routes' }, { id: 'contacts', label: 'Contact directory' }, { id: 'attempts', label: 'Contact attempts' }]} value={tab} onChange={t => setSp(t === 'routes' ? {} : { tab: t }, { replace: true })} /></div>
        {tab === 'routes' && <RoutesList />}
        {tab === 'contacts' && <ContactsList />}
        {tab === 'attempts' && <AttemptsList />}
      </div>
    </>
  );
}
function RoutesList() {
  const [state, setState] = useState('');
  const { data } = useQuery<{ id: string; targetCaseId: string; state: string; chain: { kind: string; label: string; sub?: string }[]; confidence: number; ownerName: string; origin: string; lastChecked: string | null; rejectionReason: string | null }[]>('routesOverview', { state });
  const navigate = useNavigate();
  return (
    <>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
        {['', ...ROUTE_STATES].map(s => <button key={s} type="button" onClick={() => setState(s)} className={`rounded-full border px-3 py-1 text-xs ${state === s ? 'border-sel-line bg-sel font-medium text-sel-ink' : 'border-line-strong text-ink-2 hover:bg-hover'}`}>{s || 'All states'}</button>)}
      </div>
      <DataTable rows={data} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.targetCaseId}?tab=routes`)} empty={<Empty compact title="No verified routes found." />}
        columns={[
          { key: 'id', header: 'Route', render: r => <span className="mono">{r.id}</span> },
          { key: 'c', header: 'Path to the artist', render: r => <RouteChain chain={r.chain} /> },
          { key: 's', header: 'State', render: r => <span><StatusBadge value={r.state} />{r.rejectionReason && <span className="mt-0.5 block max-w-[200px] text-xs text-muted">{r.rejectionReason}</span>}</span> },
          { key: 'cf', header: 'Conf.', render: r => `${r.confidence}%`, className: 'tnum' },
          { key: 'o', header: 'Owner', render: r => r.ownerName },
          { key: 'org', header: 'From', render: r => <span className="text-xs text-muted">{r.origin}</span> },
          { key: 'l', header: 'Last checked', render: r => fmtAgo(r.lastChecked) },
        ]} />
    </>
  );
}
function ContactsList() {
  const { data } = useQuery<{ id: string; personName: string; caseId: string | null; organisation: string | null; role: string; channel: string; value: string; authorityEvidence: string; verified: boolean; verifiedByName: string | null; verifiedAt: string | null; willingIntroducer: boolean; routes: number }[]>('contacts');
  const { open } = useActions();
  return (
    <DataTable rows={data} rowKey={r => r.id} empty={<Empty compact title="The contact directory is empty." action={<Button size="sm" onClick={() => open('addContact')}>Add contact</Button>} />}
      columns={[
        { key: 'n', header: 'Name', render: r => <span>{r.caseId ? <Link to={`/artists/${r.caseId}`} className="font-medium underline decoration-line-strong hover:decoration-ink">{r.personName}</Link> : <span className="font-medium">{r.personName}</span>}{r.willingIntroducer && <Badge tone="gold" className="ml-1.5">Willing introducer</Badge>}</span> },
        { key: 'r', header: 'Role', render: r => r.role },
        { key: 'c', header: 'Channel', render: r => <span>{r.channel}<span className="block text-xs text-muted">{r.value}</span></span> },
        { key: 'a', header: 'Source / authority', render: r => <span className="block max-w-[260px] text-xs text-ink-2">{r.authorityEvidence || '—'}</span> },
        { key: 'v', header: 'Verified', render: r => r.verified ? <span><Badge tone="green" dot>Verified</Badge><span className="block text-xs text-muted">{r.verifiedByName} · {fmtDate(r.verifiedAt)}</span></span> : <Button size="sm" onClick={() => open('verifyContact', { contactId: r.id })}>Verify</Button> },
        { key: 'rt', header: 'Routes', render: r => num(r.routes), className: 'tnum' },
      ]} />
  );
}
function AttemptsList() {
  const { data } = useQuery<{ id: string; caseId: string; caseName: string; date: string; channel: string; recipient: string; result: string; evidence: string; nextAction: string; ownerName: string }[]>('recentAttempts');
  const navigate = useNavigate();
  return (
    <DataTable rows={data} rowKey={r => r.id} onRowClick={r => navigate(`/artists/${r.caseId}?tab=routes`)} empty={<Empty compact title="No contact attempts recorded." />}
      columns={[
        { key: 'd', header: 'Date', render: r => <span className="whitespace-nowrap">{fmtDateTime(r.date)}</span> },
        { key: 'a', header: 'Artist', render: r => <span className="font-medium">{r.caseName}</span> },
        { key: 'c', header: 'Channel', render: r => r.channel },
        { key: 'r', header: 'Recipient', render: r => r.recipient },
        { key: 'res', header: 'Result', render: r => <Badge tone={['Conversation Confirmed', 'Interested', 'Needs Help'].includes(r.result) ? 'green' : ['Declined', 'Do Not Contact', 'Wrong Person', 'Bounce'].includes(r.result) ? 'red' : 'neutral'} dot>{r.result}</Badge> },
        { key: 'e', header: 'Evidence', render: r => <span className="block max-w-[220px] text-xs text-ink-2">{r.evidence || '—'}</span> },
        { key: 'n', header: 'Next action', render: r => r.nextAction },
        { key: 'o', header: 'Owner', render: r => r.ownerName },
      ]} />
  );
}

// ------------------------------------------------------------------ Claims & Activation
