// Every write in the app is one entry in this registry: a short form with smart defaults, mapped to one domain command.
// Screens only call open(actionId, context); the modal, validation, confirmation and error handling live here.
import { AlertTriangle, Search } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ATTEMPT_RESULTS, CHANNELS, CHECKLIST_STEPS, CONTACT_PREFERENCES, FEATURES, GOONGOONALO_INFO, GOONGOONALO_STATUSES, LIFECYCLE_STAGES, PRIORITIES, TASK_KINDS,
} from '../../domain/constants';
import { useApp, type Meta } from '../lib/app';
import { addDays, todayLocal } from '../lib/format';
import { Button, ErrorBox, Field, Modal, Notice, SkeletonRows, cx } from './ui';

// ------------------------------------------------------------------ types
export interface ActionCtx { caseId?: string; taskId?: string; task?: TaskLite; routeId?: string; contactId?: string; rowId?: string; conflictId?: string; decisionId?: string; preset?: Record<string, unknown> }
export interface TaskLite { id: string; caseId: string; kind: string; step: string; channel: string | null; recipient: string | null; dueDate: string; nextAction: string | null; ownerId: string | null; stage?: string }
type Values = Record<string, any>;
type Opt = { value: string; label: string };
interface Env { ctx: ActionCtx; d: any; meta: Meta; userId: string; today: string }
interface FieldDef {
  name: string; label: string; type: 'text' | 'textarea' | 'select' | 'date' | 'number' | 'checkbox' | 'radio' | 'case';
  required?: boolean | ((v: Values) => boolean);
  help?: ReactNode | ((v: Values) => ReactNode);
  placeholder?: string;
  options?: readonly (string | Opt)[] | ((env: Env) => readonly (string | Opt)[]);
  load?: (env: Env, q: (n: string, p: object) => Promise<any>) => Promise<Opt[]>;
  initial?: unknown | ((env: Env) => unknown);
  /** Value used while the person has not typed in this field; follows the other answers. */
  suggest?: (v: Values, env: Env) => string;
  show?: (v: Values) => boolean;
  half?: boolean;
}
interface ActionDef {
  title: string | ((env: Env) => string);
  intro?: (env: Env) => ReactNode;
  command: string;
  submit: string;
  fields?: FieldDef[] | ((env: Env) => FieldDef[]);
  params?: (v: Values, env: Env) => object;
  confirm?: (v: Values, env: Env) => string | null;
  danger?: boolean;
  /** Load the case dossier for defaults (on by default when a caseId is given). */
  needsCase?: boolean;
}

// ------------------------------------------------------------------ shared option helpers
const users = (env: Env): Opt[] => env.meta.users.filter(u => u.role !== 'Automation').map(u => ({ value: u.id, label: `${u.name} · ${u.role}` }));
const reviewers = (env: Env): Opt[] => env.meta.users.filter(u => ['Claim Reviewer', 'G Amplify Lead', 'Admin', 'System Owner'].includes(u.role)).map(u => ({ value: u.id, label: `${u.name} · ${u.role}` }));
const firstOf = (env: Env, role: string) => env.meta.users.find(u => u.role === role)?.id ?? env.userId;
const routeOptions = (env: Env): Opt[] => (env.d?.routesForForms ?? []).map((r: any) => ({ value: r.id, label: `${r.id} · ${r.chain.slice(1).map((x: any) => x.label).join(' → ')} (${r.state})` }));
const caseName = (env: Env) => env.d?.case?.canonicalName ?? 'this artist';

const RESULT_HINT: Record<string, string> = {
  'No Response': 'Stays “Contact Attempted”. A follow-up task is created automatically.',
  'Introduction Requested': 'Moves to “Introduction Pending”. Reaching an introducer is not reaching the artist.',
  'Conversation Confirmed': 'Moves to “Contact Confirmed”: the artist or an authorised representative was actually reached.',
  Interested: 'Moves to “Contact Confirmed”. Next: claim invitation.',
  'Needs Help': 'Moves to “Contact Confirmed” with a help call before the claim invitation.',
  'Wrong Person': 'The route is rejected (kept, with the reason) and the case goes back to research.',
  Bounce: 'The route is rejected (kept, with the reason) and the case goes back to research.',
  Later: 'Contact preference becomes “Later” until the agreed date; a callback task is set.',
  Declined: 'Case closes with history kept. Outreach is blocked.',
  'Do Not Contact': 'Outreach is blocked permanently, including after every future import.',
};
const RESULT_NEXT: Record<string, string> = {
  'No Response': 'Follow up', 'Introduction Requested': 'Wait for the introduction', 'Conversation Confirmed': 'Send claim invitation', Interested: 'Send claim invitation',
  'Needs Help': 'Help call, then claim invitation', 'Wrong Person': 'Try another route', Bounce: 'Try another route', Later: 'Call back on the agreed date',
  Declined: 'None: artist declined', 'Do Not Contact': 'None: do not contact',
};

const REJECT_FIELDS: FieldDef[] = [
  { name: 'choice', label: 'Why', type: 'radio', required: true, options: ['Wrong artist', 'Same name, different person', 'Fan or unofficial page', 'Inactive or fake account', 'Other'], initial: 'Wrong artist' },
  { name: 'detail', label: 'Details', type: 'text', required: v => v.choice === 'Other', placeholder: 'e.g. Profile belongs to an actor' },
];
function rejectReason(v: Values): string { return v.choice === 'Other' ? v.detail : v.detail ? `${v.choice}: ${v.detail}` : v.choice; }

// ------------------------------------------------------------------ registry
export const ACTIONS: Record<string, ActionDef> = {
  // ---- v2: identity status and Goongoonalo status (never mixed)
  setGoongoonalo: {
    title: env => `Goongoonalo status: ${caseName(env)}`, command: 'setGoongoonaloStatus', submit: 'Save status',
    intro: env => <>Only a person decides this, and it does not change the identity verification{env.d?.v2?.verified ? '' : ' (this artist is not verified yet: only “Pending” or “Do not contact” are possible)'}. Every change is recorded with your name and the time.</>,
    fields: env => [
      { name: 'status', label: 'Goongoonalo status', type: 'radio', required: true, options: GOONGOONALO_STATUSES.map(s => ({ value: s, label: GOONGOONALO_INFO[s].label })), initial: (env.ctx.preset?.status as string) ?? env.d?.v2?.goongoonaloStatus ?? 'PENDING', help: v => GOONGOONALO_INFO[v.status as keyof typeof GOONGOONALO_INFO]?.meaning },
      { name: 'reason', label: 'Reason', type: 'text', required: v => v.status === 'REJECTED' || v.status === 'DO_NOT_CONTACT', placeholder: 'e.g. Claimed and active on Goongoonalo', suggest: v => (v.status === 'GOONGOONALO' ? 'Joined Goongoonalo' : '') },
    ],
    params: (v, env) => ({ caseId: env.ctx.caseId, ...v }),
  },
  rejectArtist: {
    title: env => `Reject artist record: ${caseName(env)}`, command: 'rejectArtist', submit: 'Reject record', danger: true,
    intro: () => 'For records that are not a real artist (a label or company name, test content, a placeholder). The record and its history are kept and it can be restored; it is not searched or contacted.',
    fields: [{ name: 'choice', label: 'Why', type: 'radio', required: true, options: ['Label or company name, not an artist', 'Test content', 'Placeholder or unknown artist', 'Other'], initial: 'Label or company name, not an artist' }, { name: 'detail', label: 'Details', type: 'text', required: v => v.choice === 'Other' }],
    params: (v, env) => ({ caseId: env.ctx.caseId, reason: v.choice === 'Other' ? v.detail : v.detail ? `${v.choice}: ${v.detail}` : v.choice }),
  },
  restoreArtist: { title: 'Restore artist record', command: 'restoreArtist', submit: 'Restore', fields: [{ name: 'reason', label: 'Why', type: 'text', placeholder: 'e.g. It is a real artist after all' }], params: (v, env) => ({ caseId: env.ctx.caseId, ...v }) },
  confirmIdentity: {
    title: env => `Confirm identity: ${caseName(env)}`, command: 'confirmIdentity', submit: 'Mark verified',
    intro: () => 'Use this when the identity was confirmed outside discovery (a call, the label, a signed document). It counts as verified, with your evidence.',
    fields: [{ name: 'evidence', label: 'How it was confirmed', type: 'text', required: true, placeholder: 'e.g. Call with the artist: confirmed the catalogue songs' }],
    params: (v, env) => ({ caseId: env.ctx.caseId, ...v }),
  },
  reopenArtist: {
    title: env => `Reopen ${caseName(env)}`, command: 'reopenArtist', submit: 'Reopen',
    intro: () => 'The artist is listed as Reopened until someone reviews it. Earlier verification and evidence are kept.',
    fields: [{ name: 'reason', label: 'What should be reviewed', type: 'text', required: true, placeholder: 'e.g. Label says the artist changed management' }],
    params: (v, env) => ({ caseId: env.ctx.caseId, ...v }),
  },
  markReopenReviewed: {
    title: 'Mark changes as reviewed', command: 'markReopenReviewed', submit: 'Mark reviewed',
    intro: env => <>The artist goes back to {env.d?.v2?.verified ? 'Verified' : 'its earlier status'}. Nothing is deleted.</>,
    fields: [{ name: 'note', label: 'Note', type: 'text', placeholder: 'e.g. New songs checked, same artist' }],
    params: (v, env) => ({ caseId: env.ctx.caseId, ...v }),
  },

  // ---- cases
  createCase: {
    title: 'New artist case', command: 'createCase', submit: 'Create case', needsCase: false,
    intro: () => 'Use this for an artist found outside an import. A same or similar name goes to identity review; it is never merged automatically.',
    fields: [
      { name: 'name', label: 'Artist name', type: 'text', required: true },
      { name: 'backendId', label: 'Backend artist ID', type: 'text', placeholder: 'e.g. A2001 (if known)', half: true },
      { name: 'language', label: 'Language', type: 'text', half: true },
      { name: 'ownerId', label: 'Owner', type: 'select', options: users, initial: (e: Env) => e.userId },
      { name: 'reason', label: 'Why this case is created', type: 'text', placeholder: 'e.g. Found through a collaborator' },
    ],
  },
  startResearch: { title: 'Start research', command: 'startResearch', submit: 'Start research', intro: env => `${caseName(env)} moves to Researching and the 8-step checklist opens. You become the owner if nobody owns the case.` },
  addResearch: {
    title: 'Add research', command: 'addResearch', submit: 'Save research',
    intro: env => <>Recorded as <b>{env.meta.me?.name}</b>, {todayLocal()}. Log negative results too, so nobody repeats the same search.</>,
    fields: [
      { name: 'source', label: 'Source', type: 'select', required: true, options: ['Instagram', 'YouTube', 'Spotify', 'Apple Music', 'JioSaavn', 'Google search', 'Official website', 'Label / distributor', 'Internal records', 'Other'], half: true },
      { name: 'checklistStep', label: 'Checklist step', type: 'select', options: CHECKLIST_STEPS.map((s, i) => ({ value: String(i + 1), label: `${i + 1}. ${s.title}` })), initial: '5', half: true },
      { name: 'query', label: 'Search query', type: 'text', placeholder: '"Rahul Sharma" singer' },
      { name: 'url', label: 'URL', type: 'text', placeholder: 'https://' },
      { name: 'result', label: 'Result', type: 'text', required: true, placeholder: 'e.g. Profile found / No match' },
      { name: 'evidence', label: 'Evidence notes', type: 'textarea' },
      { name: 'confidence', label: 'Confidence %', type: 'number', initial: 50, half: true },
      { name: 'minutes', label: 'Time spent (min)', type: 'number', initial: 10, half: true },
    ],
  },
  moveToWaiting: {
    title: 'Move to Waiting for Evidence', command: 'moveToWaiting', submit: 'Move to waiting',
    intro: () => 'Waiting is a real stage, not a deletion. Open research and outreach tasks close, a re-check is scheduled, and the case reopens by itself when an import brings new evidence.',
    fields: [
      { name: 'blocker', label: 'Blocker', type: 'text', required: true, initial: 'No verified contact route found' },
      { name: 'futureTrigger', label: 'What would reopen it', type: 'text', initial: 'New song, credit or verified collaborator contact' },
      { name: 'nextReviewDate', label: 'Next review date', type: 'date', required: true, initial: (e: Env) => addDays(e.today, 30) },
    ],
  },
  setContactPreference: {
    title: 'Contact preference', command: 'setContactPreference', submit: 'Save preference',
    fields: env => [
      { name: 'preference', label: 'Preference', type: 'radio', required: true, options: CONTACT_PREFERENCES, initial: env.d?.case?.contactPreference ?? 'Allowed' },
      { name: 'until', label: 'Contact again from', type: 'date', required: true, show: v => v.preference === 'Later', initial: addDays(env.today, 14) },
      { name: 'reason', label: 'Reason', type: 'text', required: true, placeholder: 'What the artist said, and where' },
    ],
    confirm: v => v.preference === 'Do Not Contact' ? 'Mark as do-not-contact? Every open outreach task is cancelled and no future import will create outreach for this artist.' : v.preference === 'Declined' ? 'Record that the artist declined? The case closes; history is kept.' : null,
  },
  assignOwner: {
    title: 'Change owner', command: 'assignOwner', submit: 'Assign',
    intro: () => 'Open tasks and routes move with the case. History stays.',
    fields: env => [
      { name: 'ownerId', label: 'New owner', type: 'select', required: true, options: users, initial: env.d?.case?.ownerId ?? env.userId },
      { name: 'reason', label: 'Reason', type: 'text' },
    ],
  },
  changeStage: {
    title: 'Change lifecycle stage', command: 'changeStage', submit: 'Change stage',
    intro: () => 'Stages that need evidence (route, contact, claim, activation) can only be reached when that evidence exists. The reason is kept in the audit log.',
    fields: env => [
      { name: 'stage', label: 'New stage', type: 'select', required: true, options: LIFECYCLE_STAGES, initial: env.d?.case?.lifecycleStage },
      { name: 'reason', label: 'Reason', type: 'text', required: true },
    ],
  },
  closeCase: {
    title: 'Close case', command: 'closeCase', submit: 'Close case', danger: true,
    fields: [{ name: 'reason', label: 'Closure reason', type: 'text', required: true, placeholder: 'e.g. Deceased artist / Duplicate test profile' }],
    confirm: (_v, env) => `Close ${caseName(env)}? Open tasks are cancelled. Nothing is deleted and the case can be reopened.`,
  },
  reopenCase: { title: 'Reopen case', command: 'reopenCase', submit: 'Reopen', fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true }] },
  flagIdentity: {
    title: 'Flag possible duplicate', command: 'flagIdentity', submit: 'Send to identity review',
    intro: () => 'Both artists are listed in Deduplicate until a reviewer decides. Name similarity alone never merges artists.',
    fields: [
      { name: 'otherCaseId', label: 'Other case', type: 'case', required: true },
      { name: 'reason', label: 'Why they might be the same artist', type: 'text', required: true },
    ],
  },

  // ---- songs + credits found outside an import
  addSong: {
    title: 'Link a song', command: 'addSong', submit: 'Link song',
    intro: () => 'For a song found in research before it appears in an export. Credits on it are checked against the verified contact directory straight away.',
    fields: env => [
      { name: 'title', label: 'Song title', type: 'text', required: true },
      { name: 'role', label: `${caseName(env)}’s role`, type: 'select', options: ['Singer', 'Performer', 'Composer', 'Lyricist', 'Producer', 'Other'], initial: 'Singer', half: true },
      { name: 'backendTrackId', label: 'Track ID', type: 'text', placeholder: 'if known', half: true },
      { name: 'isrc', label: 'ISRC', type: 'text', half: true },
      { name: 'releaseDate', label: 'Release date', type: 'date', half: true },
      { name: 'label', label: 'Label', type: 'text', half: true },
      { name: 'distributor', label: 'Distributor', type: 'text', half: true },
      { name: 'source', label: 'Where it was found', type: 'text', placeholder: 'e.g. Spotify release page URL' },
    ],
  },
  addCredit: {
    title: 'Add a credit', command: 'addCredit', submit: 'Add credit', needsCase: false,
    intro: () => 'Add a collaborator credited on this song. A collaborator is a research lead: if they have a verified contact, a route is suggested automatically.',
    fields: [
      { name: 'personCaseId', label: 'Person with an artist case', type: 'case' },
      { name: 'personName', label: 'Or name (no case yet)', type: 'text', required: v => !v.personCaseId, show: v => !v.personCaseId },
      { name: 'role', label: 'Role', type: 'select', required: true, options: ['Singer', 'Performer', 'Composer', 'Lyricist', 'Producer', 'Other'], initial: 'Composer' },
      { name: 'source', label: 'Where it was found', type: 'text' },
    ],
    params: (v, env) => ({ trackId: env.ctx.preset?.trackId, ...v, personCaseId: v.personCaseId || null }),
  },

  // ---- routes + contact
  addRoute: {
    title: 'Add route', command: 'addRoute', submit: 'Add route',
    intro: () => 'A route is a path to the artist: a profile link, or a person/organisation in the contact directory. Appearing on the same song is a lead, not proof of a relationship.',
    fields: [
      { name: 'kind', label: 'Route type', type: 'radio', options: ['Profile link', 'Directory contact'], initial: 'Profile link' },
      { name: 'sourceUrl', label: 'Profile URL', type: 'text', placeholder: 'https://instagram.com/…', required: v => v.kind === 'Profile link', show: v => v.kind === 'Profile link' },
      { name: 'contactId', label: 'Contact', type: 'select', required: v => v.kind === 'Directory contact', show: v => v.kind === 'Directory contact', load: async (_e, q) => (await q('contacts', {})).map((k: any) => ({ value: k.id, label: `${k.personName} · ${k.role} · ${k.channel}${k.verified ? ' · verified' : ' · unverified'}` })) },
      { name: 'state', label: 'State', type: 'radio', options: ['Candidate', 'Verified'], initial: 'Candidate', help: 'Verified needs a verified contact or a source you checked.' },
      { name: 'evidence', label: 'Evidence', type: 'text', required: true, placeholder: 'Why this route leads to the artist' },
      { name: 'confidence', label: 'Confidence %', type: 'number', initial: 60 },
    ],
    params: (v, env) => ({ caseId: env.ctx.caseId, sourceUrl: v.kind === 'Profile link' ? v.sourceUrl : '', contactId: v.kind === 'Directory contact' ? v.contactId : null, state: v.state, evidence: v.evidence, confidence: v.confidence, origin: 'Manual' }),
  },
  selectRoute: { title: 'Select route', command: 'updateRoute', submit: 'Select route', intro: () => 'One route is selected at a time; others stay available. Selecting creates the outreach task.', fields: [{ name: 'reason', label: 'Why this route', type: 'text' }], params: (v, env) => ({ routeId: env.ctx.routeId, state: 'Selected', reason: v.reason }) },
  verifyRoute: { title: 'Mark route verified', command: 'updateRoute', submit: 'Mark verified', fields: [{ name: 'reason', label: 'How it was verified', type: 'text', required: true }], params: (v, env) => ({ routeId: env.ctx.routeId, state: 'Verified', reason: v.reason }) },
  rejectRoute: { title: 'Reject route', command: 'updateRoute', submit: 'Reject route', danger: true, intro: () => 'The route is kept with its reason so nobody tries it again.', fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true, placeholder: 'e.g. Wrong person: actor with the same name' }], params: (v, env) => ({ routeId: env.ctx.routeId, state: 'Rejected', reason: v.reason }) },
  exhaustRoute: { title: 'Mark route exhausted', command: 'updateRoute', submit: 'Mark exhausted', fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true, placeholder: 'e.g. No reply after two follow-ups' }], params: (v, env) => ({ routeId: env.ctx.routeId, state: 'Exhausted', reason: v.reason }) },
  recordContact: {
    title: env => `Record contact: ${caseName(env)}`, command: 'recordContactAttempt', submit: 'Save contact attempt',
    fields: env => [
      { name: 'routeId', label: 'Route used', type: 'select', options: [{ value: '', label: 'No route (direct)' }, ...routeOptions(env)], initial: env.ctx.routeId ?? (env.d?.routesForForms ?? []).find((r: any) => r.state === 'Selected')?.id ?? (env.d?.routesForForms ?? [])[0]?.id ?? '' },
      { name: 'channel', label: 'Channel', type: 'select', required: true, options: CHANNELS, initial: env.ctx.task?.channel ?? defaultChannel(env), half: true },
      { name: 'recipient', label: 'Recipient', type: 'text', required: true, initial: env.ctx.task?.recipient ?? defaultRecipient(env), half: true },
      { name: 'message', label: 'Message / action', type: 'text', placeholder: 'What was sent or said' },
      { name: 'result', label: 'Result', type: 'select', required: true, options: ATTEMPT_RESULTS, initial: 'No Response', help: v => RESULT_HINT[v.result] },
      { name: 'evidence', label: 'Evidence', type: 'text', placeholder: 'e.g. Email sent 10:20 / call note' },
      { name: 'laterDate', label: 'Agreed date', type: 'date', required: true, show: v => v.result === 'Later' },
      { name: 'nextAction', label: 'Next action', type: 'text', required: true, suggest: v => RESULT_NEXT[v.result] ?? '', half: true },
      { name: 'nextActionDate', label: 'Next action date', type: 'date', half: true },
    ],
    params: (v, env) => ({ caseId: env.ctx.caseId, ...v, routeId: v.routeId || null }),
    confirm: v => v.result === 'Do Not Contact' ? 'Record do-not-contact? Outreach for this artist stops permanently, including after future imports.' : null,
  },
  addContact: {
    title: 'Add contact to directory', command: 'addContact', submit: 'Add contact', needsCase: false,
    intro: () => 'Contact identity is separate from artist identity and from claim authority. Verifying a collaborator’s contact can reopen waiting cases they are credited with.',
    fields: [
      { name: 'personName', label: 'Person or organisation', type: 'text', required: true },
      { name: 'role', label: 'Role', type: 'select', required: true, options: ['Artist', 'Collaborator', 'Manager', 'Representative', 'Label', 'Distributor'], initial: 'Collaborator', half: true },
      { name: 'channel', label: 'Channel', type: 'select', required: true, options: CHANNELS.filter(c => c !== 'Introducer'), initial: 'Phone', half: true },
      { name: 'value', label: 'Address, number or handle', type: 'text', required: true },
      { name: 'caseId', label: 'Linked artist case (optional)', type: 'case' },
      { name: 'authorityEvidence', label: 'Where the contact comes from', type: 'text', placeholder: 'e.g. Listed on the official website' },
      { name: 'willingIntroducer', label: 'Willing to introduce collaborators', type: 'checkbox' },
      { name: 'verified', label: 'Identity verified now', type: 'checkbox' },
      { name: 'verificationEvidence', label: 'How it was verified', type: 'text', required: v => !!v.verified, show: v => !!v.verified },
    ],
  },
  verifyContact: { title: 'Verify contact', command: 'verifyContact', submit: 'Mark verified', needsCase: false, intro: () => 'Waiting cases credited with this person can reopen with a new lead.', fields: [{ name: 'evidence', label: 'How the identity was corroborated', type: 'text', required: true }], params: (v, env) => ({ contactId: env.ctx.contactId, ...v }) },

  // ---- claims
  sendClaimInvitation: {
    title: 'Send claim invitation', command: 'sendClaimInvitation', submit: 'Record invitation',
    intro: () => 'A sent link is not a submitted claim. The case waits in Claim Invited until the submission is recorded.',
    fields: env => [
      { name: 'profileId', label: 'Profile ID', type: 'text', required: true, initial: env.d?.artistId ?? '', half: true },
      { name: 'recipient', label: 'Recipient', type: 'text', required: true, initial: caseName(env), half: true },
      { name: 'notes', label: 'Notes', type: 'text', placeholder: 'e.g. Walkthrough offered on WhatsApp' },
    ],
  },
  recordClaimSubmission: {
    title: 'Record claim submission', command: 'recordClaimSubmission', submit: 'Record submission',
    intro: () => 'Submitted is not approved. An admin review follows.',
    fields: env => [
      { name: 'claimRequestId', label: 'Claim request ID', type: 'text', required: true, placeholder: 'From the admin console, e.g. CR-2026-0412', half: true },
      { name: 'claimant', label: 'Claimant', type: 'text', initial: caseName(env), half: true },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
  },
  sendClaimToReview: {
    title: 'Send claim to review', command: 'sendClaimToReview', submit: 'Send to review',
    fields: env => [
      { name: 'reviewerId', label: 'Reviewer', type: 'select', required: true, options: reviewers, initial: firstOf(env, 'Claim Reviewer') },
      { name: 'notes', label: 'Notes for the reviewer', type: 'text' },
    ],
  },
  reviewClaim: {
    title: 'Review claim', command: 'reviewClaim', submit: 'Save decision',
    intro: () => 'Check claimant authority and that the exact profile is being claimed. Approval is not completion: the backend must confirm it.',
    fields: env => [
      { name: 'decision', label: 'Decision', type: 'radio', required: true, options: ['Approve', 'Reject', 'Request Clarification'], initial: (env.ctx.preset?.decision as string) ?? 'Approve' },
      { name: 'notes', label: 'What was checked', type: 'text', required: true, placeholder: 'e.g. Government ID and label letter match the profile' },
      { name: 'evidence', label: 'Evidence', type: 'text' },
    ],
  },
  verifyBackendClaim: {
    title: 'Verify claim in the backend', command: 'verifyBackendClaim', submit: 'Save verification',
    intro: () => 'Claim Completed is only recorded when the backend/admin record shows the profile claimed by the right person.',
    fields: [
      { name: 'outcome', label: 'Backend shows', type: 'radio', required: true, options: [{ value: 'Verified', label: 'Claimed by the artist' }, { value: 'Access unavailable', label: 'Access unavailable / mismatch' }], initial: 'Verified' },
      { name: 'backendRef', label: 'Backend reference', type: 'text', required: true, placeholder: 'e.g. ADMIN-A001-CLAIMED' },
      { name: 'verifiedOwner', label: 'Claimed by', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
  },

  // ---- activation + ARM
  verifyAccess: {
    title: 'Confirm profile access', command: 'verifyAccess', submit: 'Confirm access',
    intro: () => 'Access is step one. Activation also needs one meaningful feature action with evidence.',
    fields: [{ name: 'evidence', label: 'How access was confirmed', type: 'text', required: true, placeholder: 'e.g. Artist logged in on a call and saw the catalogue' }, { name: 'backendRef', label: 'Backend reference', type: 'text' }],
  },
  selectFeature: {
    title: 'Choose a useful feature', command: 'selectFeature', submit: 'Save plan',
    fields: env => [
      { name: 'feature', label: 'Feature', type: 'radio', required: true, options: FEATURES, initial: 'Correct Profile' },
      { name: 'expectedOutcome', label: 'Expected outcome', type: 'text', placeholder: 'e.g. Photo and bio updated' },
      { name: 'agreedDate', label: 'Agreed date', type: 'date', required: true, initial: addDays(env.today, 2), half: true },
      { name: 'operatorId', label: 'Responsible operator', type: 'select', options: users, initial: env.userId, half: true },
    ],
  },
  recordFirstUse: {
    title: 'Record first use', command: 'recordFirstUse', submit: 'Save',
    intro: () => 'Login alone is not activation. Only a meaningful feature action with a backend reference or verified evidence activates the artist.',
    fields: [
      { name: 'kind', label: 'What happened', type: 'radio', required: true, options: ['Meaningful use', 'Login only'], initial: 'Meaningful use' },
      { name: 'backendRef', label: 'Backend event / reference', type: 'text', placeholder: 'e.g. EVT-48213', half: true },
      { name: 'timestamp', label: 'When', type: 'date', half: true },
      { name: 'evidence', label: 'Evidence', type: 'text', placeholder: 'e.g. Profile photo and bio changed', required: v => v.kind === 'Meaningful use' && !v.backendRef },
    ],
  },
  handoverToArm: {
    title: 'Hand over to ARM', command: 'handoverToArm', submit: 'Hand over',
    fields: env => [
      { name: 'relationshipOwnerId', label: 'Relationship owner', type: 'select', required: true, options: users, initial: firstOf(env, 'G Amplify Lead') },
      { name: 'interests', label: 'Interests', type: 'text' },
      { name: 'language', label: 'Language', type: 'text', initial: env.d?.case?.language ?? '', half: true },
      { name: 'nextParticipationCheck', label: 'Participation check', type: 'date', initial: addDays(env.today, 30), half: true, help: 'Proposed 30-day check.' },
      { name: 'supportNeeds', label: 'Support needs', type: 'text' },
    ],
  },
  recordParticipationCheck: {
    title: 'Participation check', command: 'recordParticipationCheck', submit: 'Save check',
    fields: [
      { name: 'result', label: 'Result', type: 'radio', required: true, options: [{ value: 'Active', label: 'Still using the profile' }, { value: 'Inactive', label: 'No further use' }], initial: 'Active', help: v => v.result === 'Inactive' ? 'A re-engagement task is created. No new claim invitation is needed.' : null },
      { name: 'note', label: 'Note', type: 'text' }, { name: 'backendRef', label: 'Backend reference', type: 'text' },
    ],
  },

  // ---- tasks
  createTask: {
    title: 'Create task', command: 'createTask', submit: 'Create task',
    fields: env => [
      { name: 'step', label: 'Task', type: 'text', required: true, placeholder: 'What needs doing' },
      { name: 'why', label: 'Why', type: 'text' },
      { name: 'kind', label: 'Type', type: 'select', options: TASK_KINDS, initial: 'Manual', half: true },
      { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, initial: env.d?.case?.priority ?? 'Medium', half: true },
      { name: 'dueDate', label: 'Due', type: 'date', required: true, initial: env.today, half: true },
      { name: 'ownerId', label: 'Owner', type: 'select', options: users, initial: env.d?.case?.ownerId ?? env.userId, half: true },
    ],
  },
  startTask: { title: 'Start task', command: 'startTask', submit: 'Start', needsCase: false, params: (_v, env) => ({ taskId: env.ctx.taskId }) },
  completeTask: {
    title: 'Complete task', command: 'completeTask', submit: 'Complete task', needsCase: false,
    intro: env => <>Every finished task needs an outcome and a next step.{env.ctx.task ? <span className="block mt-1 text-ink">“{env.ctx.task.step}”</span> : null}</>,
    fields: env => [
      { name: 'outcome', label: 'Outcome', type: 'text', required: true },
      { name: 'nextAction', label: 'Next action', type: 'text', required: true, initial: env.ctx.task?.nextAction ?? '' },
      { name: 'nextActionDate', label: 'Next action date', type: 'date', half: true, help: 'If set, a follow-on task is created.' },
      { name: 'minutes', label: 'Focused time (min)', type: 'number', half: true },
      { name: 'evidence', label: 'Evidence', type: 'text' },
    ],
    params: (v, env) => ({ taskId: env.ctx.taskId, ...v }),
  },
  holdTask: { title: 'Put task on hold', command: 'holdTask', submit: 'Put on hold', needsCase: false, fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true }], params: (v, env) => ({ taskId: env.ctx.taskId, ...v }) },
  rescheduleTask: { title: 'Reschedule task', command: 'rescheduleTask', submit: 'Reschedule', needsCase: false, fields: env => [{ name: 'dueDate', label: 'New due date', type: 'date', required: true, initial: addDays(env.today, 1) }, { name: 'reason', label: 'Reason', type: 'text', required: true }], params: (v, env) => ({ taskId: env.ctx.taskId, ...v }) },
  reassignTask: { title: 'Reassign task', command: 'reassignTask', submit: 'Reassign', needsCase: false, fields: env => [{ name: 'ownerId', label: 'Owner', type: 'select', required: true, options: users, initial: env.ctx.task?.ownerId ?? env.userId }, { name: 'reason', label: 'Reason', type: 'text' }], params: (v, env) => ({ taskId: env.ctx.taskId, ...v }) },
  addTaskNote: { title: 'Add note', command: 'addTaskNote', submit: 'Add note', needsCase: false, fields: [{ name: 'text', label: 'Note', type: 'textarea', required: true }], params: (v, env) => ({ taskId: env.ctx.taskId, text: v.text, kind: 'note' }) },
  addTaskEvidence: { title: 'Add evidence', command: 'addTaskNote', submit: 'Add evidence', needsCase: false, fields: [{ name: 'text', label: 'Evidence (link, reference or note)', type: 'text', required: true }], params: (v, env) => ({ taskId: env.ctx.taskId, text: v.text, kind: 'evidence' }) },
  createFollowUp: { title: 'Create follow-up', command: 'createFollowUp', submit: 'Create follow-up', needsCase: false, fields: env => [{ name: 'step', label: 'Follow-up', type: 'text', required: true }, { name: 'dueDate', label: 'Due', type: 'date', required: true, initial: addDays(env.today, 3) }], params: (v, env) => ({ taskId: env.ctx.taskId, ...v }) },
  changeNextAction: { title: 'Change next action', command: 'changeNextAction', submit: 'Save', needsCase: false, fields: env => [{ name: 'nextAction', label: 'Next action', type: 'text', required: true, initial: env.ctx.task?.nextAction ?? '' }], params: (v, env) => ({ taskId: env.ctx.taskId, ...v }) },
  cancelTask: { title: 'Cancel task', command: 'cancelTask', submit: 'Cancel task', danger: true, needsCase: false, fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true }], params: (v, env) => ({ taskId: env.ctx.taskId, ...v }), confirm: () => 'Cancel this task? It stays in the history with your reason.' },

  // ---- discovery: software suggests, a person decides
  verifyProfile: {
    title: env => `Verify ${(env.ctx.preset?.label as string) ?? 'profile'}`, command: 'verifyProfile', submit: 'Verify profile', needsCase: false,
    intro: env => <>Verify only when the evidence shows this profile belongs to <b>{caseName(env)}</b>. It is saved as verified knowledge and reused by every future import. You are recorded as the verifier.</>,
    fields: [{ name: 'note', label: 'What convinced you (optional)', type: 'text', placeholder: 'e.g. Bio lists his songs and label' }],
    params: (v, env) => ({ profileId: env.ctx.preset?.profileId, note: v.note }),
  },
  rejectProfile: {
    title: 'Reject candidate', command: 'rejectProfile', submit: 'Reject', danger: true, needsCase: false,
    intro: () => 'The candidate stays on record with your reason, so the same bad result is not shown again. You can reconsider it later.',
    fields: REJECT_FIELDS,
    params: (v, env) => ({ profileId: env.ctx.preset?.profileId, reason: rejectReason(v) }),
  },
  rejectCandidateGroup: {
    title: env => `Reject Candidate ${env.ctx.preset?.groupKey}`, command: 'rejectCandidateGroup', submit: 'Reject candidate', danger: true,
    intro: () => 'Every open profile in this possible artist is rejected with your reason. Nothing is deleted.',
    fields: REJECT_FIELDS,
    params: (v, env) => ({ caseId: env.ctx.caseId, groupKey: env.ctx.preset?.groupKey, reason: rejectReason(v) }),
  },
  verifyCandidateGroup: {
    title: env => `Verify Candidate ${env.ctx.preset?.groupKey}`, command: 'verifyCandidateGroup', submit: 'Verify all', needsCase: false,
    intro: env => <>All {String(env.ctx.preset?.count ?? '')} profiles in this possible artist will be saved as <b>{String(env.ctx.preset?.name ?? 'this artist')}</b>’s verified profiles. Verify one by one instead if you are not sure about some of them.</>,
    fields: [{ name: 'note', label: 'What convinced you (optional)', type: 'text', placeholder: 'e.g. Website links to all of them and lists his songs' }],
    params: (v, env) => ({ caseId: env.ctx.caseId, groupKey: env.ctx.preset?.groupKey, note: v.note }),
  },
  keepSeparateGroup: {
    title: env => `Keep Candidate ${env.ctx.preset?.groupKey} separate`, command: 'keepSeparateGroup', submit: 'Keep separate', needsCase: false,
    intro: env => { const o = env.ctx.preset?.other as { name: string; artistId: string | null } | null; return <>Same name, different person. These profiles are rejected for this artist{o ? <> and offered to <b>{o.name} ({o.artistId})</b> for review</> : null}. The two artists are never merged.</>; },
    params: (_v, env) => ({ caseId: env.ctx.caseId, groupKey: env.ctx.preset?.groupKey }),
  },
  resolveProfileChange: {
    title: 'Profile change detected', command: 'resolveProfileChange', submit: 'Save decision', needsCase: false,
    intro: () => 'A refresh found a likely replacement for a verified profile. Nothing was overwritten. The old profile is kept in history whatever you decide.',
    fields: env => [
      { name: 'decision', label: 'Decision', type: 'radio', required: true, options: [{ value: 'verify_new', label: 'Verify new' }, { value: 'keep_old', label: 'Keep old' }, { value: 'reject_new', label: 'Reject new' }], initial: (env.ctx.preset?.decision as string) ?? 'verify_new' },
      { name: 'note', label: 'Note', type: 'text', placeholder: 'e.g. Artist confirmed the new account on a call' },
    ],
    params: (v, env) => ({ profileId: env.ctx.preset?.profileId, decision: v.decision, note: v.note, reason: v.note }),
  },
  verifyRelationship: {
    title: 'Confirm a real relationship', command: 'verifyRelationship', submit: 'Confirm relationship', needsCase: false,
    intro: env => <>Sharing a song is a research lead, not proof that two people know each other. Confirm only with real evidence. <span className="block mt-1 text-ink">{String(env.ctx.preset?.label ?? '')}</span></>,
    fields: [{ name: 'evidence', label: 'Evidence', type: 'text', required: true, placeholder: 'e.g. Joshua confirmed on a call that he works with Rahul regularly' }],
    params: (v, env) => ({ caseId: env.ctx.caseId, edgeId: env.ctx.preset?.edgeId, evidence: v.evidence }),
  },
  rejectConnectionPath: {
    title: 'Reject connection path', command: 'rejectConnectionPath', submit: 'Reject path', danger: true, needsCase: false,
    fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true, placeholder: 'e.g. Joshua no longer works with this label' }],
    params: (v, env) => ({ pathId: env.ctx.preset?.pathId, reason: v.reason }),
  },
  verifyRouteDiscovery: {
    title: 'Verify route', command: 'verifyRoute', submit: 'Verify route', needsCase: false,
    intro: env => <>After verification the route is selected and the case becomes <b>Route Ready</b>: the contact workflow continues. Messages are never sent automatically. <span className="block mt-1 text-ink">{String(env.ctx.preset?.path ?? '')}</span></>,
    fields: [{ name: 'note', label: 'How you checked it (optional)', type: 'text', placeholder: 'e.g. Joshua confirmed he can introduce Rahul' }],
    params: (v, env) => ({ routeId: env.ctx.routeId, note: v.note }),
  },

  // ---- identity + imports
  decideIdentity: {
    title: 'Identity decision', command: 'decideIdentity', submit: 'Save decision', needsCase: false,
    intro: env => <>Reviewer: <b>{env.meta.me?.name}</b>, {todayLocal()}. Decisions are reversible.</>,
    fields: env => {
      const cases = (env.ctx.preset?.cases as { id: string; name: string; backendIds: string[] }[]) ?? [];
      return [
        { name: 'decision', label: 'Decision', type: 'radio', required: true, options: ['Same Person', 'Keep Separate', 'Defer'], initial: (env.ctx.preset?.decision as string) ?? 'Keep Separate' },
        { name: 'canonicalId', label: 'Case that stays', type: 'select', show: v => v.decision === 'Same Person', options: cases.map(c => ({ value: c.id, label: `${c.name} (${c.backendIds.join(', ') || c.id})` })), initial: cases[0]?.id },
        { name: 'reason', label: 'Reason', type: 'text', required: true },
        { name: 'evidence', label: 'Evidence', type: 'text', required: true, placeholder: 'What proves it: shared phone, label letter, same ISRCs…' },
      ];
    },
    params: (v, env) => ({ conflictId: env.ctx.conflictId, ...v }),
    confirm: v => v.decision === 'Same Person' ? 'Merge these cases? Songs, IDs and history are combined under one case. You can reverse this later.' : v.decision === 'Keep Separate' ? 'Keep these as separate artists?' : null,
  },
  reverseIdentityDecision: { title: 'Reverse identity decision', command: 'reverseIdentityDecision', submit: 'Reverse decision', danger: true, needsCase: false, fields: [{ name: 'reason', label: 'Why the decision was wrong', type: 'text', required: true }], params: (v, env) => ({ decisionId: env.ctx.decisionId, ...v }), confirm: () => 'Reverse this decision? The cases go back to identity review and a check task is created.' },
  resolveImportException: {
    title: 'Resolve import exception', command: 'resolveImportException', submit: 'Save', needsCase: false,
    fields: [{ name: 'action', label: 'Outcome', type: 'radio', required: true, options: ['Resolved', 'Dismissed'], initial: 'Resolved' }, { name: 'resolution', label: 'Resolution', type: 'text', required: true, placeholder: 'e.g. Backend team re-exported with the artist ID' }],
    params: (v, env) => ({ rowId: env.ctx.rowId, ...v }),
  },
};

function defaultChannel(env: Env): string {
  const r = (env.d?.routesForForms ?? []).find((x: any) => x.state === 'Selected') ?? (env.d?.routesForForms ?? [])[0];
  if (!r) return 'Email';
  if (r.collaboratorName || r.organisation) return 'Introducer';
  if (r.sourceUrl && /instagram/i.test(r.sourceUrl)) return 'Instagram';
  return 'Email';
}
function defaultRecipient(env: Env): string {
  const r = (env.d?.routesForForms ?? []).find((x: any) => x.state === 'Selected') ?? (env.d?.routesForForms ?? [])[0];
  return r?.collaboratorName ?? r?.organisation ?? r?.contactName ?? caseName(env);
}

/** Which form a task's “Do it” button opens: the workflow step the task stands for. */
export function actionForTask(task: TaskLite, d: any): string {
  const stage = d?.case?.lifecycleStage;
  const primary = (d?.actions ?? []).find((a: any) => a.primary && !a.disabled)?.id;
  if (task.step === 'Review discovery candidates') return 'reviewCandidates';
  if (['Outreach', 'Follow-up', 'Introduction'].includes(task.kind)) return 'recordContact';
  if (task.kind === 'Research' && stage === 'Waiting for Evidence') return 'startResearch';
  if (task.kind === 'Research') return (d?.routesForForms ?? []).length ? 'recordContact' : 'addResearch';
  if (['Claim', 'Claim Review', 'Backend Check', 'Activation', 'ARM'].includes(task.kind) && primary && ACTIONS[primary]) return primary;
  return 'completeTask';
}

// ------------------------------------------------------------------ host
interface Host { open(id: string, ctx?: ActionCtx): void }
const HostCtx = createContext<Host | null>(null);
export const useActions = () => { const c = useContext(HostCtx); if (!c) throw new Error('useActions outside ActionHost'); return c; };

/** One-click actions: no form, the result shows up in the artist's Evidence or Graph tab. */
const DIRECT = new Set(['openIdentityReview', 'findArtist', 'retrySearch', 'refreshSearch', 'findConnection', 'reviewCandidates', 'viewDiscovery', 'reviewChanges', 'openArtist']);
export function ActionHost({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ id: string; ctx: ActionCtx; key: number } | null>(null);
  const navigate = useNavigate();
  const app = useApp();
  const open = useCallback((id: string, ctx: ActionCtx = {}) => {
    if (!DIRECT.has(id)) { setState({ id, ctx, key: Date.now() }); return; }
    const caseId = ctx.caseId ?? ctx.task?.caseId;
    const tab = (t: string) => navigate(`/artists/${caseId}?tab=${t}`);
    if (id === 'openIdentityReview') navigate('/deduplicate');
    else if (id === 'reviewCandidates' || id === 'viewDiscovery') tab('evidence');
    else if (id === 'reviewChanges' || id === 'openArtist') navigate(`/artists/${caseId}`);
    else if (id === 'findArtist' || id === 'retrySearch' || id === 'refreshSearch') void app.run('startDiscovery', { caseId, mode: id === 'refreshSearch' ? 'refresh' : 'full' }).then(r => { if (r) tab('evidence'); });
    else if (id === 'findConnection') void app.run('findConnection', { caseId }).then(r => { if (r) tab('graph'); });
  }, [navigate, app]);
  const host = useMemo(() => ({ open }), [open]);
  return (
    <HostCtx.Provider value={host}>
      {children}
      {state && <ActionModal key={state.key} id={state.id} ctx={state.ctx} onClose={() => setState(null)} onSwitch={(id, ctx) => setState({ id, ctx, key: Date.now() })} />}
    </HostCtx.Provider>
  );
}

function ActionModal({ id, ctx, onClose, onSwitch }: { id: string; ctx: ActionCtx; onClose: () => void; onSwitch: (id: string, ctx: ActionCtx) => void }) {
  const app = useApp();
  const isTask = id === 'doTask';
  const def = ACTIONS[id];
  const caseId = ctx.caseId ?? ctx.task?.caseId;
  const wantCase = !!caseId && (isTask || def?.needsCase !== false);
  const [d, setD] = useState<any>(wantCase ? undefined : null);
  useEffect(() => {
    if (!wantCase) return;
    app.backend.query('caseDetail', { id: caseId }, app.userId).then(setD).catch(() => setD(null));
  }, [wantCase, caseId, app.backend, app.userId]);

  // “Do it” on a task: resolve to the real workflow form once the dossier is loaded.
  useEffect(() => {
    if (isTask && d !== undefined && ctx.task) onSwitch(actionForTask(ctx.task, d), { ...ctx, caseId });
  }, [isTask, d, ctx, caseId, onSwitch]);

  if (isTask) return <Modal open onClose={onClose} title="Opening task…"><SkeletonRows rows={3} /></Modal>;
  if (!def) return null;
  if (!app.meta || d === undefined) return <Modal open onClose={onClose} title="Loading…"><SkeletonRows rows={4} /></Modal>;
  const env: Env = { ctx: { ...ctx, caseId }, d, meta: app.meta, userId: app.userId, today: app.meta.today ?? todayLocal() };
  return <ActionForm def={def} env={env} onClose={onClose} />;
}

function ActionForm({ def, env, onClose }: { def: ActionDef; env: Env; onClose: () => void }) {
  const app = useApp();
  const fields = useMemo(() => (typeof def.fields === 'function' ? def.fields(env) : def.fields ?? []), [def, env]);
  const [values, setValues] = useState<Values>(() => {
    const v: Values = {};
    for (const f of fields) v[f.name] = typeof f.initial === 'function' ? (f.initial as (e: Env) => unknown)(env) : f.initial ?? (f.type === 'checkbox' ? false : '');
    return { ...v, ...(env.ctx.preset?.values as Values ?? {}) };
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, Opt[]>>({});

  useEffect(() => {
    for (const f of fields) if (f.load) f.load(env, (n, p) => app.backend.query(n, p, app.userId)).then(opts => setLoaded(l => ({ ...l, [f.name]: opts })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const effective: Values = { ...values };
  for (const f of fields) if (f.suggest && !touched.has(f.name)) effective[f.name] = f.suggest(effective, env);
  const visible = fields.filter(f => !f.show || f.show(effective));
  const set = (name: string, val: unknown) => { setValues(v => ({ ...v, [name]: val })); setTouched(t => new Set(t).add(name)); setError(null); };

  const submit = async (confirmed = false) => {
    for (const f of visible) {
      const req = typeof f.required === 'function' ? f.required(effective) : f.required;
      if (req && (effective[f.name] === '' || effective[f.name] == null)) { setError(`${f.label} is required.`); return; }
    }
    const confirmText = def.confirm?.(effective, env) ?? null;
    if (confirmText && !confirmed) { setConfirming(confirmText); return; }
    const payload: Values = {};
    for (const f of visible) payload[f.name] = f.type === 'number' && effective[f.name] !== '' ? Number(effective[f.name]) : effective[f.name];
    const params = def.params ? def.params(payload, env) : { caseId: env.ctx.caseId, taskId: env.ctx.taskId, ...payload };
    setBusy(true); setError(null);
    try {
      const res = await app.backend.command(def.command, params, app.userId);
      app.toast(res.message, 'ok');
      app.refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  const title = typeof def.title === 'function' ? def.title(env) : def.title;
  return (
    <Modal open onClose={onClose} title={title} description={def.intro?.(env)} width={visible.length > 5 ? 640 : 560}
      footer={confirming ? (
        <>
          <Button variant="ghost" onClick={() => setConfirming(null)}>Back</Button>
          <Button variant={def.danger ? 'danger' : 'primary'} loading={busy} onClick={() => submit(true)}>Yes, {def.submit.toLowerCase()}</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={def.danger ? 'danger' : 'primary'} loading={busy} onClick={() => submit()}>{def.submit}</Button>
        </>
      )}>
      {confirming ? (
        <Notice tone={def.danger ? 'red' : 'orange'} icon={<AlertTriangle size={16} />} title="Please confirm">{confirming}</Notice>
      ) : (
        <form onSubmit={e => { e.preventDefault(); submit(); }} className="grid grid-cols-2 gap-x-3 gap-y-3.5">
          {visible.map(f => (
            <FieldInput key={f.name} f={f} env={env} value={effective[f.name]} values={effective} options={loaded[f.name]} onChange={v => set(f.name, v)} />
          ))}
          {error && <div className="col-span-2"><ErrorBox text={error} /></div>}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

function FieldInput({ f, env, value, values, options, onChange }: { f: FieldDef; env: Env; value: any; values: Values; options?: Opt[]; onChange: (v: unknown) => void }) {
  const req = typeof f.required === 'function' ? f.required(values) : f.required;
  const help = typeof f.help === 'function' ? f.help(values) : f.help;
  const opts: Opt[] = (options ?? (typeof f.options === 'function' ? f.options(env) : f.options ?? [])).map(o => (typeof o === 'string' ? { value: o, label: o } : o));
  const span = f.half ? 'col-span-2 sm:col-span-1' : 'col-span-2';
  if (f.type === 'checkbox') {
    return (
      <label className={cx(span, 'flex items-center gap-2 text-sm text-ink-2')}>
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--accent-strong)]" />{f.label}
      </label>
    );
  }
  if (f.type === 'radio') {
    return (
      <div className={span}>
        <span className="mb-1 block text-sm font-medium text-ink-2">{f.label}{req && <span className="text-[var(--t-red)]"> *</span>}</span>
        <div className="flex flex-wrap gap-1.5">
          {opts.map(o => (
            <button key={o.value} type="button" onClick={() => onChange(o.value)}
              className={cx('rounded-md border px-2.5 py-1.5 text-sm', value === o.value ? 'border-accent-strong bg-accent-soft font-medium text-ink' : 'border-line-strong bg-surface text-ink-2 hover:bg-hover')}>{o.label}</button>
          ))}
        </div>
        {help && <span className="mt-1 block text-xs text-muted">{help}</span>}
      </div>
    );
  }
  let input: ReactNode;
  if (f.type === 'select') input = (
    <select className="field" value={value ?? ''} onChange={e => onChange(e.target.value)}>
      {!opts.some(o => o.value === '') && <option value="" disabled>{f.load && !options ? 'Loading…' : 'Choose…'}</option>}
      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  else if (f.type === 'textarea') input = <textarea className="field" value={value ?? ''} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} />;
  else if (f.type === 'case') input = <CasePicker value={value} onChange={onChange} />;
  else input = <input className="field" type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={value ?? ''} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} />;
  return <Field className={span} label={f.label} required={req} help={help}>{input}</Field>;
}

function CasePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<{ id: string; name: string; artistId: string; stage: string }[]>([]);
  const [label, setLabel] = useState('');
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => { app.backend.query<any[]>('caseOptions', { q }, app.userId).then(r => { if (alive) setOpts(r); }); }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q, app.backend, app.userId]);
  if (value) return (
    <div className="field flex items-center justify-between">
      <span className="truncate">{label || value}</span>
      <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => { onChange(''); setLabel(''); }}>Change</button>
    </div>
  );
  return (
    <div>
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <input className="field pl-8" placeholder="Search by name or artist ID" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="scroll-thin mt-1 max-h-40 overflow-y-auto rounded-md border border-line">
        {opts.map(o => (
          <button key={o.id} type="button" onClick={() => { onChange(o.id); setLabel(`${o.name} (${o.artistId || o.id})`); }} className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-hover">
            <span className="truncate">{o.name} <span className="mono text-muted">{o.artistId || o.id}</span></span>
            <span className="shrink-0 text-xs text-muted">{o.stage}</span>
          </button>
        ))}
        {!opts.length && <p className="px-2.5 py-2 text-xs text-muted">No matching case.</p>}
      </div>
    </div>
  );
}
