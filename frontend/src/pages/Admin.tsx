// Reports, Audit Log and Settings.
import { Database, KeyRound, LogOut, Moon, Sun, Monitor, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PEOPLE_ROLES } from '@domain/constants';
import { Timeline, type AuditRow } from '../components/case-bits';
import { Avatar, Badge, Bars, Button, Card, DataTable, Empty, Field, Modal, PageHeader, Pagination, Segmented, Skeleton, Stat } from '../components/ui';
import { useApp, useDebounced, useQuery } from '../lib/app';
import type { Queries } from '@domain/queries';
import { fmtDateTime, num } from '../lib/format';
import { SearchBudget, type DiscoveryConfigV } from '../components/discovery/bits';
import type { Person } from '../api/backend';

// ------------------------------------------------------------------ Reports
type Rep = ReturnType<Queries['reports']>;
export function ReportsPage() {
  const { data } = useQuery<Rep>('reports');
  const navigate = useNavigate();
  if (!data) return <><PageHeader title="Reports" /><Skeleton className="h-96" /></>;
  const by = (l: string) => data.stageDistribution.find(s => s.label === l)?.value ?? 0;
  const usable = by('Route Ready') + by('Introduction Pending') + by('Contact Attempted');
  return (
    <>
      <PageHeader title="Reports" subtitle={`Unique canonical artist cases only. ${num(data.total)} cases hold ${num(data.backendProfiles)} backend profiles.`} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Artists in the system" value={data.total} sub={`${num(data.backendProfiles)} backend profiles`} />
        <Stat label="Unresearched" value={by('Unresearched')} />
        <Stat label="Identity conflicts" value={data.identityConflicts} />
        <Stat label="Waiting for evidence" value={by('Waiting for Evidence')} />
        <Stat label="With a usable route" value={usable} sub="route ready → contact attempted" />
        <Stat label="Contact attempts" value={data.attempts} />
        <Stat label="Conversations" value={data.conversations} sub="confirmed with the artist" />
        <Stat label="Claims submitted" value={data.claimFunnel[1].value} />
        <Stat label="Claims approved" value={data.claimFunnel[2].value} />
        <Stat label="Claims completed" value={data.claimsCompleted} sub="backend verified" />
        <Stat label="Activated" value={data.activated} />
        <Stat label="Ongoing ARM" value={by('Ongoing ARM')} />
        <Stat label="Overdue tasks" value={data.overdue} tone={data.overdue ? 'red' : undefined} />
        <Stat label="New leads open" value={data.newLeads} />
        <Stat label="Reopened by evidence" value={data.reopenedTotal} />
        <Stat label="Oldest unresolved" value={`${data.oldestUnresolvedDays} d`} sub="in its current stage" />
        <Stat label="Route success" value={`${data.routeSuccess.confirmed}/${data.routeSuccess.used}`} sub="cases confirmed via a used route" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Cases by lifecycle stage" subtitle="Click a stage to open those cases"><Bars data={data.stageDistribution} onPick={l => navigate(`/artists?stage=${encodeURIComponent(l)}&kind=all`)} /></Card>
        <div className="space-y-4">
          <Card title="Claim funnel"><Bars data={data.claimFunnel} tone="violet" /></Card>
          <Card title="Activation funnel"><Bars data={data.activationFunnel} tone="green" /></Card>
        </div>
        <Card title="Workload by owner" pad={false}>
          <DataTable rows={data.owners} rowKey={r => r.name} dense columns={[
            { key: 'n', header: 'Owner', render: r => <span className="flex items-center gap-2"><Avatar name={r.name} size={22} />{r.name} <span className="text-xs text-muted">{r.role}</span></span> },
            { key: 'c', header: 'Active cases', render: r => num(r.cases), className: 'tnum text-right', headClass: 'text-right' },
            { key: 't', header: 'Open tasks', render: r => num(r.openTasks), className: 'tnum text-right', headClass: 'text-right' },
            { key: 'o', header: 'Overdue', render: r => <span className={r.overdue ? 'font-medium text-[var(--t-red)]' : ''}>{num(r.overdue)}</span>, className: 'tnum text-right', headClass: 'text-right' },
          ]} />
        </Card>
        <Card title="Ageing of waiting cases" subtitle="Days in Waiting for Evidence"><Bars data={data.waitingAgeing} tone="orange" /></Card>
        <Card title="Reopened cases over time" subtitle="Per week, last 6 weeks"><Bars data={data.reopenedByWeek} tone="violet" /></Card>
        <Card title="Contact attempt results"><Bars data={data.attemptResults} tone="blue" /></Card>
        <Card title="Routes by state"><Bars data={data.routeStates} tone="neutral" /></Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Audit Log
export function AuditPage() {
  const { meta } = useApp();
  const [f, setF] = useState({ userId: '', action: '', q: '', from: '', to: '', page: 1 });
  const dq = useDebounced(f.q, 250);
  const { data } = useQuery<{ rows: AuditRow[]; total: number; page: number; pageSize: number; actions: string[] }>('auditLog', { ...f, q: dq });
  const [view, setView] = useState<'table' | 'timeline'>('table');
  const set = (p: Partial<typeof f>) => setF(x => ({ ...x, ...p, page: 'page' in p ? p.page! : 1 }));
  return (
    <>
      <PageHeader title="Audit Log" subtitle="Who did what, when, why, with which evidence, the result and the next step. Append-only." actions={<Segmented options={[{ id: 'table', label: 'Table' }, { id: 'timeline', label: 'Timeline' }]} value={view} onChange={setView} />} />
      <Card pad={false}>
        <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-2 lg:grid-cols-5">
          <input className="field" placeholder="Search artist, case ID or text" value={f.q} onChange={e => set({ q: e.target.value })} />
          <select className="field" value={f.userId} onChange={e => set({ userId: e.target.value })}><option value="">Anyone</option>{meta?.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <select className="field" value={f.action} onChange={e => set({ action: e.target.value })}><option value="">Any action</option>{data?.actions.map(a => <option key={a}>{a}</option>)}</select>
          <input type="date" className="field" value={f.from} onChange={e => set({ from: e.target.value })} aria-label="From date" />
          <input type="date" className="field" value={f.to} onChange={e => set({ to: e.target.value })} aria-label="To date" />
        </div>
        {view === 'timeline' ? <div className="p-4">{data ? (data.rows.length ? <Timeline events={data.rows} showCase /> : <Empty compact title="No matching events." />) : <Skeleton className="h-60" />}</div> : (
          <DataTable rows={data?.rows} rowKey={r => r.id} dense empty={<Empty compact title="No matching events." />}
            columns={[
              { key: 'w', header: 'When', render: r => <span className="whitespace-nowrap">{fmtDateTime(r.at)}</span> },
              { key: 'u', header: 'Who', render: r => r.userName },
              { key: 'a', header: 'What', render: r => <span className="font-medium">{r.action}</span> },
              { key: 'c', header: 'Case', render: r => r.caseId ? <Link to={`/artists/${r.caseId}`} className="underline decoration-line-strong hover:decoration-ink">{r.caseName}</Link> : <span className="text-muted">{r.entity}</span> },
              { key: 'ch', header: 'Change', render: r => <span className="block max-w-[260px] text-xs">{r.from ? `${r.from} → ` : ''}{r.to ?? ''}</span> },
              { key: 'y', header: 'Why', render: r => <span className="block max-w-[240px] text-xs text-ink-2">{r.reason ?? '—'}</span> },
              { key: 'e', header: 'Evidence', render: r => <span className="block max-w-[200px] text-xs text-ink-2">{r.evidence ?? '—'}</span> },
              { key: 'r', header: 'Result', render: r => <span className="text-xs">{r.result ?? '—'}</span> },
              { key: 'n', header: 'Next', render: r => <span className="text-xs">{r.next ?? '—'}</span> },
            ]} />
        )}
        {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={p => set({ page: p })} />}
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ Settings
const THEME_KEY = 'gamplify.theme';
export function applyStoredTheme() { try { const t = localStorage.getItem(THEME_KEY); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* default */ } }
export function SettingsPage() {
  const app = useApp();
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => { try { return (localStorage.getItem(THEME_KEY) as 'light' | 'dark') || 'system'; } catch { return 'system'; } });
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    try { if (theme === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, theme); } catch { /* per-browser */ }
  }, [theme]);
  const navigate = useNavigate();
  const owner = app.can('resetWorkspace');
  const reset = async () => {
    setBusy(true);
    try { await app.backend.reset(); app.toast('All data deleted. Upload an export on the Imports page.'); app.refresh(); navigate('/imports'); }
    catch (e) { app.toast((e as Error).message, 'error'); }
    finally { setBusy(false); setConfirm(false); setTyped(''); }
  };
  return (
    <>
      <PageHeader title="Settings" subtitle="People, your account, discovery, storage and the tools that are not needed every day." />
      <Card className="mb-4" title="More tools" subtitle="Everything here is also reachable from inside each artist; these pages show it across all artists.">
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {([['/queue', 'Task queue', 'Every open task, by due date'], ['/routes', 'Contacts & routes', 'Contact directory, routes, attempts'], ['/research', 'Manual research', 'Checklists and research notes'], ['/reports', 'Reports', 'Management reports'], ['/audit', 'Audit log', 'Who changed what, when and why']] as const).map(([to, title, text]) => (
            <li key={to}><Link to={to} className="block h-full rounded-lg border border-line px-3.5 py-3 hover:border-accent-line hover:bg-hover"><span className="block text-sm font-medium text-ink">{title}</span><span className="block text-xs text-muted">{text}</span></Link></li>
          ))}
        </ul>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <PeopleCard />
          <AccountCard />
        </div>
        <div className="space-y-4">
          <DiscoverySettings />
          <Card title="Storage">
            <p className="flex items-center gap-2 text-sm text-ink"><Database size={15} />PostgreSQL through the API server (system of record).</p>
            <p className="mt-1 text-xs text-muted">Artists, songs and credits come only from the export files uploaded on the Imports page; every row is kept with its original values.</p>
          </Card>
          <Card title="Appearance">
            <Segmented options={[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} value={theme} onChange={setTheme} />
            <span className="ml-2 inline-flex gap-1 align-middle text-faint">{theme === 'light' ? <Sun size={14} /> : theme === 'dark' ? <Moon size={14} /> : <Monitor size={14} />}</span>
          </Card>
          {owner && (
            <Card title="Workspace" subtitle="Deleting cannot be undone: every artist, import, search result and history entry is removed. People and their accounts stay.">
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirm(true)}>Delete all data…</Button>
            </Card>
          )}
        </div>
      </div>
      <Modal open={confirm} onClose={() => { setConfirm(false); setTyped(''); }} title="Delete all data?"
        footer={<><Button variant="ghost" onClick={() => { setConfirm(false); setTyped(''); }}>Cancel</Button><Button variant="danger" loading={busy} disabled={typed.trim().toUpperCase() !== 'DELETE'} onClick={reset}>Delete everything</Button></>}>
        <p className="text-sm text-ink-2">Every artist, song, import, search result, verified profile, contact, task and history entry is removed from PostgreSQL. This cannot be undone. Take a database backup first if you may need any of it.</p>
        <Field label="Type DELETE to confirm" className="mt-3"><input className="field" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" /></Field>
      </Modal>
    </>
  );
}
const ROLE_TEXT: Record<string, string> = {
  'System Owner': 'everything: adds people, sets anyone’s password, changes any role and can delete all data. Only you see this role: everyone else sees you as Admin.',
  Admin: 'adds people, sees the team and makes Users Admins; uploads imports, decides claims, closes artists, runs bulk search and discovery settings, plus everything a User does.',
  User: 'finds artists and verifies their profiles, deduplicates, researches and contacts artists, and sees the team’s work.',
};

/** The team. The System Owner and Admins add people; the owner sets roles and passwords, Admins make Users Admins.
 *  The System Owner shows as Admin to everyone else (the server sends it that way). */
function PeopleCard() {
  const app = useApp();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pwFor, setPwFor] = useState<Person | null>(null);
  useEffect(() => {
    let alive = true;
    app.backend.people().then(p => { if (alive) { setPeople(p); setError(null); } }).catch(e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [app.backend, app.rev]);
  const manage = app.can('manageUsers');
  const iAmOwner = app.role === 'System Owner';
  const roleOptions = PEOPLE_ROLES.map(r => <option key={r} value={r}>{r}</option>);
  return (
    <Card title="People and roles" subtitle={manage ? (iAmOwner ? 'Add people, change roles and set passwords.' : 'Add people and make Users Admins.') : 'Everyone on the team. An Admin adds people and sets roles.'}
      actions={manage ? <Button size="sm" variant="primary" icon={<UserPlus size={15} />} onClick={() => setAdding(true)}>Add person</Button> : undefined}>
      {error && <p className="text-sm text-[var(--t-red)]">{error}</p>}
      {!people && !error && <Skeleton className="h-24" />}
      <ul className="divide-y divide-line">
        {people?.map(u => {
          const me = u.id === app.userId;
          const canRole = !me && manage && (iAmOwner || u.role === 'User');
          const canPw = !me && iAmOwner && !!u.email;
          return (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5">
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <Avatar name={u.name} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{u.name}</span>
                  <span className="block truncate text-xs text-muted">{u.email ?? 'no sign-in'}</span>
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {me ? <Badge tone="green">You · {u.role}</Badge> : canRole ? (
                  <span className="w-[130px]">
                    <select className="field" aria-label={`Role of ${u.name}`} value={u.role} onChange={e => { void app.run('setUserRole', { userId: u.id, role: e.target.value }); }}>{roleOptions}</select>
                  </span>
                ) : <Badge>{u.role}</Badge>}
                {canPw && <Button size="sm" icon={<KeyRound size={14} />} onClick={() => setPwFor(u)}>Set password</Button>}
              </span>
            </li>
          );
        })}
      </ul>
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer text-sm font-medium text-ink-2">What each role can do</summary>
        <ul className="mt-2 space-y-1">
          {(iAmOwner ? ['System Owner', ...PEOPLE_ROLES] : PEOPLE_ROLES).map(r => <li key={r}><b className="text-ink-2">{r}:</b> {ROLE_TEXT[r]}</li>)}
        </ul>
        <p className="mt-2">People who sign up themselves start as User.</p>
      </details>
      {adding && <AddPersonModal onClose={() => setAdding(false)} />}
      {pwFor && <SetPasswordModal person={pwFor} onClose={() => setPwFor(null)} />}
    </Card>
  );
}

function AddPersonModal({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'User' as 'Admin' | 'User' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!f.name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()) && f.password.length >= 8;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const p = await app.backend.addPerson(f);
      app.toast(`${p.name} added as ${p.role}. Share the email and password with them; they can change the password under Your account.`);
      app.refresh(); onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Add person" description="They sign in with this email and password."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>Add person</Button></>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); if (ready) void save(); }}>
        <Field label="Name" required><input className="field" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus maxLength={80} /></Field>
        <Field label="Email" required><input className="field" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} autoComplete="off" /></Field>
        <Field label="First password" required help="At least 8 characters. Share it with them."><input className="field" type="text" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} autoComplete="off" /></Field>
        <Field label="Role" required><select className="field" value={f.role} onChange={e => setF({ ...f, role: e.target.value as 'Admin' | 'User' })}>{PEOPLE_ROLES.map(r => <option key={r} value={r}>{r}</option>)}</select></Field>
        <p className="text-xs text-muted sm:col-span-2"><b className="text-ink-2">{f.role}:</b> {ROLE_TEXT[f.role]}</p>
        {error && <p role="alert" className="text-sm text-[var(--t-red)] sm:col-span-2">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function SetPasswordModal({ person, onClose }: { person: Person; onClose: () => void }) {
  const app = useApp();
  const [pw, setPw] = useState({ next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const mismatch = !!pw.again && pw.next !== pw.again;
  const save = async () => {
    setBusy(true);
    try { app.toast(await app.backend.setPassword(person.id, pw.next)); onClose(); }
    catch (e) { app.toast((e as Error).message, 'error'); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Set password for ${person.name}`} description={`${person.email} is signed out everywhere and signs in with this password.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={pw.next.length < 8 || pw.next !== pw.again} onClick={() => void save()}>Set password</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="New password" help="At least 8 characters."><input className="field" type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} autoFocus /></Field>
        <Field label="New password again" help={mismatch ? <span className="text-[var(--t-red)]">The passwords do not match.</span> : undefined}><input className="field" type="password" autoComplete="new-password" value={pw.again} onChange={e => setPw({ ...pw, again: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/** The signed-in person's account: email and password. */
function AccountCard() {
  const app = useApp();
  const [form, setForm] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const mismatch = !!form.again && form.next !== form.again;
  const save = async () => {
    setBusy(true);
    try { app.toast(await app.backend.changePassword(form.current, form.next)); setForm({ current: '', next: '', again: '' }); }
    catch (e) { app.toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Card id="account" title="Your account" subtitle={app.me ? `Signed in as ${app.me.email}` : undefined}
      actions={<Button size="sm" icon={<LogOut size={15} />} onClick={app.signOut}>Sign out</Button>}>
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={e => { e.preventDefault(); if (!mismatch) void save(); }}>
        <Field label="Current password"><input className="field" type="password" autoComplete="current-password" value={form.current} onChange={e => setForm(f => ({ ...f, current: e.target.value }))} /></Field>
        <Field label="New password" help="At least 8 characters."><input className="field" type="password" autoComplete="new-password" value={form.next} onChange={e => setForm(f => ({ ...f, next: e.target.value }))} /></Field>
        <Field label="New password again" help={mismatch ? <span className="text-[var(--t-red)]">The passwords do not match.</span> : undefined}><input className="field" type="password" autoComplete="new-password" value={form.again} onChange={e => setForm(f => ({ ...f, again: e.target.value }))} /></Field>
        <div className="sm:col-span-3"><Button type="submit" variant="primary" loading={busy} disabled={!form.current || form.next.length < 8 || form.next !== form.again}>Change password</Button></div>
      </form>
    </Card>
  );
}

/** Live providers (configured on the server), usage limits and the stale threshold. */
function DiscoverySettings() {
  const app = useApp();
  const { data } = useQuery<DiscoveryConfigV>('discoveryConfig');
  const [days, setDays] = useState('');
  const allowed = app.can('discoverySettings');
  if (!data) return <Card title="Artist discovery"><Skeleton className="h-16" /></Card>;
  return (
    <Card title="Artist discovery" subtitle={data.mode === 'live' ? 'Live search is configured on the server' : 'Live search is not configured: Find artist is off'}>
      <ul className="space-y-1 text-sm">
        {data.providers.map(p => <li key={p.id} className="flex items-center justify-between gap-2"><span>{p.label}</span><Badge tone={p.kind === 'internal' ? 'neutral' : 'green'}>{p.kind === 'internal' ? 'internal data' : 'live'}</Badge></li>)}
      </ul>
      {data.mode === 'live' && data.notes.map(n => <p key={n} className="mt-2 text-xs text-muted">{n}</p>)}
      {data.blocked && <p className="mt-2 text-xs font-medium text-[var(--t-red)]">{data.blocked}</p>}
      {data.usage?.length > 0 && <div className="mt-3 border-t border-line pt-3"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Usage limits</p><SearchBudget cfg={data} /><p className="mt-2 text-xs text-muted">Set in the server’s .env (SEARCH_MONTHLY_LIMIT, YOUTUBE_MONTHLY_LIMIT, YOUTUBE_DAILY_LIMIT, …; 0 = no limit). Counted in the database, so restarts do not reset them; cached answers are free.</p></div>}
      <p className="mt-2 text-xs text-muted">Real providers are set in the server’s .env (SEARCH_PROVIDER_API_KEY, SPOTIFY_CLIENT_ID/SECRET, YOUTUBE_API_KEY). Secrets never reach the browser.</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-sm text-ink-2">Profile is stale after
          <input type="number" min={1} max={3650} className="field mt-1 !w-28" placeholder={String(data.staleDays)} value={days} onChange={e => setDays(e.target.value)} disabled={!allowed} /> days
        </label>
        <Button size="sm" disabled={!allowed || !days} onClick={async () => { await app.run('setDiscoverySettings', { staleDays: Number(days) }); setDays(''); }}>Save</Button>
      </div>
      {!allowed && <p className="mt-2 text-xs text-muted">Only an Admin can change these settings.</p>}
    </Card>
  );
}
