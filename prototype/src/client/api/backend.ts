// Service layer used by every screen: the Express API backed by PostgreSQL (npm run dev / npm start).
// There is no offline copy of the data: when the API cannot be reached the app says so instead of showing anything else.
import type { CommandResult } from '../../domain/commands';
import type { ImportJob } from '../../domain/engine';

export type ImportStep = 'Uploading' | 'Validating' | 'Matching' | 'Detecting changes' | 'Updating cases' | 'Creating tasks' | 'Complete';
export interface UploadOptions { importType: 'Full' | 'Incremental'; exportDate: string; source: string }
export type ImportJobView = Omit<ImportJob, 'userId'>;

export interface Backend {
  query<T>(name: string, params: object, userId: string): Promise<T>;
  command(name: string, params: object, userId: string): Promise<CommandResult>;
  /** Starts a background import and reports the job until it is finished (v2 §39). */
  upload(file: { name: string; bytes: Uint8Array }, opts: UploadOptions, userId: string, onJob: (j: ImportJobView) => void): Promise<ImportJobView>;
  /** Deletes everything and starts with an empty workspace. */
  reset(userId: string): Promise<void>;
}
const finished = (j: ImportJobView) => j.status === 'COMPLETED' || j.status === 'FAILED';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const UNREACHABLE = 'Cannot reach the ArtistFinder API. Check that "npm run dev" is still running in the prototype folder.';

export class ApiError extends Error {}

class ServerBackend implements Backend {
  private async post<T>(url: string, body: object, userId: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': userId }, body: JSON.stringify(body) });
    } catch {
      throw new ApiError(UNREACHABLE);
    }
    const data = await res.json().catch(() => ({ error: res.status === 502 || res.status === 504 ? UNREACHABLE : `Server error ${res.status}` }));
    if (!res.ok) throw new ApiError(data.error ?? `Server error ${res.status}`);
    return data as T;
  }
  query<T>(name: string, params: object, userId: string) { return this.post<T>(`/api/query/${name}`, params, userId); }
  command(name: string, params: object, userId: string) { return this.post<CommandResult>(`/api/command/${name}`, params, userId); }
  async reset(userId: string) { await this.post('/api/admin/reset', {}, userId); }
  async upload(file: { name: string; bytes: Uint8Array }, opts: UploadOptions, userId: string, onJob: (j: ImportJobView) => void): Promise<ImportJobView> {
    const qs = new URLSearchParams({ filename: file.name, importType: opts.importType, exportDate: opts.exportDate, source: opts.source });
    let res: Response;
    try { res = await fetch(`/api/import?${qs}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-user-id': userId }, body: file.bytes as BodyInit }); }
    catch { throw new ApiError(UNREACHABLE); }
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.job) throw new ApiError(d.error ?? `Upload failed (${res.status})`);
    let job: ImportJobView = d.job;
    onJob(job);
    while (!finished(job)) {
      await wait(500);
      const r = await fetch(`/api/import/jobs/${encodeURIComponent(job.id)}`, { headers: { 'x-user-id': userId } }).catch(() => null);
      if (r?.ok) { job = await r.json(); onJob(job); }
    }
    return job;
  }
}

/** Connect to the API. It may still be loading the workspace from PostgreSQL, so keep trying for a while before giving up. */
export async function connect(onStatus: (s: string) => void): Promise<Backend> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2000);
      const res = await fetch('/api/health', { signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok && (await res.json()).mode === 'server') return new ServerBackend();
    } catch { /* not up yet */ }
    onStatus('Waiting for the ArtistFinder API… (npm run dev starts it, together with the database)');
    await wait(1000);
  }
  throw new ApiError('The ArtistFinder API is not running, so there is no data to show. In a terminal, go to the prototype folder and run "npm run dev" (it starts PostgreSQL in Docker and the API), then try again.');
}
