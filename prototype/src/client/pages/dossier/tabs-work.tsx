// Dossier tabs about the work done with the artist: contact attempts, claims, activation, tasks and the audit timeline.
import { Check, Circle, CircleDot, Plus } from 'lucide-react';
import { useActions } from '../../components/actions';
import { Timeline, taskMenu, type AuditRow, type TaskRowLike } from '../../components/case-bits';
import { Badge, Button, Card, DataTable, Empty, KeyVal, Menu, Notice, SkeletonRows, StatusBadge, cx } from '../../components/ui';
import { useApp, useQuery } from '../../lib/app';
import { fmtDate, fmtDateTime, fmtDue } from '../../lib/format';
import type { CaseDetail } from './Dossier';

// ------------------------------------------------------------------ contact attempts
interface Attempt { id: string; date: string; channel: string; recipient: string; routeLabel: string; message: string; result: string; evidence: string; nextAction: string; nextActionDate: string | null; ownerName: string }
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
        empty={<Empty compact title="No contact attempts recorded." text={canContact ? undefined : 'Select a verified route first (Contact Routes tab).'} action={btn} />}
        columns={[
          { key: 'd', header: 'Date', render: r => <span className="whitespace-nowrap">{fmtDateTime(r.date)}</span> },
          { key: 'c', header: 'Channel', render: r => r.channel },
          { key: 'r', header: 'Recipient', render: r => r.recipient },
          { key: 'rt', header: 'Route', render: r => <span className="block max-w-[220px] truncate text-ink-2" title={r.routeLabel}>{r.routeLabel}</span> },
          { key: 'm', header: 'Message / action', render: r => <span className="block max-w-[200px] text-ink-2">{r.message || '—'}</span> },
          { key: 'res', header: 'Result', render: r => <Badge tone={RESULT_TONE[r.result] ?? 'neutral'} dot>{r.result}</Badge> },
          { key: 'e', header: 'Evidence', render: r => <span className="block max-w-[180px] text-ink-2">{r.evidence || '—'}</span> },
          { key: 'n', header: 'Next action', render: r => <span>{r.nextAction}{r.nextActionDate && <span className="block text-xs text-muted">{fmtDate(r.nextActionDate)}</span>}</span> },
          { key: 'o', header: 'Owner', render: r => r.ownerName },
        ]} />
    </>
  );
}

// ------------------------------------------------------------------ claims
interface Claims { claimStatus: string; stages: string[]; reachedIdx: number; events: { id: string; type: string; date: string; profileId: string | null; claimRequestId: string | null; recipient: string | null; reviewerName: string | null; notes: string; evidence: string; actorName: string; source: string }[]; fields: Record<string, string | null> }
export function ClaimsTab({ d }: { d: CaseDetail }) {
  const { data } = useQuery<Claims>('caseClaims', { id: d.case.id });
  const { open } = useActions();
  const { can } = useApp();
  if (!data) return <SkeletonRows />;
  const s = data.claimStatus, stage = d.case.lifecycleStage;
  const ctx = { caseId: d.case.id };
  const done = s === 'Completed';
  const buttons: { id: string; label: string; ctx?: object; why: string | null }[] = [
    { id: 'sendClaimInvitation', label: 'Send Claim Invitation', why: done ? 'Already claimed' : stage !== 'Contact Confirmed' ? 'Needs a confirmed conversation first' : !['Not Invited', 'Rejected'].includes(s) ? `Claim is ${s.toLowerCase()}` : null },
    { id: 'recordClaimSubmission', label: 'Record Submission', why: s !== 'Invited' ? 'Needs a sent invitation' : null },
    { id: 'sendClaimToReview', label: 'Send to Review', why: s !== 'Submitted' ? 'Needs a recorded submission' : null },
    { id: 'reviewClaim', label: 'Approve Claim', ctx: { preset: { decision: 'Approve' } }, why: s !== 'In Review' ? 'Needs the claim in review' : !can('reviewClaim') ? 'Your role cannot approve claims' : null },
    { id: 'verifyBackendClaim', label: 'Verify Backend Claim', why: s !== 'Approved' ? 'Needs an approved claim' : !can('verifyBackendClaim') ? 'Your role cannot verify claims' : null },
  ];
  const next = buttons.find(b => !b.why);
  return (
    <div className="space-y-4">
      <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
        {data.stages.map((st, i) => {
          const state = i < data.reachedIdx || (done && i === data.reachedIdx) ? 'done' : i === data.reachedIdx ? 'active' : 'todo';
          return (
            <li key={st} className={cx('bg-surface px-3 py-2.5', state === 'active' && 'bg-accent-soft')}>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {state === 'done' ? <Check size={14} className="text-[var(--t-green)]" /> : state === 'active' ? <CircleDot size={14} className="text-accent-text" /> : <Circle size={14} className="text-faint" />}
                <span className={state === 'todo' ? 'text-faint' : 'text-ink'}>{i + 1}. {st}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        {buttons.map(b => <Button key={b.id} size="sm" variant={b === next ? 'primary' : 'secondary'} disabled={!!b.why} title={b.why ?? undefined} onClick={() => open(b.id, { ...ctx, ...b.ctx })}>{b.label}</Button>)}
      </div>
      <Notice tone="neutral">Sending the link is not a submission. A submission is not an approval. “Claim Completed” is only recorded after the backend confirms it.</Notice>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Claim record">
          <KeyVal items={[
            ['Claim status', <StatusBadge key="s" value={s} />], ['Profile ID', data.fields.profileId], ['Claim request ID', data.fields.claimRequestId], ['Recipient', data.fields.recipient],
            ['Invitation sent', data.fields.invitedAt ? fmtDateTime(data.fields.invitedAt) : null], ['Submitted', data.fields.submittedAt ? fmtDateTime(data.fields.submittedAt) : null],
            ['Reviewer', data.fields.reviewer], ['Approved', data.fields.approvedAt ? fmtDateTime(data.fields.approvedAt) : null], ['Backend verification', data.fields.backend],
          ]} />
        </Card>
        <Card title="Claim events" pad={!data.events.length}>
          {!data.events.length ? <Empty compact title="No claim activity yet." text={stage === 'Contact Confirmed' ? 'The conversation is confirmed: send the claim invitation.' : 'Claims start after a confirmed conversation.'} /> : (
            <ul className="divide-y divide-line">
              {data.events.slice().reverse().map(e => (
                <li key={e.id} className="px-4 py-2.5 text-sm">
                  <p className="flex items-center justify-between gap-2"><span className="font-medium text-ink">{e.type}</span><span className="text-xs text-muted">{fmtDateTime(e.date)}</span></p>
                  <p className="text-xs text-muted">{[e.actorName, e.source === 'Import' ? 'from import' : null, e.claimRequestId, e.reviewerName && `reviewer ${e.reviewerName}`].filter(Boolean).join(' · ')}</p>
                  {(e.notes || e.evidence) && <p className="text-xs text-ink-2">{[e.notes, e.evidence && `Evidence: ${e.evidence}`].filter(Boolean).join(' · ')}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
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
