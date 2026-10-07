// Accounts and sign-in. Passwords are hashed with scrypt; a session is a random token in an httpOnly cookie and only its
// SHA-256 is stored. The person behind an account is a workspace user (name + role) kept by the domain engine, so every
// write is audited under the signed-in person. The first account of a workspace becomes its only System Owner; people who
// sign up later are Users. The System Owner and Admins add people; only the System Owner sets other people's passwords.
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { PEOPLE_ROLES } from '../domain/constants';
import { RuleError, type Engine } from '../domain/engine';
import { audit, can } from '../domain/ops';
import type { User } from '../domain/types';

export interface Account { userId: string; email: string; passwordHash: string; createdAt: string; lastLoginAt: string | null }
export interface Session { id: string; userId: string; createdAt: string; expiresAt: string; userAgent: string | null }

export interface AuthStore {
  accountCount(): Promise<number>;
  accountByEmail(email: string): Promise<Account | null>;
  accountByUser(userId: string): Promise<Account | null>;
  createAccount(a: Account): Promise<void>;
  updateAccount(userId: string, patch: Partial<Pick<Account, 'passwordHash' | 'lastLoginAt'>>): Promise<void>;
  createSession(s: Session): Promise<void>;
  session(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsOf(userId: string, except?: string): Promise<void>;
  deleteExpired(now: string): Promise<void>;
}

export class PrismaAuthStore implements AuthStore {
  constructor(private db: PrismaClient) {}
  accountCount() { return this.db.authAccount.count(); }
  accountByEmail(email: string) { return this.db.authAccount.findUnique({ where: { email } }); }
  accountByUser(userId: string) { return this.db.authAccount.findUnique({ where: { userId } }); }
  async createAccount(a: Account) { await this.db.authAccount.create({ data: a }); }
  async updateAccount(userId: string, patch: Partial<Account>) { await this.db.authAccount.update({ where: { userId }, data: patch }); }
  async createSession(s: Session) { await this.db.authSession.create({ data: s }); }
  session(id: string) { return this.db.authSession.findUnique({ where: { id } }); }
  async deleteSession(id: string) { await this.db.authSession.deleteMany({ where: { id } }); }
  async deleteSessionsOf(userId: string, except?: string) { await this.db.authSession.deleteMany({ where: { userId, ...(except ? { id: { not: except } } : {}) } }); }
  async deleteExpired(now: string) { await this.db.authSession.deleteMany({ where: { expiresAt: { lt: now } } }); }
}

/** Accounts kept in memory (tests). */
export class MemoryAuthStore implements AuthStore {
  accounts = new Map<string, Account>();
  sessions = new Map<string, Session>();
  async accountCount() { return this.accounts.size; }
  async accountByEmail(email: string) { return [...this.accounts.values()].find(a => a.email === email) ?? null; }
  async accountByUser(userId: string) { return this.accounts.get(userId) ?? null; }
  async createAccount(a: Account) {
    if (await this.accountByEmail(a.email)) throw new Error('Unique constraint failed on the fields: (`email`)');
    this.accounts.set(a.userId, { ...a });
  }
  async updateAccount(userId: string, patch: Partial<Account>) { const a = this.accounts.get(userId); if (a) Object.assign(a, patch); }
  async createSession(s: Session) { this.sessions.set(s.id, { ...s }); }
  async session(id: string) { return this.sessions.get(id) ?? null; }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async deleteSessionsOf(userId: string, except?: string) { for (const [id, s] of this.sessions) if (s.userId === userId && id !== except) this.sessions.delete(id); }
  async deleteExpired(now: string) { for (const [id, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(id); }
}

// --------------------------------------------------------------------------- passwords
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const scrypt = (pw: string, salt: Buffer, keylen: number, o: ScryptOptions) =>
  new Promise<Buffer>((ok, fail) => scryptCb(pw.normalize('NFKC'), salt, keylen, { ...o, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? fail(e) : ok(k)));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, N, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === want.length && timingSafeEqual(got, want);
}
/** Used when an email is unknown, so a wrong email takes as long as a wrong password. */
let decoy: Promise<string> | null = null;

// --------------------------------------------------------------------------- the auth service
export const SESSION_COOKIE = 'af_session';
const SESSION_DAYS = 30;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthOptions {
  /** After the first account (the System Owner), may people create their own accounts? Default: yes. */
  allowSignup?: boolean;
  /** Mark the cookie Secure (only sent over HTTPS). Turn on behind HTTPS. */
  secureCookie?: boolean;
}
export interface Me extends User { email: string }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const bad = (msg: string) => new RuleError(msg);

export class Auth {
  private cache = new Map<string, { userId: string; expiresAt: string }>();
  private failures = new Map<string, { count: number; since: number }>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private store: AuthStore, private engine: Engine, private opts: AuthOptions = {}) {}

  get allowSignup() { return this.opts.allowSignup !== false; }

  /** What the sign-in page needs: is anyone signed in, is this a brand-new workspace, may people sign up. */
  async state(token: string | undefined) {
    const me = await this.me(token);
    const firstAccount = (await this.store.accountCount()) === 0;
    return { me, firstAccount, signupOpen: firstAccount || this.allowSignup };
  }

  async me(token: string | undefined): Promise<Me | null> {
    const userId = await this.userOf(token);
    if (!userId) return null;
    const u = this.engine.m.get('users', userId);
    const a = await this.store.accountByUser(userId);
    return u && a ? { ...u, email: a.email } : null;
  }

  /** The signed-in user behind a session token, or null (unknown or expired). */
  async userOf(token: string | undefined): Promise<string | null> {
    if (!token || token.length > 200) return null;
    const id = sha(token);
    const now = new Date().toISOString();
    let s = this.cache.get(id);
    if (!s) {
      const row = await this.store.session(id);
      if (row) { s = { userId: row.userId, expiresAt: row.expiresAt }; this.cache.set(id, s); }
    }
    if (!s) return null;
    if (s.expiresAt < now || !this.engine.m.get('users', s.userId)) { this.cache.delete(id); await this.store.deleteSession(id); return null; }
    return s.userId;
  }

  /** Create an account (and its workspace user); returns a session token. Sign-ups run one at a time. */
  signup(input: { name?: unknown; email?: unknown; password?: unknown }, userAgent?: string): Promise<{ token: string; me: Me }> {
    const run = this.chain.then(async () => {
      const { name, email, password } = personInput(input, 'Your name');
      const first = (await this.store.accountCount()) === 0 && !this.engine.m.all('users').some(u => u.role === 'System Owner');
      if (!first && !this.allowSignup) throw bad('Sign-up is closed. Ask an Admin for an account.');
      if (await this.store.accountByEmail(email)) throw bad('An account with this email already exists. Sign in instead.');
      const passwordHash = await hashPassword(password);
      const user: User = { id: `u-${randomUUID()}`, name, role: first ? 'System Owner' : 'User' };
      await this.engine.addUser(user);
      const now = new Date().toISOString();
      await this.store.createAccount({ userId: user.id, email, passwordHash, createdAt: now, lastLoginAt: now });
      const token = await this.startSession(user.id, userAgent);
      return { token, me: { ...user, email } };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async login(input: { email?: unknown; password?: unknown }, ip: string, userAgent?: string): Promise<{ token: string; me: Me }> {
    const email = normEmail(input.email);
    const password = String(input.password ?? '');
    const key = `${ip}|${email}`;
    const f = this.failures.get(key);
    if (f && Date.now() - f.since < LOGIN_WINDOW_MS && f.count >= LOGIN_MAX_FAILURES) {
      throw Object.assign(bad('Too many failed sign-in attempts. Wait 15 minutes and try again.'), { status: 429 });
    }
    const account = email ? await this.store.accountByEmail(email) : null;
    const ok = account ? await checkPassword(password, account.passwordHash) : (await checkPassword(password, await (decoy ??= hashPassword('decoy-password'))), false);
    const u = account && this.engine.m.get('users', account.userId);
    if (!ok || !account || !u) {
      const cur = f && Date.now() - f.since < LOGIN_WINDOW_MS ? f : { count: 0, since: Date.now() };
      this.failures.set(key, { ...cur, count: cur.count + 1 });
      throw bad('Email or password is wrong.');
    }
    this.failures.delete(key);
    await this.store.updateAccount(account.userId, { lastLoginAt: new Date().toISOString() });
    const token = await this.startSession(account.userId, userAgent);
    return { token, me: { ...u, email: account.email } };
  }

  async logout(token: string | undefined) {
    if (!token) return;
    const id = sha(token);
    this.cache.delete(id);
    await this.store.deleteSession(id);
  }

  /** Change the password; every other session of this account is signed out. */
  async changePassword(token: string | undefined, input: { current?: unknown; next?: unknown }) {
    const userId = await this.userOf(token);
    if (!userId) throw Object.assign(bad('Sign in first.'), { status: 401 });
    const account = await this.store.accountByUser(userId);
    if (!account || !(await checkPassword(String(input.current ?? ''), account.passwordHash))) throw bad('Your current password is wrong.');
    const next = String(input.next ?? '');
    checkStrength(next);
    await this.store.updateAccount(userId, { passwordHash: await hashPassword(next) });
    const keep = sha(token!);
    for (const [id, s] of this.cache) if (s.userId === userId && id !== keep) this.cache.delete(id);
    await this.store.deleteSessionsOf(userId, keep);
  }

  /** The System Owner or an Admin adds a person (Admin or User) with a first password they pass on. */
  addPerson(byUserId: string, input: { name?: unknown; email?: unknown; password?: unknown; role?: unknown }): Promise<Me> {
    const run = this.chain.then(async () => {
      if (!can(this.engine.m, byUserId, 'manageUsers')) throw bad('Only an Admin can add people.');
      const { name, email, password } = personInput(input, 'Name');
      const role = String(input.role ?? '');
      if (!(PEOPLE_ROLES as readonly string[]).includes(role)) throw bad('Pick a role: Admin or User.');
      if (await this.store.accountByEmail(email)) throw bad('An account with this email already exists.');
      const passwordHash = await hashPassword(password);
      const user: User = { id: `u-${randomUUID()}`, name, role: role as User['role'] };
      await this.engine.addUser(user, byUserId);
      await this.store.createAccount({ userId: user.id, email, passwordHash, createdAt: new Date().toISOString(), lastLoginAt: null });
      return { ...user, email };
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
    checkStrength(pw);
    await this.store.updateAccount(userId, { passwordHash: await hashPassword(pw) });
    for (const [id, s] of this.cache) if (s.userId === userId) this.cache.delete(id);
    await this.store.deleteSessionsOf(userId);
    await this.engine.write(byUserId, (m, ctx) => audit(m, ctx, { caseId: null, entity: 'User', entityId: userId, action: 'Password set by the System Owner' }));
    return `New password set for ${u.name}. They were signed out everywhere.`;
  }

  /** Emails of the workspace's people (Settings → People). */
  async emails(userIds: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const id of userIds) { const a = await this.store.accountByUser(id); if (a) out[id] = a.email; }
    return out;
  }

  cleanup() {
    const now = new Date().toISOString();
    for (const [id, s] of this.cache) if (s.expiresAt < now) this.cache.delete(id);
    for (const [k, f] of this.failures) if (Date.now() - f.since > LOGIN_WINDOW_MS) this.failures.delete(k);
    return this.store.deleteExpired(now);
  }

  private async startSession(userId: string, userAgent?: string) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString();
    const id = sha(token);
    await this.store.createSession({ id, userId, createdAt: now.toISOString(), expiresAt, userAgent: userAgent?.slice(0, 300) ?? null });
    this.cache.set(id, { userId, expiresAt });
    return token;
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
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: !!this.opts.secureCookie, path: '/', maxAge: SESSION_DAYS * 86_400_000 });
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
function personInput(input: { name?: unknown; email?: unknown; password?: unknown }, nameLabel: string) {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  const email = normEmail(input.email);
  const password = String(input.password ?? '');
  if (!name) throw bad(`Enter ${nameLabel === 'Name' ? 'a name' : 'your name'}.`);
  if (name.length > 80) throw bad('A name can be at most 80 characters.');
  if (!EMAIL_RE.test(email) || email.length > 200) throw bad('Enter a valid email address.');
  checkStrength(password);
  return { name, email, password };
}
function checkStrength(pw: string) {
  if (pw.length < 8) throw bad('Use a password of at least 8 characters.');
  if (pw.length > 200) throw bad('Use a password of at most 200 characters.');
}
