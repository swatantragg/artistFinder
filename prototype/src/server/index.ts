// ArtistFinder API server: the domain engine on PostgreSQL with the live discovery providers configured in .env.
// Routes: see app.ts. In production the built web app is served from the same port.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../domain/engine';
import { createApi, serveWebApp } from './app';
import { serverProviders } from './providers';
import { PrismaStore } from './store';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// prototype/.env: database URL and discovery keys. Values already set in the environment win.
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const PORT = Number(process.env.PORT ?? 4000);
const engine = new Engine(new PrismaStore(), { providers: getModel => serverProviders(getModel) });
const app = createApi(engine);

const dist = join(root, 'dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) serveWebApp(app, dist);

const t = Date.now();
engine.init().then(how => {
  console.log(`Workspace ${how === 'created' ? 'created (empty: upload an export on the Imports page)' : 'loaded from PostgreSQL'}: ${engine.m.count('cases')} artists (${Date.now() - t} ms)`);
  const cfg = engine.discoveryConfig();
  console.log(cfg.mode === 'live' ? `Artist discovery: LIVE search · ${cfg.providers.map(p => p.label).join(', ')}` : `Artist discovery: OFF · ${cfg.notes[0]}`);
  app.listen(PORT, () => console.log(`ArtistFinder API on http://localhost:${PORT}`));
  // Time-based checks (stale verified profiles reopen their artist) every six hours.
  setInterval(() => { engine.maintain().catch(e => console.error('Maintenance failed:', e)); }, 6 * 3600_000).unref();
}).catch(e => {
  console.error('Could not reach PostgreSQL. Start it with "npm run db:up" and run "npm run db:migrate".');
  console.error(String(e?.message ?? e));
  process.exit(1);
});
