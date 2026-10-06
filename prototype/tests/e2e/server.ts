// End-to-end test server: the real API routes and the built web app on the fictional fixture workspace, entirely in
// memory (no PostgreSQL, no API keys, no search quota, never the real catalogue). POST /api/admin/reset restores it.
//   tsx tests/e2e/server.ts      PORT (default 4100) · E2E_FILES: folder for the upload files the flows pick
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { Engine, type Store } from '../../src/domain/engine';
import { toCsv } from '../../src/domain/util';
import { createApi, serveWebApp } from '../../src/server/app';
import { FIXTURE_MEDIA, FIXTURE_XLSX, fixtureFile, fixtureMediaLibraryRows, fixtureXlsxRows } from '../fixtures/catalog';
import { fixtureProviderSet } from '../fixtures/engine';
import { seedFixtures } from '../fixtures/seed';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT ?? 4100);
const memory: Store = { load: async () => null, save: async () => {}, replace: async () => {} };
// Providers answer with a little latency and each step takes at least 320 ms, so the flows can watch the progress.
const engine = new Engine(memory, { providers: g => fixtureProviderSet(g, true), seed: () => seedFixtures(), runner: { pace: j => (j.bulkId ? 0 : 320) } });
const app = createApi(engine, { reset: () => engine.reset('seed') });
serveWebApp(app, join(root, 'dist'));

// The export files the flows upload through the real file picker.
const files = process.env.E2E_FILES ?? join(root, 'tests', 'e2e', 'files');
mkdirSync(files, { recursive: true });
writeFileSync(join(files, FIXTURE_MEDIA.filename), toCsv(fixtureMediaLibraryRows()));
for (const k of ['b002', 'b003', 'b004'] as const) { const f = fixtureFile(k); writeFileSync(join(files, f.filename), f.csv); }
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fixtureXlsxRows()), 'Artists');
writeFileSync(join(files, FIXTURE_XLSX.filename), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);

engine.init().then(() => app.listen(PORT, () => console.log(`E2E fixture server on http://localhost:${PORT} (in memory, files in ${files})`)));
