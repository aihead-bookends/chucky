// Key-value storage for the API routes: bug reports always, and published menus and photos when
// there is no Postgres (api/_lib/menus.mjs).
//
// Production: the `kv` table in Neon Postgres (db/schema.sql; also created on first use), through
// api/_lib/db.mjs. Values are kept as the exact JSON text that was written (text, not jsonb: jsonb
// reorders object keys), the format the old Upstash store used, so records copied across by
// `npm run db:import-upstash` read back unchanged. Postgres has no TTL, so each row carries its
// expiry and every read ignores expired rows.
//
// Without DATABASE_URL, Upstash Redis is still used if its env vars are set: it's the deployment
// this one replaces, and the source the import script copies from.
//
// Local dev and tests inject their own store with setStore() (dev/server.mjs uses a JSON file,
// tests use memoryStore()). Nothing in this file touches the filesystem: the Edge runtime has none.
//
// Every store has the same five async methods:
//   get(key) -> value|null     mget(keys) -> [value|null]     set(key, value, {ex}) -> void
//   del(key) -> void            keys(prefix) -> [key]           (+ a `kind` label for /api/health)

import { getDb } from './db.mjs';

const env = (name) => globalThis.process?.env?.[name] || '';

let injected = null;
let cached = null;

export function setStore(store) { injected = store; }

export function getStore() {
  if (injected) return injected;
  const db = getDb();
  if (db) {
    if (!cached || cached.db !== db) cached = { db, store: pgKvStore(db.query) };
    return cached.store;
  }
  // Vercel's Upstash integration has shipped under two naming schemes; accept either pair.
  const url = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
  const token = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return null;
  if (!cached || cached.url !== url || cached.token !== token) cached = { url, token, store: upstashStore(url, token) };
  return cached.store;
}

const parse = (v) => {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
};

// expires_at is milliseconds since the epoch, or null for never. Expired rows are ignored by every
// read and deleted when their prefix is listed.
const KV_SCHEMA = 'CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value text NOT NULL, expires_at bigint)';
const LIVE = '(expires_at IS NULL OR expires_at > $2)';

export function pgKvStore(query, { now = () => Date.now() } = {}) {
  let ready = null;
  async function q(text, params) {
    try { return await query(text, params); }
    catch (e) {
      if (e?.code !== '42P01') throw e;   // undefined_table: a database `npm run db:migrate` hasn't seen yet
      ready ||= query(KV_SCHEMA).catch((err) => { ready = null; throw err; });
      await ready;
      return query(text, params);
    }
  }
  return {
    kind: 'postgres',
    get: async (key) => {
      const rows = await q(`SELECT value FROM kv WHERE key = $1 AND ${LIVE}`, [key, now()]);
      return rows.length ? parse(rows[0].value) : null;
    },
    // in batches: a bug report can carry a ~900KB screenshot
    mget: async (keys) => {
      const found = new Map();
      for (let i = 0; i < keys.length; i += 10) {
        const rows = await q(`SELECT key, value FROM kv WHERE key = ANY($1) AND ${LIVE}`, [keys.slice(i, i + 10), now()]);
        for (const r of rows) found.set(r.key, parse(r.value));
      }
      return keys.map((k) => (found.has(k) ? found.get(k) : null));
    },
    set: async (key, value, { ex } = {}) => {
      await q('INSERT INTO kv (key, value, expires_at) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at',
        [key, JSON.stringify(value), ex ? now() + ex * 1000 : null]);
    },
    del: async (key) => { await q('DELETE FROM kv WHERE key = $1', [key]); },
    // starts_with, not LIKE: the prefixes contain '_', which LIKE reads as a wildcard
    keys: async (prefix) => {
      await q('DELETE FROM kv WHERE starts_with(key, $1) AND expires_at <= $2', [prefix, now()]);
      const rows = await q(`SELECT key FROM kv WHERE starts_with(key, $1) AND ${LIVE}`, [prefix, now()]);
      return rows.map((r) => r.key);
    },
  };
}

export function upstashStore(url, token, fetchImpl = (...a) => fetch(...a)) {
  const base = url.replace(/\/+$/, '');
  async function cmd(...args) {
    const res = await fetchImpl(base, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    let body = null;
    try { body = await res.json(); } catch { /* fall through to the status check */ }
    if (!res.ok || !body || body.error) throw new Error('upstash ' + args[0] + ': ' + (body?.error || 'HTTP ' + res.status));
    return body.result;
  }
  return {
    kind: 'upstash',
    // seconds left before `key` expires, or null if it never does (Redis: -1 none, -2 missing).
    // The import script uses it so a copied bug report keeps its expiry.
    ttl: async (key) => { const s = await cmd('TTL', key); return s >= 0 ? s : null; },
    get: async (key) => parse(await cmd('GET', key)),
    // in batches: a bug report can carry a ~900KB screenshot, and one MGET of every report at once
    // could outgrow a single Upstash response
    mget: async (keys) => {
      const out = [];
      for (let i = 0; i < keys.length; i += 10) out.push(...(await cmd('MGET', ...keys.slice(i, i + 10))).map(parse));
      return out;
    },
    set: async (key, value, { ex } = {}) => {
      const args = ['SET', key, JSON.stringify(value)];
      if (ex) args.push('EX', String(ex));
      await cmd(...args);
    },
    del: async (key) => { await cmd('DEL', key); },
    // SCAN, not KEYS: KEYS blocks the whole database while it walks it.
    keys: async (prefix) => {
      const out = [];
      let cursor = '0';
      for (let i = 0; i < 1000; i++) {
        const [next, batch] = await cmd('SCAN', cursor, 'MATCH', prefix + '*', 'COUNT', '500');
        out.push(...batch);
        cursor = String(next);
        if (cursor === '0') break;
      }
      return [...new Set(out)];   // SCAN may return a key more than once
    },
  };
}

// Values are kept as JSON strings, like Redis, so every read hands back a fresh object — a caller
// that mutates what it read (GET /api/bugs strips `shot`) can never alter what is stored.
// `entries` and `onChange` let dev/filestore.mjs persist the same map to disk.
export function memoryStore({ now = () => Date.now(), entries = {}, onChange = () => {} } = {}) {
  const map = new Map(Object.entries(entries));
  const live = (key) => {
    const e = map.get(key);
    if (!e) return null;
    if (e.exp && e.exp <= now()) { map.delete(key); onChange(map); return null; }
    return e;
  };
  const get = async (key) => { const e = live(key); return e ? JSON.parse(e.v) : null; };
  return {
    kind: 'memory',
    map,
    get,
    mget: async (keys) => Promise.all(keys.map(get)),
    set: async (key, value, { ex } = {}) => {
      map.set(key, { v: JSON.stringify(value), exp: ex ? now() + ex * 1000 : null });
      onChange(map);
    },
    del: async (key) => { if (map.delete(key)) onChange(map); },
    keys: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix) && live(k)),
  };
}
