// Messages: message verified artists on their own Instagram, X or Facebook profile. The app writes each message and
// opens the chat; a person pastes it and presses Send there. Nothing is sent automatically, so the account is never
// flagged as a bot. First question: is the artist on Goongoonalo? Then the join invitation or the member message,
// follow-ups 3, 7 and 14 days later, and festival greetings for members who said yes.
import { Check, ExternalLink, MessageCircle, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useActions } from '../components/actions';
import { PlatformBadge } from '../components/discovery/bits';
import { Badge, Button, Card, Empty, ErrorBox, Field, FilterSelect, Modal, Notice, PageHeader, Pagination, Pill, PillBar, Select, SkeletonRows, Tabs, cx } from '../components/ui';
import { useApp, useQuery } from '../lib/app';
import { fmtAgo, fmtDate, num } from '../lib/format';

type Kind = 'answer' | 'invite' | 'member' | 'followup' | 'greeting';
type Platform = 'Instagram' | 'X' | 'Facebook';
interface Target { platform: Platform; url: string; handle: string; dmUrl: string; how: string; chosen?: boolean }
type TemplateKind = Exclude<Kind, 'answer'>;
interface Template { id: string; name: string; kind: TemplateKind; language: string; text: string; senderName: string; builtIn: boolean; updatedAt: string | null }
interface Festival { id: string; name: string; date: string | null; region: string }
interface Placeholder { key: string; meaning: string; example: string; kinds?: TemplateKind[] }
interface SentRow { id: string; caseId: string; name: string; rank: number | null; kind: TemplateKind; followUpNo: number; platform: Platform; handle: string; profileUrl: string; text: string; sentAt: string; sentByName: string; answer: string | null; state: string }
interface SentPage { rows: SentRow[]; total: number; page: number; pageSize: number }
interface NeedYes { caseId: string; name: string; rank: number | null; targets: Target[]; lastAnswer: string | null; lastMessageAt: string | null }
interface Usage { counts: Record<Platform, number>; limits: Record<Platform, number>; gapSeconds: number; nextAt: string | null }
interface Overview {
  counts: Record<Kind, number>; sent: Record<TemplateKind, number>; greetingsNeedYes: number; waiting: number; optedOut: number; top: boolean; topSize: number; festival: Festival | null; festivals: Festival[]; templates: Template[];
  placeholders: Placeholder[]; samples: Record<TemplateKind, string>; defaultSender: string; kinds: Record<string, { label: string; meaning: string }>; usage: Usage; settings: { daily: Record<Platform, number>; gapSeconds: number }; followUpDays: number[];
}
interface QueueRow { caseId: string; name: string; rank: number | null; songs: number; language: string | null; targets: Target[]; templateId: string | null; text: string; followUpNo: number; due: string | null; lastPlatform: Platform | null; startedAt: string | null }
interface Queue { kind: Kind; rows: QueueRow[]; total: number; page: number; pageSize: number; festival: Festival | null; usage: Usage; needYes?: NeedYes[] }
interface WaitingRow { caseId: string; name: string; kind: Kind; startedAt: string; followUps: number; exhausted: boolean; nextDue: string | null; platform: Platform; handle: string; chatUrl: string; lastText: string; goongoonaloStatus: string }

const PLATFORMS: Platform[] = ['Instagram', 'X', 'Facebook'];
const STEPS: { id: Kind; title: string; text: string }[] = [
  { id: 'answer', title: 'Is the artist on Goongoonalo?', text: 'Answer this first: it decides which message the artist gets.' },
  { id: 'invite', title: 'Join invitation', text: 'Not on Goongoonalo yet: introduce Goongoonalo and invite them to claim their profile.' },
  { id: 'member', title: 'Member message', text: 'Already on Goongoonalo: help them start using their profile.' },
  { id: 'followup', title: 'Follow-ups due', text: 'No reply yet: 3, 7 and 14 days after the first message.' },
  { id: 'greeting', title: 'Festival greeting', text: 'Only members who said yes to greetings.' },
];
const KIND_LABEL: Record<string, string> = { invite: 'Join invitation', member: 'Member message', followup: 'Follow-up', greeting: 'Festival greeting' };

/** Copy text to the clipboard; works without the Clipboard API too (plain http on another host). */
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall back below */ }
  const el = document.createElement('textarea');
  el.value = text; el.style.position = 'fixed'; el.style.opacity = '0';
  document.body.appendChild(el); el.select();
  try { document.execCommand('copy'); } finally { el.remove(); }
}
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
const Key = ({ k }: { k: string }) => <kbd className="mono rounded border border-line-strong bg-surface-2 px-1.5 py-0.5 text-xs font-semibold text-ink">{k}</kbd>;
/**
 * In the chat the message is already on the clipboard: two keys send it. (A web page cannot type into Instagram,
 * X or Messenger: browsers keep other sites' pages out of reach, and these chats have no "pre-filled text" link.)
 */
export function PasteSteps() {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-ink">
      <span>In the chat: click the message box</span><span aria-hidden>→</span><Key k={MOD} />+<Key k="V" /><span>pastes it</span><span aria-hidden>→</span><Key k="Enter" /><span>sends it.</span>
    </span>
  );
}
/** Seconds until the next message may go out (0 = now). */
function useWait(nextAt: string | null) {
  const left = () => (nextAt ? Math.max(0, Math.ceil((Date.parse(nextAt) - Date.now()) / 1000)) : 0);
  const [s, setS] = useState(left);
  useEffect(() => {
    setS(left());
    if (!nextAt) return;
    const t = setInterval(() => setS(left()), 1000);
    return () => clearInterval(t);
  }, [nextAt]); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

export default function Messages() {
  const [sp, setSp] = useSearchParams();
  const app = useApp();
  const tab = sp.get('tab') ?? 'send';
  const top = sp.get('top') !== 'all';
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v); else n.delete(k); if (!('page' in patch)) n.delete('page'); setSp(n, { replace: true }); };
  const ov = useQuery<Overview>('messagesOverview', { top, festivalId: sp.get('festival') ?? undefined });
  const asked = sp.get('kind') as Kind | null;
  const kind: Kind = asked ?? (ov.data ? STEPS.find(s => ov.data!.counts[s.id] > 0)?.id ?? 'invite' : 'answer');
  return (
    <>
      <PageHeader title="Messages"
        subtitle="Message verified artists on their own Instagram, X or Facebook. The app writes the message and opens the chat; you paste it and press Send there. Nothing goes out automatically, so your account stays safe." />
      {ov.error && <ErrorBox text={ov.error} />}
      {ov.data && <UsageBar usage={ov.data.usage} />}
      <Tabs value={tab} onChange={t => set({ tab: t === 'send' ? null : t, kind: null, template: null })}
        tabs={[{ id: 'send', label: 'Send' }, { id: 'waiting', label: 'Waiting for reply', count: ov.data?.waiting ?? null }, { id: 'templates', label: 'Templates', count: ov.data?.templates.length ?? null }, { id: 'festivals', label: 'Festivals' }, ...(app.can('messageSettings') ? [{ id: 'limits', label: 'Limits' }] : [])]} />
      <div className="mt-4">
        {!ov.data ? <SkeletonRows /> : <>
          {tab === 'send' && <SendTab ov={ov.data} kind={kind} top={top} sp={sp} set={set} />}
          {tab === 'waiting' && <WaitingTab />}
          {tab === 'templates' && <TemplatesTab ov={ov.data} onUse={t => set({ tab: null, kind: t.kind, template: t.id })} />}
          {tab === 'festivals' && <FestivalsTab ov={ov.data} onSend={f => set({ tab: null, kind: 'greeting', festival: f.id })} />}
          {tab === 'limits' && <LimitsTab ov={ov.data} />}
        </>}
      </div>
    </>
  );
}

function UsageBar({ usage }: { usage: Usage }) {
  const wait = useWait(usage.nextAt);
  return (
    <p className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
      <span className="font-medium text-ink-2">Today</span>
      {PLATFORMS.map(p => <span key={p} className={cx('tnum', usage.counts[p] >= usage.limits[p] && 'text-[var(--t-red)]')}>{p} {usage.counts[p]} of {usage.limits[p]}</span>)}
      <span>{usage.gapSeconds} s between messages</span>
      {wait > 0 && <Badge tone="orange" dot>Next message in {wait} s</Badge>}
    </p>
  );
}

// ------------------------------------------------------------------ send
function SendTab({ ov, kind, top, sp, set }: { ov: Overview; kind: Kind; top: boolean; sp: URLSearchParams; set: (p: Record<string, string | null>) => void }) {
  const templates = ov.templates.filter(t => t.kind === kind);
  const asked = sp.get('template');
  const templateId = kind === 'answer' ? undefined : asked && (asked === 'auto' || templates.some(t => t.id === asked)) ? asked : kind === 'greeting' ? 'auto' : templates[0]?.id;
  const dated = ov.festivals.filter(f => f.date);
  const festivalId = kind === 'greeting' ? sp.get('festival') ?? ov.festival?.id : undefined;
  const page = Number(sp.get('page') ?? 1);
  const queue = useQuery<Queue>('messageQueue', { kind, top, templateId, festivalId, page });
  const step = STEPS.find(s => s.id === kind)!;
  // Two lists per step: Pending (not sent yet: send from here) and Sent (already went out, with the answer so far)
  const view = kind !== 'answer' && sp.get('view') === 'sent' ? 'sent' : 'pending';
  const sentPage = Number(sp.get('spage') ?? 1);
  const sent = useQuery<SentPage>(kind === 'answer' ? null : 'messageSent', { kind, top, festivalId, page: sentPage });
  const needYes = queue.data?.needYes ?? [];
  return (
    <div className="space-y-4">
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <button type="button" onClick={() => set({ kind: s.id, template: null })} aria-pressed={kind === s.id}
              className={cx('h-full w-full rounded-xl border p-3 text-left hover:bg-hover', kind === s.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface')}>
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-ink">{i === 0 ? '1. ' : ''}{s.title}</span>
                <span className={cx('tnum text-xl font-semibold', ov.counts[s.id] ? 'text-ink' : 'text-faint')}>{num(ov.counts[s.id])}</span>
              </span>
              <span className="mt-1 block text-xs text-muted">{s.text}</span>
              {s.id !== 'answer' && <span className="mt-1.5 block text-xs font-medium text-ink-2">{num(ov.sent[s.id as TemplateKind] ?? 0)} sent{s.id === 'greeting' && ov.greetingsNeedYes ? ` · ${num(ov.greetingsNeedYes)} waiting for a yes` : ''}</span>}
            </button>
          </li>
        ))}
      </ol>

      <Card pad={false}>
        <div className="space-y-3 border-b border-line p-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <FilterSelect label="Artists" value={top ? 'top' : 'all'} onChange={v => set({ top: v === 'all' ? 'all' : null })}
              options={[{ id: 'top', label: `Top ${ov.topSize} only` }, { id: 'all', label: 'Every verified artist' }]} />
            {kind !== 'answer' && (
              <FilterSelect label="Message" value={templateId ?? ''} onChange={v => set({ template: v })}
                options={[...(kind === 'greeting' ? [{ id: 'auto', label: 'By the artist’s language' }] : []), ...templates.map(t => ({ id: t.id, label: `${t.name} · ${t.language}` }))]} />
            )}
            {kind === 'greeting' && (
              <FilterSelect label="Festival" value={festivalId ?? ''} onChange={v => set({ festival: v })}
                options={ov.festivals.map(f => ({ id: f.id, label: f.date ? `${f.name} · ${fmtDate(f.date)}` : `${f.name} · date to set`, disabled: !f.date }))} />
            )}
            {kind !== 'answer' && <Link to="/messages?tab=templates" className="text-sm text-accent-text underline decoration-line-strong">Edit or add messages</Link>}
          </div>
          <p className="text-sm text-ink-2">{step.text}{kind === 'followup' && ` Any answer stops them; at most ${ov.followUpDays.length}.`}{kind === 'greeting' && ' Greetings can go out any day before or on the festival, not only on the day.'}{kind === 'greeting' && !dated.length && ' Add festival dates first (Festivals tab).'}</p>
          {kind !== 'answer' && (
            <PillBar label="Pending or sent">
              <Pill active={view === 'pending'} onClick={() => set({ view: null, spage: null })} count={queue.data ? num(queue.data.total) : undefined} title="Artists this message has not gone to yet">Pending: not sent yet</Pill>
              <Pill active={view === 'sent'} onClick={() => set({ view: 'sent', spage: null })} count={sent.data ? num(sent.data.total) : undefined} title="Messages that went out, newest first">Sent</Pill>
            </PillBar>
          )}
        </div>
        {view === 'sent' ? <SentTab data={sent.data} error={sent.error} onPage={p => set({ view: 'sent', spage: String(p) })} /> : <>
          {queue.error && <div className="p-3"><ErrorBox text={queue.error} /></div>}
          {!queue.data ? <div className="p-3"><SkeletonRows /></div> : !queue.data.rows.length ? (
            kind === 'greeting' && needYes.length ? (
              <Empty title="Nobody has said yes to greetings yet." text="Greetings go only to members who said yes. Record the answer below: they appear here at once." />
            ) : (
              <Empty title={kind === 'answer' ? 'Every verified artist is answered.' : 'Nobody is waiting for this message.'}
                text={kind !== 'answer' && sent.data?.total ? `${num(sent.data.total)} already sent: see Sent.` : top ? `Only the top ${ov.topSize} artists are shown. Pick “Every verified artist” for the rest, or verify more artists’ Instagram, X or Facebook profiles.` : 'Messages go only to artists with a verified Instagram, X or Facebook profile.'} />
            )
          ) : (
            <ul className="divide-y divide-line">
              {queue.data.rows.map(r => <QueueItem key={`${r.caseId}|${r.templateId}|${festivalId}`} row={r} kind={kind} festivalId={festivalId} usage={queue.data!.usage} />)}
            </ul>
          )}
          {queue.data && queue.data.total > queue.data.pageSize && <Pagination page={queue.data.page} pageSize={queue.data.pageSize} total={queue.data.total} onPage={p => set({ page: String(p) })} />}
          {kind === 'greeting' && needYes.length > 0 && <NeedYesList rows={needYes} />}
        </>}
      </Card>
    </div>
  );
}

/** One artist's message (Claims & routes tab): the invitation or the member message, on the chosen route's profile. */
export function ArtistMessage({ caseId, kind, url, fallback }: { caseId: string; kind: 'invite' | 'member'; url?: string | null; fallback: ReactNode }) {
  const q = useQuery<Queue>('messageQueue', { kind, caseId, top: false });
  if (q.error) return <ErrorBox text={q.error} />;
  if (!q.data) return <SkeletonRows rows={2} />;
  const row = q.data.rows[0];
  const only = row && url ? { ...row, targets: row.targets.filter(t => t.url === url) } : row;
  return only && only.targets.length ? <ul className="-mx-4 rounded-xl"><QueueItem row={only} kind={kind} usage={q.data.usage} /></ul> : <>{fallback}</>;
}

/** Messages of this step that went out, newest first, with the answer so far; one sent in the last 10 minutes is highlighted. */
function SentTab({ data, error, onPage }: { data?: SentPage | null; error?: string | null; onPage: (p: number) => void }) {
  const [now] = useState(() => Date.now());
  if (error) return <div className="p-3"><ErrorBox text={error} /></div>;
  if (!data) return <div className="p-3"><SkeletonRows /></div>;
  if (!data.rows.length) return <Empty title="Nothing sent yet." text="Send from Pending: after “Yes, I sent it” the message shows here." />;
  return (
    <>
      <ul className="divide-y divide-line">
        {data.rows.map(x => {
          const fresh = Date.parse(x.sentAt) > now - 10 * 60_000;
          return (
            <li key={x.id} className={cx('px-4 py-3', fresh && 'bg-accent-soft/50')}>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                {fresh && <Badge tone="violet" dot>Just sent</Badge>}
                {x.rank != null && <span className="tnum text-xs text-muted">#{num(x.rank)}</span>}
                <Link to={`/artists/${x.caseId}`} className="text-base font-semibold text-ink hover:underline">{x.name}</Link>
                <PlatformBadge platform={x.platform} size="xs" /><span className="text-xs text-muted">@{x.handle}</span>
                <span className="text-xs text-muted">{KIND_LABEL[x.kind]}{x.followUpNo ? ` #${x.followUpNo}` : ''} · sent {fmtAgo(x.sentAt)} by {x.sentByName}</span>
                <Badge tone={x.answer ? 'green' : x.kind === 'greeting' ? 'neutral' : 'orange'} dot>{x.state}</Badge>
              </p>
              <p className="mt-0.5 line-clamp-2 text-sm text-ink-2" title={x.text}>{x.text}</p>
            </li>
          );
        })}
      </ul>
      {data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={onPage} />}
    </>
  );
}

/** Members who have not said yes to greetings: record their answer here, and the ones who said yes move up to Pending. */
function NeedYesList({ rows }: { rows: NeedYes[] }) {
  const { run } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const answer = async (r: NeedYes, consent: 'Yes' | 'No') => {
    setBusy(`${r.caseId}|${consent}`);
    await run('setGreetings', { caseId: r.caseId, consent, reason: consent === 'Yes' ? 'Said yes to festival greetings' : 'Said no to festival greetings' });
    setBusy(null);
  };
  return (
    <div className="border-t border-line">
      <div className="px-4 pb-2 pt-4">
        <h3 className="text-base font-semibold text-ink">Waiting for a yes to greetings · {num(rows.length)}</h3>
        <p className="text-sm text-muted">Members on Goongoonalo who have not said yes yet (the member message asks “Reply YES for festival wishes”). If they said yes, record it: they move up to Pending.</p>
      </div>
      <ul className="divide-y divide-line">
        {rows.map(r => (
          <li key={r.caseId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              {r.rank != null && <span className="tnum text-xs text-muted">#{num(r.rank)}</span>}
              <Link to={`/artists/${r.caseId}`} className="text-base font-semibold text-ink hover:underline">{r.name}</Link>
              {r.targets.map(t => <PlatformBadge key={t.url} platform={t.platform} size="xs" />)}
              <span className="text-xs text-muted">{r.lastAnswer ? `Last answer: ${r.lastAnswer}` : r.lastMessageAt ? `Messaged ${fmtAgo(r.lastMessageAt)}, no answer yet` : 'Not messaged yet'}</span>
            </span>
            <span className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" icon={<Check size={14} />} loading={busy === `${r.caseId}|Yes`} disabled={!!busy} onClick={() => answer(r, 'Yes')}>They said yes</Button>
              <Button size="sm" variant="ghost" loading={busy === `${r.caseId}|No`} disabled={!!busy} onClick={() => answer(r, 'No')}>They said no</Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QueueItem({ row, kind, festivalId, usage }: { row: QueueRow; kind: Kind; festivalId?: string; usage: Usage }) {
  const { run } = useApp();
  const [text, setText] = useState(row.text);
  const [opened, setOpened] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const wait = useWait(usage.nextAt);
  const head = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {row.rank != null && <span className="tnum text-xs text-muted" title="Rank by songs released">#{num(row.rank)}</span>}
      <Link to={`/artists/${row.caseId}`} className="text-base font-semibold text-ink hover:underline">{row.name}</Link>
      <span className="text-xs text-muted">{num(row.songs)} songs</span>
      {row.targets.map(t => <a key={t.url} href={t.url} target="_blank" rel="noreferrer" title={`Verified ${t.platform}: @${t.handle}`}><PlatformBadge platform={t.platform} size="sm" /></a>)}
      {kind === 'followup' && <Badge tone="orange">Follow-up #{row.followUpNo} · due {fmtDate(row.due)}</Badge>}
    </div>
  );
  if (kind === 'answer') {
    const answer = async (status: 'GOONGOONALO' | 'NOT_MEMBER') => { setBusy(true); await run('setGoongoonaloStatus', { caseId: row.caseId, status, reason: 'Answered in Messages' }); setBusy(false); };
    return (
      <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        {head}
        <span className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => answer('GOONGOONALO')}>Yes, on Goongoonalo</Button>
          <Button size="sm" disabled={busy} onClick={() => answer('NOT_MEMBER')}>No, not yet</Button>
        </span>
      </li>
    );
  }
  const send = async () => {
    if (!opened) return;
    setBusy(true);
    const res = await run('sendMessage', { caseId: row.caseId, kind, platform: opened.platform, text, templateId: row.templateId, festivalId });
    setBusy(false);
    if (res) setOpened(null);
  };
  const open = async (t: Target) => {
    await copyText(text);
    window.open(t.dmUrl, '_blank', 'noopener');
    setOpened(t);
  };
  return (
    <li className="space-y-2 px-4 py-3">
      {head}
      <textarea className="field !min-h-[9rem] text-base" value={text} onChange={e => setText(e.target.value)} aria-label={`Message to ${row.name}`} />
      {!opened ? (
        <div className="flex flex-wrap items-center gap-2">
          {row.targets.map(t => {
            const full = usage.counts[t.platform] >= usage.limits[t.platform];
            return (
              <Button key={t.url} size="sm" variant="primary" icon={<PlatformBadge platform={t.platform} size="xs" />} disabled={!text.trim() || wait > 0 || full}
                title={full ? `Today’s ${t.platform} limit is reached` : wait > 0 ? `Wait ${wait} s` : `Copies the message and opens the ${t.platform} chat with @${t.handle}`}
                onClick={() => open(t)}>Copy &amp; open {t.platform} @{t.handle}{t.chosen && row.targets.length > 1 ? ' · chosen route' : ''}</Button>
            );
          })}
          {wait > 0 && <span className="text-xs text-muted">Next message in {wait} s</span>}
        </div>
      ) : (
        <Notice tone="blue" icon={<MessageCircle size={18} />} title={`Message copied. ${opened.how}`}
          action={<span className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<Check size={14} />} disabled={busy} onClick={send}>Yes, I sent it</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpened(null)}>Not sent</Button>
            <a href={opened.dmUrl} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost" icon={<ExternalLink size={14} />}>Open again</Button></a>
          </span>}>
          <PasteSteps />
          <span className="mt-1 block">Then come back and click “Yes, I sent it”: it is recorded as a contact attempt and the follow-up is planned.</span>
        </Notice>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ waiting for a reply
function WaitingTab() {
  const [page, setPage] = useState(1);
  const { data, error } = useQuery<{ rows: WaitingRow[]; total: number; page: number; pageSize: number }>('messageWaiting', { page });
  const { open } = useActions();
  if (error) return <ErrorBox text={error} />;
  if (!data) return <SkeletonRows />;
  return (
    <Card pad={false} title="Waiting for an answer" subtitle="Open the chat to read the reply, then record what the artist said. Any answer stops the follow-ups.">
      {!data.rows.length ? <Empty title="Nobody is waiting for an answer." text="Messages you send appear here until the artist answers." /> : (
        <ul className="divide-y divide-line">
          {data.rows.map(r => (
            <li key={r.caseId} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2"><Link to={`/artists/${r.caseId}`} className="text-base font-semibold text-ink hover:underline">{r.name}</Link><PlatformBadge platform={r.platform} size="sm" /><span className="text-xs text-muted">@{r.handle}</span></p>
                <p className="text-sm text-ink-2">{KIND_LABEL[r.kind]} sent {fmtDate(r.startedAt)}{r.followUps ? ` · ${r.followUps} follow-up${r.followUps === 1 ? '' : 's'}` : ''} · {r.exhausted ? <span className="text-[var(--t-orange)]">all follow-ups sent, no answer</span> : <>next follow-up {fmtDate(r.nextDue)}</>}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted" title={r.lastText}>{r.lastText}</p>
              </div>
              <span className="flex flex-wrap gap-1.5">
                <a href={r.chatUrl} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost" icon={<ExternalLink size={14} />}>Open chat</Button></a>
                <Button size="sm" variant="primary" onClick={() => open('recordReply', { caseId: r.caseId, preset: { values: { outcome: 'Interested' } } })}>Interested</Button>
                <Button size="sm" onClick={() => open('recordReply', { caseId: r.caseId, preset: { values: { outcome: 'Not interested' } } })}>Not interested</Button>
                <Button size="sm" onClick={() => open('recordReply', { caseId: r.caseId, preset: { values: { outcome: 'Do not disturb' } } })}>Do not disturb</Button>
                <Button size="sm" variant="ghost" onClick={() => open('recordReply', { caseId: r.caseId, preset: { values: { outcome: 'Replied' } } })}>Other answer…</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </Card>
  );
}

// ------------------------------------------------------------------ templates
function TemplatesTab({ ov, onUse }: { ov: Overview; onUse: (t: Template) => void }) {
  const { open } = useActions();
  const [editing, setEditing] = useState<Template | TemplateKind | null>(null);
  return (
    <div className="space-y-4">
      {editing && <TemplateEditor ov={ov} template={typeof editing === 'string' ? null : editing} kind={typeof editing === 'string' ? editing : editing.kind} onClose={() => setEditing(null)} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">Words in braces are filled in by the system for each artist: {ov.placeholders.map(p => <code key={p.key} className="mono mx-0.5 rounded bg-hover px-1 text-xs" title={p.meaning}>{`{${p.key}}`}</code>)}. Open a message to see the rules and a preview.</p>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('invite')}>New message</Button>
      </div>
      {(['invite', 'member', 'followup', 'greeting'] as const).map(k => (
        <Card key={k} title={ov.kinds[k].label} subtitle={ov.kinds[k].meaning} pad={false} actions={<Button size="sm" icon={<Plus size={14} />} onClick={() => setEditing(k)}>New {ov.kinds[k].label.toLowerCase()}</Button>}>
          <ul className="divide-y divide-line">
            {ov.templates.filter(t => t.kind === k).map(t => (
              <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{t.name}</span><Badge>{t.language}</Badge>{t.builtIn && <Badge tone="blue">Built in</Badge>}<span className="text-xs text-muted">Signed: {t.senderName || 'your name'}</span></p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{t.text}</p>
                </div>
                <span className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => onUse(t)}>Use</Button>
                  <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setEditing(t)}>Edit</Button>
                  {!t.builtIn && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => open('deleteTemplate', { preset: { values: { id: t.id } } })}>Delete</Button>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

/** Write a message template: the rules of the words in braces, a sample to start from, the sender name, a live preview. */
function TemplateEditor({ ov, template, kind: startKind, onClose }: { ov: Overview; template: Template | null; kind: TemplateKind; onClose: () => void }) {
  const { run, me } = useApp();
  const [kind, setKind] = useState<TemplateKind>(template?.kind ?? startKind);
  const [name, setName] = useState(template?.name ?? '');
  const [language, setLanguage] = useState(template?.language ?? 'English');
  const [sender, setSender] = useState(template ? template.senderName : ov.defaultSender);
  const [text, setText] = useState(template?.text ?? '');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const allowed = ov.placeholders.filter(p => !p.kinds || p.kinds.includes(kind));
  const used = [...text.matchAll(/\{([^{}]*)\}/g)].map(x => x[1]);
  const unknown = used.find(k => !allowed.some(p => p.key === k));
  const problem = unknown !== undefined
    ? `The system cannot fill {${unknown}}${ov.placeholders.some(p => p.key === unknown) ? ' in this type of message' : ''}. Use only: ${allowed.map(p => `{${p.key}}`).join(', ')}.`
    : /[{}]/.test(text.replace(/\{[^{}]*\}/g, '')) ? 'A brace is not closed: write each word in braces like {name}.'
    : text.includes('{sender}') && !sender.trim() ? 'The message is signed with {sender}: fill in the sender name.' : null;
  const example: Record<string, string> = Object.fromEntries(ov.placeholders.map(p => [p.key, p.example]));
  const preview = text.replace(/\{(\w+)\}/g, (all, k: string) => (k === 'sender' ? sender.trim() || me.name : example[k]) ?? all);
  const insert = (word: string) => {
    const el = area.current;
    const at = el ? el.selectionStart : text.length, end = el ? el.selectionEnd : text.length;
    const next = text.slice(0, at) + `{${word}}` + text.slice(end);
    setText(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + word.length + 2, at + word.length + 2); });
  };
  const save = async () => {
    setBusy(true);
    const res = await run('saveTemplate', { id: template?.id, kind, name, language, senderName: sender, text });
    setBusy(false);
    if (res) onClose();
  };
  return (
    <Modal open onClose={onClose} title={template ? `Edit “${template.name}”` : 'New message'} description="Write it once; the system fills in the words in braces for every artist when you send."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !text.trim() || !!problem} title={problem ?? undefined} onClick={save}>Save message</Button></>}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Used for" required help={ov.kinds[kind].meaning}>
              <Select ariaLabel="Used for" value={kind} disabled={!!template} onChange={v => setKind(v as TemplateKind)}
                options={(['invite', 'member', 'followup', 'greeting'] as const).map(k => ({ value: k, label: ov.kinds[k].label, hint: ov.kinds[k].meaning }))} />
            </Field>
            <Field label="Template name" required help="Only for you, to find it in the list. Artists never see it.">
              <input className="field" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Diwali wishes, short (Hindi)" />
            </Field>
            <Field label="Language" help="Greetings can be picked by the artist’s language.">
              <input className="field" value={language} onChange={e => setLanguage(e.target.value)} placeholder="English, Hindi, Tamil…" />
            </Field>
            <Field label="Sender name" required={text.includes('{sender}')} help="Who signs the message. It goes where you write {sender}, e.g. “Warm regards, {sender}”.">
              <input className="field" value={sender} onChange={e => setSender(e.target.value)} placeholder="e.g. Team Goongoonalo" />
            </Field>
          </div>
          <Field label="Message" required help="Short and personal works best: 2–4 lines, one question, then your sign-off.">
            <textarea ref={area} className="field !min-h-[12rem] text-base" value={text} onChange={e => setText(e.target.value)} placeholder={ov.samples[kind]} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">Insert:</span>
            {allowed.map(p => <button key={p.key} type="button" onClick={() => insert(p.key)} title={p.meaning} className="mono rounded-md border border-line-strong px-2 py-1 text-sm text-ink-2 hover:bg-hover">{`{${p.key}}`}</button>)}
            <Button size="sm" variant="ghost" onClick={() => setText(ov.samples[kind])}>Start from the sample</Button>
          </div>
          {problem && <ErrorBox text={problem} />}
        </div>
        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-surface-2 p-4">
            <p className="mb-2 text-base font-semibold text-ink">Rules: words the system fills in</p>
            <ul className="space-y-2 text-sm">
              {ov.placeholders.map(p => {
                const ok = !p.kinds || p.kinds.includes(kind);
                return (
                  <li key={p.key} className={cx(!ok && 'opacity-50')}>
                    <code className="mono rounded bg-hover px-1.5 py-0.5 text-ink">{`{${p.key}}`}</code> <span className="text-ink-2">{p.meaning}</span>
                    <span className="block text-xs text-muted">Example: {p.key === 'sender' ? (sender.trim() || me.name) : p.example}{!ok ? ' · not in this type of message' : ''}</span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-muted">Write the word exactly as shown, in small letters and in braces. Anything else in braces is not filled in and the message cannot be saved.</p>
          </div>
          <div className="rounded-xl border border-line p-4">
            <p className="mb-1 text-base font-semibold text-ink">Sample ({ov.kinds[kind].label.toLowerCase()})</p>
            <p className="whitespace-pre-wrap text-sm text-ink-2">{ov.samples[kind]}</p>
          </div>
          <div className="rounded-xl border border-accent-line bg-accent-soft/40 p-4">
            <p className="mb-1 flex items-center gap-2 text-base font-semibold text-ink"><Send size={16} />Preview: what an artist receives</p>
            <p className="whitespace-pre-wrap text-base text-ink">{preview || <span className="text-faint">Write the message to see it here.</span>}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ festivals
function FestivalsTab({ ov, onSend }: { ov: Overview; onSend: (f: Festival) => void }) {
  const { open } = useActions();
  const { can, meta } = useApp();
  const admin = can('messageSettings');
  const today = meta?.today ?? '';
  return (
    <Card pad={false} title="Festival calendar" subtitle="Greetings go only to artists on Goongoonalo who said yes. Each greeting ends with “Reply STOP”: a direct message cannot carry an unsubscribe link, so STOP is the way out, and it is recorded."
      actions={admin ? <Button size="sm" icon={<Plus size={14} />} onClick={() => open('saveFestival', {})}>Add festival</Button> : undefined}>
      <ul className="divide-y divide-line">
        {ov.festivals.map(f => (
          <li key={f.id} className={cx('flex flex-wrap items-center justify-between gap-3 px-4 py-2.5', f.date && f.date < today && 'opacity-60')}>
            <span className="min-w-0">
              <span className="font-medium text-ink">{f.name}</span>
              <span className="ml-2 text-sm text-muted">{f.region}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {f.date ? <span className="tnum text-sm text-ink-2">{fmtDate(f.date)}</span> : <Badge tone="orange" dot>Date to set</Badge>}
              {f.date && f.date >= today && <Button size="sm" onClick={() => onSend(f)}>Send greetings</Button>}
              {admin && <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => open('saveFestival', { preset: { values: { id: f.id, name: f.name, date: f.date ?? '', region: f.region } } })}>Edit</Button>}
              {admin && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => open('deleteFestival', { preset: { values: { id: f.id } } })} aria-label={`Delete ${f.name}`} />}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------ limits
function LimitsTab({ ov }: { ov: Overview }) {
  const { open } = useActions();
  const s = ov.settings;
  return (
    <Card title="Limits that keep accounts safe" subtitle="Instagram, X and Facebook flag accounts that send many similar messages quickly. These limits count for each person."
      actions={<Button size="sm" icon={<Pencil size={14} />} onClick={() => open('messageLimits', { preset: { values: { ...s.daily, gapSeconds: s.gapSeconds } } })}>Change limits</Button>}>
      <ul className="space-y-1 text-sm">
        {PLATFORMS.map(p => <li key={p} className="flex items-center gap-2"><PlatformBadge platform={p} size="sm" />{p}: at most <b className="tnum">{s.daily[p]}</b> messages a day</li>)}
        <li>At least <b className="tnum">{s.gapSeconds} s</b> between two messages.</li>
        <li>Follow-ups {ov.followUpDays.join(', ')} days after the first message, at most {ov.followUpDays.length}.</li>
      </ul>
    </Card>
  );
}
