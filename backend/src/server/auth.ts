// Accounts and sign-in. Passwords are hashed with scrypt (passwords.ts); a session is a random token in an httpOnly
// cookie and only its SHA-256 is stored. The person behind an account is a workspace user (name + role) kept by the
// domain engine, so every write is audited under the signed-in person.
//
// - The first account becomes the only System Owner, and needs the owner setup code (OWNER_SETUP_TOKEN, or the code the
//   server prints at start-up), so nobody else can claim a fresh installation.
// - Later sign-ups wait for an Admin's approval before they can sign in; sign-ups are rate-limited, have a hidden bot
//   trap, and an optional Cloudflare Turnstile check. The System Owner and Admins can also add people directly.
// - Optional two-step sign-in with an authenticator app (totp.ts), with one-time recovery codes.
// - Sessions end after 30 days, or after 7 days without use. People can be switched off (and back on).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { PEOPLE_ROLES, type Role } from '../domain/constants';
import { RuleError, type Engine } from '../domain/engine';
import { audit, can, visibleRole } from '../domain/ops';
import type { User } from '../domain/types';
import { MIN_PASSWORD, checkPassword, hashPassword, needsRehash, passwordProblem } from './passwords';
import { base32, newRecoveryCodes, newTotpSecret, openSecret, otpauthUri, recoveryHash, sealSecret, verifyTotp } from './totp';

export { checkPassword, hashPassword } from './passwords';

export type AccountStatus = 'active' | 'pending' | 'disabled';
export interface Account {
  userId: string; email: string; passwordHash: string; createdAt: string; lastLoginAt: string | null;
  status: AccountStatus | string; name: string | null; mfaSecret: string | null; mfaRecovery: string | null; mfaLastStep: number | null;
}
export interface Session { id: string; userId: string; createdAt: string; expiresAt: string; userAgent: string | null; lastSeenAt: string | null }
type NewAccount = Pick<Account, 'userId' | 'email' | 'passwordHash' | 'createdAt' | 'lastLoginAt'> & Partial<Account>;

export interface AuthStore {
  accountCount(): Promise<number>;
  accountByEmail(email: string): Promise<Account | null>;
  accountByUser(userId: string): Promise<Account | null>;
  accountsByStatus(status: AccountStatus): Promise<Account[]>;
  createAccount(a: NewAccount): Promise<void>;
  updateAccount(userId: string, patch: Partial<Omit<Account, 'userId'>>): Promise<void>;
  deleteAccount(userId: string): Promise<void>;
  createSession(s: Session): Promise<void>;
  session(id: string): Promise<Session | null>;
  touchSession(id: string, at: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsOf(userId: string, except?: string): Promise<void>;
  deleteExpired(now: string, idleBefore: string): Promise<void>;
}

export class PrismaAuthStore implements AuthStore {
  constructor(private db: PrismaClient) {}
  accountCount() { return this.db.authAccount.count(); }
  accountByEmail(email: string) { return this.db.authAccount.findUnique({ where: { email } }); }
  accountByUser(userId: string) { return this.db.authAccount.findUnique({ where: { userId } }); }
  accountsByStatus(status: AccountStatus) { return this.db.authAccount.findMany({ where: { status }, orderBy: { createdAt: 'asc' } }); }
  async createAccount(a: NewAccount) { await this.db.authAccount.create({ data: a }); }
  async updateAccount(userId: string, patch: Partial<Omit<Account, 'userId'>>) { await this.db.authAccount.update({ where: { userId }, data: patch }); }
  async deleteAccount(userId: string) { await this.db.authAccount.deleteMany({ where: { userId } }); }
  async createSession(s: Session) { await this.db.authSession.create({ data: s }); }
  session(id: string) { return this.db.authSession.findUnique({ where: { id } }); }
  async touchSession(id: string, at: string) { await this.db.authSession.updateMany({ where: { id }, data: { lastSeenAt: at } }); }
  async deleteSession(id: string) { await this.db.authSession.deleteMany({ where: { id } }); }
  async deleteSessionsOf(userId: string, except?: string) { await this.db.authSession.deleteMany({ where: { userId, ...(except ? { id: { not: except } } : {}) } }); }
  async deleteExpired(now: string, idleBefore: string) {
    await this.db.authSession.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { lastSeenAt: { lt: idleBefore } }, { lastSeenAt: null, createdAt: { lt: idleBefore } }] } });
  }
}

/** Accounts kept in memory (tests). */
export class MemoryAuthStore implements AuthStore {
  accounts = new Map<string, Account>();
  sessions = new Map<string, Session>();
  async accountCount() { return this.accounts.size; }
  async accountByEmail(email: string) { return [...this.accounts.values()].find(a => a.email === email) ?? null; }
  async accountByUser(userId: string) { return this.accounts.get(userId) ?? null; }
  async accountsByStatus(status: AccountStatus) { return [...this.accounts.values()].filter(a => a.status === status); }
  async createAccount(a: NewAccount) {
    if (await this.accountByEmail(a.email)) throw new Error('Unique constraint failed on the fields: (`email`)');
    this.accounts.set(a.userId, { status: 'active', name: null, mfaSecret: null, mfaRecovery: null, mfaLastStep: null, ...a });
  }
  async updateAccount(userId: string, patch: Partial<Account>) { const a = this.accounts.get(userId); if (a) Object.assign(a, patch); }
  async deleteAccount(userId: string) { this.accounts.delete(userId); }
  async createSession(s: Session) { this.sessions.set(s.id, { ...s }); }
  async session(id: string) { return this.sessions.get(id) ?? null; }
  async touchSession(id: string, at: string) { const s = this.sessions.get(id); if (s) s.lastSeenAt = at; }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async deleteSessionsOf(userId: string, except?: string) { for (const [id, s] of this.sessions) if (s.userId === userId && id !== except) this.sessions.delete(id); }
  async deleteExpired(now: string, idleBefore: string) { for (const [id, s] of this.sessions) if (s.expiresAt < now || (s.lastSeenAt ?? s.createdAt) < idleBefore) this.sessions.delete(id); }
}

/** Used when an email is unknown, so a wrong email takes as long as a wrong password. */
let decoy: Promise<string> | null = null;

/** Counts events per key in a time window (sign-in failures, sign-ups, people added). */
class RateWindow {
  private hits = new Map<string, { count: number; since: number }>();
  constructor(private windowMs: number) {}
  count(key: string) { const h = this.hits.get(key); return h && Date.now() - h.since < this.windowMs ? h.count : 0; }
  add(key: string) {
    const h = this.hits.get(key);
    const cur = h && Date.now() - h.since < this.windowMs ? h : { count: 0, since: Date.now() };
    this.hits.set(key, { ...cur, count: cur.count + 1 });
    if (this.hits.size > 50_000) this.prune();
  }
  clear(key: string) { this.hits.delete(key); }
  prune() { for (const [k, h] of this.hits) if (Date.now() - h.since >= this.windowMs) this.hits.delete(k); }
}

// --------------------------------------------------------------------------- the auth service
export const SESSION_COOKIE = 'af_session';
const SESSION_DAYS = 30;
const IDLE_DAYS = 7;
const TOUCH_EVERY_MS = 60 * 60_000;
const DAY = 86_400_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const LIMITS = {
  loginPerAddressAndEmail: 10,   // wrong passwords per 15 minutes from one address for one email
  loginPerEmail: 30,             // … and for one email from anywhere (spread-out guessing)
  signupPerAddress: 10,          // sign-up attempts per hour from one address
  signupTotal: 50,               // sign-ups per hour in total
  addPerPerson: 30,              // people one Admin can add per hour
  codeTries: 5,                  // wrong two-step codes per sign-in
};

export interface AuthOptions {
  /** After the first account (the System Owner), may people ask for an account (an Admin approves)? Default: yes. */
  allowSignup?: boolean;
  /** Mark the cookie Secure (only sent over HTTPS). Turn on behind HTTPS. */
  secureCookie?: boolean;
  /** Needed to create the first account. When not set, a random code is made and printed in the server log. */
  ownerSetupCode?: string;
  /** Cloudflare Turnstile ("are you human") on sign-up, when both keys are set. */
  turnstile?: { siteKey: string; secretKey: string } | null;
  /** Refuse passwords found in known data breaches (Have I Been Pwned, k-anonymity). Default: yes. */
  breachCheck?: boolean;
  /** Encrypts two-step sign-in secrets in the database. */
  secret?: string;
  /** Tests: network access (Turnstile, breach check). */
  fetchFn?: typeof fetch;
}
export interface Me extends User { email: string; mfa: boolean }
export interface Person extends User { email: string | null; status: string; mfa: boolean; lastLoginAt: string | null }
export type LoginResult = { token: string; me: Me } | { mfa: true; ticket: string };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const bad = (msg: string, status?: number) => Object.assign(new RuleError(msg), status ? { status } : {});
const same = (a: string, b: string) => { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return timingSafeEqual(x, y); };

export class Auth {
  private cache = new Map<string, { userId: string; expiresAt: string; lastSeenAt: string }>();
  private loginFails = new RateWindow(15 * 60_000);
  private signups = new RateWindow(60 * 60_000);
  private added = new RateWindow(60 * 60_000);
  private tickets = new Map<string, { userId: string; until: number; tries: number }>();
  private pendingMfa = new Map<string, { secret: string; until: number }>();
  private chain: Promise<unknown> = Promise.resolve();
  private setupCode: string | null = null;
  constructor(private store: AuthStore, private engine: Engine, private opts: AuthOptions = {}) {}

  get allowSignup() { return this.opts.allowSignup !== false; }
  private get rules() { return { breachCheck: this.opts.breachCheck !== false, fetchFn: this.opts.fetchFn }; }
  private hasOwner() { return this.engine.m.all('users').some(u => u.role === 'System Owner'); }
  /** The code that creates the first account (only while the workspace has no System Owner). */
  get ownerSetupCode(): string {
    return (this.setupCode ??= this.opts.ownerSetupCode?.trim() || base32(randomBytes(8)).slice(0, 12).replace(/(.{4})(?=.)/g, '$1-'));
  }
  /** After the workspace has loaded: print the setup code when nobody owns the workspace yet. */
  async init() {
    if (!this.hasOwner() && (await this.store.accountCount()) === 0) {
      const code = this.ownerSetupCode;
      console.log(this.opts.ownerSetupCode ? 'No System Owner yet: the first sign-up needs OWNER_SETUP_TOKEN from .env.' : `No System Owner yet. Owner setup code (needed once, for the first sign-up): ${code}`);
    }
    if (!this.opts.secret) console.warn('AUTH_SECRET is not set: two-step sign-in secrets are stored unencrypted. Set AUTH_SECRET in .env.');
  }

  /** What the sign-in page needs. */
  async state(token: string | undefined) {
    const me = await this.me(token);
    const firstAccount = !this.hasOwner() && (await this.store.accountCount()) === 0;
    return { me, firstAccount, signupOpen: firstAccount || this.allowSignup, captchaSiteKey: this.opts.turnstile?.siteKey ?? null, passwordMin: MIN_PASSWORD };
  }

  async me(token: string | undefined): Promise<Me | null> {
    const userId = await this.userOf(token);
    if (!userId) return null;
    const u = this.engine.m.get('users', userId);
    const a = await this.store.accountByUser(userId);
    return u && a ? { ...u, email: a.email, mfa: !!a.mfaSecret } : null;
  }

  /** The signed-in user behind a session token, or null (unknown, expired, or unused for 7 days). */
  async userOf(token: string | undefined): Promise<string | null> {
    if (!token || token.length > 200) return null;
    const id = sha(token);
    const now = new Date();
    let s = this.cache.get(id);
    if (!s) {
      const row = await this.store.session(id);
      if (row) { s = { userId: row.userId, expiresAt: row.expiresAt, lastSeenAt: row.lastSeenAt ?? row.createdAt }; this.cache.set(id, s); }
    }
    if (!s) return null;
    const idle = now.getTime() - Date.parse(s.lastSeenAt) > IDLE_DAYS * DAY;
    if (s.expiresAt < now.toISOString() || idle || !this.engine.m.get('users', s.userId)) { this.cache.delete(id); await this.store.deleteSession(id); return null; }
    if (now.getTime() - Date.parse(s.lastSeenAt) > TOUCH_EVERY_MS) {
      s.lastSeenAt = now.toISOString();
      this.store.touchSession(id, s.lastSeenAt).catch(e => console.error('Session touch failed:', e));
    }
    return s.userId;
  }

  // ------------------------------------------------------------------------- sign-up
  /**
   * The first account (with the owner setup code) becomes the System Owner and is signed in. Everyone else asks for an
   * account: it waits until an Admin approves it. Sign-ups run one at a time.
   */
  async signup(input: { name?: unknown; email?: unknown; password?: unknown; setupCode?: unknown; captcha?: unknown; website?: unknown }, meta: { ip: string; userAgent?: string }): Promise<{ token: string; me: Me } | { pending: true; message: string }> {
    const PENDING = { pending: true as const, message: 'Thanks! An Admin has to approve your account before you can sign in.' };
    if (this.signups.count(`ip:${meta.ip}`) >= LIMITS.signupPerAddress || this.signups.count('all') >= LIMITS.signupTotal) throw bad('Too many sign-ups right now. Try again in an hour.', 429);
    this.signups.add(`ip:${meta.ip}`); this.signups.add('all');
    // Bots fill every field, people never see this one: pretend it worked and keep nothing.
    if (String(input.website ?? '').trim()) return PENDING;
    if (this.opts.turnstile) await this.checkHuman(String(input.captcha ?? ''), meta.ip);
    const run = this.chain.then(async () => {
      const first = !this.hasOwner() && (await this.store.accountCount()) === 0;
      if (first) {
        const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!same(norm(String(input.setupCode ?? '')), norm(this.ownerSetupCode))) throw bad('Enter the owner setup code (printed in the server log at start-up, or OWNER_SETUP_TOKEN in .env).');
      } else if (!this.allowSignup) throw bad('Sign-up is closed. Ask an Admin for an account.');
      const { name, email, password } = await this.personInput(input, 'Your name');
      const existing = await this.store.accountByEmail(email);
      if (existing) throw bad(existing.status === 'pending' ? 'This email is already waiting for approval.' : 'An account with this email already exists. Sign in instead.');
      const passwordHash = await hashPassword(password);
      const userId = `u-${randomUUID()}`;
      const now = new Date().toISOString();
      if (!first) {
        await this.store.createAccount({ userId, email, passwordHash, createdAt: now, lastLoginAt: null, status: 'pending', name });
        return PENDING;
      }
      const user: User = { id: userId, name, role: 'System Owner' };
      await this.engine.addUser(user);
      await this.store.createAccount({ userId, email, passwordHash, createdAt: now, lastLoginAt: now });
      this.setupCode = null;
      const token = await this.startSession(userId, meta.userAgent);
      return { token, me: { ...user, email, mfa: false } };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async checkHuman(token: string, ip: string) {
    if (!token) throw bad('Complete the “I am human” check first.');
    try {
      const res = await (this.opts.fetchFn ?? fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: this.opts.turnstile!.secretKey, response: token, remoteip: ip }), signal: AbortSignal.timeout(5000),
      });
      if ((await res.json() as { success?: boolean }).success) return;
    } catch { throw bad('The “I am human” check could not be verified. Try again.'); }
    throw bad('The “I am human” check failed. Try again.');
  }

  // ------------------------------------------------------------------------- sign-in
  async login(input: { email?: unknown; password?: unknown }, ip: string, userAgent?: string): Promise<LoginResult> {
    const email = normEmail(input.email);
    const password = String(input.password ?? '');
    const pairKey = `${ip}|${email}`, emailKey = `email:${email}`;
    if (this.loginFails.count(pairKey) >= LIMITS.loginPerAddressAndEmail || this.loginFails.count(emailKey) >= LIMITS.loginPerEmail) {
      throw bad('Too many failed sign-in attempts. Wait 15 minutes and try again.', 429);
    }
    const account = email ? await this.store.accountByEmail(email) : null;
    const ok = account ? await checkPassword(password, account.passwordHash) : (await checkPassword(password, await (decoy ??= hashPassword('decoy-password'))), false);
    if (!ok || !account) {
      this.loginFails.add(pairKey); this.loginFails.add(emailKey);
      throw bad('Email or password is wrong.');
    }
    if (account.status === 'pending') throw bad('Your account is waiting for approval by an Admin.');
    if (account.status === 'disabled') throw bad('This account is switched off. Ask an Admin.');
    const u = this.engine.m.get('users', account.userId);
    if (!u) throw bad('Email or password is wrong.');
    this.loginFails.clear(pairKey);
    if (needsRehash(account.passwordHash)) await this.store.updateAccount(account.userId, { passwordHash: await hashPassword(password) });
    if (account.mfaSecret) {
      const ticket = randomBytes(24).toString('base64url');
      this.tickets.set(ticket, { userId: account.userId, until: Date.now() + 5 * 60_000, tries: 0 });
      return { mfa: true, ticket };
    }
    return this.finishLogin(account, u, userAgent);
  }

  /** Second step: a code from the authenticator app, or a recovery code. */
  async loginCode(input: { ticket?: unknown; code?: unknown }, userAgent?: string): Promise<{ token: string; me: Me }> {
    const key = String(input.ticket ?? '');
    const t = this.tickets.get(key);
    if (!t || t.until < Date.now()) { this.tickets.delete(key); throw bad('The sign-in timed out. Sign in again.', 401); }
    const account = await this.store.accountByUser(t.userId);
    const u = this.engine.m.get('users', t.userId);
    if (!account?.mfaSecret || !u || account.status !== 'active') { this.tickets.delete(key); throw bad('Sign in again.', 401); }
    if (!(await this.useCode(account, String(input.code ?? '')))) {
      if (++t.tries >= LIMITS.codeTries) { this.tickets.delete(key); throw bad('Too many wrong codes. Sign in again.', 429); }
      throw bad('That code is not right. Use the 6-digit code from the app, or a recovery code.');
    }
    this.tickets.delete(key);
    return this.finishLogin(account, u, userAgent);
  }

  private async finishLogin(account: Account, u: User, userAgent?: string) {
    await this.store.updateAccount(account.userId, { lastLoginAt: new Date().toISOString() });
    const token = await this.startSession(account.userId, userAgent);
    return { token, me: { ...u, email: account.email, mfa: !!account.mfaSecret } };
  }

  /** A valid authenticator code (each works once) or an unused recovery code (then used up). */
  private async useCode(account: Account, code: string): Promise<boolean> {
    if (!account.mfaSecret) return false;
    let secret: string | null = null;
    try { secret = openSecret(account.mfaSecret, this.opts.secret); } catch (e) { console.error(String(e)); }   // AUTH_SECRET changed: recovery codes still work
    const step = secret ? verifyTotp(secret, code, account.mfaLastStep) : null;
    if (step != null) { await this.store.updateAccount(account.userId, { mfaLastStep: step }); return true; }
    const list: string[] = account.mfaRecovery ? JSON.parse(account.mfaRecovery) : [];
    const h = recoveryHash(code);
    if (code.replace(/[^a-z0-9]/gi, '').length === 8 && list.includes(h)) {
      await this.store.updateAccount(account.userId, { mfaRecovery: JSON.stringify(list.filter(x => x !== h)) });
      return true;
    }
    return false;
  }

  async logout(token: string | undefined) {
    if (!token) return;
    const id = sha(token);
    this.cache.delete(id);
    await this.store.deleteSession(id);
  }

  // ------------------------------------------------------------------------- own account
  /** Change the password; every other session of this account is signed out. */
  async changePassword(token: string | undefined, input: { current?: unknown; next?: unknown }) {
    const userId = await this.userOf(token);
    if (!userId) throw bad('Sign in first.', 401);
    const account = await this.store.accountByUser(userId);
    if (!account || !(await checkPassword(String(input.current ?? ''), account.passwordHash))) throw bad('Your current password is wrong.');
    const next = String(input.next ?? '');
    await this.requireGoodPassword(next, { email: account.email, name: this.engine.m.get('users', userId)?.name });
    await this.store.updateAccount(userId, { passwordHash: await hashPassword(next) });
    this.signOutEverywhere(userId, sha(token!));
    await this.store.deleteSessionsOf(userId, sha(token!));
  }

  /** Start two-step sign-in: a secret to scan; it is saved only once a code from the app is confirmed. */
  async mfaSetup(userId: string) {
    const account = await this.store.accountByUser(userId);
    if (!account) throw bad('Sign in first.', 401);
    if (account.mfaSecret) throw bad('Two-step sign-in is already on.');
    const secret = newTotpSecret();
    this.pendingMfa.set(userId, { secret, until: Date.now() + 15 * 60_000 });
    return { secret, uri: otpauthUri(account.email, secret) };
  }
  async mfaEnable(userId: string, code: unknown) {
    const p = this.pendingMfa.get(userId);
    if (!p || p.until < Date.now()) throw bad('Start again: the setup timed out.');
    const step = verifyTotp(p.secret, String(code ?? ''), null);
    if (step == null) throw bad('That code is not right. Check the time on the phone and try the current code.');
    const codes = newRecoveryCodes();
    await this.store.updateAccount(userId, { mfaSecret: sealSecret(p.secret, this.opts.secret), mfaRecovery: JSON.stringify(codes.map(recoveryHash)), mfaLastStep: step });
    this.pendingMfa.delete(userId);
    await this.engine.write(userId, (m, ctx) => audit(m, ctx, { caseId: null, entity: 'User', entityId: userId, action: 'Two-step sign-in turned on' }));
    return { recoveryCodes: codes };
  }
  async mfaDisable(userId: string, input: { password?: unknown; code?: unknown }) {
    const account = await this.store.accountByUser(userId);
    if (!account?.mfaSecret) throw bad('Two-step sign-in is not on.');
    if (!(await checkPassword(String(input.password ?? ''), account.passwordHash))) throw bad('Your password is wrong.');
    if (!(await this.useCode(account, String(input.code ?? '')))) throw bad('That code is not right.');
    await this.store.updateAccount(userId, { mfaSecret: null, mfaRecovery: null, mfaLastStep: null });
    await this.engine.write(userId, (m, ctx) => audit(m, ctx, { caseId: null, entity: 'User', entityId: userId, action: 'Two-step sign-in turned off' }));
  }

  // ------------------------------------------------------------------------- people (System Owner and Admins)
  /** The team as the viewer may see it: the System Owner shows as Admin to everyone else. */
  async people(viewerId: string): Promise<Person[]> {
    const out: Person[] = [];
    for (const u of this.engine.m.all('users')) {
      if (u.role === 'Automation') continue;
      const a = await this.store.accountByUser(u.id);
      out.push({ ...u, role: visibleRole(this.engine.m, viewerId, u), email: a?.email ?? null, status: a?.status ?? 'active', mfa: !!a?.mfaSecret, lastLoginAt: a?.lastLoginAt ?? null });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Sign-ups waiting for approval (System Owner and Admins). */
  async pending(byUserId: string) {
    if (!can(this.engine.m, byUserId, 'manageUsers')) throw bad('Only an Admin can see sign-up requests.');
    return (await this.store.accountsByStatus('pending')).map(a => ({ userId: a.userId, name: a.name ?? a.email, email: a.email, requestedAt: a.createdAt }));
  }
  async approve(byUserId: string, userId: string, role: unknown) {
    if (!can(this.engine.m, byUserId, 'manageUsers')) throw bad('Only an Admin can approve sign-ups.');
    const r = String(role ?? 'User');
    if (!(PEOPLE_ROLES as readonly string[]).includes(r)) throw bad('Pick a role: Admin or User.');
    const a = await this.store.accountByUser(userId);
    if (!a || a.status !== 'pending') throw bad('This sign-up request is gone.');
    const user: User = { id: userId, name: a.name ?? a.email, role: r as Role };
    await this.engine.addUser(user, byUserId, 'Sign-up approved');
    await this.store.updateAccount(userId, { status: 'active', name: null });
    return `${user.name} can sign in now (${r}).`;
  }
  async decline(byUserId: string, userId: string) {
    if (!can(this.engine.m, byUserId, 'manageUsers')) throw bad('Only an Admin can decline sign-ups.');
    const a = await this.store.accountByUser(userId);
    if (!a || a.status !== 'pending') throw bad('This sign-up request is gone.');
    await this.store.deleteAccount(userId);
    await this.engine.write(byUserId, (m, ctx) => audit(m, ctx, { caseId: null, entity: 'User', entityId: userId, action: 'Sign-up declined', to: a.name ?? null }));
    return `Sign-up of ${a.name ?? a.email} declined.`;
  }

  /** The System Owner or an Admin adds a person (Admin or User) with a first password they pass on. */
  addPerson(byUserId: string, input: { name?: unknown; email?: unknown; password?: unknown; role?: unknown }): Promise<Person> {
    const run = this.chain.then(async () => {
      if (!can(this.engine.m, byUserId, 'manageUsers')) throw bad('Only an Admin can add people.');
      if (this.added.count(byUserId) >= LIMITS.addPerPerson) throw bad(`You can add at most ${LIMITS.addPerPerson} people an hour.`, 429);
      const { name, email, password } = await this.personInput(input, 'Name');
      const role = String(input.role ?? '');
      if (!(PEOPLE_ROLES as readonly string[]).includes(role)) throw bad('Pick a role: Admin or User.');
      if (await this.store.accountByEmail(email)) throw bad('An account with this email already exists.');
      const passwordHash = await hashPassword(password);
      const user: User = { id: `u-${randomUUID()}`, name, role: role as Role };
      await this.engine.addUser(user, byUserId);
      await this.store.createAccount({ userId: user.id, email, passwordHash, createdAt: new Date().toISOString(), lastLoginAt: null });
      this.added.add(byUserId);
      return { ...user, email, status: 'active', mfa: false, lastLoginAt: null };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The System Owner sets someone else's password; that person is signed out everywhere. */
  async setPasswordFor(byUserId: string, userId: string, password: unknown) {
    if (!can(this.engine.m, byUserId, 'managePasswords')) throw bad('Only the System Owner can set other people’s passwords.');
    if (userId === byUserId) throw bad('Change your own password under Your account.');
    const u = this.engine.m.get('users', userId);
    const account = await this.store.accountByUser(userId);
    if (!u || !account) throw bad('This person has no account.');
    const pw = String(password ?? '');
    await this.requireGoodPassword(pw, { email: account.email, name: u.name });
    await this.store.updateAccount(userId, { passwordHash: await hashPassword(pw) });
    this.signOutEverywhere(userId);
    await this.store.deleteSessionsOf(userId);
    await this.engine.write(byUserId, (m, ctx) => audit(m, ctx, { caseId: null, entity: 'User', entityId: userId, action: 'Password set' }));
    return `New password set for ${u.name}. They were signed out everywhere.`;
  }

  /** The System Owner turns off someone's two-step sign-in (lost phone and recovery codes). */
  async resetMfaFor(byUserId: string, userId: string) {
    if (!can(this.engine.m, byUserId, 'managePasswords')) throw bad('Only the System Owner can reset two-step sign-in.');
    const u = this.engine.m.get('users', userId);
    const account = await this.store.accountByUser(userId);
    if (!u || !account?.mfaSecret) throw bad('Two-step sign-in is not on for this person.');
    await this.store.updateAccount(userId, { mfaSecret: null, mfaRecovery: null, mfaLastStep: null });
    this.signOutEverywhere(userId);
    await this.store.deleteSessionsOf(userId);
    await this.engine.write(byUserId, (m, ctx) => audit(m, ctx, { caseId: null, entity: 'User', entityId: userId, action: 'Two-step sign-in reset' }));
    return `Two-step sign-in is off for ${u.name}. They sign in with their password and can turn it on again.`;
  }

  /**
   * Switch a person off (no sign-in, signed out everywhere) or back on. The System Owner can do it for anyone; an Admin
   * only for Users (the owner shows as Admin, so the same answer keeps the owner hidden).
   */
  async setActive(byUserId: string, userId: string, active: boolean) {
    if (!can(this.engine.m, byUserId, 'manageUsers')) throw bad('Only an Admin can switch people off.');
    if (userId === byUserId) throw bad('You cannot switch yourself off.');
    const u = this.engine.m.get('users', userId);
    const account = await this.store.accountByUser(userId);
    if (!u || !account || u.role === 'Automation') throw bad('Unknown person.');
    if (u.role !== 'User' && this.engine.m.get('users', byUserId)?.role !== 'System Owner') throw bad('Only the System Owner can switch an Admin off or on.');
    await this.store.updateAccount(userId, { status: active ? 'active' : 'disabled' });
    if (!active) { this.signOutEverywhere(userId); await this.store.deleteSessionsOf(userId); }
    await this.engine.write(byUserId, (m, ctx) => audit(m, ctx, { caseId: null, entity: 'User', entityId: userId, action: active ? 'Person switched on' : 'Person switched off' }));
    return active ? `${u.name} can sign in again.` : `${u.name} is switched off and was signed out everywhere.`;
  }

  cleanup() {
    const now = Date.now();
    for (const [id, s] of this.cache) if (s.expiresAt < new Date(now).toISOString() || now - Date.parse(s.lastSeenAt) > IDLE_DAYS * DAY) this.cache.delete(id);
    for (const [k, t] of this.tickets) if (t.until < now) this.tickets.delete(k);
    for (const [k, p] of this.pendingMfa) if (p.until < now) this.pendingMfa.delete(k);
    this.loginFails.prune(); this.signups.prune(); this.added.prune();
    return this.store.deleteExpired(new Date(now).toISOString(), new Date(now - IDLE_DAYS * DAY).toISOString());
  }

  private signOutEverywhere(userId: string, except?: string) { for (const [id, s] of this.cache) if (s.userId === userId && id !== except) this.cache.delete(id); }

  private async startSession(userId: string, userAgent?: string) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY).toISOString();
    const id = sha(token);
    await this.store.createSession({ id, userId, createdAt: now.toISOString(), expiresAt, userAgent: userAgent?.slice(0, 300) ?? null, lastSeenAt: now.toISOString() });
    this.cache.set(id, { userId, expiresAt, lastSeenAt: now.toISOString() });
    return token;
  }

  private async personInput(input: { name?: unknown; email?: unknown; password?: unknown }, nameLabel: string) {
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
    const email = normEmail(input.email);
    const password = String(input.password ?? '');
    if (!name) throw bad(`Enter ${nameLabel === 'Name' ? 'a name' : 'your name'}.`);
    if (name.length > 80) throw bad('A name can be at most 80 characters.');
    if (!EMAIL_RE.test(email) || email.length > 200) throw bad('Enter a valid email address.');
    await this.requireGoodPassword(password, { email, name });
    return { name, email, password };
  }
  private async requireGoodPassword(pw: string, who: { email?: string; name?: string }) {
    const problem = await passwordProblem(pw, who, this.rules);
    if (problem) throw bad(problem);
  }

  // ------------------------------------------------------------------------- HTTP helpers
  tokenOf(req: Request): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return undefined;
  }
  setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: !!this.opts.secureCookie, path: '/', maxAge: SESSION_DAYS * DAY });
  }
  clearCookie(res: Response) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: !!this.opts.secureCookie, path: '/' });
  }

  /** Every API route except health and sign-in needs a signed-in user; it is available as res.locals.userId. */
  requireUser = (req: Request, res: Response, next: NextFunction) => {
    this.userOf(this.tokenOf(req)).then(userId => {
      if (!userId) { res.status(401).json({ error: 'Your session has ended. Sign in again.' }); return; }
      res.locals.userId = userId;
      next();
    }, next);
  };
}

function normEmail(v: unknown) { return String(v ?? '').trim().toLowerCase(); }
