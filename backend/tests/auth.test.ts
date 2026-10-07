// Accounts, sessions and the signed-in API, tested over HTTP on an in-memory engine and account store (no database).
import type { AddressInfo } from 'node:net';
import { Engine, type Store } from '../src/domain/engine';
import { Model, type Dirty, type Snapshot } from '../src/domain/model';
import { upgradeWorkspace } from '../src/domain/upgrade';
import { createApi } from '../src/server/app';
import { Auth, MemoryAuthStore, SESSION_COOKIE, checkPassword, hashPassword } from '../src/server/auth';

class MemoryStore implements Store {
  async load(): Promise<Snapshot | null> { return null; }
  async save(_d: Dirty) {}
  async replace(_s: Snapshot) {}
}
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`); }
}

async function start(opts: { allowSignup?: boolean } = {}) {
  const engine = new Engine(new MemoryStore());
  await engine.init();
  const accounts = new MemoryAuthStore();
  const auth = new Auth(accounts, engine, opts);
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
  return { engine, accounts, auth, server, browser };
}

console.log('Passwords');
{
  const h = await hashPassword('correct horse battery');
  check('stored as scrypt with a salt, never the password', h.startsWith('scrypt$') && !h.includes('correct horse'));
  check('right password matches', await checkPassword('correct horse battery', h));
  check('wrong password does not', !(await checkPassword('correct horse battery!', h)));
  check('same password, different salt → different hash', h !== await hashPassword('correct horse battery'));
}

console.log('\nA brand-new workspace');
{
  const { engine, accounts, server, browser } = await start();
  const a = browser();
  check('no people at the start (only the discovery engine)', engine.m.all('users').every(u => u.role === 'Automation'));
  const st = await a.call('GET', '/api/auth/state');
  check('state: signed out, first account expected, sign-up open', st.status === 200 && st.json.me === null && st.json.firstAccount === true && st.json.signupOpen === true, st.json);
  check('health needs no sign-in', (await a.call('GET', '/api/health')).status === 200);
  for (const [path, method] of [['/api/query/meta', 'POST'], ['/api/command/createCase', 'POST'], ['/api/people', 'GET'], ['/api/discovery/config', 'GET'], ['/api/import?filename=x.csv', 'POST']] as const) {
    check(`${method} ${path.split('?')[0]} needs sign-in (401)`, (await a.call(method, path, method === 'POST' ? {} : undefined)).status === 401);
  }

  const bad = await a.call('POST', '/api/auth/signup', { name: 'Asha Rao', email: 'not-an-email', password: 'long enough pw' });
  check('sign-up checks the email', bad.status === 422 && /valid email/.test(bad.json.error), bad.json);
  const weak = await a.call('POST', '/api/auth/signup', { name: 'Asha Rao', email: 'asha@example.com', password: 'short' });
  check('sign-up checks the password length', weak.status === 422 && /at least 8/.test(weak.json.error), weak.json);
  check('no account or person was created by failed sign-ups', accounts.accounts.size === 0 && engine.m.count('users') === 1);

  const s1 = await a.call('POST', '/api/auth/signup', { name: '  Asha   Rao ', email: ' Asha@Example.com ', password: 'long enough pw' });
  check('first sign-up → System Owner, signed in', s1.status === 201 && s1.json.me.role === 'System Owner' && s1.json.me.name === 'Asha Rao' && s1.json.me.email === 'asha@example.com', s1.json);
  check('session cookie is httpOnly + SameSite=Lax', !!s1.setCookie && s1.setCookie.startsWith(`${SESSION_COOKIE}=`) && /HttpOnly/i.test(s1.setCookie) && /SameSite=Lax/i.test(s1.setCookie), s1.setCookie);
  check('only a hash of the session token is stored', [...accounts.sessions.keys()].every(id => !a.cookie.includes(id)) && accounts.sessions.size === 1);
  const me = (await a.call('GET', '/api/auth/state')).json;
  check('state now shows the signed-in person', me.me?.email === 'asha@example.com' && me.firstAccount === false);
  const meta = await a.call('POST', '/api/query/meta', {});
  check('API works when signed in: meta.me is the signed-in person', meta.status === 200 && meta.json.me?.id === s1.json.me.id, meta.json?.me);

  const created = await a.call('POST', '/api/command/createCase', { name: 'Fictional Artist' });
  const auditRow = engine.m.all('audit').find(x => x.caseId === created.json?.caseId);
  check('writes are recorded under the signed-in person', created.status === 200 && auditRow?.userId === s1.json.me.id, created.json);
  check('a request cannot act as someone else (x-user-id is ignored)', (await a.call('POST', '/api/query/meta', {}, { 'x-user-id': 'u-engine' })).json.me?.id === s1.json.me.id);

  const b = browser();
  const dup = await b.call('POST', '/api/auth/signup', { name: 'Other', email: 'ASHA@example.com', password: 'another password' });
  check('the same email cannot sign up twice', dup.status === 422 && /already exists/.test(dup.json.error), dup.json);
  const s2 = await b.call('POST', '/api/auth/signup', { name: 'Ravi K', email: 'ravi@example.com', password: 'ravi password 1' });
  check('later sign-ups are Users', s2.status === 201 && s2.json.me.role === 'User', s2.json);
  check('a User cannot reset the workspace', (await b.call('POST', '/api/admin/reset', {})).status === 403);
  const promote = await b.call('POST', '/api/command/setUserRole', { userId: s2.json.me.id, role: 'Admin' });
  check('a User cannot change roles', promote.status === 422 && /cannot do this/.test(promote.json.error), promote.json);
  const userAdds = await b.call('POST', '/api/people', { name: 'Nope', email: 'nope@example.com', password: 'nope password', role: 'User' });
  check('a User cannot add people', userAdds.status === 422 && /Only an Admin/.test(userAdds.json.error), userAdds.json);
  const asUser = await b.call('GET', '/api/people');
  check('a User sees the team, the System Owner shown as Admin', asUser.status === 200 && asUser.json.find((p: any) => p.id === s1.json.me.id)?.role === 'Admin' && !JSON.stringify(asUser.json).includes('System Owner'), asUser.json);
  const userMeta = (await b.call('POST', '/api/query/meta', {})).json;
  check('…also in meta (no "System Owner" anywhere for a User)', !JSON.stringify(userMeta.users).includes('System Owner') && userMeta.me.role === 'User');
  check('the System Owner sees their own role', (await a.call('GET', '/api/people')).json.find((p: any) => p.id === s1.json.me.id)?.role === 'System Owner');
  check('…and a User can still deduplicate (identity decisions) but not import', userMeta.permissions.identityDecision === true && userMeta.permissions.import === false && userMeta.permissions.manageUsers === false);

  const added = await a.call('POST', '/api/people', { name: 'Meera Iyer', email: 'Meera@Example.com', password: 'first password', role: 'Admin' });
  check('the System Owner adds an Admin', added.status === 201 && added.json.person.role === 'Admin' && added.json.person.email === 'meera@example.com', added.json);
  const noOwner = await a.call('POST', '/api/people', { name: 'Two', email: 'two@example.com', password: 'two password', role: 'System Owner' });
  check('nobody can be added as System Owner (there is only one)', noOwner.status === 422 && /Admin or User/.test(noOwner.json.error), noOwner.json);
  check('adding a person is audited', engine.m.all('audit').some(x => x.action === 'Person added' && x.entityId === added.json.person.id && x.userId === s1.json.me.id));
  const m = browser();
  check('the added person signs in with the password they were given', (await m.call('POST', '/api/auth/login', { email: 'meera@example.com', password: 'first password' })).json?.me?.role === 'Admin');
  const adminSees = await m.call('GET', '/api/people');
  check('an Admin sees the System Owner as Admin', adminSees.json.find((p: any) => p.id === s1.json.me.id)?.role === 'Admin' && !JSON.stringify(adminSees.json).includes('System Owner'), adminSees.json);
  const adminMeta = (await m.call('POST', '/api/query/meta', {})).json;
  check('…an Admin can manage people but not passwords or delete all data', adminMeta.permissions.manageUsers && !adminMeta.permissions.managePasswords && !adminMeta.permissions.resetWorkspace);
  const adminAdds = await m.call('POST', '/api/people', { name: 'Kiran Rao', email: 'kiran@example.com', password: 'kiran password', role: 'User' });
  check('an Admin adds a User', adminAdds.status === 201 && adminAdds.json.person.role === 'User', adminAdds.json);
  const kiran = adminAdds.json.person.id;
  const up = await m.call('POST', '/api/command/setUserRole', { userId: kiran, role: 'Admin' });
  check('an Admin makes a User an Admin', up.status === 200 && engine.m.get('users', kiran)?.role === 'Admin', up.json);
  const down = await m.call('POST', '/api/command/setUserRole', { userId: kiran, role: 'User' });
  const downOwner = await m.call('POST', '/api/command/setUserRole', { userId: s1.json.me.id, role: 'User' });
  check('an Admin cannot change another Admin’s role…', down.status === 422 && /Only the System Owner/.test(down.json.error), down.json);
  check('…nor the owner’s, with the very same answer (the owner stays hidden)', downOwner.status === 422 && downOwner.json.error === down.json.error, downOwner.json);
  const ownerDown = await a.call('POST', '/api/command/setUserRole', { userId: kiran, role: 'User' });
  check('the System Owner changes an Admin back to User', ownerDown.status === 200 && engine.m.get('users', kiran)?.role === 'User', ownerDown.json);
  const self = await a.call('POST', '/api/command/setUserRole', { userId: s1.json.me.id, role: 'Admin' });
  check('the System Owner’s role never changes', self.status === 422 && engine.m.get('users', s1.json.me.id)?.role === 'System Owner', self.json);
  const toOwner = await a.call('POST', '/api/command/setUserRole', { userId: kiran, role: 'System Owner' });
  check('nobody can be made System Owner', toOwner.status === 422, toOwner.json);
  check('role changes are audited', engine.m.all('audit').some(x => x.action === 'Role changed' && x.entityId === kiran && x.to === 'Admin'));

  const k = browser();
  await k.call('POST', '/api/auth/login', { email: 'kiran@example.com', password: 'kiran password' });
  const adminPw = await m.call('POST', `/api/people/${kiran}/password`, { password: 'admin chose this' });
  check('an Admin cannot set other people’s passwords', adminPw.status === 422 && /Only the System Owner/.test(adminPw.json.error), adminPw.json);
  const ownerPw = await a.call('POST', `/api/people/${kiran}/password`, { password: 'owner chose this' });
  check('the System Owner sets someone’s password', ownerPw.status === 200, ownerPw.json);
  check('…that person is signed out everywhere', (await k.call('POST', '/api/query/meta', {})).status === 401);
  check('…and signs in with the new password only', (await browser().call('POST', '/api/auth/login', { email: 'kiran@example.com', password: 'kiran password' })).status === 422
    && (await browser().call('POST', '/api/auth/login', { email: 'kiran@example.com', password: 'owner chose this' })).status === 200);
  check('…audited', engine.m.all('audit').some(x => x.action === 'Password set by the System Owner' && x.entityId === kiran));
  check('an Admin cannot delete all data', (await m.call('POST', '/api/admin/reset', {})).status === 403);

  const r = await a.call('POST', '/api/admin/reset', {});
  check('reset deletes data but keeps people and accounts', r.status === 200 && engine.m.count('cases') === 0 && engine.m.get('users', s1.json.me.id)?.role === 'System Owner' && accounts.accounts.size === 4);
  check('still signed in after a reset', (await a.call('POST', '/api/query/meta', {})).json.me?.id === s1.json.me.id);

  const before = accounts.sessions.size;
  const out = await a.call('POST', '/api/auth/logout', {});
  check('sign out clears the cookie and ends the session', out.status === 200 && a.cookie === '' && accounts.sessions.size === before - 1);
  check('after sign out the API answers 401', (await a.call('POST', '/api/query/meta', {})).status === 401);
  const wrong = await a.call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'nope nope nope' });
  check('wrong password → one message for both cases', wrong.status === 422 && wrong.json.error === 'Email or password is wrong.', wrong.json);
  const unknown = await a.call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever pw' });
  check('unknown email → the same message', unknown.status === 422 && unknown.json.error === 'Email or password is wrong.');
  const ok = await a.call('POST', '/api/auth/login', { email: 'ASHA@example.com', password: 'long enough pw' });
  check('sign in (email in any case) → signed in again', ok.status === 200 && ok.json.me.role === 'System Owner' && !!a.cookie, ok.json);

  const c = browser();
  await c.call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'long enough pw' });
  const pw = await a.call('POST', '/api/auth/password', { current: 'long enough pw', next: 'a brand new password' });
  check('change password', pw.status === 200, pw.json);
  check('…other devices are signed out', (await c.call('POST', '/api/query/meta', {})).status === 401);
  check('…this device stays signed in', (await a.call('POST', '/api/query/meta', {})).status === 200);
  check('…old password no longer works', (await browser().call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'long enough pw' })).status === 422);
  check('…new password works', (await browser().call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'a brand new password' })).status === 200);

  const forged = browser();
  const f = await forged.call('POST', '/api/query/meta', {}, { cookie: `${SESSION_COOKIE}=made-up-token` });
  check('a made-up session token is refused', f.status === 401);

  const spam = browser();
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await spam.call('POST', '/api/auth/login', { email: 'ravi@example.com', password: `guess ${i} wrong` })).status;
  check('too many wrong passwords → 429 for a while', last === 429, last);
  const blocked = await spam.call('POST', '/api/auth/login', { email: 'ravi@example.com', password: 'ravi password 1' });
  check('…even the right password waits', blocked.status === 429);
  check('…other accounts are not blocked', (await spam.call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'a brand new password' })).status === 200);
  check('broken JSON → 400, not a crash', (await browser().call('POST', '/api/auth/login', '{nope', { 'content-type': 'application/json' })).status === 400);
  server.close();
}

console.log('\nSign-up closed (ALLOW_SIGNUP=false)');
{
  const { server, browser } = await start({ allowSignup: false });
  const a = browser();
  check('first account can still sign up (someone must own the workspace)', (await a.call('GET', '/api/auth/state')).json.signupOpen === true);
  check('first sign-up → System Owner', (await a.call('POST', '/api/auth/signup', { name: 'Owner', email: 'owner@example.com', password: 'owner password' })).json?.me?.role === 'System Owner');
  const b = browser();
  check('then sign-up shows as closed', (await b.call('GET', '/api/auth/state')).json.signupOpen === false);
  const s = await b.call('POST', '/api/auth/signup', { name: 'Late', email: 'late@example.com', password: 'late password' });
  check('…and is refused with the reason', s.status === 422 && /Sign-up is closed/.test(s.json.error), s.json);
  server.close();
}

console.log('\nTwo first sign-ups at the same moment');
{
  const { engine, server, browser } = await start();
  const [x, y] = await Promise.all([
    browser().call('POST', '/api/auth/signup', { name: 'One', email: 'one@example.com', password: 'password one' }),
    browser().call('POST', '/api/auth/signup', { name: 'Two', email: 'two@example.com', password: 'password two' }),
  ]);
  check('exactly one becomes System Owner', [x.json.me.role, y.json.me.role].sort().join() === 'System Owner,User', [x.json, y.json]);
  check('both are people in the workspace', engine.m.all('users').filter(u => u.role !== 'Automation').length === 2);
  server.close();
}

console.log('\nWhile the workspace is loading');
{
  const engine = new Engine(new MemoryStore());
  let ready = false;
  const server = createApi(engine, new Auth(new MemoryAuthStore(), engine), { ready: () => ready }).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = await fetch(`${base}/api/health`);
  const body = await h.json();
  check('health answers 503 "loading" (the web app keeps waiting)', h.status === 503 && body.loading === true);
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
