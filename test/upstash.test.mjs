// The Upstash REST client, against a local HTTP server that speaks Upstash's wire protocol
// (POST a JSON command array with a Bearer token, get back {result} or {error}).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { upstashStore, getStore, setStore } from '../api/_lib/store.mjs';
import { setDb } from '../api/_lib/db.mjs';

const TOKEN = 'upstash-token';
const db = new Map();   // key -> { v, exp }
const seen = [];
let server, url;

function run([cmd, ...a]) {
  const live = (k) => { const e = db.get(k); if (e && e.exp && e.exp <= Date.now()) { db.delete(k); return null; } return e || null; };
  switch (cmd) {
    case 'GET': return live(a[0])?.v ?? null;
    case 'MGET': return a.map((k) => live(k)?.v ?? null);
    case 'SET': {
      if (typeof a[1] !== 'string') throw new Error('ERR value must be a string');
      const ex = a[2] === 'EX' ? Date.now() + Number(a[3]) * 1000 : null;
      db.set(a[0], { v: a[1], exp: ex }); return 'OK';
    }
    case 'DEL': return db.delete(a[0]) ? 1 : 0;
    case 'SCAN': {   // two pages, so the client must follow the cursor
      const re = new RegExp('^' + a[2].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const keys = [...db.keys()].filter((k) => re.test(k) && live(k));
      const half = Math.ceil(keys.length / 2);
      return a[0] === '0' ? [keys.length > 1 ? '7' : '0', keys.slice(0, keys.length > 1 ? half : keys.length)] : ['0', keys.slice(half)];
    }
    default: throw new Error('ERR unknown command ' + cmd);
  }
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Unauthorized' })); }
      const command = JSON.parse(body);
      seen.push(command);
      try { res.end(JSON.stringify({ result: run(command) })); }
      catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server.close());

test('set/get round-trips objects as JSON strings, with EX when asked', async () => {
  const s = upstashStore(url, TOKEN);
  await s.set('bug_1', { id: 'bug_1', t: 5 }, { ex: 3888000 });
  assert.deepEqual(seen.at(-1), ['SET', 'bug_1', '{"id":"bug_1","t":5}', 'EX', '3888000']);
  assert.deepEqual(await s.get('bug_1'), { id: 'bug_1', t: 5 });

  await s.set('menu_state_capiche', { state: {} });
  assert.deepEqual(seen.at(-1), ['SET', 'menu_state_capiche', '{"state":{}}'], 'no EX for published state');
  assert.equal(await s.get('missing'), null);
});

test('reads records written by @upstash/redis (JSON-serialised objects)', async () => {
  db.set('bug_legacy', { v: JSON.stringify({ id: 'bug_legacy', desc: 'from the old deploy' }), exp: null });
  const s = upstashStore(url, TOKEN);
  assert.deepEqual(await s.get('bug_legacy'), { id: 'bug_legacy', desc: 'from the old deploy' });
});

test('keys() follows the SCAN cursor and mget() keeps order', async () => {
  const s = upstashStore(url, TOKEN);
  for (const k of ['bug_a', 'bug_b', 'bug_c']) await s.set(k, { k });
  const keys = (await s.keys('bug_')).sort();
  assert.ok(['bug_a', 'bug_b', 'bug_c'].every((k) => keys.includes(k)));
  assert.ok(!keys.includes('menu_state_capiche'));
  assert.ok(seen.some((c) => c[0] === 'SCAN' && c[1] === '7'), 'second SCAN page requested');
  assert.deepEqual(await s.mget(['bug_c', 'nope', 'bug_a']), [{ k: 'bug_c' }, null, { k: 'bug_a' }]);
  assert.deepEqual(await s.mget([]), []);
  // many keys go in batches, and still come back in order
  for (let i = 0; i < 25; i++) await s.set('many_' + i, { i });
  const before = seen.length;
  const many = await s.mget(Array.from({ length: 25 }, (_, i) => 'many_' + i));
  assert.deepEqual(many.map((r) => r.i), Array.from({ length: 25 }, (_, i) => i));
  assert.equal(seen.slice(before).filter((c) => c[0] === 'MGET').length, 3, '25 keys -> 3 MGETs of at most 10');
  await s.del('bug_b');
  assert.equal(await s.get('bug_b'), null);
});

test('errors surface as exceptions (the routes turn them into 502)', async () => {
  await assert.rejects(upstashStore(url, 'wrong-token').get('x'), /Unauthorized/);
  await assert.rejects(upstashStore('http://127.0.0.1:1/', TOKEN).get('x'));
});

test('without Postgres, getStore() picks up either Upstash env var naming scheme', () => {
  setStore(null);
  setDb(null);   // DATABASE_URL takes precedence; this is the no-Postgres fallback
  for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
  assert.equal(getStore(), null);
  process.env.UPSTASH_REDIS_REST_URL = url; process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
  assert.equal(getStore()?.kind, 'upstash');
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.KV_REST_API_URL = url; process.env.KV_REST_API_TOKEN = TOKEN;
  assert.equal(getStore()?.kind, 'upstash');
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  setDb(undefined);
});
