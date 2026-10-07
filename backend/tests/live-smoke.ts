// Live provider smoke check: one real call per configured provider, to confirm the keys in .env work.
// Spends a little quota (1 web search, 1 Spotify search, 1 YouTube search = 100 units) and writes nothing to the database.
//   npx tsx tests/live-smoke.ts ["artist name"]
import { existsSync } from 'node:fs';
import { Model } from '../src/domain/model';
import type { SearchRequest } from '../src/domain/discovery/queries';
import { serverProviders } from '../src/server/providers';

// backend/.env, then the project's .env (where docker compose reads it).
for (const f of ['../.env', '../../.env']) { const env = new URL(f, import.meta.url).pathname; if (existsSync(env)) process.loadEnvFile(env); }
const name = process.argv[2] ?? 'Arijit Singh';
const set = serverProviders(() => new Model());
if (set.mode !== 'live') { console.log(`Live search is not configured: ${set.notes[0]}`); process.exit(1); }
const req: SearchRequest = { query: `"${name}"`, kind: 'name', priority: 1, subject: 'artist', subjectName: name, subjectKey: 'smoke' } as SearchRequest;
const ctx = { caseId: 'smoke', jobId: 'smoke', version: 1, bulk: false, attempt: 1 } as never;
let failed = 0;
for (const p of set.providers) {
  if (p.kind === 'internal' || p.kind === 'crawler' || !p.search) continue;
  try {
    const hits = await p.search(req, ctx);
    console.log(`✓ ${p.label}: ${hits.length} result${hits.length === 1 ? '' : 's'} for “${name}”${hits[0] ? ` (first: ${hits[0].platform} · ${hits[0].displayName ?? hits[0].title})` : ''}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${p.label}: ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
