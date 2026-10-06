// Small pure helpers shared by browser and server: dates, text normalisation, CSV and SHA-256.

export function todayISO(d: Date = new Date()): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function addWorkingDays(date: string, n: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  let k = 0;
  while (k < n) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) k++; }
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 864e5);
}
/** Timestamp at a given calendar date and hour (local-agnostic, used for seeding history). */
export function at(date: string, hour = 10, minute = 0): string {
  return `${date.slice(0, 10)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

const WS = /\s+/g;
export function clean(v: unknown): string { return String(v ?? '').trim().replace(WS, ' '); }
/** Exact-name key: case and spacing insensitive. */
export function nameKey(s: string): string { return clean(s).normalize('NFC').toLowerCase(); }
/** Similar-spelling key: also ignores punctuation, accents and doubled letters ("Ishitaa Rao" ~ "Ishita Rao"). */
export function similarKey(s: string): string {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '').replace(/(.)\1+/g, '$1');
}
/** Words such as "Official" or "Music" around a name do not make another artist ("Rahul Sharma Official" ~ "Rahul Sharma"). */
const GENERIC_NAME_WORDS = new Set(['official', 'music', 'musics', 'band', 'the', 'live', 'records', 'recordings', 'entertainment', 'studio', 'studios', 'productions', 'production', 'topic', 'vevo', 'tv', 'channel', 'fanpage', 'fan', 'page', 'group']);
export function coreKey(s: string): string {
  const words = nameKey(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const core = words.filter(w => !GENERIC_NAME_WORDS.has(w));
  return (core.length ? core : words).join(' ');
}
export function splitList(v: unknown, sep = ','): string[] {
  const out: string[] = [];
  for (const part of String(v ?? '').split(sep)) { const x = clean(part); if (x && !out.includes(x)) out.push(x); }
  return out;
}
export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
export const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
export function normIsrc(v: unknown): string { return String(v ?? '').replace(/[\s-]/g, '').toUpperCase(); }

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF, BOM); the delimiter can be a comma, semicolon or tab. */
export function parseCsv(text: string, delim = ','): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let field: string;
    if (text[i] === '"') {
      let j = i + 1, buf = '';
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { buf += text.slice(j); j = n; break; }
        buf += text.slice(j, q);
        if (text[q + 1] === '"') { buf += '"'; j = q + 2; } else { j = q + 1; break; }
      }
      field = buf; i = j;
    } else {
      let j = i;
      while (j < n && text[j] !== delim && text[j] !== '\n' && text[j] !== '\r') j++;
      field = text.slice(i, j); i = j;
    }
    row.push(field);
    if (text[i] === delim) { i++; if (i === n) row.push(''); continue; }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    rows.push(row); row = [];
  }
  if (row.length) rows.push(row);
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}
export function csvCell(v: unknown): string { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
export function toCsv(rows: unknown[][]): string { return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
/** SHA-256 of bytes -> hex. Pure JS so the checksum is identical in browser and server. */
export function sha256Hex(bytes: Uint8Array): string {
  const len = bytes.length, total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes); buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000)); dv.setUint32(total - 4, (len << 3) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = W[t - 15], b = W[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, x => x.toString(16).padStart(8, '0')).join('');
}
export function sha256Text(text: string): string { return sha256Hex(new TextEncoder().encode(text)); }

/** Deterministic pseudo-random generator for seed data. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
