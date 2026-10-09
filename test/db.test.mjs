// The Postgres store for published menus and photos (api/_lib/menus.mjs, db/schema.sql).
//
// flattenState runs everywhere. The rest needs a real Postgres: set TEST_DATABASE_URL (a database
// you don't mind tests writing to, e.g. postgres://postgres:<pw>@localhost:5432/postgres). Each run
// works in its own throwaway schema and drops it afterwards; without the variable those tests skip.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { flattenState } from '../api/_lib/menus.mjs';
import { setDb } from '../api/_lib/db.mjs';
import { setStore, memoryStore, getStore } from '../api/_lib/store.mjs';
import { setPhotoStore } from '../api/_lib/photos.mjs';
import menuState from '../api/menu-state/[editor].mjs';
import postPhoto from '../api/photo.mjs';
import getPhoto from '../api/photo/[id].mjs';
import health from '../api/health.mjs';

// ---------------- flattenState: one row per editable value ----------------

// rebuild a state from its rows: every value must be there, at a path that leads back to it
function unflatten(rows) {
  const un = (k) => k.replace(/~1/g, '/').replace(/~0/g, '~');
  const root = {};
  for (const { path, value } of rows) {
    const keys = path.split('/').map(un);
    let o = root;
    keys.forEach((k, i) => {
      if (i === keys.length - 1) o[k] = value;
      else o = o[k] ??= /^\d+$/.test(keys[i + 1]) ? [] : {};
    });
  }
  return root;
}

test('every editor\'s starting menu flattens to unique paths that rebuild it exactly', () => {
  for (const ed of ['capiche', 'aiko', 'drinks', 'capiche-surat', 'capiche-ahm', 'beshak']) {
    const { state } = JSON.parse(fs.readFileSync(`public/${ed}/start-state.json`, 'utf8'));
    const rows = flattenState(state);
    assert.equal(new Set(rows.map((r) => r.path)).size, rows.length, ed + ': paths are unique');
    assert.deepEqual(unflatten(rows), JSON.parse(JSON.stringify(state)), ed + ': nothing lost');
    for (const r of rows) assert.equal(r.section, r.path.split('/')[0]);
  }
});

test('flattenState: lists of plain values stay whole, lists of objects are split, keys are escaped', () => {
  const rows = flattenState({
    edits: { '1:9': 'CASSATA 2.O', 'a/b~c': 'x' },
    removed: ['1:3', '1:48'],
    markerEdits: { '1:0': ['dairy', 'jain'] },
    added: [{ name: 'HOT CHIPS', allergens: ['dairy'] }],
    persona: { occasion: '', guest: '' },
    qr: { base: {}, added: [] },
  });
  const by = Object.fromEntries(rows.map((r) => [r.path, r.value]));
  assert.deepEqual(by, {
    'edits/1:9': 'CASSATA 2.O', 'edits/a~1b~0c': 'x',
    removed: ['1:3', '1:48'],
    'markerEdits/1:0': ['dairy', 'jain'],
    'added/0/name': 'HOT CHIPS', 'added/0/allergens': ['dairy'],
    'persona/occasion': '', 'persona/guest': '',
    'qr/base': {}, 'qr/added': [],
  });
});

// ---------------- Postgres ----------------

const URL_ = process.env.TEST_DATABASE_URL;
const pgTest = URL_ ? test : test.skip;
const PUBLISH_KEY = 'publish-secret';
const SCHEMA = 'chucky_test_' + process.pid;
let admin, db;

before(async () => {
  if (!URL_) return;
  const { pgAdapter } = await import('../dev/pg.mjs');
  admin = pgAdapter(URL_);
  await admin.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  const u = new URL(URL_);
  u.searchParams.set('options', `-c search_path=${SCHEMA}`);
  db = pgAdapter(u.toString());
  await db.pool.query(fs.readFileSync('db/schema.sql', 'utf8'));
});
after(async () => {
  setDb(undefined); setStore(null); setPhotoStore(undefined);
  if (!URL_) return;
  await db.end();
  await admin.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  process.env.PUBLISH_KEY = PUBLISH_KEY;
  setPhotoStore(null);
  if (!URL_) return;
  await db.pool.query('TRUNCATE menu_versions, menu_version_items, photos, kv');
  setDb(db);
  setStore(null);   // so getStore() is the Postgres kv store, as in production
});

const req = (path, { method = 'GET', body, key } = {}) => new Request('http://test.local' + path, {
  method,
  headers: { ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: 'Bearer ' + key } : {}) },
  body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
});
const json = async (res) => ({ status: res.status, body: await res.json() });
const publish = (editor, body) => menuState(req('/api/menu-state/' + editor, { method: 'POST', key: PUBLISH_KEY, body }));

pgTest('publish, read back, history and ?v= — every version kept, with a row per value', async () => {
  assert.equal((await menuState(req('/api/menu-state/capiche'))).status, 404);
  const s1 = { edits: { '0:16': 'HULK 2.O' }, removed: ['1:3'], added: [], markerEdits: { '0:16': ['dairy', 'chilli'] } };
  const s2 = { edits: { '0:16': 'HULK 3.O', '1:9': 'CASSATA 2.O' }, removed: [], added: [{ name: 'HOT CHIPS', price: '1140' }] };
  const t1 = (await json(await publish('capiche', { state: s1, base: 'v4323752', prev: null }))).body.t;
  const t2 = (await json(await publish('capiche', { state: s2, base: 'v4323752', prev: t1 }))).body.t;
  assert.ok(t2 > t1);

  assert.deepEqual((await json(await menuState(req('/api/menu-state/capiche')))).body, { editor: 'capiche', t: t2, base: 'v4323752', state: s2 });
  assert.deepEqual((await json(await menuState(req('/api/menu-state/capiche?v=' + t1)))).body.state, s1);
  const hist = (await json(await menuState(req('/api/menu-state/capiche?history=1')))).body.versions;
  assert.deepEqual(hist.map((v) => [v.t, v.current, v.edits, v.removed, v.added]), [[t2, true, 2, 0, 1], [t1, false, 1, 1, 0]]);

  const rows = await db.query(`SELECT t, path, value FROM menu_version_items WHERE editor = 'capiche' ORDER BY t, path`);
  assert.deepEqual(rows.map((r) => [r.t, r.path, r.value]), [
    [t1, 'added', []], [t1, 'edits/0:16', 'HULK 2.O'], [t1, 'markerEdits/0:16', ['dairy', 'chilli']], [t1, 'removed', ['1:3']],
    [t2, 'added/0/name', 'HOT CHIPS'], [t2, 'added/0/price', '1140'], [t2, 'edits/0:16', 'HULK 3.O'], [t2, 'edits/1:9', 'CASSATA 2.O'], [t2, 'removed', []],
  ]);
  const chain = await db.query(`SELECT t, parent_t FROM menu_versions WHERE editor = 'capiche' ORDER BY t`);
  assert.deepEqual(chain.map((r) => [r.t, r.parent_t]), [[t1, null], [t2, t1]]);
});

pgTest('a state reads back with its keys in the order it was published', async () => {
  const state = { zeta: 1, alpha: { b: 2, a: 1 }, edits: { '10': 'x', '9': 'y' } };
  await publish('aiko', { state, base: 'v', prev: null });
  const back = await (await menuState(req('/api/menu-state/aiko'))).text();
  assert.ok(back.includes(JSON.stringify(state)), back);
});

pgTest('a stale copy is refused with 409 and writes nothing', async () => {
  const a = (await json(await publish('capiche', { state: { edits: { n: 'A' } }, base: 'v', prev: null }))).body.t;
  const b = (await json(await publish('capiche', { state: { edits: { n: 'B' } }, base: 'v', prev: a }))).body.t;
  for (const prev of [a, null]) {
    const res = await json(await publish('capiche', { state: { edits: { n: 'OLD' } }, base: 'v', prev }));
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.current, { t: b, base: 'v' });
  }
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM menu_versions`))[0].n, 2);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM menu_version_items WHERE value = '"OLD"'`))[0].n, 0);
});

pgTest('two publishes from the same version at the same moment: exactly one lands', async () => {
  const a = (await json(await publish('beshak', { state: { edits: {} }, base: 'v', prev: null }))).body.t;
  for (let round = 0; round < 5; round++) {
    const cur = (await json(await menuState(req('/api/menu-state/beshak')))).body.t;
    const res = await Promise.all([1, 2, 3].map((i) => publish('beshak', { state: { edits: { n: round + '-' + i } }, base: 'v', prev: cur }).then(json)));
    assert.deepEqual(res.map((r) => r.status).sort(), [200, 409, 409], 'round ' + round);
  }
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM menu_versions WHERE editor = 'beshak'`))[0].n, 6);
  assert.ok(a);
});

const jpeg = (n = 1) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 2, 3, 4]);
const sha = (b) => createHash('sha256').update(b).digest('hex');

pgTest('photos without Blob: bytes in Postgres, deduplicated, served back', async () => {
  const bytes = jpeg();
  const up = await json(await postPhoto(req('/api/photo', { method: 'POST', key: PUBLISH_KEY, body: bytes })));
  assert.deepEqual(up.body, { ok: true, id: sha(bytes), size: bytes.length });
  await postPhoto(req('/api/photo', { method: 'POST', key: PUBLISH_KEY, body: bytes }));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM photos'))[0].n, 1);
  const got = await getPhoto(req('/api/photo/' + up.body.id));
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
  assert.equal((await getPhoto(req('/api/photo/' + 'b'.repeat(64)))).status, 404);
});

pgTest('photos with Blob: bytes go to Blob, the row keeps the URL, reads stream from Blob', async () => {
  const blobs = new Map();
  setPhotoStore({
    kind: 'blob',
    save: async (id, bytes, type) => { const url = 'https://blob.test/photos/' + id + (type === 'image/png' ? '.png' : '.jpg'); blobs.set(url, bytes); return url; },
    load: async (url) => (blobs.has(url) ? new Blob([blobs.get(url)]).stream() : null),
  });
  const bytes = jpeg(7);
  const id = (await json(await postPhoto(req('/api/photo', { method: 'POST', key: PUBLISH_KEY, body: bytes })))).body.id;
  const row = (await db.query('SELECT url, bytes FROM photos WHERE id = $1', [id]))[0];
  assert.deepEqual(row, { url: 'https://blob.test/photos/' + id + '.jpg', bytes: null });
  await postPhoto(req('/api/photo', { method: 'POST', key: PUBLISH_KEY, body: bytes }));
  assert.equal(blobs.size, 1, 'a photo already recorded is not uploaded again');
  assert.deepEqual(new Uint8Array(await (await getPhoto(req('/api/photo/' + id))).arrayBuffer()), bytes);
});

pgTest('bug reports live in the kv table, with their expiry', async () => {
  const store = getStore();
  assert.equal(store.kind, 'postgres');
  await store.set('bug_1_a', { desc: 'x' }, { ex: 60 });
  await store.set('bug_2_b', { desc: 'gone' }, { ex: -1 });
  assert.deepEqual(await store.get('bug_1_a'), { desc: 'x' });
  assert.equal(await store.get('bug_2_b'), null, 'expired');
  assert.deepEqual(await store.keys('bug_'), ['bug_1_a']);
  assert.deepEqual(await store.mget(['bug_1_a', 'bug_9_z']), [{ desc: 'x' }, null]);
});

pgTest('health reports Postgres for menus and bug reports, and the schema', async () => {
  const h = (await json(await health(req('/api/health')))).body;
  assert.deepEqual([h.ok, h.store, h.storeOk, h.menus, h.menusOk, h.schema], [true, 'postgres', true, 'postgres', true, true]);
});
