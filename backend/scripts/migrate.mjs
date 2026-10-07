// npm run db:migrate (development): apply the migrations with the settings in ../.env (or backend/.env).
// Neon: migrations need the direct host, derived from the pooled DATABASE_URL by dropping "-pooler" unless DIRECT_URL is set.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

for (const f of ['.env', '../.env']) if (existsSync(f)) process.loadEnvFile(f);
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set (see ../.env.example).'); process.exit(1); }
process.env.DIRECT_URL ||= process.env.DATABASE_URL.replace('-pooler.', '.');
const r = spawnSync('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
