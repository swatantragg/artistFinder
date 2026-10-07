// HTTP API for ArtistFinder. Reads and writes go through the shared domain engine; PostgreSQL is the system of record.
//   POST /api/query/:name     read models for each screen
//   POST /api/command/:name   every write (validated, audited, atomic)
//   POST /api/import          raw file upload; returns the background import job (poll GET /api/import/jobs/:id)
//   POST /api/admin/reset     delete all data and start with an empty workspace (System Owner only; people stay)
//   GET  /api/auth/state · POST /api/auth/signup · /login · /logout · /password   accounts and sessions (auth.ts)
//   GET  /api/people · POST /api/people · POST /api/people/:id/password   the team (Settings → People and roles)
//   POST /api/discovery/:caseId/start · GET /api/discovery/:caseId · POST /api/discovery/bulk · GET /api/discovery/config
//                             REST shortcuts to the discovery commands and queries (jobs run in the background)
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import * as XLSX from 'xlsx';
import { RuleError, type Engine } from '../domain/engine';
import { can, viewUser } from '../domain/ops';
import type { Auth } from './auth';

/**
 * The API routes on top of one engine. Every route except health and sign-in needs a signed-in user (auth.ts); writes
 * are recorded under that person. `reset` decides what "start again" loads (the app: an empty workspace).
 */
export function createApi(engine: Engine, auth: Auth, opts: { reset?: () => Promise<{ cases: number }>; ready?: () => boolean } = {}): Express {
  const reset = opts.reset ?? (() => engine.reset('empty'));
  const app = express();
  // Behind the web server's reverse proxy (Docker): the client address comes from X-Forwarded-For.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  // While the workspace is still loading from the database every route answers 503, and the web app waits.
  const ready = opts.ready ?? (() => true);
  app.use('/api', (_req, res, next) => {
    if (ready()) { next(); return; }
    res.status(503).json({ ok: false, loading: true, error: 'ArtistFinder is starting: loading the workspace from the database…' });
  });
  app.use('/api', express.json({ limit: '20mb' }));
  const user = (_req: Request, res: Response): string => res.locals.userId;

  app.get('/api/health', (_req, res) => { res.json({ ok: true, mode: 'server', database: 'postgresql', discovery: engine.discoveryMode }); });

  // Accounts. Sign-up and sign-in set an httpOnly session cookie; the first account is the System Owner.
  app.get('/api/auth/state', async (req, res) => { res.json(await auth.state(auth.tokenOf(req))); });
  app.post('/api/auth/signup', async (req, res) => {
    const { token, me } = await auth.signup(req.body ?? {}, req.header('user-agent'));
    auth.setCookie(res, token);
    res.status(201).json({ me });
  });
  app.post('/api/auth/login', async (req, res) => {
    const { token, me } = await auth.login(req.body ?? {}, req.ip ?? '', req.header('user-agent'));
    auth.setCookie(res, token);
    res.json({ me });
  });
  app.post('/api/auth/logout', async (req, res) => {
    await auth.logout(auth.tokenOf(req));
    auth.clearCookie(res);
    res.json({ ok: true });
  });
  app.post('/api/auth/password', async (req, res) => {
    await auth.changePassword(auth.tokenOf(req), req.body ?? {});
    res.json({ message: 'Password changed. Other devices were signed out.' });
  });

  app.use('/api', auth.requireUser);

  // People: everyone sees the team (the System Owner shows as Admin to others); Admins add people; the owner sets passwords.
  app.get('/api/people', async (req, res) => {
    const people = engine.m.all('users').filter(u => u.role !== 'Automation');
    const emails = await auth.emails(people.map(u => u.id));
    res.json(people.map(u => ({ ...viewUser(engine.m, user(req, res), u), email: emails[u.id] ?? null })));
  });
  app.post('/api/people', async (req, res) => { res.status(201).json({ person: await auth.addPerson(user(req, res), req.body ?? {}) }); });
  app.post('/api/people/:id/password', async (req, res) => { res.json({ message: await auth.setPasswordFor(user(req, res), String(req.params.id), req.body?.password) }); });

  app.post('/api/query/:name', (req, res) => {
    res.json(engine.query(String(req.params.name), user(req, res), req.body ?? {}));
  });

  app.post('/api/command/:name', async (req, res) => {
    res.json(await engine.command(String(req.params.name), user(req, res), req.body ?? {}));
  });

  // Discovery: start returns immediately with the queued job; poll GET /api/discovery/:caseId for progress and results.
  app.get('/api/discovery/config', (_req, res) => { res.json(engine.query('discoveryConfig', undefined)); });
  app.post('/api/discovery/bulk', async (req, res) => { res.json(await engine.command('startBulkDiscovery', user(req, res), req.body ?? {})); });
  app.post('/api/discovery/:caseId/start', async (req, res) => { res.status(202).json(await engine.command('startDiscovery', user(req, res), { caseId: String(req.params.caseId), mode: req.body?.mode === 'refresh' ? 'refresh' : 'full' })); });
  app.get('/api/discovery/:caseId', (req, res) => { const d = engine.query('discoveryDetail', user(req, res), { id: String(req.params.caseId) }); if (!d) { res.status(404).json({ error: 'Case not found.' }); return; } res.json(d); });

  // Uploads return at once with an import job (202); the browser polls GET /api/import/jobs/:id for progress (v2 §39).
  app.post('/api/import', express.raw({ type: () => true, limit: '150mb' }), (req, res) => {
    const filename = String(req.query.filename ?? 'upload.csv');
    const bytes = new Uint8Array(req.body as Buffer);
    if (!bytes.length) { res.status(422).json({ error: 'The file is empty.' }); return; }
    let sheets: { name: string; rows: unknown[][] }[] | undefined;
    if (/\.xlsx?$/i.test(filename)) {
      try {
        const wb = XLSX.read(bytes, { type: 'array' });
        sheets = wb.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', raw: false }) }));
      } catch { res.status(422).json({ error: 'This Excel file could not be read. Save it again as .xlsx or export it as CSV.' }); return; }
    }
    const job = engine.startImport({
      filename, bytes, sheets, importType: req.query.importType === 'Full' ? 'Full' : 'Incremental',
      exportDate: req.query.exportDate ? String(req.query.exportDate) : undefined, source: req.query.source ? String(req.query.source) : undefined,
    }, user(req, res));
    res.status(202).json({ job });
  });
  app.get('/api/import/jobs/:id', (req, res) => {
    const job = engine.importJob(String(req.params.id));
    if (!job) { res.status(404).json({ error: 'Import job not found (it may have finished before a restart: see Imports).' }); return; }
    res.json(job);
  });

  app.post('/api/admin/reset', async (req, res) => {
    if (!can(engine.m, user(req, res), 'resetWorkspace')) { res.status(403).json({ error: 'Only the System Owner can delete all data.' }); return; }
    res.json(await reset());
  });

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown API route.' }); });
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(err); return; }
    if (err instanceof RuleError) { res.status((err as RuleError & { status?: number }).status ?? 422).json({ error: err.message }); return; }
    if ((err as { type?: string })?.type === 'entity.parse.failed') { res.status(400).json({ error: 'The request was not valid JSON.' }); return; }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Nothing was saved.' });
  });
  return app;
}
