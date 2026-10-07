// ArtistFinder API server: the domain engine on PostgreSQL, accounts and sessions, and the live discovery providers.
// Routes: see app.ts. The web app is served separately (nginx in Docker, Vite in development) and proxies /api here.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../domain/engine';
import { createApi } from './app';
import { Auth, PrismaAuthStore } from './auth';
import { serverProviders } from './providers';
import { PrismaStore } from './store';

// Local development: backend/.env, then the project's .env. Values already set in the environment (Docker) win.
const here = dirname(fileURLToPath(import.meta.url));
for (const f of [join(here, '..', '..', '.env'), join(here, '..', '..', '..', '.env')]) if (existsSync(f)) process.loadEnvFile(f);
const PORT = Number(process.env.PORT ?? 4000);
const flag = (v: string | undefined, dflt: boolean) => v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v);

const store = new PrismaStore();
const engine = new Engine(store, { providers: getModel => serverProviders(getModel) });
const auth = new Auth(new PrismaAuthStore(store.db), engine, { allowSignup: flag(process.env.ALLOW_SIGNUP, true), secureCookie: flag(process.env.COOKIE_SECURE, false) });
let ready = false;
const app = createApi(engine, auth, { ready: () => ready });
// Listen at once: until the workspace is loaded the API answers 503 "loading" and the web app shows that it is waiting.
app.listen(PORT, () => console.log(`ArtistFinder API on http://localhost:${PORT} (loading the workspace…)`));

const t = Date.now();
engine.init().then(how => {
  ready = true;
  console.log(`Workspace ${how === 'created' ? 'created (empty: sign up, then upload an export on the Imports page)' : 'loaded from PostgreSQL'}: ${engine.m.count('cases')} artists (${Date.now() - t} ms)`);
  const cfg = engine.discoveryConfig();
  console.log(cfg.mode === 'live' ? `Artist discovery: LIVE search · ${cfg.providers.map(p => p.label).join(', ')}` : `Artist discovery: OFF · ${cfg.notes[0]}`);
  console.log(`Sign-up: ${auth.allowSignup ? 'open' : 'closed (only the first account, the System Owner, can sign up)'}`);
  console.log('Ready.');
  // Time-based checks (stale verified profiles reopen their artist) every six hours; expired sessions are removed.
  setInterval(() => { engine.maintain().catch(e => console.error('Maintenance failed:', e)); auth.cleanup().catch(e => console.error('Session cleanup failed:', e)); }, 6 * 3600_000).unref();
}).catch(e => {
  console.error('Could not reach PostgreSQL. Check DATABASE_URL and run the migrations ("npm run db:migrate").');
  console.error(String(e?.message ?? e));
  process.exit(1);
});
