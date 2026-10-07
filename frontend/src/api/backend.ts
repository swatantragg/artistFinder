// Service layer used by every screen: the Express API backed by PostgreSQL. The browser is signed in with an httpOnly
// session cookie, so requests carry no user id: the server knows who is asking. When the session ends (401) the app
// goes back to the sign-in page. There is no offline copy of the data: when the API cannot be reached the app says so.
import type { CommandResult } from '@domain/commands';
import type { ImportJob } from '@domain/engine';
import type { User } from '@domain/types';

export type ImportStep = 'Uploading' | 'Validating' | 'Matching' | 'Detecting changes' | 'Updating cases' | 'Creating tasks' | 'Complete';
export interface UploadOptions { importType: 'Full' | 'Incremental'; exportDate: string; source: string }
export type ImportJobView = Omit<ImportJob, 'userId'>;
export interface Me extends User { email: string }
export interface AuthState { me: Me | null; firstAccount: boolean; signupOpen: boolean }
export interface Person extends User { email: string | null }

export interface Backend {
  query<T>(name: string, params: object): Promise<T>;
  command(name: string, params: object): Promise<CommandResult>;
  /** Starts a background import and reports the job until it is finished (v2 §39). */
  upload(file: { name: string; bytes: Uint8Array }, opts: UploadOptions, onJob: (j: ImportJobView) => void): Promise<ImportJobView>;
  /** Deletes all data and starts with an empty workspace (people and their accounts stay). */
  reset(): Promise<void>;
  people(): Promise<Person[]>;
  /** System Owner or Admin: add a person (Admin or User) with a first password. */
  addPerson(p: { name: string; email: string; password: string; role: 'Admin' | 'User' }): Promise<Person>;
  /** System Owner only: set someone's password (they are signed out everywhere). */
  setPassword(userId: string, password: string): Promise<string>;
  changePassword(current: string, next: string): Promise<string>;
  logout(): Promise<void>;
}
const finished = (j: ImportJobView) => j.status === 'COMPLETED' || j.status === 'FAILED';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const UNREACHABLE = 'Cannot reach the ArtistFinder API. Check that the server is running ("docker compose up").';

export class ApiError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

async function call<T>(method: 'GET' | 'POST', url: string, body?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(UNREACHABLE);
  }
  const data = await res.json().catch(() => ({ error: res.status === 502 || res.status === 503 || res.status === 504 ? UNREACHABLE : `Server error ${res.status}` }));
  if (!res.ok) throw new ApiError(data.error ?? `Server error ${res.status}`, res.status);
  return data as T;
}

/** Sign-in endpoints (no session needed). */
export const account = {
  state: () => call<AuthState>('GET', '/api/auth/state'),
  login: (email: string, password: string) => call<{ me: Me }>('POST', '/api/auth/login', { email, password }).then(r => r.me),
  signup: (name: string, email: string, password: string) => call<{ me: Me }>('POST', '/api/auth/signup', { name, email, password }).then(r => r.me),
};

class ServerBackend implements Backend {
  /** `onSignedOut` runs once when the server says the session is over (expired, signed out elsewhere, password changed). */
  constructor(private onSignedOut: () => void) {}
  private async guard<T>(p: Promise<T>): Promise<T> {
    try { return await p; } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.onSignedOut();
      throw e;
    }
  }
  private post<T>(url: string, body: object) { return this.guard(call<T>('POST', url, body)); }
  query<T>(name: string, params: object) { return this.post<T>(`/api/query/${name}`, params); }
  command(name: string, params: object) { return this.post<CommandResult>(`/api/command/${name}`, params); }
  async reset() { await this.post('/api/admin/reset', {}); }
  people() { return this.guard(call<Person[]>('GET', '/api/people')); }
  async addPerson(p: { name: string; email: string; password: string; role: 'Admin' | 'User' }) { return (await this.post<{ person: Person }>('/api/people', p)).person; }
  async setPassword(userId: string, password: string) { return (await this.post<{ message: string }>(`/api/people/${encodeURIComponent(userId)}/password`, { password })).message; }
  async changePassword(current: string, next: string) { return (await this.post<{ message: string }>('/api/auth/password', { current, next })).message; }
  async logout() { await call('POST', '/api/auth/logout', {}).catch(() => undefined); }
  async upload(file: { name: string; bytes: Uint8Array }, opts: UploadOptions, onJob: (j: ImportJobView) => void): Promise<ImportJobView> {
    const qs = new URLSearchParams({ filename: file.name, importType: opts.importType, exportDate: opts.exportDate, source: opts.source });
    let res: Response;
    try { res = await fetch(`/api/import?${qs}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file.bytes as BodyInit }); }
    catch { throw new ApiError(UNREACHABLE); }
    const d = await res.json().catch(() => ({ error: res.status === 413 ? 'The file is too large to upload.' : undefined }));
    if (res.status === 401) this.onSignedOut();
    if (!res.ok || !d.job) throw new ApiError(d.error ?? `Upload failed (${res.status})`, res.status);
    let job: ImportJobView = d.job;
    onJob(job);
    while (!finished(job)) {
      await wait(500);
      const r = await fetch(`/api/import/jobs/${encodeURIComponent(job.id)}`, { credentials: 'same-origin' }).catch(() => null);
      if (r?.status === 401) { this.onSignedOut(); throw new ApiError('Your session has ended. Sign in again.', 401); }
      if (r?.ok) { job = await r.json(); onJob(job); }
    }
    return job;
  }
}

export function createBackend(onSignedOut: () => void): Backend { return new ServerBackend(onSignedOut); }

/** Wait for the API. It may still be starting or loading the workspace from PostgreSQL, so keep trying for a while. */
export async function connect(onStatus: (s: string) => void): Promise<void> {
  // Unreachable: give up after about a minute. Loading a large catalogue from the database: keep waiting (up to 20 min).
  for (let attempt = 0, loading = 0; attempt < 60 && loading < 600; ) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3000);
      const res = await fetch('/api/health', { signal: ctl.signal });
      clearTimeout(timer);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.mode === 'server') return;
      if (body?.loading) { loading++; onStatus('Loading the workspace from the database… A large catalogue takes a minute.'); await wait(2000); continue; }
    } catch { /* not up yet */ }
    attempt++;
    onStatus('Waiting for the ArtistFinder API… (it starts together with the database)');
    await wait(1000);
  }
  throw new ApiError('The ArtistFinder API is not running, so there is no data to show. Start the project with "docker compose up --build" and try again.');
}
