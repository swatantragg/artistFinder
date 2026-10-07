// Password hashing and the password rules. Hashes are scrypt with OWASP's low-memory setting (N=2^14, r=8, p=5: the
// same work as N=2^17 with 16 MiB instead of 128 MiB per sign-in). Older hashes still work and are upgraded on sign-in.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 5, keylen: 64 };
export const MIN_PASSWORD = 12;
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
/** True when a stored hash uses older settings (it is replaced at the next sign-in). */
export function needsRehash(stored: string): boolean {
  const [, N, r, p] = stored.split('$');
  return Number(N) !== SCRYPT.N || Number(r) !== SCRYPT.r || Number(p) !== SCRYPT.p;
}

const COMMON = new Set(['password1234', 'password12345', 'qwertyuiop12', '123456789012', '1234567890123', 'iloveyou1234', 'welcome12345', 'artistfinder', 'goongoonalo1', 'letmein12345', 'adminadmin12', 'administrator']);

export interface PasswordRules {
  /** Ask Have I Been Pwned (k-anonymity: only 5 characters of a SHA-1 hash leave the server) whether it leaked. */
  breachCheck?: boolean;
  fetchFn?: typeof fetch;
}
/** Why a password cannot be used, or null. Applies to new passwords only: existing ones keep working. */
export async function passwordProblem(pw: string, who: { email?: string; name?: string }, rules: PasswordRules = {}): Promise<string | null> {
  if (pw.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'Use a password of at most 200 characters.';
  const low = pw.toLowerCase();
  if (new Set(low).size < 4 || COMMON.has(low)) return 'This password is too easy to guess. Use a few unrelated words.';
  const local = (who.email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 4 && low.includes(local)) return 'Do not use your email address in the password.';
  const first = (who.name ?? '').toLowerCase().split(/\s+/).find(w => w.length >= 4);
  if (first && low.includes(first) && low.replace(first, '').length < 8) return 'Do not build the password around your name.';
  if (rules.breachCheck) {
    const n = await breachCount(pw, rules.fetchFn ?? fetch);
    if (n > 0) return `This password appears in known data breaches (${n.toLocaleString('en')} times). Choose another one.`;
  }
  return null;
}

/** How often a password appears in Have I Been Pwned. Fails open (0) when the service cannot be reached. */
export async function breachCount(pw: string, fetchFn: typeof fetch): Promise<number> {
  const sha1 = createHash('sha1').update(pw).digest('hex').toUpperCase();
  try {
    const res = await fetchFn(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'ArtistFinder' }, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return 0;
    for (const line of (await res.text()).split('\n')) {
      const [suffix, count] = line.trim().split(':');
      if (suffix === sha1.slice(5)) return Number(count) || 0;
    }
  } catch { /* offline: the other rules still apply */ }
  return 0;
}
