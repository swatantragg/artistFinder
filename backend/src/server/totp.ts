// Two-step sign-in: time-based one-time codes (RFC 6238, the format of Google Authenticator, Microsoft Authenticator,
// 1Password …), one-time recovery codes, and encryption of the stored secret when AUTH_SECRET is set.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function fromBase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const STEP_SECONDS = 30;
export function newTotpSecret(): string { return base32(randomBytes(20)); }
export function stepOf(ms = Date.now()): number { return Math.floor(ms / 1000 / STEP_SECONDS); }
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
/** The step of a valid code (one step of clock drift either way), or null. A step at or before `lastStep` is refused (no replay). */
export function verifyTotp(secret: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  const c = code.replace(/\D/g, '');
  if (c.length !== 6) return null;
  const cur = stepOf(now);
  for (const step of [cur, cur - 1, cur + 1]) if (totpCode(secret, step) === c && (lastStep == null || step > lastStep)) return step;
  return null;
}
export function otpauthUri(email: string, secret: string): string {
  const label = encodeURIComponent(`ArtistFinder:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=ArtistFinder&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

/** Ten recovery codes (xxxx-xxxx), each usable once instead of an authenticator code. Only their hashes are stored. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => { const s = base32(randomBytes(5)).toLowerCase(); return `${s.slice(0, 4)}-${s.slice(4, 8)}`; });
}
export function recoveryHash(code: string): string { return createHash('sha256').update(code.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex'); }

/** Secrets at rest: AES-256-GCM with a key from AUTH_SECRET; without it the secret is stored as is (and the server warns). */
export function sealSecret(secret: string, key?: string): string {
  if (!key) return `plain:${secret}`;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}
export function openSecret(sealed: string, key?: string): string {
  if (sealed.startsWith('plain:')) return sealed.slice(6);
  if (!sealed.startsWith('v1:') || !key) throw new Error('Two-step secret is encrypted: AUTH_SECRET is missing or changed.');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
