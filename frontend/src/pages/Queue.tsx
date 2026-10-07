// Today's Queue: the page an operator works from every day. Each task says what to do, why, what changed and by when.
import { Coffee, Inbox } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useActions } from '../components/actions';
import { TaskCard, type TaskRowLike } from '../components/case-bits';
import { Button, Card, Empty, ErrorBox, PageHeader, Segmented, Skeleton, StatusBadge } from '../components/ui';
import { useApp, useQuery } from '../lib/app';
import { num } from '../lib/format';

const SECTIONS: { id: string; title: string; hint: string }[] = [
  { id: 'overdue', title: 'Overdue', hint: 'Past their due date. Clear these first.' },
  { id: 'dueToday', title: 'Due today', hint: 'Follow-ups, callbacks and research due today.' },
  { id: 'newLeads', title: 'New leads', hint: 'An import or a newly verified contact opened a route.' },
  { id: 'routeReady', title: 'Route ready', hint: 'A verified route is selected; outreach is due.' },
  { id: 'identity', title: 'Identity reviews', hint: 'Decisions needed before any contact.' },
  { id: 'claimSupport', title: 'Claim support', hint: 'Invitations, submissions, reviews and backend checks.' },
  { id: 'activation', title: 'Activation tasks', hint: 'Access, first meaningful use and ARM handover.' },
  { id: 'reengagement', title: 'Re-engagement', hint: 'Activated artists with no further use.' },
  { id: 'upcoming', title: 'Coming up', hint: 'Scheduled for later; shown for planning.' },
];

interface Q { sections: Record<string, TaskRowLike[]>; conflicts: number; unresearched: { id: string; name: string; artistId: string; songs: number; priority: string }[]; total: number }

export default function Queue() {
  const [sp, setSp] = useSearchParams();
  const scope = (sp.get('scope') as 'mine' | 'team') ?? 'mine';
  const { data, error } = useQuery<Q>('queue', { scope });
  const { meta } = useApp();
  const { open } = useActions();
  const loc = useLocation();
  useEffect(() => { if (data && loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: 'start' }); }, [data, loc.hash]);
  const now = data ? SECTIONS.filter(s => s.id !== 'upcoming').reduce((n, s) => n + (data.sections[s.id]?.length ?? 0), 0) : 0;

  return (
    <>
      <PageHeader title="Today's Queue" subtitle={data ? `${num(now)} task${now === 1 ? '' : 's'} for ${scope === 'mine' ? meta?.me?.name ?? 'you' : 'the team'} today · start with overdue, then new leads, then route-ready outreach` : 'Loading…'}
        actions={<Segmented options={[{ id: 'mine', label: 'My tasks' }, { id: 'team', label: 'Whole team' }]} value={scope} onChange={v => setSp(v === 'mine' ? {} : { scope: v }, { replace: true })} />} />
      {error && <ErrorBox text={error} />}
      {!data ? <div className="space-y-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div> : (
        <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
          <div className="space-y-6">
            {now === 0 && (
              <Card><Empty icon={<Coffee size={28} />} title={scope === 'mine' ? 'Nothing due for you today.' : 'Nothing due for the team today.'} text="Pick up an unresearched artist, or check the whole team’s queue." action={scope === 'mine' ? <Button onClick={() => setSp({ scope: 'team' })}>Show whole team</Button> : undefined} /></Card>
            )}
            {SECTIONS.map(s => {
              const list = data.sections[s.id] ?? [];
              if (!list.length) return null;
              return (
                <section key={s.id} id={s.id} className="scroll-mt-4">
                  <header className="mb-2 flex items-baseline gap-2">
                    <h2 className={`text-md font-semibold ${s.id === 'overdue' ? 'text-[var(--t-red)]' : 'text-ink'}`}>{s.title}</h2>
                    <span className="text-sm tnum text-muted">{list.length}</span>
                    <span className="text-xs text-muted">· {s.hint}</span>
                  </header>
                  <div className="space-y-2">{list.map(t => <TaskCard key={t.id} t={t} />)}</div>
                </section>
              );
            })}
          </div>
          <aside className="space-y-4">
            <Card title="Start of day">
              <ol className="list-inside list-decimal space-y-1 text-sm text-ink-2">
                <li>Replies and agreed callbacks</li><li>Overdue tasks</li><li>New lead alerts</li><li>Route-ready outreach</li><li>Unresearched artists</li>
              </ol>
              <p className="mt-2 text-xs text-muted">Every worked case ends with an outcome and a next step.</p>
            </Card>
            {data.conflicts > 0 && (
              <Card title="Identity reviews waiting"><p className="text-sm text-ink-2">{data.conflicts} possible duplicate{data.conflicts === 1 ? '' : 's'} need a decision before contact.</p><Link to="/identity" className="mt-2 inline-block text-sm font-medium underline">Open Identity Review</Link></Card>
            )}
            <Card title="Unresearched: pick up next" subtitle="Highest priority, nobody assigned" pad={false}>
              {!data.unresearched.length ? <Empty compact icon={<Inbox size={20} />} title="All artists have an owner." /> : (
                <ul className="divide-y divide-line">
                  {data.unresearched.map(c => (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2">
                      <Link to={`/artists/${c.id}`} className="min-w-0"><span className="block truncate text-sm font-medium text-ink hover:underline">{c.name}</span><span className="text-xs text-muted"><span className="mono">{c.artistId}</span> · {c.songs} songs · <StatusBadge value={c.priority} dot={false} /></span></Link>
                      <Button size="sm" onClick={() => open('startResearch', { caseId: c.id })}>Start</Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </aside>
        </div>
      )}
    </>
  );
}
