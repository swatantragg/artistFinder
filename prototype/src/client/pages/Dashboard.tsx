// Dashboard: the management overview (v2 §11). Every number counts artist records and real status-change timestamps;
// every tile opens the artists behind it.
import { FileUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ARTIST_STATUS_INFO } from '../../domain/constants';
import { Button, Card, Empty, PageHeader, Skeleton, cx } from '../components/ui';
import { useQuery } from '../lib/app';
import { fmtDate, fmtDateTime, fmtDue, num } from '../lib/format';

interface Overview {
  today: string; weekStart: string; monthStart: string; total: number; collaborators: number; duplicates: number; verifiedAll: number; searching: number;
  status: Record<string, number>; goongoonalo: Record<string, number>;
  week: { added: number; verified: number; goongoonalo: number }; month: { added: number; verified: number; goongoonalo: number };
  funnel: { label: string; value: number; help: string }[];
  myTasks: { id: string; caseId: string; name: string; step: string; due: string; overdue: boolean }[]; myTaskCount: number;
  imports: { id: string; file: string; date: string; status: string; rows: number; artists: number; newArtists: number }[];
}

function Tile({ label, value, to, tone, hint }: { label: string; value: number | undefined; to: string; tone?: string; hint?: string }) {
  return (
    <Link to={to} title={hint} className="group min-w-0 rounded-lg border border-line bg-surface px-4 py-3.5 shadow-[var(--shadow)] transition-colors hover:border-accent-line hover:bg-surface-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">{tone && <span className={`tone-${tone} tone-dot h-2 w-2 shrink-0 rounded-full`} />}<span className="truncate">{label}</span></p>
      <p className="mt-1 text-3xl font-semibold tracking-tight tnum text-ink group-hover:text-accent-text">{value === undefined ? '…' : num(value)}</p>
    </Link>
  );
}

export default function Dashboard() {
  const { data } = useQuery<Overview>('overview');
  const st = data?.status;
  return (
    <>
      <PageHeader title="Dashboard" subtitle="Where the artists stand: found, verified and on Goongoonalo. Click any number to open those artists." />
      {data && data.total === 0 && <FirstImport />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Total artists" value={data?.total} to="/artists" hint={data ? `${num(data.collaborators)} credited collaborators are counted separately` : undefined} />
        <Tile label="New artists" value={st?.NEW} to="/artists?status=NEW" tone={ARTIST_STATUS_INFO.NEW.tone} hint={ARTIST_STATUS_INFO.NEW.meaning} />
        <Tile label="Pending verification" value={st?.PENDING} to="/artists?status=PENDING" tone={ARTIST_STATUS_INFO.PENDING.tone} hint={ARTIST_STATUS_INFO.PENDING.meaning} />
        <Tile label="Searching" value={st?.SEARCHING} to="/artists?status=SEARCHING" tone={ARTIST_STATUS_INFO.SEARCHING.tone} hint={ARTIST_STATUS_INFO.SEARCHING.meaning} />
        <Tile label="Needs review" value={st?.NEEDS_REVIEW} to="/artists?status=NEEDS_REVIEW" tone={ARTIST_STATUS_INFO.NEEDS_REVIEW.tone} hint={ARTIST_STATUS_INFO.NEEDS_REVIEW.meaning} />
        <Tile label="Reopened" value={st?.REOPENED} to="/artists?status=REOPENED" tone={ARTIST_STATUS_INFO.REOPENED.tone} hint={ARTIST_STATUS_INFO.REOPENED.meaning} />
        <Tile label="Possible duplicates" value={data?.duplicates} to="/deduplicate" tone="orange" hint="Records that may be the same artist" />
        <Tile label="Verified artists" value={st?.VERIFIED} to="/artists?status=VERIFIED" tone={ARTIST_STATUS_INFO.VERIFIED.tone} hint={data ? `${num(data.verifiedAll)} verified in total, including reopened ones` : undefined} />
        <Tile label="Goongoonalo artists" value={data?.goongoonalo.GOONGOONALO} to="/verified?goongoonalo=GOONGOONALO" tone="green" hint="Goongoonalo status decided by a person" />
        <Tile label="Rejected" value={st?.REJECTED} to="/artists?status=REJECTED" tone={ARTIST_STATUS_INFO.REJECTED.tone} hint={ARTIST_STATUS_INFO.REJECTED.meaning} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Card title="This week and this month" subtitle={data ? `Week since ${fmtDate(data.weekStart)} · month since ${fmtDate(data.monthStart)} · from the dates things actually happened` : undefined} pad={false}>
          {!data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line bg-surface-2 text-xs text-muted"><th className="px-4 py-2 text-left font-medium" /><th className="px-4 py-2 text-right font-medium">This week</th><th className="px-4 py-2 text-right font-medium">This month</th></tr></thead>
              <tbody>
                {([['Artists added', 'added', '/artists?status=NEW'], ['Artists verified', 'verified', '/verified'], ['Added to Goongoonalo', 'goongoonalo', '/verified?goongoonalo=GOONGOONALO']] as const).map(([label, k, to]) => (
                  <tr key={k} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5"><Link to={to} className="text-ink hover:underline">{label}</Link></td>
                    <td className="px-4 py-2.5 text-right text-lg font-semibold tnum text-ink">{num(data.week[k])}</td>
                    <td className="px-4 py-2.5 text-right text-lg font-semibold tnum text-ink">{num(data.month[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Discovery funnel" subtitle="From the uploaded files to artists on Goongoonalo">
          {!data ? <Skeleton className="h-32" /> : (
            <ol className="space-y-2">
              {data.funnel.map((f, i) => {
                const pct = data.funnel[0].value ? Math.max(f.value ? 2 : 0, Math.round((f.value / data.funnel[0].value) * 100)) : 0;
                return (
                  <li key={f.label} title={f.help}>
                    <div className="flex justify-between text-sm"><span className="text-ink">{i > 0 && <span className="mr-1 text-faint">↓</span>}{f.label}</span><span className="font-semibold tnum text-ink">{num(f.value)}</span></div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-hover"><div className="brand-fill h-full rounded-full" style={{ width: `${pct}%` }} /></div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Your next actions" subtitle={data ? `${num(data.myTaskCount)} open task${data.myTaskCount === 1 ? '' : 's'} assigned to you` : undefined} actions={<Link to="/queue" className="text-xs text-muted hover:text-ink">All tasks →</Link>} pad={false}>
          {!data ? <div className="p-4"><Skeleton className="h-24" /></div> : !data.myTasks.length ? <Empty compact title="Nothing assigned to you." text="Open Artists and start with the ones that need review." /> : (
            <ul className="divide-y divide-line">
              {data.myTasks.map(t => {
                const due = fmtDue(t.due, data.today);
                return (
                  <li key={t.id}><Link to={`/artists/${t.caseId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover">
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{t.name}</span><span className="block truncate text-xs text-muted">{t.step}</span></span>
                    <span className={cx('whitespace-nowrap text-xs', due.overdue ? 'font-medium text-[var(--t-red)]' : 'text-muted')}>{due.text}</span>
                  </Link></li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="Recent imports" actions={<Link to="/imports" className="text-xs text-muted hover:text-ink">Imports →</Link>} pad={false}>
          {!data ? <div className="p-4"><Skeleton className="h-24" /></div> : !data.imports.length ? <Empty compact title="No imports yet." text="Upload the media-library export on the Imports page." /> : (
            <ul className="divide-y divide-line">
              {data.imports.map(b => (
                <li key={b.id}><Link to={`/imports/${b.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover">
                  <span className="mono w-14 shrink-0 text-xs text-muted">{b.id}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm text-ink">{b.file}</span><span className="block text-xs text-muted">{fmtDateTime(b.date)} · {num(b.rows)} rows · {num(b.artists)} artists{b.newArtists ? `, ${num(b.newArtists)} new` : ''}</span></span>
                  <span className="hidden text-xs text-muted sm:inline">{b.status}</span>
                </Link></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

/** A new workspace has no artists yet: one obvious next step. */
function FirstImport() {
  return (
    <section className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-accent-line bg-accent-soft px-5 py-4">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface text-accent-text"><FileUp size={22} /></span>
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-base font-semibold text-ink">Upload your media-library export to start</p>
        <p className="text-sm text-ink-2">Artists, songs, ISRCs, albums, labels and credits are extracted from the file. Then open an artist and click Find artist: it searches the web, Spotify and YouTube live.</p>
      </div>
      <Link to="/imports"><Button variant="primary" icon={<FileUp size={17} />}>Go to Imports</Button></Link>
    </section>
  );
}
