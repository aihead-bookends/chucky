// npm run db:migrate — create (or bring up to date) the Postgres tables in db/schema.sql.
// Uses DATABASE_URL from .env or the shell: the Neon database's connection string in production
// (Vercel → Storage → your Neon database → .env.local tab), or a local Postgres for dev.
// Safe to run any number of times: every statement is CREATE … IF NOT EXISTS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './server.mjs';
import { pgAdapter } from './pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(ROOT, '.env'));
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Put the Postgres connection string in .env (see .env.example).');
  process.exit(1);
}

const db = pgAdapter(url);
try {
  // one multi-statement simple query, so the whole schema goes in together
  await db.pool.query(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  const tables = await db.query(`SELECT table_name FROM information_schema.tables
                                 WHERE table_schema = current_schema() ORDER BY table_name`);
  console.log('✔ schema is up to date. Tables: ' + tables.map((t) => t.table_name).join(', '));
} catch (e) {
  console.error('✘ migration failed: ' + (e.message || e));
  process.exitCode = 1;
} finally {
  await db.end();
}
