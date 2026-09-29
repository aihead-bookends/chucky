// Storage for the API routes.
//
// Production: Upstash Redis, spoken to over its REST API with plain fetch — no SDK, so the routes
// run on Vercel's Edge runtime with zero dependencies. Values are stored as JSON strings, the same
// wire format @upstash/redis uses, so records written by the previous deployment read back fine.
//
// Local dev and tests inject their own store with setStore() (dev/server.mjs uses a JSON file,
// tests use memoryStore()). Nothing in this file touches the filesystem: the Edge runtime has none.
//
// Every store has the same five async methods:
//   get(key) -> value|null     mget(keys) -> [value|null]     set(key, value, {ex}) -> void
//   del(key) -> void            keys(prefix) -> [key]           (+ a `kind` label for /api/health)

const env = (name) => globalThis.process?.env?.[name] || '';

let injected = null;
let cached = null;

export function setStore(store) { injected = store; }

// Vercel's Upstash integration has shipped under two naming schemes; accept either pair.
export function getStore() {
  if (injected) return injected;
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
