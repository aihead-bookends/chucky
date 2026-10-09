// Postgres for the published menus and drink photos (api/_lib/menus.mjs).
//
// Every caller speaks one small interface, so the menu code never knows which driver is underneath:
//   db.query(text, params) -> rows            one statement
//   db.tx([{ text, params }, …]) -> [rows…]   several statements, all or nothing
//   db.kind                                   'postgres', for /api/health
//
// Production: Neon (added from the Vercel Marketplace, which sets DATABASE_URL), spoken to with
// @neondatabase/serverless over HTTP. That driver runs on the Edge runtime the routes use, where a
// TCP driver can't. Its `transaction()` sends every statement in one request, run as one transaction.
//
// Local dev, the scripts in dev/ and the tests inject a TCP-backed adapter instead (pgAdapter in
// dev/pg.mjs), because Neon's HTTP endpoint only exists for Neon databases, not a local Postgres.
import { neon } from '@neondatabase/serverless';

const env = (name) => globalThis.process?.env?.[name] || '';

let injected;          // undefined = not injected; null = injected "no database"
let cached = null;

export function setDb(db) { injected = db; }

export function getDb() {
  if (injected !== undefined) return injected;
  const url = env('DATABASE_URL') || env('POSTGRES_URL');   // the Neon integration has used both names
  if (!url) return null;
  if (!cached || cached.url !== url) cached = { url, db: neonAdapter(neon(url)) };
  return cached.db;
}

export function neonAdapter(sql) {
  return {
    kind: 'postgres',
    query: (text, params = []) => sql.query(text, params),
    tx: (stmts) => sql.transaction(stmts.map((s) => sql.query(s.text, s.params || []))),
  };
}
