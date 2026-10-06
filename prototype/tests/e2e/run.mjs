// Runs the four browser flows against the in-memory fixture server (tests/e2e/server.ts): the real UI and API on the
// fictional fixture workspace, restored before each flow. No database, no API keys, no search quota. Needs google-chrome
// and a built web app (npm run test:e2e builds it first).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 4100);
const BASE = `http://localhost:${PORT}/`;
const FILES = `${HERE}files/`;
if (!existsSync(`${ROOT}dist/index.html`)) { console.error('Build the web app first: npx vite build (or npm run test:e2e).'); process.exit(1); }

const server = spawn(process.execPath, [`${ROOT}node_modules/tsx/dist/cli.mjs`, `${HERE}server.ts`], { env: { ...process.env, PORT: String(PORT), E2E_FILES: FILES }, stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 120 && !up; i++) { up = await fetch(`${BASE}api/health`).then(r => r.ok, () => false); if (!up) await new Promise(r => setTimeout(r, 500)); }
if (!up) { console.error(`The fixture server did not start on ${BASE}`); stop(); process.exit(1); }

for (const suite of ['v2-flow', 'discovery', 'outreach', 'interactions']) {
  const r = await fetch(`${BASE}api/admin/reset`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'u-swatantra' }, body: '{}' }).catch(e => ({ ok: false, status: String(e) }));
  if (!r.ok) { console.error(`Could not restore the fixture workspace (${r.status}).`); stop(); process.exit(1); }
  console.log(`\n▶ ${suite}`);
  const code = await new Promise(done => spawn(process.execPath, [`${HERE}${suite}.mjs`, BASE], { env: { ...process.env, E2E_FILES: FILES }, stdio: 'inherit' }).on('exit', done));
  if (code) { stop(); process.exit(code); }
}
console.log('\nAll browser flows passed.');
stop();
