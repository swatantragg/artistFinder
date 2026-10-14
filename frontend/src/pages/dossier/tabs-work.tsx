// Dossier tabs about the work done with the artist: contact attempts, claims, activation, tasks and the audit timeline.
import { Check, Circle, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { normalizeProfileUrl } from '@domain/discovery/normalize';
import { useActions } from '../../components/actions';
import { PlatformBadge } from '../../components/discovery/bits';
import { NextStep, ProcessControls, StepBar, type ProcessSide, type StepState } from '../../components/process';
import { ArtistMessage } from '../Messages';
import { RoutesTab } from './tabs-identity';
import { Timeline, taskMenu, type AuditRow, type TaskRowLike } from '../../components/case-bits';
import { Badge, Button, Card, DataTable, Empty, KeyVal, Menu, Notice, SkeletonRows, StatusBadge, cx } from '../../components/ui';
import { useApp, useQuery } from '../../lib/app';
import { fmtDate, fmtDateTime, fmtDue } from '../../lib/format';
import type { CaseDetail } from './Dossier';

// ------------------------------------------------------------------ contact attempts
interface Attempt { id: string; date: string; channel: string; recipient: string; routeLabel: string; message: string; result: string; evidence: string; nextAction: string; nextActionDate: string | null; ownerName: string; undoneAt?: string | null; undoReason?: string | null }
const RESULT_TONE: Record<string, 'green' | 'red' | 'orange' | 'blue' | 'neutral'> = { 'Conversation Confirmed': 'green', Interested: 'green', 'Needs Help': 'green', 'Introduction Requested': 'blue', 'No Response': 'neutral', Later: 'orange', 'Wrong Person': 'red', Bounce: 'red', Declined: 'red', 'Do Not Contact': 'red' };
export function AttemptsTab({ d }: { d: CaseDetail }) {
  const { data } = useQuery<Attempt[]>('caseAttempts', { id: d.case.id });
  const { open } = useActions();
  const canContact = d.actions.some(a => a.id === 'recordContact' && !a.disabled);
  const btn = canContact ? <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => open('recordContact', { caseId: d.case.id })}>Record contact</Button> : null;
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">A sent message is not a conversation. “Contact Confirmed” needs the correct artist or an authorised representative to have been reached.</p>
        {btn}
      </div>
      <DataTable rows={data} rowKey={r => r.id}
        empty={<Empty compact title="No contact attempts recorded." text={canContact ? undefined : 'Verify one of the artist’s profiles (Profiles tab) or add a verified route first.'} action={btn} />}
        columns={[
          { key: 'd', header: 'Date', render: r => <span className="whitespace-nowrap">{fmtDateTime(r.date)}</span> },
          { key: 'c', header: 'Channel', render: r => r.channel },
          { key: 'r', header: 'Recipient', render: r => r.recipient },
          { key: 'rt', header: 'Route', render: r => <span className="block max-w-[220px] truncate text-ink-2" title={r.routeLabel}>{r.routeLabel}</span> },
          { key: 'm', header: 'Message / action', render: r => <span className="block max-w-[200px] text-ink-2">{r.message || '—'}</span> },
          { key: 'res', header: 'Result', render: r => r.undoneAt ? <span title={r.undoReason ?? ''}><Badge tone="neutral">Undone</Badge> <span className="text-xs text-muted line-through">{r.result}</span></span> : <Badge tone={RESULT_TONE[r.result] ?? 'neutral'} dot>{r.result}</Badge> },
          { key: 'e', header: 'Evidence', render: r => <span className="block max-w-[180px] text-ink-2">{r.evidence || '—'}</span> },
          { key: 'n', header: 'Next action', render: r => <span>{r.nextAction}{r.nextActionDate && <span className="block text-xs text-muted">{fmtDate(r.nextActionDate)}</span>}</span> },
          { key: 'o', header: 'Owner', render: r => r.ownerName },
        ]} />
    </>
  );
}

// ------------------------------------------------------------------ process data
interface ContactView extends ProcessSide { progress: { label: string; state: StepState }[]; ended: string | null; next: string; nextAction: string | null }
interface DmTarget { platform: string; url: string; handle: string; dmUrl: string; how: string }
interface Process { contact: ContactView; claim: ProcessSide; all: ProcessSide; targets: DmTarget[]; memberMessageSent: boolean }
interface RouteLite { id: string; state: string; chain: { kind: string; label: string; sub?: string }[]; sourceUrl: string | null; origin: string; contactName: string | null; organisation: string | null; collaboratorName: string | null }

// ------------------------------------------------------------------ claims
/** Each claim step in plain words: what it means, why it exists, which claim events belong to it and the action that reaches it. */
const CLAIM_STEPS: { means: string; why: string; events: string[]; action?: string }[] = [
  { means: 'The artist has not been asked to claim their profile yet. Before this, someone actually spoke with the artist (or their manager) and they are interested.',
    why: 'A claim link only goes to a person we have really reached, so it ends up with the right artist.', events: [] },
  { means: 'The artist was sent the link to claim their Goongoonalo profile (the Profile ID), by email, WhatsApp or a message.',
    why: 'Claiming lets the real artist take charge of their own profile: songs, photo, bio and data. A sent link is not a claim yet: we wait for the artist to fill it in.', events: ['Invited'], action: 'sendClaimInvitation' },
  { means: 'The artist filled in the claim form. The Goongoonalo admin console gave the request an ID (the claim request ID).',
    why: 'The ID lets anyone find and check this exact request. Submitted is not approved: anyone can fill in a form.', events: ['Submitted'], action: 'recordClaimSubmission' },
  { means: 'An Admin checks the claim: is this person really the artist, or allowed to act for them, and is it the right profile?',
    why: 'It stops the wrong person (a fan, an impostor or someone with the same name) from taking over an artist’s profile.', events: ['Sent to Review', 'Clarification Requested', 'Rejected'], action: 'sendClaimToReview' },
  { means: 'The Admin is satisfied and approved the claim.',
    why: 'Approval is our decision. The profile itself only changes hands in the Goongoonalo backend, so one last check follows.', events: ['Approved', 'Backend Mismatch'], action: 'reviewClaim' },
  { means: 'Someone checked the Goongoonalo backend and saw the profile now belongs to the artist (with a backend reference as proof).',
    why: 'Only the backend proves the claim really worked. After this, activation starts: the artist logs in and starts using the profile.', events: ['Backend Verified', 'Backend Reported Claimed'], action: 'verifyBackendClaim' },
];
interface Claims { claimStatus: string; stages: string[]; reachedIdx: number; events: { id: string; type: string; date: string; profileId: string | null; claimRequestId: string | null; recipient: string | null; reviewerName: string | null; notes: string; evidence: string; actorName: string; source: string; undoneAt?: string | null; undoReason?: string | null }[]; fields: Record<string, string | null> }

/**
 * Claims & routes: one guided flow. 1 Is the artist on Goongoonalo? 2 The route (how we reach them) 3 The first message
 * on that route 4 Their answer 5 The claim (only for artists not on Goongoonalo). Members get member messages and
 * festival greetings through the same route. The next step is highlighted; undo and reset are always at hand.
 */
export function ClaimsTab({ d, onTab }: { d: CaseDetail; onTab: (tab: string) => void }) {
  const id = d.case.id;
  const proc = useQuery<Process | null>('caseProcess', { id });
  const routes = useQuery<RouteLite[]>('caseRoutes', { id });
  const claims = useQuery<Claims>('caseClaims', { id });
  const attempts = useQuery<Attempt[]>('caseAttempts', { id });
  const { open } = useActions();
  const { can, run } = useApp();
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!d.v2.verified && d.case.claimStatus === 'Not Invited') return <Empty title="Verify the artist first." text="Claims & routes start once a person has verified who the artist is (Profiles tab)." action={<Button onClick={() => onTab('profiles')}>Open Profiles</Button>} />;
  if (!proc.data || !routes.data || !claims.data) return <SkeletonRows />;
  const ctx = { caseId: id }, name = d.case.canonicalName;
  const g = d.v2.goongoonaloStatus, pending = g === 'PENDING', member = g === 'GOONGOONALO';
  const p = proc.data, c = p.contact, data = claims.data;
  const chosen = routes.data.find(r => r.state === 'Selected') ?? null;
  const chosenTarget = chosen?.sourceUrl ? p.targets.find(t => t.url === chosen.sourceUrl) ?? null : null;
  const others = routes.data.filter(r => r.id !== chosen?.id && (r.state === 'Verified' || r.state === 'Candidate'));
  const contacted = c.progress[1]?.state === 'done', answered = c.progress[2]?.state === 'done', confirmed = c.progress[3]?.state === 'done';
  const ended = c.ended;
  const s = data.claimStatus, stage = d.case.lifecycleStage, done = s === 'Completed';
  const claimOpen = !member && (confirmed || s !== 'Not Invited');
  const run1 = async (key: string, cmd: string, params: object) => { setBusy(key); await run(cmd, params); setBusy(null); };

  // ---- claim buttons (step 5)
  const buttons: { id: string; label: string; ctx?: object; why: string | null }[] = [
    { id: 'sendClaimInvitation', label: 'Send Claim Invitation', why: done ? 'Already claimed' : stage !== 'Contact Confirmed' ? 'Needs a confirmed conversation first' : !['Not Invited', 'Rejected'].includes(s) ? `Claim is ${s.toLowerCase()}` : null },
    { id: 'recordClaimSubmission', label: 'Record Submission', why: s !== 'Invited' ? 'Needs a sent invitation' : null },
    { id: 'sendClaimToReview', label: 'Send to Review', why: s !== 'Submitted' ? 'Needs a recorded submission' : null },
    { id: 'reviewClaim', label: 'Approve Claim', ctx: { preset: { decision: 'Approve' } }, why: s !== 'In Review' ? 'Needs the claim in review' : !can('reviewClaim') ? 'Your role cannot approve claims' : null },
    { id: 'verifyBackendClaim', label: 'Verify Backend Claim', why: s !== 'Approved' ? 'Needs an approved claim' : !can('verifyBackendClaim') ? 'Your role cannot verify claims' : null },
  ];
  const nextClaim = buttons.find(b => !b.why);
  const nextClaimIdx = nextClaim ? CLAIM_STEPS.findIndex(x => x.action === nextClaim.id) : -1;
  const stateOf = (i: number): StepState => i < data.reachedIdx || (done && i === data.reachedIdx) ? 'done' : i === data.reachedIdx ? 'active' : 'todo';
  const sel = picked ?? (nextClaimIdx >= 0 ? nextClaimIdx : data.reachedIdx);

  // ---- the whole flow at a glance, and the one next step
  const flow: { label: string; state: StepState }[] = [
    { label: 'On Goongoonalo?', state: pending ? 'active' : 'done' },
    { label: 'The route', state: chosen ? 'done' : 'todo' },
    { label: member ? 'Member message' : 'Join invitation', state: contacted ? 'done' : 'todo' },
    { label: 'Their answer', state: answered ? 'done' : 'todo' },
    ...(member ? [] : [{ label: 'The claim', state: (done ? 'done' : s !== 'Not Invited' ? 'active' : 'todo') as StepState }]),
  ];
  const nextIdx = ended ? -1 : pending ? 0 : !chosen && !contacted ? 1 : !contacted ? 2 : !answered ? 3 : !member && !done ? 4 : -1;
  let nextText: ReactNode, nextAction: ReactNode = undefined, tone: 'accent' | 'red' = 'accent';
  if (ended) { nextText = `${ended} If that was a mistake, undo the last step below.`; tone = 'red'; }
  else if (pending) nextText = `Answer the first question: is ${name} on Goongoonalo? It decides what the route is used for.`;
  else if (!chosen && !contacted) nextText = `Choose the route: how we reach ${name}. ${member ? 'Member messages, updates and festival greetings' : 'The invitation to join and claim the profile'} will go through it.`;
  else if (!contacted) nextText = member ? 'Send the member message through the route (step 3 below).' : 'Send the invitation to join and claim through the route (step 3 below).';
  else if (!answered) { nextText = c.next; nextAction = <Button variant="primary" onClick={() => open(c.nextAction === 'recordReply' ? 'recordReply' : 'recordContact', ctx)}>Record the answer</Button>; }
  else if (member) { nextText = 'Done for now. Member messages, updates and festival greetings go through this route (Messages).'; nextAction = <Link to="/messages?kind=greeting"><Button variant="primary">Festival greetings</Button></Link>; }
  else if (done) { nextText = `The claim is completed: ${name} is now on Goongoonalo. Mark it so; from then on the route carries member messages and greetings.`; nextAction = <Button variant="primary" loading={busy === 'member'} onClick={() => run1('member', 'setGoongoonaloStatus', { caseId: id, status: 'GOONGOONALO', reason: 'Claim completed (backend verified)' })}>Mark as on Goongoonalo</Button>; }
  else if (s === 'Rejected') { nextText = 'The reviewer rejected the claim. Sort it out with the artist, then send the claim invitation again (or undo the rejection if it was a mistake).'; nextAction = nextClaim && <Button variant="primary" onClick={() => open(nextClaim.id, { ...ctx, ...nextClaim.ctx })}>{nextClaim.label}</Button>; }
  else if (nextClaim) { nextText = `${nextClaim.label}. ${CLAIM_STEPS[nextClaimIdx].means}`; nextAction = <Button variant="primary" onClick={() => open(nextClaim.id, { ...ctx, ...nextClaim.ctx })}>{nextClaim.label}</Button>; }
  else nextText = 'Nothing to do right now.';

  const routeLabel = (r: RouteLite) => r.sourceUrl && p.targets.find(t => t.url === r.sourceUrl) ? `Direct message on ${p.targets.find(t => t.url === r.sourceUrl)!.platform} @${p.targets.find(t => t.url === r.sourceUrl)!.handle}` : r.chain.slice(1).map(x => x.label).join(' → ') || r.sourceUrl || r.id;
  // the app's logo in front of each route, so it is clear at a glance which app the message goes through
  const routePlatform = (r: RouteLite) => (r.sourceUrl ? p.targets.find(t => t.url === r.sourceUrl)?.platform ?? normalizeProfileUrl(r.sourceUrl)?.platform : null) ?? 'Go-between';
  const routeName = (r: RouteLite, strong?: boolean) => <span className="inline-flex items-center gap-2 align-middle"><PlatformBadge platform={routePlatform(r)} size="sm" />{strong ? <b>{routeLabel(r)}</b> : routeLabel(r)}</span>;
  const section = (n: number, title: string, active: boolean, body: ReactNode, sub?: ReactNode) => (
    <section className={cx('rounded-2xl border p-4 sm:p-5', active ? 'border-accent bg-accent-soft/30' : 'border-line')}>
      <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-ink"><span className={cx('flex h-7 w-7 items-center justify-center rounded-full text-sm', active ? 'bg-accent text-white' : 'bg-hover text-ink-2')}>{n}</span>{title}{active && <Badge tone="violet">Next step</Badge>}</h3>
      {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      <div className="mt-3">{body}</div>
    </section>
  );

  return (
    <div className="space-y-4">
      <NextStep text={nextText} action={nextAction} tone={tone} />
      <ProcessControls caseId={id} process="all" side={p.all} name={name} undoFirst={!!ended || s === 'Rejected'} />
      <StepBar label="Claims & routes: where it stands" steps={flow} next={nextIdx} />

      {section(1, `Is ${name} on Goongoonalo?`, pending, pending ? (
        <>
          <p className="max-w-3xl text-base text-ink-2">An artist already on Goongoonalo has nothing to claim: the route will carry member messages, updates and festival greetings. An artist not on it yet is asked, through the route, to join and claim their profile.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="primary" loading={busy === 'NOT_MEMBER'} onClick={() => run1('NOT_MEMBER', 'setGoongoonaloStatus', { caseId: id, status: 'NOT_MEMBER', reason: 'Answered in Claims & routes' })}>No, not yet: start the claim</Button>
            <Button loading={busy === 'GOONGOONALO'} onClick={() => run1('GOONGOONALO', 'setGoongoonaloStatus', { caseId: id, status: 'GOONGOONALO', reason: 'Answered in Claims & routes' })}>Yes, on Goongoonalo</Button>
          </div>
        </>
      ) : (
        <p className="flex flex-wrap items-center gap-3 text-base text-ink">{member ? 'Yes: on Goongoonalo. No claim needed.' : g === 'NOT_MEMBER' ? 'No, not yet: the route is used to ask the artist to join and claim.' : `Goongoonalo status: ${d.v2.goongoonaloInfo.label}.`}<Button size="sm" variant="ghost" onClick={() => open('setGoongoonalo', ctx)}>Change</Button></p>
      ))}

      {!pending && section(2, 'The route: how we reach the artist', !chosen && !contacted, (
        <div className="space-y-3">
          {chosen ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--t-green-bd)] bg-[var(--t-green-bg)]/40 px-4 py-3">
              <p className="flex flex-wrap items-center gap-2 text-base text-ink"><Check size={17} className="text-[var(--t-green)]" />Chosen route: {routeName(chosen, true)}</p>
              <span className="text-sm text-muted">{chosenTarget ? 'The message goes straight to the artist.' : 'The message goes through this person or organisation.'}</span>
            </div>
          ) : <p className="text-base text-ink-2">No route chosen yet. Pick one of the artist’s own verified profiles (simplest: a direct message), or someone who can pass the message on.</p>}
          {p.targets.filter(t => t.url !== chosen?.sourceUrl).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {p.targets.filter(t => t.url !== chosen?.sourceUrl).map(t => (
                <Button key={t.url} variant={chosen ? 'secondary' : 'primary'} icon={<PlatformBadge platform={t.platform} size="xs" />} loading={busy === t.url} onClick={() => run1(t.url, 'useProfileAsRoute', { caseId: id, url: t.url })}>Use {t.platform} @{t.handle} as the route</Button>
              ))}
            </div>
          )}
          {others.length > 0 && (
            <ul className="space-y-2">
              {others.map(r => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                  <span className="flex flex-wrap items-center gap-2 text-ink-2">{routeName(r)} <StatusBadge value={r.state} /></span>
                  {r.state === 'Verified' ? <Button size="sm" onClick={() => open('selectRoute', { caseId: id, routeId: r.id })}>Use this route</Button> : <Button size="sm" variant="ghost" onClick={() => open('verifyRoute', { caseId: id, routeId: r.id })}>Mark verified</Button>}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => open('addRoute', ctx)}>Add someone who can pass it on (manager, label, collaborator)</Button>
            {!p.targets.length && <span className="text-sm text-muted">No verified Instagram, X or Facebook profile yet. <button type="button" className="text-accent-text underline" onClick={() => onTab('profiles')}>Verify one in Profiles</button>.</span>}
          </div>
        </div>
      ), member ? 'Member messages, updates and festival greetings go through this route.' : 'The invitation to join and claim the profile, and its follow-ups, go through this route.')}

      {!pending && chosen && section(3, member ? 'Send the member message' : 'Ask the artist to join and claim', !contacted && !ended, contacted ? (
        <p className="text-base text-ink-2">{answered ? 'Sent and answered.' : 'Sent. Waiting for the answer: record it when they reply.'} {!answered && <Button size="sm" className="ml-2" onClick={() => open(c.nextAction === 'recordReply' ? 'recordReply' : 'recordContact', ctx)}>Record the answer</Button>}</p>
      ) : chosenTarget ? (
        <ArtistMessage caseId={id} kind={member ? 'member' : 'invite'} url={chosenTarget.url}
          fallback={<p className="text-base text-ink-2">{member && p.memberMessageSent ? 'The member message was already sent.' : 'This message cannot go out right now (opted out, already sent, or limits).'} <Link to="/messages" className="text-accent-text underline">Open Messages</Link></p>} />
      ) : (
        <p className="text-base text-ink-2">The route goes through someone else: send them the message yourself, then record it here. <Button size="sm" className="ml-2" variant="primary" onClick={() => open('recordContact', { caseId: id, routeId: chosen.id })}>Record contact</Button></p>
      ), chosenTarget ? 'One click copies the message and opens the chat; paste it, send it, then click “Yes, I sent it”. Follow-ups 3, 7 and 14 days later are planned for you.' : undefined)}

      {claimOpen && section(5, 'The claim', !!nextClaim && !ended, (
        <div className="space-y-3">
          <StepBar label="Claim steps: click one to see what it means and what happened" next={nextClaimIdx} selected={sel} onPick={setPicked} steps={data.stages.map((label, i) => ({ label, state: stateOf(i) }))} />
          <ClaimStep i={sel} name={data.stages[sel]} state={stateOf(sel)} events={data.events.filter(e => !e.undoneAt && CLAIM_STEPS[sel].events.includes(e.type))}
            confirmed={sel === 0 ? (attempts.data ?? []).filter(a => !a.undoneAt && ['Conversation Confirmed', 'Interested', 'Needs Help'].includes(a.result)) : []}
            button={buttons.find(b => b.id === CLAIM_STEPS[sel].action)} onDo={b => open(b.id, { ...ctx, ...b.ctx })} />
          <Notice tone="neutral">Sending the link is not a submission. A submission is not an approval. “Claim Completed” is only recorded after the backend confirms it.</Notice>
        </div>
      ), 'Starts once the artist said they are interested.')}

      <details className="rounded-2xl border border-line">
        <summary className="cursor-pointer px-4 py-3 text-base font-medium text-ink">All routes, contact history and the claim record</summary>
        <div className="space-y-5 border-t border-line p-4">
          <RoutesTab d={d} />
          <div><p className="mb-2 text-sm font-semibold text-ink">Contact history</p><AttemptsTab d={d} /></div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Claim record">
              <KeyVal items={[
                ['Claim status', <StatusBadge key="s" value={s} />], ['Profile ID', data.fields.profileId], ['Claim request ID', data.fields.claimRequestId], ['Recipient', data.fields.recipient],
                ['Invitation sent', data.fields.invitedAt ? fmtDateTime(data.fields.invitedAt) : null], ['Submitted', data.fields.submittedAt ? fmtDateTime(data.fields.submittedAt) : null],
                ['Reviewer', data.fields.reviewer], ['Approved', data.fields.approvedAt ? fmtDateTime(data.fields.approvedAt) : null], ['Backend verification', data.fields.backend],
              ]} />
            </Card>
            <Card title="Claim events" pad={!data.events.length}>
              {!data.events.length ? <Empty compact title="No claim activity yet." /> : (
                <ul className="divide-y divide-line">
                  {data.events.slice().reverse().map(e => (
                    <li key={e.id} className={cx('px-4 py-2.5 text-sm', e.undoneAt && 'opacity-60')}>
                      <p className="flex items-center justify-between gap-2"><span className={cx('font-medium text-ink', e.undoneAt && 'line-through')}>{e.type}</span><span className="flex items-center gap-2">{e.undoneAt && <Badge tone="neutral">Undone</Badge>}<span className="text-xs text-muted">{fmtDateTime(e.date)}</span></span></p>
                      <p className="text-xs text-muted">{[e.actorName, e.source === 'Import' ? 'from import' : null, e.claimRequestId, e.reviewerName && `reviewer ${e.reviewerName}`].filter(Boolean).join(' · ')}</p>
                      {(e.notes || e.evidence) && <p className="text-xs text-ink-2">{[e.notes, e.evidence && `Evidence: ${e.evidence}`].filter(Boolean).join(' · ')}</p>}
                      {e.undoneAt && e.undoReason && <p className="text-xs text-muted">Undone: {e.undoReason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </details>
    </div>
  );
}

type ClaimEvent = Claims['events'][number];
type ClaimButton = { id: string; label: string; ctx?: object; why: string | null };
/** One claim step opened: plain-words meaning, why it exists, and everything recorded for it. */
function ClaimStep({ i, name, state, events, confirmed, button, onDo }: { i: number; name: string; state: 'done' | 'active' | 'todo'; events: ClaimEvent[]; confirmed: Attempt[]; button?: ClaimButton; onDo: (b: ClaimButton) => void }) {
  const info = CLAIM_STEPS[i];
  const status = state === 'done' ? 'Done' : state === 'active' ? (i === 0 ? 'Where the claim is now' : 'Current step') : 'Not reached yet';
  return (
    <Card title={`Step ${i + 1} · ${name}`} subtitle={status}
      actions={button && state !== 'done' ? <Button size="sm" variant={button.why ? 'secondary' : 'primary'} disabled={!!button.why} title={button.why ?? undefined} onClick={() => onDo(button)}>{button.label}</Button> : undefined}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 text-sm">
          <p><span className="font-medium text-ink">What it means. </span><span className="text-ink-2">{info.means}</span></p>
          <p><span className="font-medium text-ink">Why we do it. </span><span className="text-ink-2">{info.why}</span></p>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink">What happened</p>
          {i === 0 ? (
            confirmed.length ? (
              <ul className="space-y-2">{confirmed.map(a => (
                <li key={a.id} className="rounded-md border border-line px-3 py-2 text-xs">
                  <p className="flex justify-between gap-2"><span className="font-medium text-ink">{a.result}: {a.recipient} ({a.channel})</span><span className="text-muted">{fmtDateTime(a.date)}</span></p>
                  <p className="text-muted">{[a.ownerName, a.routeLabel].filter(Boolean).join(' · ')}</p>
                  {(a.message || a.evidence) && <p className="text-ink-2">{[a.message, a.evidence && `Evidence: ${a.evidence}`].filter(Boolean).join(' · ')}</p>}
                </li>
              ))}</ul>
            ) : <p className="text-xs text-muted">No confirmed conversation recorded yet: the claim starts after the artist answers (steps 3 and 4 above).</p>
          ) : events.length ? (
            <ul className="space-y-2">{events.map(e => (
              <li key={e.id} className="rounded-md border border-line px-3 py-2 text-xs">
                <p className="flex justify-between gap-2"><span className="font-medium text-ink">{e.type}</span><span className="text-muted">{fmtDateTime(e.date)}</span></p>
                <p className="text-muted">{[`by ${e.actorName}`, e.source === 'Import' ? 'from import' : null, e.profileId && `profile ${e.profileId}`, e.claimRequestId && `request ${e.claimRequestId}`, e.recipient && `to ${e.recipient}`, e.reviewerName && `reviewer ${e.reviewerName}`].filter(Boolean).join(' · ')}</p>
                {(e.notes || e.evidence) && <p className="text-ink-2">{[e.notes, e.evidence && `Evidence: ${e.evidence}`].filter(Boolean).join(' · ')}</p>}
              </li>
            ))}</ul>
          ) : <p className="text-xs text-muted">{state === 'todo' ? 'Not reached yet.' : 'Nothing recorded for this step.'}</p>}
        </div>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ activation
interface Act { status: string; access: string; meaningfulUse: string; loginOnly: boolean; feature: { feature: string; expectedOutcome: string; operator: string; agreedDate: string } | null; use: { backendRef: string | null; evidence: string; date: string; feature: string | null } | null; arm: { ownerName: string; interests: string; language: string; supportNeeds: string; nextParticipationCheck: string; since: string } | null; events: { id: string; type: string; date: string; feature: string | null; evidence: string; backendRef: string | null; result: string | null; actorName: string }[]; claimCompleted: boolean }
export function ActivationTab({ d }: { d: CaseDetail }) {
  const { data } = useQuery<Act>('caseActivation', { id: d.case.id });
  const { open } = useActions();
  if (!data) return <SkeletonRows />;
  const st = d.case.lifecycleStage, as = d.case.activationStatus;
  const ctx = { caseId: d.case.id };
  const buttons = [
    { id: 'verifyAccess', label: 'Verify access', why: !data.claimCompleted ? 'Needs a backend-verified claim' : as !== 'Not Started' ? 'Access already verified' : null },
    { id: 'selectFeature', label: 'Choose feature', why: st !== 'Activation Pending' || !['Access Verified', 'Feature Selected'].includes(as) ? 'Verify access first' : null },
    { id: 'recordFirstUse', label: 'Record first use', why: st !== 'Activation Pending' ? 'Needs verified access' : null },
    { id: 'handoverToArm', label: 'Handover to ARM', why: st !== 'Activated' ? 'Needs activation first' : null },
    { id: 'recordParticipationCheck', label: 'Participation check', why: st !== 'Ongoing ARM' ? 'After ARM handover' : null },
  ];
  const next = buttons.find(b => !b.why);
  return (
    <div className="space-y-4">
      {!data.claimCompleted && <Notice tone="neutral" title="Activation starts after a backend-verified claim.">Current claim status: {d.case.claimStatus}.</Notice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Gate label="Access" value={data.access} />
        <Gate label="Meaningful use" value={data.meaningfulUse} />
        <Gate label="Activation" value={data.status === 'Activated' ? 'Activated' : 'Pending'} hint={data.loginOnly && data.status !== 'Activated' ? 'Login recorded, but login alone is not activation.' : undefined} />
      </div>
      <div className="flex flex-wrap gap-2">
        {buttons.map(b => <Button key={b.id} size="sm" variant={b === next ? 'primary' : 'secondary'} disabled={!!b.why} title={b.why ?? undefined} onClick={() => open(b.id, ctx)}>{b.label}</Button>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Feature and first use">
          <KeyVal items={[
            ['Selected feature', data.feature?.feature], ['Expected outcome', data.feature?.expectedOutcome], ['Responsible operator', data.feature?.operator], ['Agreed date', data.feature ? fmtDate(data.feature.agreedDate) : null],
            ['Backend event', data.use?.backendRef], ['Evidence', data.use?.evidence], ['Timestamp', data.use ? fmtDateTime(data.use.date) : null],
          ]} />
        </Card>
        <Card title="ARM handover">
          {data.arm ? <KeyVal items={[['Relationship owner', data.arm.ownerName], ['Interests', data.arm.interests], ['Language', data.arm.language], ['Support needs', data.arm.supportNeeds], ['Next participation check', fmtDate(data.arm.nextParticipationCheck)], ['Since', fmtDate(data.arm.since)]]} />
            : <Empty compact title="Not handed over yet." text="After activation, assign a relationship owner and a 30-day participation check." />}
        </Card>
      </div>
      <Card title="Activation events" pad={!data.events.length}>
        {!data.events.length ? <Empty compact title="No activation activity yet." /> : (
          <ul className="divide-y divide-line">
            {data.events.slice().reverse().map(e => (
              <li key={e.id} className="px-4 py-2.5 text-sm">
                <p className="flex justify-between gap-2"><span className="font-medium text-ink">{e.type}{e.feature ? `: ${e.feature}` : ''}</span><span className="text-xs text-muted">{fmtDateTime(e.date)}</span></p>
                <p className="text-xs text-muted">{[e.actorName, e.backendRef, e.result].filter(Boolean).join(' · ')}{e.evidence ? ` · ${e.evidence}` : ''}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
function Gate({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const ok = value === 'Verified' || value === 'Activated';
  return (
    <div className={cx('rounded-lg border px-3.5 py-3', ok ? 'tone-green tone-box' : 'border-line bg-surface')}>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={cx('mt-0.5 flex items-center gap-1.5 text-md font-semibold', ok ? 'tone-text' : 'text-ink')}>{ok ? <Check size={16} /> : <Circle size={14} className="text-faint" />}{value}</p>
      {hint && <p className="mt-0.5 text-xs text-[var(--t-orange)]">{hint}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ tasks
export function TasksTab({ d }: { d: CaseDetail }) {
  const { data } = useQuery<(TaskRowLike & { nextAction: string | null; focusedMinutes: number; createdAt: string; channel: string | null; recipient: string | null })[]>('caseTasks', { id: d.case.id });
  const { open } = useActions();
  const { run } = useApp();
  return (
    <>
      <div className="mb-3 flex justify-end">{d.case.lifecycleStage !== 'Closed' && <Button size="sm" icon={<Plus size={14} />} onClick={() => open('createTask', { caseId: d.case.id })}>Create task</Button>}</div>
      <DataTable rows={data} rowKey={r => r.id} empty={<Empty compact title="No tasks yet." />}
        columns={[
          { key: 'id', header: 'Task ID', render: r => <span className="mono">{r.id}</span> },
          { key: 'step', header: 'Step', render: r => <span className="block min-w-[200px]"><span className="text-ink">{r.step}</span><span className="block text-xs text-muted">{r.why}</span></span> },
          { key: 'owner', header: 'Owner', render: r => r.ownerName },
          { key: 'trigger', header: 'Trigger', render: r => <span className="block max-w-[160px] text-xs text-ink-2">{r.trigger}</span> },
          { key: 'due', header: 'Due', render: r => { const x = fmtDue(r.dueDate); const open_ = ['Queued', 'In Progress', 'Waiting'].includes(r.status); return <span className={cx('whitespace-nowrap', open_ && x.overdue && 'font-medium text-[var(--t-red)]')}>{open_ ? x.text : fmtDate(r.dueDate)}</span>; } },
          { key: 'p', header: 'Priority', render: r => <StatusBadge value={r.priority} dot={false} /> },
          { key: 's', header: 'Status', render: r => <StatusBadge value={r.status} /> },
          { key: 'a', header: 'Action', render: r => r.channel ? `${r.channel}${r.recipient ? ` → ${r.recipient}` : ''}` : <span className="text-faint">—</span> },
          { key: 'res', header: 'Result', render: r => <span className="block max-w-[180px] text-xs text-ink-2">{r.result ?? '—'}</span> },
          { key: 'ev', header: 'Evidence', render: r => r.evidence?.length ? <span className="text-xs">{r.evidence.join('; ')}</span> : <span className="text-faint">—</span> },
          { key: 'n', header: 'Next action', render: r => <span className="text-xs">{r.nextAction ?? '—'}</span> },
          { key: 'f', header: 'Focus', render: r => r.focusedMinutes ? `${r.focusedMinutes} min` : '—', className: 'tnum whitespace-nowrap' },
          { key: 'm', header: '', render: r => ['Queued', 'In Progress', 'Waiting'].includes(r.status) ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="primary" onClick={() => open('doTask', { task: r, taskId: r.id, caseId: r.caseId })}>Do it</Button>
              <Menu items={taskMenu(open, r, (n, p) => run(n, p))} />
            </div>
          ) : null },
        ]} />
    </>
  );
}

// ------------------------------------------------------------------ timeline
export function TimelineTab({ id }: { id: string }) {
  const { data } = useQuery<AuditRow[]>('caseTimeline', { id });
  if (!data) return <SkeletonRows />;
  if (!data.length) return <Empty title="No history yet." />;
  return <><p className="mb-3 text-xs text-muted">Every meaningful change, newest first: who, what, why, evidence, result and next step.</p><Timeline events={data} /></>;
}
