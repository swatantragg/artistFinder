// HTTP API for ArtistFinder. Reads and writes go through the shared domain engine; PostgreSQL is the system of record.
//   POST /api/query/:name     read models for each screen
//   POST /api/command/:name   every write (validated, audited, atomic)
//   POST /api/import          raw file upload; returns the background import job (poll GET /api/import/jobs/:id)
//   POST /api/admin/reset     delete everything and start with an empty workspace (System Owner / Admin)
//   POST /api/discovery/:caseId/start · GET /api/discovery/:caseId · POST /api/discovery/bulk · GET /api/discovery/config
//                             REST shortcuts to the discovery commands and queries (jobs run in the background)
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import * as XLSX from 'xlsx';
import { RuleError, type Engine } from '../domain/engine';

/** The API routes on top of one engine. `reset` decides what "start again" loads (the app: an empty workspace). */
export function createApi(engine: Engine, opts: { reset?: () => Promise<{ cases: number }> } = {}): Express {
  const reset = opts.reset ?? (() => engine.reset('empty'));
  const app = express();
  app.use('/api', express.json({ limit: '20mb' }));
  const user = (req: Request) => (req.header('x-user-id') || undefined);

  app.get('/api/health', (_req, res) => { res.json({ ok: true, mode: 'server', database: 'postgresql', discovery: engine.discoveryMode }); });

  app.post('/api/query/:name', (req, res) => {
    res.json(engine.query(String(req.params.name), user(req), req.body ?? {}));
  });

  app.post('/api/command/:name', async (req, res) => {
    res.json(await engine.command(String(req.params.name), user(req), req.body ?? {}));
  });

  // Discovery: start returns immediately with the queued job; poll GET /api/discovery/:caseId for progress and results.
  app.get('/api/discovery/config', (_req, res) => { res.json(engine.query('discoveryConfig', undefined)); });
  app.post('/api/discovery/bulk', async (req, res) => { res.json(await engine.command('startBulkDiscovery', user(req), req.body ?? {})); });
  app.post('/api/discovery/:caseId/start', async (req, res) => { res.status(202).json(await engine.command('startDiscovery', user(req), { caseId: String(req.params.caseId), mode: req.body?.mode === 'refresh' ? 'refresh' : 'full' })); });
  app.get('/api/discovery/:caseId', (req, res) => { const d = engine.query('discoveryDetail', user(req), { id: String(req.params.caseId) }); if (!d) { res.status(404).json({ error: 'Case not found.' }); return; } res.json(d); });

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
    }, user(req));
    res.status(202).json({ job });
  });
  app.get('/api/import/jobs/:id', (req, res) => {
    const job = engine.importJob(String(req.params.id));
    if (!job) { res.status(404).json({ error: 'Import job not found (it may have finished before a restart: see Imports).' }); return; }
    res.json(job);
  });

  app.post('/api/admin/reset', async (req, res) => {
    const u = engine.m.get('users', user(req) ?? '');
    if (!u || !['System Owner', 'Admin'].includes(u.role)) { res.status(403).json({ error: 'Only the System Owner or an Admin can reset the workspace.' }); return; }
    res.json(await reset());
  });

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown API route.' }); });
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(err); return; }
    if (err instanceof RuleError) { res.status(422).json({ error: err.message }); return; }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Nothing was saved.' });
  });
  return app;
}

/** Serve the built web app from the same port (production, and the end-to-end test server). */
export function serveWebApp(app: Express, dist: string) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => { res.sendFile(`${dist}/index.html`); });
}
