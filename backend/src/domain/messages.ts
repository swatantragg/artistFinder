// Messages: outreach by direct message on the artist's own verified Instagram, X or Facebook profile. The app writes the
// message and opens the chat; a person pastes it and presses Send there. Nothing is sent automatically, so the account
// is never flagged as a bot, and messages only go to profiles a person verified.
// The first question is always: is the artist on Goongoonalo? Members get the member message and festival greetings
// (only with their yes); the others get a join invitation, which leads into the claim. Follow-ups go out 3, 7 and 14
// days after the first message (at most 3); any answer, an opt-out or a failed delivery stops them.
import {
  GREETINGS_CONSENTS, MESSAGE_KINDS, MESSAGE_KIND_INFO, MESSAGE_PLATFORMS, REPLY_OUTCOMES,
  type AttemptResult, type GreetingsConsent, type LifecycleStage, type MessageKind, type MessagePlatform, type ReplyOutcome,
} from './constants';
import type { CommandResult } from './commands';
import type { Model } from './model';
import { OUTREACH_KINDS, audit, closeTasks, notUndone, computePriority, getCase, openTask, outreachBlocked, requirePerm, rule, setStage, syncNextAction, userName } from './ops';
import { isVerified } from './status';
import type { ArtistCase, Ctx, OutreachMessage } from './types';
import { addDays, clean } from './util';
import { artistRanks, songCounts, TOP_ARTISTS } from './views';

type P = Record<string, any>;
type Command = (m: Model, ctx: Ctx, p: P) => CommandResult;

// ------------------------------------------------------------------ templates, festivals, settings (kept in meta)
export interface MessageTemplate { id: string; name: string; kind: MessageKind; language: string; text: string; senderName: string; builtIn: boolean; updatedAt: string | null; updatedBy: string | null }
export interface Festival { id: string; name: string; date: string | null; region: string }
export interface MessageSettings { daily: Record<MessagePlatform, number>; gapSeconds: number; followUpDays: number[] }

/** The rules of a template: words in braces are filled in by the system for each artist, when the message is sent. */
export const PLACEHOLDERS: { key: string; meaning: string; example: string; kinds?: MessageKind[] }[] = [
  { key: 'name', meaning: 'The artist’s name, filled in for each artist.', example: 'K. S. Chithra' },
  { key: 'song', meaning: 'One of the artist’s songs.', example: 'December Ki Sardi' },
  { key: 'songs', meaning: 'How many of the artist’s songs we have.', example: '2,316' },
  { key: 'festival', meaning: 'The festival you pick when you send greetings (greetings only).', example: 'Diwali', kinds: ['greeting'] },
  { key: 'sender', meaning: 'Who signs the message: the “Sender name” of the template (e.g. Team Goongoonalo). Empty = your own name.', example: 'Team Goongoonalo' },
];
/** A short example per message type, to start from. */
export const SAMPLES: Record<MessageKind, string> = {
  invite: 'Hi {name}! 🙏 We love your song “{song}”. Your music is already on Goongoonalo and you can claim your artist profile for free. Shall I send you the link?\n\nWarm regards,\n{sender}',
  member: 'Hi {name}! Thank you for being on Goongoonalo. Your {songs} songs are on your profile. Want help getting started? Just reply here.\n\nWarm regards,\n{sender}',
  followup: 'Hi {name}, just checking you saw my last message. Happy to help whenever it suits you. Reply STOP if you’d rather not hear from us.\n\nWarm regards,\n{sender}',
  greeting: 'Happy {festival}, {name}! 🎉 Wishing you joy and lots of music.\n\nWarm regards,\n{sender}\n(Reply STOP to stop these messages.)',
};
export const DEFAULT_SENDER = 'Team Goongoonalo';
const tpl = (id: string, name: string, kind: MessageKind, language: string, text: string): MessageTemplate => ({ id, name, kind, language, text, senderName: DEFAULT_SENDER, builtIn: true, updatedAt: null, updatedBy: null });
export const DEFAULT_TEMPLATES: MessageTemplate[] = [
  tpl('TM-invite', 'Join Goongoonalo', 'invite', 'English',
    'Hi {name}! 🙏 We love your music, especially “{song}”. Your songs are already on Goongoonalo, a music platform for Indian artists, and you can claim your artist profile for free to look after your photo, bio and songs yourself. Would you like the link?\n\nWarm regards,\n{sender}'),
  tpl('TM-member', 'Welcome, member', 'member', 'English',
    'Hi {name}! Thank you for being part of Goongoonalo. Your artist profile is ready: update your photo and bio and see how your {songs} songs are doing. Shall I send you the link? Reply YES if you’d also like festival wishes from us.\n\nWarm regards,\n{sender}'),
  tpl('TM-followup', 'Friendly follow-up', 'followup', 'English',
    'Hi {name}, just following up on my earlier message. Happy to help whenever it suits you. If you’d rather not hear from us, reply STOP and we won’t message again.\n\nWarm regards,\n{sender}'),
  tpl('TM-greeting-en', 'Festival wishes (English)', 'greeting', 'English',
    'Happy {festival}, {name}! 🎉 Wishing you joy and lots of music.\n\nWarm regards,\n{sender}\n(Reply STOP to stop these messages.)'),
  tpl('TM-greeting-hi', 'Festival wishes (Hindi)', 'greeting', 'Hindi',
    '{name} जी, आपको {festival} की हार्दिक शुभकामनाएँ! 🎉 ढेर सारा प्यार और संगीत।\n\nशुभकामनाओं सहित,\n{sender}\n(ये संदेश बंद करने के लिए STOP लिखें।)'),
];
/** Built-in texts before V2.6.0: a stored built-in that still has one of them follows the new default. */
const OLD_DEFAULT_TEXT: Record<string, string> = {
  'TM-invite': 'Hi {name}, I’m {sender} from Goongoonalo, a music platform for Indian artists. We love your music, like “{song}”. Your songs are already on Goongoonalo, and you can claim your artist profile for free to look after it yourself: your photo, bio and songs in one place. Would you like to join? Reply here and I’ll send you the link. 🙏',
  'TM-member': 'Hi {name}, {sender} here from Goongoonalo. Thank you for being part of Goongoonalo! Your artist profile is ready: you can update your photo and bio and see how your {songs} songs are doing. Shall I send you the link to get started? And would you like festival wishes from us now and then? Just reply YES.',
  'TM-followup': 'Hi {name}, just following up on my earlier message from Goongoonalo. Happy to help whenever it suits you. If you’d rather not hear from us, reply STOP and we won’t message again.',
  'TM-greeting-en': 'Happy {festival}, {name}! 🎉 Wishing you joy and lots of music from all of us at Goongoonalo. (Reply STOP to stop these messages.)',
  'TM-greeting-hi': '{name} जी, आपको {festival} की हार्दिक शुभकामनाएँ! 🎉 Goongoonalo परिवार की ओर से ढेर सारा प्यार और संगीत। (ये संदेश बंद करने के लिए STOP लिखें।)',
};
/** Words in braces the template uses that the system cannot fill in (or not for this message type). */
export function templateProblem(kind: MessageKind, text: string): string | null {
  const used = [...text.matchAll(/\{([^{}]*)\}/g)].map(x => x[1]);
  const known = new Map(PLACEHOLDERS.map(p => [p.key, p]));
  const unknown = used.filter(k => !known.has(k.trim().toLowerCase()) || k !== k.trim().toLowerCase());
  if (unknown.length) return `The system cannot fill {${unknown[0]}}. Use only: ${PLACEHOLDERS.filter(p => !p.kinds || p.kinds.includes(kind)).map(p => `{${p.key}}`).join(', ')}.`;
  const wrong = used.find(k => known.get(k)!.kinds && !known.get(k)!.kinds!.includes(kind));
  if (wrong) return `{${wrong}} only works in festival greetings (there is no festival to fill in here).`;
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ''))) return 'A brace is not closed: write each word in braces like {name}.';
  return null;
}
/** Festivals with a fixed or announced date carry it; the others need this year's date before greetings can go out. */
export const DEFAULT_FESTIVALS: Festival[] = [
  { id: 'dussehra-2026', name: 'Dussehra', date: '2026-10-20', region: 'All India' },
  { id: 'diwali-2026', name: 'Diwali', date: '2026-11-08', region: 'All India' },
  { id: 'gurpurab-2026', name: 'Guru Nanak Jayanti', date: '2026-11-24', region: 'Punjab and Sikh community' },
  { id: 'christmas-2026', name: 'Christmas', date: '2026-12-25', region: 'All India' },
  { id: 'newyear-2027', name: 'New Year', date: '2027-01-01', region: 'All India' },
  { id: 'lohri-2027', name: 'Lohri', date: '2027-01-13', region: 'Punjab' },
  { id: 'sankranti-2027', name: 'Makar Sankranti', date: '2027-01-14', region: 'All India' },
  { id: 'pongal-2027', name: 'Pongal', date: null, region: 'Tamil Nadu' },
  { id: 'holi-2027', name: 'Holi', date: null, region: 'All India' },
  { id: 'eid-2027', name: 'Eid al-Fitr', date: null, region: 'All India' },
  { id: 'ugadi-2027', name: 'Ugadi / Gudi Padwa', date: null, region: 'Karnataka, Andhra Pradesh, Telangana, Maharashtra' },
  { id: 'baisakhi-2027', name: 'Baisakhi', date: null, region: 'Punjab' },
  { id: 'bihu-2027', name: 'Bohag Bihu', date: null, region: 'Assam' },
  { id: 'onam-2027', name: 'Onam', date: null, region: 'Kerala' },
  { id: 'ganesh-2027', name: 'Ganesh Chaturthi', date: null, region: 'Maharashtra and All India' },
  { id: 'durgapuja-2027', name: 'Durga Puja', date: null, region: 'West Bengal' },
];
export const DEFAULT_SETTINGS: MessageSettings = { daily: { Instagram: 20, X: 20, Facebook: 20 }, gapSeconds: 60, followUpDays: [3, 7, 14] };

function readJson<T>(m: Model, key: string, dflt: T): T {
  const raw = m.getMeta(key);
  if (!raw) return structuredClone(dflt);
  try { return JSON.parse(raw) as T; } catch { return structuredClone(dflt); }
}
export const templatesOf = (m: Model): MessageTemplate[] => readJson(m, 'messages.templates', DEFAULT_TEMPLATES).map(t => {
  // Untouched built-ins follow the current default text; every template has a sender name (built-ins sign as the team).
  const dflt = t.builtIn ? DEFAULT_TEMPLATES.find(d => d.id === t.id) : undefined;
  const text = dflt && t.text === OLD_DEFAULT_TEXT[t.id] ? dflt.text : t.text;
  return { ...t, text, senderName: t.senderName ?? (t.builtIn ? DEFAULT_SENDER : '') };
});
export const festivalsOf = (m: Model): Festival[] => readJson(m, 'messages.festivals', DEFAULT_FESTIVALS).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.name.localeCompare(b.name));
export function settingsOf(m: Model): MessageSettings {
  const s = readJson<Partial<MessageSettings>>(m, 'messages.settings', {});
  return { daily: { ...DEFAULT_SETTINGS.daily, ...s.daily }, gapSeconds: s.gapSeconds ?? DEFAULT_SETTINGS.gapSeconds, followUpDays: DEFAULT_SETTINGS.followUpDays };
}
export const fillTemplate = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);

// ------------------------------------------------------------------ where a message can go
export interface DmTarget { platform: MessagePlatform; url: string; handle: string; dmUrl: string; how: string; chosen: boolean }
function handleOf(url: string, username: string | null): string | null {
  if (username) return username.replace(/^@/, '');
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg[0] === 'profile.php') return u.searchParams.get('id');
    return seg[0] ? seg[0].replace(/^@/, '') : null;
  } catch { return null; }
}
const HOW: Record<MessagePlatform, string> = {
  Instagram: 'The Instagram chat is open in a new tab.',
  X: 'The X profile is open in a new tab: click the envelope (Message) there first.',
  Facebook: 'The Messenger chat is open in a new tab.',
};
/** Only the artist's own verified Instagram, X and Facebook profiles: messages never go to an unverified link. */
export function dmTargets(m: Model, c: ArtistCase): DmTarget[] {
  const out: DmTarget[] = [];
  const seen = new Set<string>();
  for (const v of m.familyItems('verifiedProfiles', c.id)) {
    if (v.verificationStatus !== 'VERIFIED' || !(MESSAGE_PLATFORMS as readonly string[]).includes(v.platform)) continue;
    const platform = v.platform as MessagePlatform;
    const handle = handleOf(v.url, v.username);
    if (!handle || seen.has(`${platform}|${handle.toLowerCase()}`)) continue;
    seen.add(`${platform}|${handle.toLowerCase()}`);
    const dmUrl = platform === 'Instagram' ? `https://ig.me/m/${encodeURIComponent(handle)}` : platform === 'Facebook' ? `https://m.me/${encodeURIComponent(handle)}` : `https://x.com/${encodeURIComponent(handle)}`;
    out.push({ platform, url: v.url, handle, dmUrl, how: HOW[platform], chosen: false });
  }
  // the chosen route first (Claims & routes), then always Instagram, X, Facebook in the same order
  const route = m.byCase('routes', c.id).find(r => r.state === 'Selected')?.sourceUrl ?? null;
  for (const t of out) t.chosen = !!route && t.url === route;
  return out.sort((a, b) => Number(b.chosen) - Number(a.chosen) || MESSAGE_PLATFORMS.indexOf(a.platform) - MESSAGE_PLATFORMS.indexOf(b.platform));
}

// ------------------------------------------------------------------ where each artist stands
/** ended = answered or blocked; exhausted = every follow-up sent and still no answer (a late answer can still be recorded). */
interface Sequence { id: string; kind: MessageKind; startedAt: string; followUps: number; last: OutreachMessage; ended: boolean; exhausted: boolean; outcome: string | null; nextDue: string | null }
export interface OutreachState { messages: OutreachMessage[]; sequence: Sequence | null; blocked: string | null; targets: DmTarget[]; optOut: 'Not interested' | 'Do not disturb' | null }
const BEFORE_CLAIM: LifecycleStage[] = ['Unresearched', 'Researching', 'Waiting for Evidence', 'Route Ready', 'Introduction Pending', 'Contact Attempted'];

export function optOutOf(c: ArtistCase): 'Not interested' | 'Do not disturb' | null {
  if (c.contactPreference === 'Do Not Contact' || c.goongoonaloStatus === 'DO_NOT_CONTACT') return 'Do not disturb';
  if (c.contactPreference === 'Declined') return 'Not interested';
  return null;
}
export function outreachState(m: Model, c: ArtistCase, today: string): OutreachState {
  const messages = notUndone(m.familyItems('messages', c.id)).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const days = settingsOf(m).followUpDays;
  const head = messages.filter(x => x.followUpNo === 0 && (x.kind === 'invite' || x.kind === 'member')).pop();
  let sequence: Sequence | null = null;
  const blocked = outreachBlocked(c, today) ?? (c.goongoonaloStatus === 'DO_NOT_CONTACT' ? `${c.canonicalName} asked not to be contacted.` : null);
  if (head) {
    const seq = messages.filter(x => x.sequenceId === head.id);
    const followUps = seq.filter(x => x.followUpNo > 0).length;
    const answered = seq.find(x => x.outcome);
    const ended = !!answered || !!blocked;
    const exhausted = followUps >= days.length;
    sequence = { id: head.id, kind: head.kind, startedAt: head.sentAt, followUps, last: seq[seq.length - 1], ended, exhausted, outcome: answered?.outcome ?? null, nextDue: ended || exhausted ? null : addDays(head.sentAt, days[followUps]) };
  }
  return { messages, sequence, blocked, targets: dmTargets(m, c), optOut: optOutOf(c) };
}
/** One line for lists: where the messages to this artist stand. */
export function outreachSummary(m: Model, c: ArtistCase, today: string): string | null {
  const s = outreachState(m, c, today);
  if (s.optOut) return `Opted out: ${s.optOut.toLowerCase()}`;
  const q = s.sequence;
  if (!q) return s.messages.length ? `Greeted ${s.messages.length}×` : null;
  if (q.outcome) return `Replied: ${q.outcome}`;
  if (q.exhausted) return `No reply after ${q.followUps} follow-up${q.followUps === 1 ? '' : 's'}`;
  return `${MESSAGE_KIND_INFO[q.kind].label} sent ${q.startedAt.slice(0, 10)} · ${q.followUps ? `${q.followUps} follow-up${q.followUps === 1 ? '' : 's'} · ` : ''}next ${q.nextDue}`;
}

/** Who can get which message now. `null` = can; otherwise why not. */
function blockedFor(m: Model, c: ArtistCase, s: OutreachState, kind: MessageKind | 'answer', today: string, festival?: Festival | null): string | null {
  if (c.mergedIntoId || c.rejectedAt) return 'Not an active artist.';
  if (!isVerified(c)) return 'Verify the artist first.';
  if (!s.targets.length) return 'No verified Instagram, X or Facebook profile: verify the right profile first.';
  if (s.blocked) return s.blocked;
  const g = c.goongoonaloStatus;
  if (g === 'REJECTED') return 'Not a fit for Goongoonalo.';
  switch (kind) {
    case 'answer': return g === 'PENDING' ? null : 'Already answered.';
    case 'invite':
      if (g !== 'NOT_MEMBER') return g === 'PENDING' ? 'Answer first: is the artist on Goongoonalo?' : 'Already on Goongoonalo: send the member message.';
      if (s.messages.some(x => x.kind === 'invite')) return 'The invitation was already sent.';
      return BEFORE_CLAIM.includes(c.lifecycleStage) ? null : `Already further along (${c.lifecycleStage}).`;
    case 'member':
      if (g !== 'GOONGOONALO') return g === 'PENDING' ? 'Answer first: is the artist on Goongoonalo?' : 'Not on Goongoonalo: send the join invitation.';
      return s.messages.some(x => x.kind === 'member') ? 'The member message was already sent.' : null;
    case 'followup':
      if (!s.sequence || s.sequence.ended || !s.sequence.nextDue) return 'No follow-up due.';
      return s.sequence.nextDue <= today ? null : `Next follow-up on ${s.sequence.nextDue}.`;
    case 'greeting':
      if (g !== 'GOONGOONALO') return 'Greetings are only for artists on Goongoonalo.';
      if ((c.greetings ?? 'Unknown') !== 'Yes') return 'The artist has not said yes to greetings.';
      if (!festival) return 'Pick a festival.';
      if (!festival.date) return `Set the date of ${festival.name} first.`;
      return s.messages.some(x => x.kind === 'greeting' && x.festivalId === festival.id) ? `Already greeted for ${festival.name}.` : null;
  }
  return null;
}
function firstSong(m: Model, c: ArtistCase): string {
  const t = m.trackIdsOfCase(c.id).map(id => m.get('tracks', id)).find(Boolean);
  return t?.title ?? 'your songs';
}
function pickTemplate(m: Model, kind: MessageKind, templateId: string | null | undefined, c?: ArtistCase): MessageTemplate | null {
  const list = templatesOf(m).filter(t => t.kind === kind);
  if (templateId && templateId !== 'auto') return list.find(t => t.id === templateId) ?? null;
  // "By language": the artist's language when a template exists for it, else English, else the first one.
  const lang = (c?.language ?? '').toLowerCase();
  return list.find(t => lang && t.language.toLowerCase() === lang) ?? list.find(t => t.language === 'English') ?? list[0] ?? null;
}
function textFor(m: Model, ctx: Ctx, c: ArtistCase, t: MessageTemplate | null, festival?: Festival | null): string {
  if (!t) return '';
  return fillTemplate(t.text, { name: c.canonicalName, song: firstSong(m, c), songs: (songCounts(m).get(c.id) ?? 0).toLocaleString('en-IN'), sender: t.senderName || userName(m, ctx.userId), festival: festival?.name ?? '' });
}
function sentToday(m: Model, ctx: Ctx) {
  const mine = notUndone(m.all('messages')).filter(x => x.sentBy === ctx.userId);
  const today = mine.filter(x => x.sentAt.slice(0, 10) === ctx.today || x.sentAt.slice(0, 10) === ctx.now.slice(0, 10));
  const counts = Object.fromEntries(MESSAGE_PLATFORMS.map(p => [p, today.filter(x => x.platform === p).length])) as Record<MessagePlatform, number>;
  const last = mine.reduce<string | null>((a, x) => (!a || x.sentAt > a ? x.sentAt : a), null);
  return { counts, last };
}
function usage(m: Model, ctx: Ctx) {
  const st = settingsOf(m);
  const { counts, last } = sentToday(m, ctx);
  const nextAt = last ? new Date(Date.parse(last) + st.gapSeconds * 1000).toISOString() : null;
  return { counts, limits: st.daily, gapSeconds: st.gapSeconds, nextAt: nextAt && nextAt > ctx.now ? nextAt : null };
}
const SENDABLE: (MessageKind | 'answer')[] = ['answer', 'invite', 'member', 'followup', 'greeting'];
/** Messages of one step that went out (undone ones are not counted: those artists are pending again). */
function sentOf(m: Model, kind: MessageKind, festivalId?: string | null) {
  return notUndone(m.all('messages')).filter(x => (kind === 'followup' ? x.followUpNo > 0 : x.kind === kind && x.followUpNo === 0) && (kind !== 'greeting' || !festivalId || x.festivalId === festivalId));
}
/** Members who could get greetings once they say yes (not asked yet, or answered something else). */
function needYes(m: Model, c: ArtistCase, s: OutreachState): boolean {
  return !c.mergedIntoId && !c.rejectedAt && isVerified(c) && c.goongoonaloStatus === 'GOONGOONALO' && (c.greetings ?? 'Unknown') === 'Unknown' && s.targets.length > 0 && !s.blocked;
}

// ------------------------------------------------------------------ reads
export const messageViews = {
  messagesOverview(m: Model, ctx: Ctx, p: { top?: boolean | string; festivalId?: string } = {}) {
    const top = p.top !== false && p.top !== 'false';
    const ranks = artistRanks(m);
    const festivals = festivalsOf(m);
    const festival = festivals.find(f => f.id === p.festivalId) ?? festivals.find(f => f.date && f.date >= ctx.today) ?? null;
    const counts = Object.fromEntries(SENDABLE.map(k => [k, 0])) as Record<MessageKind | 'answer', number>;
    let waiting = 0, optedOut = 0, greetingsNeedYes = 0;
    const inTop = (id: string) => !top || (ranks.get(m.canonical(id)) ?? Infinity) <= TOP_ARTISTS;
    for (const c of m.data.cases.values()) {
      if (c.mergedIntoId || !isVerified(c)) continue;
      const s = outreachState(m, c, ctx.today);
      if (s.optOut) optedOut++;
      if (s.sequence && !s.sequence.ended) waiting++;
      if (!inTop(c.id)) continue;
      for (const k of SENDABLE) if (!blockedFor(m, c, s, k, ctx.today, festival)) counts[k]++;
      if (needYes(m, c, s)) greetingsNeedYes++;
    }
    const sent = Object.fromEntries(MESSAGE_KINDS.map(k => [k, sentOf(m, k, festival?.id).filter(x => inTop(x.caseId)).length])) as Record<MessageKind, number>;
    return {
      counts, sent, greetingsNeedYes, waiting, optedOut, top, topSize: TOP_ARTISTS, festival, festivals, templates: templatesOf(m), placeholders: PLACEHOLDERS, samples: SAMPLES, defaultSender: DEFAULT_SENDER,
      kinds: MESSAGE_KIND_INFO, usage: usage(m, ctx), settings: settingsOf(m), followUpDays: settingsOf(m).followUpDays,
    };
  },

  /** Artists who can get this kind of message now, best-ranked first, each with the message written for them. */
  messageQueue(m: Model, ctx: Ctx, p: { kind: MessageKind | 'answer'; top?: boolean | string; templateId?: string; festivalId?: string; caseId?: string; page?: number; pageSize?: number }) {
    const kind = p.kind;
    if (!SENDABLE.includes(kind)) throw rule('Pick what to send.');
    const top = p.top !== false && p.top !== 'false';
    const ranks = artistRanks(m);
    const festival = kind === 'greeting' ? festivalsOf(m).find(f => f.id === p.festivalId) ?? null : null;
    const list: { c: ArtistCase; s: OutreachState }[] = [];
    // One artist (the Claims tab sends the invitation from there), or everyone who can get this message.
    const pool = p.caseId ? [m.get('cases', m.canonical(p.caseId))].filter((c): c is ArtistCase => !!c) : [...m.data.cases.values()];
    for (const c of pool) {
      if (c.mergedIntoId || !isVerified(c)) continue;
      if (top && !p.caseId && !((ranks.get(c.id) ?? Infinity) <= TOP_ARTISTS)) continue;
      const s = outreachState(m, c, ctx.today);
      if (!blockedFor(m, c, s, kind, ctx.today, festival)) list.push({ c, s });
    }
    const rank = (c: ArtistCase) => ranks.get(c.id) ?? Infinity;
    list.sort((a, b) => kind === 'followup' ? (a.s.sequence!.nextDue ?? '').localeCompare(b.s.sequence!.nextDue ?? '') || rank(a.c) - rank(b.c) : rank(a.c) - rank(b.c) || a.c.canonicalName.localeCompare(b.c.canonicalName));
    const pageSize = Math.min(50, Number(p.pageSize) || 20), page = Math.max(1, Number(p.page) || 1);
    const songs = songCounts(m);
    const rows = list.slice((page - 1) * pageSize, page * pageSize).map(({ c, s }) => {
      const t = kind === 'answer' ? null : pickTemplate(m, kind, p.templateId, c);
      return {
        caseId: c.id, name: c.canonicalName, rank: ranks.get(c.id) ?? null, songs: songs.get(c.id) ?? 0, language: c.language, goongoonaloStatus: c.goongoonaloStatus,
        targets: s.targets, templateId: t?.id ?? null, text: textFor(m, ctx, c, t, festival),
        followUpNo: kind === 'followup' ? s.sequence!.followUps + 1 : 0, due: kind === 'followup' ? s.sequence!.nextDue : null,
        lastPlatform: s.sequence?.last.platform ?? null, startedAt: s.sequence?.startedAt ?? null,
      };
    });
    // Greetings: members who have not said yes yet are listed too, so a person can record their answer
    const waitingForYes = kind !== 'greeting' || p.caseId ? [] : [...m.data.cases.values()]
      .filter(c => (!top || (ranks.get(c.id) ?? Infinity) <= TOP_ARTISTS) && needYes(m, c, outreachState(m, c, ctx.today)))
      .sort((a, b) => rank(a) - rank(b) || a.canonicalName.localeCompare(b.canonicalName)).slice(0, 100)
      .map(c => {
        const s = outreachState(m, c, ctx.today);
        const answered = [...s.messages].reverse().find(x => x.outcome);
        return { caseId: c.id, name: c.canonicalName, rank: ranks.get(c.id) ?? null, targets: s.targets, lastAnswer: answered?.outcome ?? null, lastMessageAt: s.messages.length ? s.messages[s.messages.length - 1].sentAt : null };
      });
    return { kind, rows, total: list.length, page, pageSize, festival, usage: usage(m, ctx), needYes: waitingForYes };
  },

  /** Messages of one step that went out, newest first, with the artist's answer so far. */
  messageSent(m: Model, ctx: Ctx, p: { kind: MessageKind; top?: boolean | string; festivalId?: string; page?: number; pageSize?: number }) {
    if (!(MESSAGE_KINDS as readonly string[]).includes(p.kind)) throw rule('Pick what was sent.');
    const top = p.top !== false && p.top !== 'false';
    const ranks = artistRanks(m);
    const list = sentOf(m, p.kind, p.festivalId).filter(x => !top || (ranks.get(m.canonical(x.caseId)) ?? Infinity) <= TOP_ARTISTS).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    const all = notUndone(m.all('messages'));
    const pageSize = Math.min(50, Number(p.pageSize) || 20), page = Math.max(1, Number(p.page) || 1);
    const rows = list.slice((page - 1) * pageSize, page * pageSize).map(x => {
      const c = m.get('cases', m.canonical(x.caseId));
      const answer = p.kind === 'greeting' ? null : all.find(y => y.sequenceId === x.sequenceId && y.outcome)?.outcome ?? null;
      const seq = c && p.kind !== 'greeting' ? outreachState(m, c, ctx.today).sequence : null;
      const state = p.kind === 'greeting' ? 'Sent' : answer ? `Answer: ${answer}` : seq && seq.id === x.sequenceId && seq.nextDue ? `Waiting for reply · follow-up ${seq.nextDue}` : 'Waiting for reply';
      return {
        id: x.id, caseId: x.caseId, name: c?.canonicalName ?? x.caseId, rank: ranks.get(m.canonical(x.caseId)) ?? null, kind: x.kind, followUpNo: x.followUpNo, platform: x.platform, handle: x.handle, profileUrl: x.profileUrl,
        text: x.text, sentAt: x.sentAt, sentByName: userName(m, x.sentBy), answer, state,
      };
    });
    return { rows, total: list.length, page, pageSize };
  },

  /** Messages waiting for an answer: record what the artist said here (it stops the follow-ups). */
  messageWaiting(m: Model, ctx: Ctx, p: { page?: number; pageSize?: number } = {}) {
    const out: { caseId: string; name: string; kind: MessageKind; startedAt: string; followUps: number; exhausted: boolean; nextDue: string | null; platform: MessagePlatform; handle: string; profileUrl: string; chatUrl: string; lastText: string; goongoonaloStatus: string; greetings: GreetingsConsent }[] = [];
    for (const c of m.data.cases.values()) {
      if (c.mergedIntoId) continue;
      const s = outreachState(m, c, ctx.today);
      const q = s.sequence;
      if (!q || q.ended) continue;
      out.push({ caseId: c.id, name: c.canonicalName, kind: q.kind, startedAt: q.startedAt, followUps: q.followUps, exhausted: q.exhausted, nextDue: q.nextDue, platform: q.last.platform, handle: q.last.handle, profileUrl: q.last.profileUrl, chatUrl: s.targets.find(t => t.platform === q.last.platform && t.handle === q.last.handle)?.dmUrl ?? q.last.profileUrl, lastText: q.last.text, goongoonaloStatus: c.goongoonaloStatus, greetings: c.greetings ?? 'Unknown' });
    }
    out.sort((a, b) => Number(a.exhausted) - Number(b.exhausted) || (a.nextDue ?? '').localeCompare(b.nextDue ?? '') || a.name.localeCompare(b.name));
    const pageSize = Math.min(50, Number(p.pageSize) || 20), page = Math.max(1, Number(p.page) || 1);
    return { rows: out.slice((page - 1) * pageSize, page * pageSize), total: out.length, page, pageSize };
  },

  /** Messages sent lately, newest first (the Send tab shows them under the list, the newest highlighted). */
  messageHistory(m: Model, _ctx: Ctx, p: { limit?: number } = {}) {
    const list = m.all('messages').sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, Math.min(100, Number(p.limit) || 20));
    return list.map(x => ({
      id: x.id, caseId: x.caseId, name: m.get('cases', x.caseId)?.canonicalName ?? x.caseId, kind: x.kind, followUpNo: x.followUpNo, platform: x.platform, handle: x.handle, profileUrl: x.profileUrl,
      text: x.text, sentAt: x.sentAt, sentByName: userName(m, x.sentBy), outcome: x.outcome, undoneAt: x.undoneAt ?? null,
    }));
  },

  /** Every message sent to one artist (dossier). */
  caseMessages(m: Model, ctx: Ctx, p: { id: string }) {
    const c = getCase(m, p.id);
    const s = outreachState(m, c, ctx.today);
    return { summary: outreachSummary(m, c, ctx.today), optOut: s.optOut, greetings: c.greetings ?? 'Unknown', messages: s.messages.slice().reverse().map(x => ({ ...x, sentByName: userName(m, x.sentBy), outcomeByName: x.outcomeBy ? userName(m, x.outcomeBy) : null })) };
  },
};

// ------------------------------------------------------------------ writes
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => { if (!list.includes(v as T)) throw rule(`Pick a valid ${what}.`); return v as T; };
const req = (v: unknown, what: string): string => { const s = String(v ?? '').trim(); if (!s) throw rule(`${what} is required.`); return s; };

/** Messages commands. `all` is the full command registry (contact attempts and contact preferences live there). */
export function messageCommandsWith(all: Record<string, Command>): Record<string, Command> {
  return {
    /** A person sent the message in the opened chat: record it, count it against the limits and plan the follow-up. */
    sendMessage(m, ctx, p) {
      const c = getCase(m, p.caseId);
      const kind = oneOf(p.kind, MESSAGE_KINDS, 'message type');
      const platform = oneOf(p.platform, MESSAGE_PLATFORMS, 'platform');
      const text = req(p.text, 'The message');
      const s = outreachState(m, c, ctx.today);
      const festival = kind === 'greeting' ? festivalsOf(m).find(f => f.id === p.festivalId) ?? null : null;
      const why = blockedFor(m, c, s, kind, ctx.today, festival);
      if (why) throw rule(`${c.canonicalName}: ${why}`);
      const target = s.targets.find(t => t.platform === platform);
      if (!target) throw rule(`${c.canonicalName} has no verified ${platform} profile. Messages only go to verified profiles.`);
      const st = settingsOf(m);
      const u = sentToday(m, ctx);
      if (u.counts[platform] >= st.daily[platform]) throw rule(`Today’s ${platform} limit (${st.daily[platform]}) is reached. It protects the account from being flagged; carry on tomorrow.`);
      if (u.last && Date.parse(ctx.now) - Date.parse(u.last) < st.gapSeconds * 1000) {
        const wait = Math.ceil((st.gapSeconds * 1000 - (Date.parse(ctx.now) - Date.parse(u.last))) / 1000);
        throw rule(`Wait ${wait} s before the next message (${st.gapSeconds} s between messages keeps the account safe).`);
      }
      const followUpNo = kind === 'followup' ? s.sequence!.followUps + 1 : 0;
      const id = m.nextId('MS', 5);
      const sequenceId = kind === 'followup' ? s.sequence!.id : id;
      const startedAt = kind === 'followup' ? s.sequence!.startedAt : ctx.now;
      const days = st.followUpDays;
      const seqKind = kind === 'followup' ? s.sequence!.kind : kind;
      const nextDue = seqKind === 'greeting' || followUpNo >= days.length ? null : addDays(startedAt, days[followUpNo]);
      const label = MESSAGE_KIND_INFO[kind].label + (followUpNo ? ` #${followUpNo}` : '') + (festival ? ` (${festival.name})` : '');
      // Sent on a profile that is also a route (chosen in Claims & routes): the attempt belongs to that route.
      const route = m.byCase('routes', c.id).find(r => (r.state === 'Selected' || r.state === 'Verified') && r.sourceUrl === target.url);
      const a = m.insert('attempts', {
        id: m.nextId('CA', 4), caseId: c.id, routeId: route?.id ?? null, date: ctx.now, channel: platform, recipient: `@${target.handle}`, message: text, result: 'No Response',
        evidence: `${label} sent from Messages to ${target.url}`, nextAction: nextDue ? `Follow-up #${followUpNo + 1} on ${nextDue}` : seqKind === 'greeting' ? 'None (greeting)' : 'Wait for a reply (no more follow-ups)',
        nextActionDate: nextDue, ownerId: ctx.userId,
      });
      m.insert('messages', {
        id, caseId: c.id, kind, sequenceId, followUpNo, templateId: clean(p.templateId) || null, festivalId: festival?.id ?? null, platform, profileUrl: target.url, handle: target.handle,
        text, sentAt: ctx.now, sentBy: ctx.userId, attemptId: a.id, outcome: null, outcomeAt: null, outcomeBy: null,
      });
      audit(m, ctx, { caseId: c.id, entity: 'Message', entityId: id, action: 'Message sent', to: `${label} on ${platform} @${target.handle}`, evidence: text.slice(0, 300), result: `Contact attempt ${a.id}`, next: nextDue ? `Follow-up on ${nextDue}` : null });
      // An invitation to an artist not on Goongoonalo is outreach: the case waits for the reply in Contact Attempted.
      if (seqKind === 'invite' && ['Unresearched', 'Researching', 'Waiting for Evidence', 'Route Ready'].includes(c.lifecycleStage)) setStage(m, ctx, c, 'Contact Attempted', `${label} sent on ${platform}; no reply yet`);
      if (seqKind !== 'greeting') {
        closeTasks(m, ctx, c.id, OUTREACH_KINDS, `${label} sent (${id})`);
        const fresh = m.get('cases', c.id)!;
        if (nextDue) openTask(m, ctx, fresh, { kind: 'Follow-up', step: `Follow-up #${followUpNo + 1} on ${platform} (Messages)`, why: `No reply to ${label.toLowerCase()} yet`, trigger: `Message ${id}`, dueDate: nextDue, status: 'Waiting', channel: platform, recipient: `@${target.handle}` });
        else openTask(m, ctx, fresh, { kind: 'Follow-up', step: `No reply after ${followUpNo} follow-ups: try another way or move to Waiting`, why: 'Messages: every follow-up was sent', trigger: `Message ${id}`, dueDate: addDays(ctx.today, 7) });
      }
      computePriority(m, m.get('cases', c.id)!, ctx.today);
      syncNextAction(m, c.id);
      return { message: `${label} to ${c.canonicalName} recorded (contact attempt ${a.id}).${nextDue ? ` Follow-up on ${nextDue} unless they reply.` : ''}`, caseId: c.id, id };
    },

    /** What the artist answered. Any answer stops the follow-ups; "not interested" and "do not disturb" opt the artist out. */
    recordReply(m, ctx, p) {
      const c = getCase(m, p.caseId);
      const outcome = oneOf<ReplyOutcome>(p.outcome, REPLY_OUTCOMES, 'answer');
      const note = clean(p.note);
      const msgs = notUndone(m.familyItems('messages', c.id)).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
      const last = msgs[msgs.length - 1];
      if (!last) throw rule(`No message was sent to ${c.canonicalName} yet.`);
      m.update('messages', last.id, { outcome, outcomeAt: ctx.now, outcomeBy: ctx.userId });
      audit(m, ctx, { caseId: c.id, entity: 'Message', entityId: last.id, action: 'Reply recorded', to: outcome, reason: note || null, evidence: `${last.platform} @${last.handle}` });
      closeTasks(m, ctx, c.id, ['Follow-up'], `Reply: ${outcome}`);
      const recipient = `@${last.handle}`;
      const attempt = (result: AttemptResult, message: string) => m.insert('attempts', {
        id: m.nextId('CA', 4), caseId: c.id, routeId: null, date: ctx.now, channel: last.platform, recipient, message: note || message, result, evidence: `Reply to message ${last.id}`,
        nextAction: result === 'Interested' || result === 'Conversation Confirmed' ? 'Continue the conversation' : 'None', nextActionDate: null, ownerId: ctx.userId,
      });
      const contactStages: LifecycleStage[] = ['Researching', 'Route Ready', 'Introduction Pending', 'Contact Attempted', 'Contact Confirmed'];
      let message = `${c.canonicalName}: ${outcome.toLowerCase()} recorded. Follow-ups stopped.`;
      switch (outcome) {
        case 'Interested': case 'Replied': {
          const result: AttemptResult = outcome === 'Interested' ? 'Interested' : 'Conversation Confirmed';
          // Not on Goongoonalo yet: a real conversation moves the artist to Contact Confirmed and the claim invitation is next.
          if (c.goongoonaloStatus !== 'GOONGOONALO' && contactStages.includes(c.lifecycleStage)) {
            all.recordContactAttempt(m, ctx, { caseId: c.id, routeId: null, channel: last.platform, recipient, message: note || `Replied on ${last.platform}`, result, evidence: `Reply to message ${last.id}`, nextAction: 'Send the claim invitation' });
            message = `${c.canonicalName} replied. Next: send the claim invitation (Claims tab).`;
          } else attempt(result, `Replied on ${last.platform}`);
          break;
        }
        case 'Not interested':
          attempt('Declined', 'Not interested');
          all.setContactPreference(m, ctx, { caseId: c.id, preference: 'Declined', reason: note || `Replied “not interested” on ${last.platform}` });
          message = `${c.canonicalName} opted out (not interested). No more messages; shown as opted out in Verified Artists.`;
          break;
        case 'Do not disturb':
          attempt('Do Not Contact', 'Do not disturb');
          all.setContactPreference(m, ctx, { caseId: c.id, preference: 'Do Not Contact', reason: note || `Asked not to be disturbed on ${last.platform}` });
          message = `${c.canonicalName} opted out (do not disturb). Nobody can message them again; shown in Verified Artists.`;
          break;
        case 'Could not deliver': {
          attempt('Bounce', `Message could not be delivered on ${last.platform}`);
          // The profile route did not work: mark it, with the reason, so nobody tries it again.
          const sentOn = last.attemptId ? m.get('attempts', last.attemptId)?.routeId : null;
          const r = sentOn ? m.get('routes', sentOn) : null;
          if (r && r.state !== 'Rejected' && r.state !== 'Deleted') {
            m.update('routes', r.id, { state: 'Rejected', rejectionReason: `Could not deliver on ${last.platform}`, lastChecked: ctx.now });
            audit(m, ctx, { caseId: c.id, entity: 'Route', entityId: r.id, action: 'Route rejected', field: 'state', from: r.state, to: 'Rejected', reason: `Could not deliver on ${last.platform}` });
          }
          const cur = m.get('cases', c.id)!;
          if (cur.lifecycleStage === 'Contact Attempted') {
            setStage(m, ctx, cur, 'Researching', `Message could not be delivered on ${last.platform}`);
            openTask(m, ctx, m.get('cases', c.id)!, { kind: 'Research', step: 'Message did not arrive: try another verified profile or a route', why: `Could not deliver on ${last.platform}`, trigger: `Message ${last.id}` });
          }
          break;
        }
        case 'Yes to greetings':
          attempt('Conversation Confirmed', 'Said yes to festival greetings');
          setGreetings(m, ctx, c, 'Yes', note || `Said yes on ${last.platform}`);
          message = `${c.canonicalName} will get festival greetings.`;
          break;
        case 'Stop greetings':
          setGreetings(m, ctx, c, 'No', note || `Replied STOP on ${last.platform}`);
          message = `${c.canonicalName} gets no more greetings.`;
          break;
      }
      computePriority(m, m.get('cases', c.id)!, ctx.today);
      syncNextAction(m, c.id);
      return { message, caseId: c.id };
    },

    setGreetings(m, ctx, p) {
      const c = getCase(m, p.caseId);
      const consent = oneOf<GreetingsConsent>(p.consent, GREETINGS_CONSENTS, 'greetings choice');
      setGreetings(m, ctx, c, consent, clean(p.reason) || 'Set by hand');
      return { message: `${c.canonicalName}: festival greetings ${consent === 'Yes' ? 'on' : consent === 'No' ? 'off' : 'not asked yet'}.`, caseId: c.id };
    },

    saveTemplate(m, ctx, p) {
      const list = templatesOf(m);
      const name = req(p.name, 'A name');
      const text = req(p.text, 'The message text');
      const language = clean(p.language) || 'English';
      const senderName = clean(p.senderName);
      if (text.length > 1000) throw rule('Keep the message under 1,000 characters (long direct messages look like spam).');
      const cur = p.id ? list.find(t => t.id === p.id) : null;
      if (p.id && !cur) throw rule('Template not found.');
      const kind = cur?.kind ?? oneOf(p.kind, MESSAGE_KINDS, 'message type');
      const problem = templateProblem(kind, text);
      if (problem) throw rule(problem);
      if (text.includes('{sender}') && !senderName) throw rule('The message is signed with {sender}: fill in the sender name (e.g. Team Goongoonalo).');
      const t: MessageTemplate = cur ? { ...cur, name, language, text, senderName, updatedAt: ctx.now, updatedBy: ctx.userId } : { id: m.nextId('TM', 3), name, kind, language, text, senderName, builtIn: false, updatedAt: ctx.now, updatedBy: ctx.userId };
      m.setMeta('messages.templates', JSON.stringify(cur ? list.map(x => (x.id === t.id ? t : x)) : [...list, t]));
      audit(m, ctx, { caseId: null, entity: 'MessageTemplate', entityId: t.id, action: cur ? 'Message template changed' : 'Message template added', to: `${t.name} (${MESSAGE_KIND_INFO[t.kind].label}, ${t.language})`, evidence: text.slice(0, 300) });
      return { message: `Template “${t.name}” saved.`, id: t.id };
    },
    deleteTemplate(m, ctx, p) {
      const list = templatesOf(m);
      const t = list.find(x => x.id === p.id);
      if (!t) throw rule('Template not found.');
      if (t.builtIn) throw rule('Built-in templates cannot be deleted. Edit the text instead.');
      m.setMeta('messages.templates', JSON.stringify(list.filter(x => x.id !== t.id)));
      audit(m, ctx, { caseId: null, entity: 'MessageTemplate', entityId: t.id, action: 'Message template deleted', to: t.name });
      return { message: `Template “${t.name}” deleted.` };
    },

    saveFestival(m, ctx, p) {
      requirePerm(m, ctx, 'messageSettings');
      const list = festivalsOf(m);
      const name = req(p.name, 'The festival name');
      const date = clean(p.date) || null;
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw rule('Give the date as YYYY-MM-DD.');
      const cur = p.id ? list.find(f => f.id === p.id) : null;
      const f: Festival = { id: cur?.id ?? m.nextId('FE', 3), name, date, region: clean(p.region) || 'All India' };
      m.setMeta('messages.festivals', JSON.stringify(cur ? list.map(x => (x.id === f.id ? f : x)) : [...list, f]));
      audit(m, ctx, { caseId: null, entity: 'Festival', entityId: f.id, action: cur ? 'Festival changed' : 'Festival added', to: `${f.name} ${f.date ?? '(date to set)'}` });
      return { message: `${f.name} saved.`, id: f.id };
    },
    deleteFestival(m, ctx, p) {
      requirePerm(m, ctx, 'messageSettings');
      const list = festivalsOf(m);
      const f = list.find(x => x.id === p.id);
      if (!f) throw rule('Festival not found.');
      m.setMeta('messages.festivals', JSON.stringify(list.filter(x => x.id !== f.id)));
      audit(m, ctx, { caseId: null, entity: 'Festival', entityId: f.id, action: 'Festival deleted', to: f.name });
      return { message: `${f.name} deleted.` };
    },

    saveMessageSettings(m, ctx, p) {
      requirePerm(m, ctx, 'messageSettings');
      const num = (v: unknown, what: string, lo: number, hi: number) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < lo || n > hi) throw rule(`${what}: between ${lo} and ${hi}.`); return n; };
      const s = { daily: Object.fromEntries(MESSAGE_PLATFORMS.map(pl => [pl, num(p.daily?.[pl] ?? settingsOf(m).daily[pl], `${pl} messages per day`, 1, 100)])), gapSeconds: num(p.gapSeconds ?? settingsOf(m).gapSeconds, 'Seconds between messages', 10, 3600) };
      m.setMeta('messages.settings', JSON.stringify(s));
      audit(m, ctx, { caseId: null, entity: 'Settings', entityId: 'messages', action: 'Message limits changed', to: `${MESSAGE_PLATFORMS.map(pl => `${pl} ${s.daily[pl]}/day`).join(', ')}, ${s.gapSeconds} s apart` });
      return { message: 'Message limits saved.' };
    },
  };
}

function setGreetings(m: Model, ctx: Ctx, c: ArtistCase, consent: GreetingsConsent, reason: string) {
  const from = c.greetings ?? 'Unknown';
  if (from === consent) return;
  m.update('cases', c.id, { greetings: consent, updatedAt: ctx.now });
  audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Festival greetings changed', field: 'greetings', from, to: consent, reason });
}
