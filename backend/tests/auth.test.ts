// Accounts, sessions, roles and account security, tested over HTTP on an in-memory engine and account store (no
// database, no network: the breach check and the "I am human" check get fake answers).
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Engine, type Store } from '../src/domain/engine';
import { Model, type Dirty, type Snapshot } from '../src/domain/model';
import { upgradeWorkspace } from '../src/domain/upgrade';
import { createApi } from '../src/server/app';
import { Auth, LIMITS, MemoryAuthStore, SESSION_COOKIE, checkPassword, hashPassword, type AuthOptions } from '../src/server/auth';
import { needsRehash, passwordProblem } from '../src/server/passwords';
import { base32, fromBase32, openSecret, sealSecret, stepOf, totpCode, verifyTotp } from '../src/server/totp';

class MemoryStore implements Store {
  async load(): Promise<Snapshot | null> { return null; }
  async save(_d: Dirty) {}
  async replace(_s: Snapshot) {}
}
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}
const CODE = 'TEST-CODE-0001';
const PW = { owner: 'owner long passphrase 1', ravi: 'monsoon river lantern 7', meera: 'copper kettle morning', kiran: 'violet tram sixteen' };

async function start(opts: AuthOptions = {}) {
  const engine = new Engine(new MemoryStore());
  await engine.init();
  const accounts = new MemoryAuthStore();
  const auth = new Auth(accounts, engine, { ownerSetupCode: CODE, breachCheck: false, ...opts });
  const server = createApi(engine, auth).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** A browser: keeps its session cookie between requests. */
  const browser = () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + path, {
        method, headers: { ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
      const text = await res.text();
      let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, setCookie: set };
    };
    return { call, get cookie() { return cookie; } };
  };
  const owner = async () => {
    const a = browser();
    await a.call('POST', '/api/auth/signup', { name: 'Asha Rao', email: 'asha@example.com', password: PW.owner, setupCode: CODE, captcha: 'tok' });
    return a;
  };
  return { engine, accounts, auth, server, browser, owner };
}
const hibp = (pw: string, count: number): typeof fetch => (async () => {
  const sha1 = createHash('sha1').update(pw).digest('hex').toUpperCase();
  return new Response(`0000000000000000000000000000000000A:1\n${sha1.slice(5)}:${count}\n`, { status: 200 });
}) as typeof fetch;

console.log('Passwords');
{
  const h = await hashPassword('correct horse battery');
  check('stored as scrypt (N=2^14, r=8, p=5) with a salt, never the password', h.startsWith('scrypt$16384$8$5$') && !h.includes('correct horse'));
  check('right password matches, wrong does not', await checkPassword('correct horse battery', h) && !(await checkPassword('correct horse battery!', h)));
  check('older hashes (p=1) still check and are marked for upgrade', needsRehash('scrypt$16384$8$1$x$y') && !needsRehash(h));
  check('at least 12 characters', /at least 12/.test(await passwordProblem('short pw 11', {}) ?? ''));
  check('not built from the email', /email/.test(await passwordProblem('ashaRao-2026-xyz', { email: 'asharao@example.com' }) ?? ''));
  check('not a well-known password', /too easy/.test(await passwordProblem('password1234', {}) ?? '') && /too easy/.test(await passwordProblem('aaaaaaaaaaaaaa', {}) ?? ''));
  check('a breached password is refused (k-anonymity lookup)', /data breaches \(3,861\b/.test(await passwordProblem('breached passphrase', {}, { breachCheck: true, fetchFn: hibp('breached passphrase', 3861) }) ?? ''));
  check('the breach check fails open when offline', await passwordProblem('fine long passphrase', {}, { breachCheck: true, fetchFn: (async () => { throw new Error('offline'); }) as typeof fetch }) === null);
}

console.log('\nTwo-step codes');
{
  const secret = base32(Buffer.from('12345678901234567890'));
  check('RFC 6238 test vector (59 s → 287082)', totpCode(secret, 1) === '287082');
  check('base32 round trip', fromBase32(secret).toString() === '12345678901234567890');
  const now = Date.now(), step = stepOf(now);
  check('current code is accepted, one step of drift too', verifyTotp(secret, totpCode(secret, step), null, now) === step && verifyTotp(secret, totpCode(secret, step - 1), null, now) === step - 1);
  check('a used code cannot be used again', verifyTotp(secret, totpCode(secret, step), step, now) === null);
  check('codes from far away are refused', verifyTotp(secret, totpCode(secret, step - 5), null, now) === null);
  const sealed = sealSecret(secret, 'server-secret');
  check('secret is encrypted with AUTH_SECRET', sealed.startsWith('v1:') && !sealed.includes(secret) && openSecret(sealed, 'server-secret') === secret);
  let threw = false; try { openSecret(sealed, 'other'); } catch { threw = true; }
  check('…and cannot be opened with another key', threw);
}

console.log('\nA brand-new workspace');
let ownerId = '', raviId = '', meeraId = '', kiranId = '';
{
  const { engine, accounts, auth, server, browser } = await start();
  const a = browser();
  check('no people at the start (only the discovery engine)', engine.m.all('users').every(u => u.role === 'Automation'));
  const st = await a.call('GET', '/api/auth/state');
  check('state: signed out, first account expected, 12-character rule', st.status === 200 && st.json.me === null && st.json.firstAccount === true && st.json.passwordMin === 12, st.json);
  check('health needs no sign-in', (await a.call('GET', '/api/health')).status === 200);
  for (const [path, method] of [['/api/query/meta', 'POST'], ['/api/command/createCase', 'POST'], ['/api/people', 'GET'], ['/api/discovery/config', 'GET'], ['/api/import?filename=x.csv', 'POST'], ['/api/account/mfa/setup', 'POST']] as const) {
    check(`${method} ${path.split('?')[0]} needs sign-in (401)`, (await a.call(method, path, method === 'POST' ? {} : undefined)).status === 401);
  }
  const noCode = await a.call('POST', '/api/auth/signup', { name: 'Intruder', email: 'x@example.com', password: 'intruder passphrase' });
  const wrongCode = await a.call('POST', '/api/auth/signup', { name: 'Intruder', email: 'x@example.com', password: 'intruder passphrase', setupCode: 'GUES-SSED-CODE' });
  check('first account needs the owner setup code', noCode.status === 422 && /setup code/.test(noCode.json.error) && wrongCode.status === 422, [noCode.json, wrongCode.json]);
  check('the setup code is the one configured (OWNER_SETUP_TOKEN)', auth.ownerSetupCode === CODE);
  const weak = await a.call('POST', '/api/auth/signup', { name: 'Asha Rao', email: 'asha@example.com', password: 'eleven char', setupCode: CODE });
  check('sign-up checks the password rules', weak.status === 422 && /at least 12/.test(weak.json.error), weak.json);
  check('no account or person was created by failed sign-ups', accounts.accounts.size === 0 && engine.m.count('users') === 1);

  const s1 = await a.call('POST', '/api/auth/signup', { name: '  Asha   Rao ', email: ' Asha@Example.com ', password: PW.owner, setupCode: ' test code 0001 ' });
  ownerId = s1.json?.me?.id;
  check('first sign-up with the code (any case/spacing) → System Owner, signed in', s1.status === 201 && s1.json.me.role === 'System Owner' && s1.json.me.name === 'Asha Rao' && s1.json.me.email === 'asha@example.com', s1.json);
  check('session cookie is httpOnly + SameSite=Lax', !!s1.setCookie && s1.setCookie.startsWith(`${SESSION_COOKIE}=`) && /HttpOnly/i.test(s1.setCookie) && /SameSite=Lax/i.test(s1.setCookie), s1.setCookie);
  check('only a hash of the session token is stored', [...accounts.sessions.keys()].every(id => !a.cookie.includes(id)) && accounts.sessions.size === 1);
  check('state: no first account any more', (await a.call('GET', '/api/auth/state')).json.firstAccount === false);
  const meta = await a.call('POST', '/api/query/meta', {});
  check('API works when signed in: meta.me is the signed-in person', meta.status === 200 && meta.json.me?.id === ownerId, meta.json?.me);
  const created = await a.call('POST', '/api/command/createCase', { name: 'Fictional Artist' });
  check('writes are recorded under the signed-in person', created.status === 200 && engine.m.all('audit').find(x => x.caseId === created.json?.caseId)?.userId === ownerId, created.json);
  check('a request cannot act as someone else (x-user-id is ignored)', (await a.call('POST', '/api/query/meta', {}, { 'x-user-id': 'u-engine' })).json.me?.id === ownerId);

  console.log('\nSign-up requests wait for an Admin');
  const b = browser();
  const req1 = await b.call('POST', '/api/auth/signup', { name: 'Ravi K', email: 'ravi@example.com', password: PW.ravi });
  check('later sign-up → 202 "waiting for approval", no cookie, not a person yet', req1.status === 202 && req1.json.pending === true && !b.cookie && engine.m.all('users').length === 2, req1.json);
  raviId = [...accounts.accounts.values()].find(x => x.email === 'ravi@example.com')!.userId;
  const early = await b.call('POST', '/api/auth/login', { email: 'ravi@example.com', password: PW.ravi });
  check('cannot sign in before approval (told why, only with the right password)', early.status === 422 && /waiting for approval/.test(early.json.error), early.json);
  check('…a wrong password still says only "wrong"', (await b.call('POST', '/api/auth/login', { email: 'ravi@example.com', password: 'not the password!' })).json.error === 'Email or password is wrong.');
  const again = await b.call('POST', '/api/auth/signup', { name: 'Ravi K', email: 'ravi@example.com', password: PW.ravi });
  check('asking twice → "already waiting"', again.status === 422 && /already waiting/.test(again.json.error));
  const bot = await browser().call('POST', '/api/auth/signup', { name: 'Bot', email: 'bot@example.com', password: 'bot long passphrase', website: 'http://spam.example' });
  check('bot trap: a filled hidden field looks accepted but nothing is kept', bot.status === 202 && ![...accounts.accounts.values()].some(x => x.email === 'bot@example.com'));
  await browser().call('POST', '/api/auth/signup', { name: 'Spam Name', email: 'spam@example.com', password: 'tin roof breakfast' });
  const list = await a.call('GET', '/api/people/pending');
  check('Admins see the requests (name, email, when)', list.status === 200 && list.json.length === 2 && list.json.some((p: any) => p.email === 'ravi@example.com' && p.name === 'Ravi K'), list.json);
  const ok = await a.call('POST', `/api/people/${raviId}/approve`, { role: 'User' });
  check('approve as User → person added (audited)', ok.status === 200 && engine.m.get('users', raviId)?.role === 'User' && engine.m.all('audit').some(x => x.action === 'Sign-up approved' && x.entityId === raviId), ok.json);
  const spamId = [...accounts.accounts.values()].find(x => x.email === 'spam@example.com')!.userId;
  const no = await a.call('POST', `/api/people/${spamId}/decline`, {});
  check('decline → request deleted, never a person (audited)', no.status === 200 && !accounts.accounts.has(spamId) && !engine.m.get('users', spamId) && engine.m.all('audit').some(x => x.action === 'Sign-up declined'), no.json);
  const r = await b.call('POST', '/api/auth/login', { email: 'ravi@example.com', password: PW.ravi });
  check('approved person signs in as User', r.status === 200 && r.json.me.role === 'User' && !!b.cookie, r.json);
  check('a User cannot see sign-up requests', (await b.call('GET', '/api/people/pending')).status === 422);

  console.log('\nRoles');
  check('a User cannot reset the workspace', (await b.call('POST', '/api/admin/reset', {})).status === 403);
  const promote = await b.call('POST', '/api/command/setUserRole', { userId: raviId, role: 'Admin' });
  check('a User cannot change roles', promote.status === 422 && /cannot do this/.test(promote.json.error), promote.json);
  const userAdds = await b.call('POST', '/api/people', { name: 'Nope', email: 'nope@example.com', password: 'nope long passphrase', role: 'User' });
  check('a User cannot add people', userAdds.status === 422 && /Only an Admin/.test(userAdds.json.error), userAdds.json);
  const asUser = await b.call('GET', '/api/people');
  check('a User sees the team, the System Owner shown as Admin', asUser.status === 200 && asUser.json.find((p: any) => p.id === ownerId)?.role === 'Admin' && !JSON.stringify(asUser.json).includes('System Owner'), asUser.json);
  const userMeta = (await b.call('POST', '/api/query/meta', {})).json;
  check('…also in meta (no "System Owner" anywhere for a User)', !JSON.stringify(userMeta.users).includes('System Owner') && userMeta.me.role === 'User');
  check('…and in the history (audit log, dashboard activity)', !JSON.stringify((await b.call('POST', '/api/query/auditLog', {})).json).includes('System Owner') && !JSON.stringify((await b.call('POST', '/api/query/dashboard', {})).json).includes('System Owner'));
  check('the System Owner sees their own role', (await a.call('GET', '/api/people')).json.find((p: any) => p.id === ownerId)?.role === 'System Owner');
  check('a User can deduplicate but not import or manage people', userMeta.permissions.identityDecision === true && userMeta.permissions.import === false && userMeta.permissions.manageUsers === false);

  const added = await a.call('POST', '/api/people', { name: 'Meera Iyer', email: 'Meera@Example.com', password: PW.meera, role: 'Admin' });
  meeraId = added.json?.person?.id;
  check('the System Owner adds an Admin', added.status === 201 && added.json.person.role === 'Admin' && added.json.person.email === 'meera@example.com', added.json);
  check('adding checks the password rules too', /at least 12/.test((await a.call('POST', '/api/people', { name: 'Short', email: 'short@example.com', password: 'too short', role: 'User' })).json.error));
  check('nobody can be added as System Owner (there is only one)', /Admin or User/.test((await a.call('POST', '/api/people', { name: 'Two', email: 'two@example.com', password: 'two long passphrase', role: 'System Owner' })).json.error));
  const m = browser();
  check('the added person signs in with the password they were given', (await m.call('POST', '/api/auth/login', { email: 'meera@example.com', password: PW.meera })).json?.me?.role === 'Admin');
  const adminMeta = (await m.call('POST', '/api/query/meta', {})).json;
  check('an Admin manages people but not passwords or delete-all', adminMeta.permissions.manageUsers && !adminMeta.permissions.managePasswords && !adminMeta.permissions.resetWorkspace);
  check('an Admin sees the System Owner as Admin', !JSON.stringify((await m.call('GET', '/api/people')).json).includes('System Owner'));
  const adminAdds = await m.call('POST', '/api/people', { name: 'Kiran Rao', email: 'kiran@example.com', password: PW.kiran, role: 'User' });
  kiranId = adminAdds.json?.person?.id;
  check('an Admin adds a User', adminAdds.status === 201 && adminAdds.json.person.role === 'User', adminAdds.json);
  check('an Admin makes a User an Admin', (await m.call('POST', '/api/command/setUserRole', { userId: kiranId, role: 'Admin' })).status === 200 && engine.m.get('users', kiranId)?.role === 'Admin');
  const down = await m.call('POST', '/api/command/setUserRole', { userId: kiranId, role: 'User' });
  const downOwner = await m.call('POST', '/api/command/setUserRole', { userId: ownerId, role: 'User' });
  check('an Admin cannot change another Admin’s role, nor the owner’s (same answer: owner stays hidden)', down.status === 422 && downOwner.json.error === down.json.error, [down.json, downOwner.json]);
  check('the System Owner changes an Admin back to User', (await a.call('POST', '/api/command/setUserRole', { userId: kiranId, role: 'User' })).status === 200 && engine.m.get('users', kiranId)?.role === 'User');
  check('the System Owner’s role never changes', (await a.call('POST', '/api/command/setUserRole', { userId: ownerId, role: 'Admin' })).status === 422);

  console.log('\nPasswords set by the System Owner');
  const k = browser();
  await k.call('POST', '/api/auth/login', { email: 'kiran@example.com', password: PW.kiran });
  check('an Admin cannot set other people’s passwords', /Only the System Owner/.test((await m.call('POST', `/api/people/${kiranId}/password`, { password: 'admin chose this one' })).json.error));
  check('the System Owner sets someone’s password', (await a.call('POST', `/api/people/${kiranId}/password`, { password: 'owner chose this one' })).status === 200);
  check('…that person is signed out everywhere', (await k.call('POST', '/api/query/meta', {})).status === 401);
  check('…and signs in with the new password only', (await browser().call('POST', '/api/auth/login', { email: 'kiran@example.com', password: PW.kiran })).status === 422
    && (await browser().call('POST', '/api/auth/login', { email: 'kiran@example.com', password: 'owner chose this one' })).status === 200);
  check('…audited without naming the owner’s role', engine.m.all('audit').some(x => x.action === 'Password set' && x.entityId === kiranId));

  console.log('\nSwitching people off');
  const k2 = browser();
  await k2.call('POST', '/api/auth/login', { email: 'kiran@example.com', password: 'owner chose this one' });
  const off = await m.call('POST', `/api/people/${kiranId}/active`, { active: false });
  check('an Admin switches a User off', off.status === 200, off.json);
  check('…who is signed out at once', (await k2.call('POST', '/api/query/meta', {})).status === 401);
  const offLogin = await browser().call('POST', '/api/auth/login', { email: 'kiran@example.com', password: 'owner chose this one' });
  check('…and cannot sign in (told why)', offLogin.status === 422 && /switched off/.test(offLogin.json.error), offLogin.json);
  check('People shows the status', (await m.call('GET', '/api/people')).json.find((p: any) => p.id === kiranId)?.status === 'disabled');
  const offOwner = await m.call('POST', `/api/people/${ownerId}/active`, { active: false });
  check('an Admin cannot switch the owner off (same answer as for any Admin)', offOwner.status === 422 && /Only the System Owner can switch an Admin/.test(offOwner.json.error), offOwner.json);
  check('nobody switches themselves off', (await a.call('POST', `/api/people/${ownerId}/active`, { active: false })).status === 422);
  check('switched back on → can sign in again', (await a.call('POST', `/api/people/${kiranId}/active`, { active: true })).status === 200
    && (await browser().call('POST', '/api/auth/login', { email: 'kiran@example.com', password: 'owner chose this one' })).status === 200);
  check('switching is audited', engine.m.all('audit').filter(x => x.entityId === kiranId && /switched/.test(x.action)).length === 2);

  console.log('\nTwo-step sign-in');
  const setup = await a.call('POST', '/api/account/mfa/setup', {});
  check('setup gives a secret and an authenticator link', setup.status === 200 && /^[A-Z2-7]{32}$/.test(setup.json.secret) && setup.json.uri.startsWith('otpauth://totp/ArtistFinder%3Aasha%40example.com?secret='), setup.json);
  check('a wrong code does not turn it on', (await a.call('POST', '/api/account/mfa/enable', { code: '000000' })).status === 422 && !accounts.accounts.get(ownerId)!.mfaSecret);
  const en = await a.call('POST', '/api/account/mfa/enable', { code: totpCode(setup.json.secret, stepOf()) });
  check('the current code turns it on; 10 recovery codes shown once', en.status === 200 && en.json.recoveryCodes.length === 10 && /^[a-z2-7]{4}-[a-z2-7]{4}$/.test(en.json.recoveryCodes[0]), en.json);
  check('only hashes of recovery codes are stored', !JSON.stringify(accounts.accounts.get(ownerId)).includes(en.json.recoveryCodes[0]));
  const p1 = await browser().call('POST', '/api/auth/login', { email: 'asha@example.com', password: PW.owner });
  check('the password alone is not enough: a ticket for the code step, no cookie', p1.status === 200 && p1.json.mfa === true && !!p1.json.ticket && !p1.setCookie, p1.json);
  const c2 = browser();
  check('a wrong code is refused', (await c2.call('POST', '/api/auth/login/code', { ticket: p1.json.ticket, code: '123456' })).status === 422);
  const reuse = await c2.call('POST', '/api/auth/login/code', { ticket: p1.json.ticket, code: totpCode(setup.json.secret, stepOf()) });
  check('the code used to turn it on cannot be used again', reuse.status === 422, reuse.json);
  const done = await c2.call('POST', '/api/auth/login/code', { ticket: p1.json.ticket, code: totpCode(setup.json.secret, stepOf() + 1) });
  check('the next code signs in', done.status === 200 && done.json.me.mfa === true && !!c2.cookie, done.json);
  const p2 = await browser().call('POST', '/api/auth/login', { email: 'asha@example.com', password: PW.owner });
  const rc = await browser().call('POST', '/api/auth/login/code', { ticket: p2.json.ticket, code: en.json.recoveryCodes[0].toUpperCase() });
  check('a recovery code works once (any case)…', rc.status === 200, rc.json);
  const p3 = await browser().call('POST', '/api/auth/login', { email: 'asha@example.com', password: PW.owner });
  check('…and not twice', (await browser().call('POST', '/api/auth/login/code', { ticket: p3.json.ticket, code: en.json.recoveryCodes[0] })).status === 422);
  const p4 = await browser().call('POST', '/api/auth/login', { email: 'asha@example.com', password: PW.owner });
  let last = 0;
  for (let i = 0; i < LIMITS.codeTries; i++) last = (await browser().call('POST', '/api/auth/login/code', { ticket: p4.json.ticket, code: '11111' + i })).status;
  check(`${LIMITS.codeTries} wrong codes end the sign-in (429), the ticket is gone`, last === 429 && (await browser().call('POST', '/api/auth/login/code', { ticket: p4.json.ticket, code: totpCode(setup.json.secret, stepOf() + 1) })).status === 401);
  const ms = await m.call('POST', '/api/account/mfa/setup', {});
  await m.call('POST', '/api/account/mfa/enable', { code: totpCode(ms.json.secret, stepOf()) });
  check('People shows who has two-step sign-in', (await a.call('GET', '/api/people')).json.find((p: any) => p.id === meeraId)?.mfa === true);
  check('an Admin cannot reset someone’s two-step sign-in', (await m.call('POST', `/api/people/${ownerId}/mfa/reset`, {})).status === 422);
  check('the System Owner resets it (lost phone) → password sign-in again', (await a.call('POST', `/api/people/${meeraId}/mfa/reset`, {})).status === 200
    && !!(await browser().call('POST', '/api/auth/login', { email: 'meera@example.com', password: PW.meera })).json?.me);
  const dis1 = await a.call('POST', '/api/account/mfa/disable', { password: 'wrong password!!', code: totpCode(setup.json.secret, stepOf()) });
  const dis2 = await a.call('POST', '/api/account/mfa/disable', { password: PW.owner, code: en.json.recoveryCodes[1] });
  check('turning it off needs the password and a code', dis1.status === 422 && dis2.status === 200 && !accounts.accounts.get(ownerId)!.mfaSecret, [dis1.json, dis2.json]);

  console.log('\nSessions');
  const idle = browser();
  await idle.call('POST', '/api/auth/login', { email: 'ravi@example.com', password: PW.ravi });
  const sid = createHash('sha256').update(decodeURIComponent(idle.cookie.split('=')[1])).digest('hex');
  accounts.sessions.get(sid)!.lastSeenAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  (auth as unknown as { cache: Map<string, unknown> }).cache.delete(sid);
  check('a session unused for 7 days ends', (await idle.call('POST', '/api/query/meta', {})).status === 401 && !accounts.sessions.has(sid));
  const old = browser();
  await old.call('POST', '/api/auth/login', { email: 'ravi@example.com', password: PW.ravi });
  const sid2 = createHash('sha256').update(decodeURIComponent(old.cookie.split('=')[1])).digest('hex');
  accounts.sessions.get(sid2)!.expiresAt = new Date(Date.now() - 1000).toISOString();
  (auth as unknown as { cache: Map<string, unknown> }).cache.delete(sid2);
  check('a session older than 30 days ends', (await old.call('POST', '/api/query/meta', {})).status === 401);
  const before = accounts.sessions.size;
  check('sign out clears the cookie and ends the session', (await c2.call('POST', '/api/auth/logout', {})).status === 200 && c2.cookie === '' && accounts.sessions.size === before - 1);
  const pw = await a.call('POST', '/api/auth/password', { current: PW.owner, next: 'owner second passphrase' });
  const other = browser();
  await other.call('POST', '/api/auth/login', { email: 'ravi@example.com', password: PW.ravi });
  check('change password (rules apply) keeps this device signed in', pw.status === 200 && (await a.call('POST', '/api/query/meta', {})).status === 200, pw.json);
  check('change password refuses a weak one', /at least 12/.test((await a.call('POST', '/api/auth/password', { current: 'owner second passphrase', next: 'short' })).json.error));
  check('a made-up session token is refused', (await browser().call('POST', '/api/query/meta', {}, { cookie: `${SESSION_COOKIE}=made-up-token` })).status === 401);

  const m2 = browser();
  await m2.call('POST', '/api/auth/login', { email: 'meera@example.com', password: PW.meera });
  check('an Admin cannot delete all data', (await m2.call('POST', '/api/admin/reset', {})).status === 403);

  console.log('\nGuessing and flooding');
  const spam = browser();
  let st429 = 0;
  for (let i = 0; i <= LIMITS.loginPerAddressAndEmail; i++) st429 = (await spam.call('POST', '/api/auth/login', { email: 'ravi@example.com', password: `guess ${i} wrong!!` })).status;
  check('too many wrong passwords from one address → 429', st429 === 429, st429);
  check('…other accounts are not blocked', (await spam.call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'owner second passphrase' })).status === 200);
  let spread = 0;
  for (let i = 0; i <= LIMITS.loginPerEmail; i++) spread = await auth.login({ email: 'meera@example.com', password: `wrong ${i}` }, `198.51.100.${i}`).then(() => 200, e => e.status ?? 422);
  check('guessing one email from many addresses is limited too (429)', spread === 429, spread);
  let flood = 0;
  for (let i = 0; i <= LIMITS.signupPerAddress; i++) flood = await auth.signup({ name: `Flood ${i}`, email: `flood${i}@example.com`, password: 'flood long passphrase' }, { ip: '203.0.113.9' }).then(() => 202, e => e.status ?? 422);
  check('sign-up flood from one address → 429', flood === 429, flood);
  check('broken JSON → 400, not a crash', (await browser().call('POST', '/api/auth/login', '{nope', { 'content-type': 'application/json' })).status === 400);

  const rr = await a.call('POST', '/api/admin/reset', {});
  check('reset deletes data but keeps people and accounts', rr.status === 200 && engine.m.count('cases') === 0 && engine.m.get('users', ownerId)?.role === 'System Owner' && !!accounts.accounts.get(kiranId));
  server.close();
}

console.log('\nSign-up closed (ALLOW_SIGNUP=false)');
{
  const { server, browser, owner } = await start({ allowSignup: false });
  check('first account can still sign up (with the setup code)', (await browser().call('GET', '/api/auth/state')).json.signupOpen === true);
  const a = await owner();
  check('first sign-up → System Owner', (await a.call('POST', '/api/query/meta', {})).json.me.role === 'System Owner');
  const b = browser();
  check('then sign-up shows as closed', (await b.call('GET', '/api/auth/state')).json.signupOpen === false);
  const s = await b.call('POST', '/api/auth/signup', { name: 'Late', email: 'late@example.com', password: 'quiet harbour lamp' });
  check('…and is refused with the reason', s.status === 422 && /Sign-up is closed/.test(s.json.error), s.json);
  server.close();
}

console.log('\n“I am human” check (Cloudflare Turnstile)');
{
  let answer = false;
  const fake = (async (url: string) => new Response(JSON.stringify({ success: String(url).includes('turnstile') && answer }), { status: 200 })) as unknown as typeof fetch;
  const { server, browser, owner } = await start({ turnstile: { siteKey: 'site-key', secretKey: 'secret' }, fetchFn: fake });
  answer = true;
  await owner();
  const b = browser();
  check('the site key reaches the sign-up page', (await b.call('GET', '/api/auth/state')).json.captchaSiteKey === 'site-key');
  check('no token → refused', /I am human/.test((await b.call('POST', '/api/auth/signup', { name: 'P', email: 'p@example.com', password: 'person long passphrase' })).json.error));
  answer = false;
  check('a failed check → refused', /failed/.test((await b.call('POST', '/api/auth/signup', { name: 'P', email: 'p@example.com', password: 'person long passphrase', captcha: 'tok' })).json.error));
  answer = true;
  const passedCheck = await b.call('POST', '/api/auth/signup', { name: 'P', email: 'p@example.com', password: 'person long passphrase', captcha: 'tok' });
  check('a passed check → request waits for approval', passedCheck.status === 202, passedCheck.json);
  server.close();
}

console.log('\nTwo sign-ups at the same moment on a fresh workspace');
{
  const { engine, server, browser } = await start();
  const [x, y] = await Promise.all([
    browser().call('POST', '/api/auth/signup', { name: 'One', email: 'one@example.com', password: 'password one long', setupCode: CODE }),
    browser().call('POST', '/api/auth/signup', { name: 'Two', email: 'two@example.com', password: 'password two long', setupCode: CODE }),
  ]);
  check('exactly one becomes System Owner, the other waits for approval', [x.status, y.status].sort().join() === '201,202' && engine.m.all('users').filter(u => u.role === 'System Owner').length === 1, [x.json, y.json]);
  server.close();
}

console.log('\nFind artist: a daily allowance per person');
{
  const engine = new Engine(new MemoryStore(), { runner: { pace: () => 0, backoffMs: 0 }, providers: () => ({ mode: 'live', providers: [], notes: [] }) });
  await engine.init();
  for (const [id, name, role] of [['u-o', 'Owner', 'System Owner'], ['u-a', 'Ana', 'Admin'], ['u-u', 'Uday', 'User']] as const) await engine.addUser({ id, name, role });
  const rows = ['X1,Artist One', 'X2,Artist Two', 'X3,Artist Three', 'X4,Artist Four'].map((r, i) => `${r},Singer,TQ${i},Song Number ${i},Some Label,Some Distributor`).join('\n');
  await engine.upload({ filename: 'allowance.csv', bytes: new TextEncoder().encode(`artist_id,artist_name,artist_role,track_id,title,label,distributor\n${rows}\n`) }, 'u-o');
  await engine.command('setDiscoverySettings', 'u-a', { perPersonDaily: 2 });
  const cid = (a: string) => engine.m.idx.caseByBackendId.get(a)!;
  await engine.command('startDiscovery', 'u-u', { caseId: cid('X1') });
  await engine.command('startDiscovery', 'u-u', { caseId: cid('X2') });
  const third = await engine.command('startDiscovery', 'u-u', { caseId: cid('X3') }).then(() => null, e => (e as Error).message);
  check('a User’s third search in 24 hours is refused with the reason', !!third && /limit is 2 per person/.test(third), third);
  check('the artist page shows Find artist as unavailable with the same reason', (engine.query('caseDetail', 'u-u', { id: cid('X3') }) as any).actions.some((a: any) => a.id === 'findArtist' && a.disabled && /limit/.test(a.disabled)));
  check('other people keep their own allowance', !!(await engine.command('startDiscovery', 'u-a', { caseId: cid('X3') })).id);
  await engine.idle();
  check('the System Owner has no daily limit', !!(await engine.command('startDiscovery', 'u-o', { caseId: cid('X4') })).id);
  check('settings show the limit', (engine.discoveryConfig() as any).perPersonDaily === 2);
  check('only Admins change it', await engine.command('setDiscoverySettings', 'u-u', { perPersonDaily: 0 }).then(() => false, () => true));
  await engine.idle();
}

console.log('\nWhile the workspace is loading');
{
  const engine = new Engine(new MemoryStore());
  let ready = false;
  const server = createApi(engine, new Auth(new MemoryAuthStore(), engine), { ready: () => ready }).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = await fetch(`${base}/api/health`);
  check('health answers 503 "loading" (the web app keeps waiting)', h.status === 503 && (await h.json()).loading === true);
  check('…and so does every other route', (await fetch(`${base}/api/auth/state`)).status === 503);
  await engine.init(); ready = true;
  check('ready → health ok', (await fetch(`${base}/api/health`)).status === 200);
  server.close();
}

console.log('\nUpgrading a workspace with the old roles');
{
  const m = new Model();
  const old = [['o1', 'System Owner'], ['o2', 'System Owner'], ['l', 'G Amplify Lead'], ['op', 'Operator'], ['cr', 'Claim Reviewer'], ['ad', 'Admin']];
  for (const [id, role] of old) m.insert('users', { id, name: id, role } as never);
  m.setMeta('workspace', 'loaded');
  const notes = upgradeWorkspace(m, { userId: 'u-engine', now: '2026-10-07T10:00:00.000Z', today: '2026-10-07' });
  const role = (id: string) => m.get('users', id)?.role;
  check('Lead → Admin, Operator and Claim Reviewer → User, Admin stays', role('l') === 'Admin' && role('op') === 'User' && role('cr') === 'User' && role('ad') === 'Admin');
  check('exactly one System Owner remains (the other becomes Admin)', role('o1') === 'System Owner' && role('o2') === 'Admin');
  check('runs once (noted, then marked done)', notes.some(n => /System Owner, Admin and User/.test(n)) && !upgradeWorkspace(m, { userId: 'u-engine', now: '2026-10-07T10:00:00.000Z', today: '2026-10-07' }).some(n => /roles/.test(n)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
