// The /api routes, called directly with Web Requests against an in-memory store.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setStore, memoryStore } from '../api/_lib/store.mjs';
import postBug from '../api/bug.mjs';
import listBugs from '../api/bugs.mjs';
import patchBug from '../api/bug/[id].mjs';
import menuState, { EDITORS, HIST_KEEP, HIST_TTL_S } from '../api/menu-state/[editor].mjs';
import health from '../api/health.mjs';
import { TTL_S, MAX_BODY } from '../api/_lib/bugs.mjs';

const BASE = 'http://test.local';
const BUG_KEY = 'bug-secret';
const PUBLISH_KEY = 'publish-secret';
let store;

beforeEach(() => {
  process.env.BUG_KEY = BUG_KEY;
  process.env.PUBLISH_KEY = PUBLISH_KEY;
  store = memoryStore();
  setStore(store);
});

const req = (path, { method = 'GET', body, key, headers = {} } = {}) =>
  new Request(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: 'Bearer ' + key } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const json = async (res) => ({ status: res.status, body: await res.json(), headers: res.headers });

const report = (extra = {}) => postBug(req('/api/bug', { method: 'POST', body: { editor: 'capiche', page: 1, desc: 'price overlaps', url: 'https://x.test/capiche/', ...extra } }));

// ---- POST /api/bug ----

test('a report is stored with a 45-day expiry and clamped fields', async () => {
  const shot = 'data:image/jpeg;base64,AAAA';
  const { status, body } = await json(await report({ shot, state: { edits: { a: 'B' } } }));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.id, /^bug_\d+_[a-z0-9]+$/);
  const rec = await store.get(body.id);
  assert.deepEqual(
    { editor: rec.editor, page: rec.page, desc: rec.desc, status: rec.status, shot: rec.shot, state: rec.state },
    { editor: 'capiche', page: 1, desc: 'price overlaps', status: 'new', shot, state: { edits: { a: 'B' } } },
  );
  const ttl = (store.map.get(body.id).exp - Date.now()) / 1000;
  assert.ok(ttl > TTL_S - 5 && ttl <= TTL_S, 'expires in ~45 days');
});

test('hostile report fields are neutralised', async () => {
  const { body } = await json(await report({
    url: 'javascript:alert(1)', shot: 'data:text/html;base64,PHNjcmlwdD4=', editor: 'x'.repeat(500),
    desc: 'd'.repeat(5000), page: 'nope', state: 'not an object',
  }));
  const rec = await store.get(body.id);
  assert.equal(rec.url, '');
  assert.equal(rec.shot, null);
  assert.equal(rec.editor.length, 60);
  assert.equal(rec.desc.length, 2000);
  assert.equal(rec.page, null);
  assert.equal(rec.state, null);
});

test('oversized state is replaced by a marker, not stored', async () => {
  const { body } = await json(await report({ state: { blob: 'x'.repeat(250_000) } }));
  const rec = await store.get(body.id);
  assert.equal(rec.state.truncated, true);
});

test('report rejects: bad json 400, no description 400, too large 413, GET 405', async () => {
  assert.equal((await postBug(req('/api/bug', { method: 'POST', body: '{nope' }))).status, 400);
  assert.equal((await report({ desc: '   ' })).status, 400);
  assert.equal((await postBug(req('/api/bug', { method: 'POST', body: 'x'.repeat(MAX_BODY + 1) }))).status, 413);
  assert.equal((await postBug(req('/api/bug'))).status, 405);
  assert.equal(store.map.size, 0);
});

test('CORS preflight is answered on every route', async () => {
  for (const [h, p] of [[postBug, '/api/bug'], [listBugs, '/api/bugs'], [patchBug, '/api/bug/bug_1700000000000_abc'], [menuState, '/api/menu-state/capiche'], [health, '/api/health']]) {
    const res = await h(req(p, { method: 'OPTIONS' }));
    assert.equal(res.status, 204, p);
    assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
  }
});

// ---- GET /api/bugs ----

test('bug list needs BUG_KEY — header or legacy ?k=', async () => {
  await report();
  assert.equal((await listBugs(req('/api/bugs'))).status, 403);
  assert.equal((await listBugs(req('/api/bugs', { key: 'wrong' }))).status, 403);
  assert.equal((await listBugs(req('/api/bugs', { key: PUBLISH_KEY }))).status, 403, 'publish key does not open the queue');
  assert.equal((await listBugs(req('/api/bugs', { key: BUG_KEY }))).status, 200);
  assert.equal((await listBugs(req('/api/bugs?k=' + BUG_KEY))).status, 200);
});

test('an unset BUG_KEY locks the queue instead of opening it', async () => {
  delete process.env.BUG_KEY;
  assert.equal((await listBugs(req('/api/bugs', { key: '' }))).status, 403);
  assert.equal((await listBugs(req('/api/bugs?k='))).status, 403);
  assert.equal((await listBugs(req('/api/bugs?k=undefined'))).status, 403);
});

test('bug list is newest first, filterable, and lite drops snapshots without touching the store', async () => {
  const a = (await json(await report({ desc: 'first', shot: 'data:image/png;base64,AAAA' }))).body.id;
  await new Promise((r) => setTimeout(r, 5));
  const b = (await json(await report({ desc: 'second' }))).body.id;
  await store.set('menu_state_capiche', { editor: 'capiche', t: 1, state: {} });   // must not show up

  const all = (await json(await listBugs(req('/api/bugs', { key: BUG_KEY })))).body.bugs;
  assert.deepEqual(all.map((x) => x.id), [b, a]);

  const lite = (await json(await listBugs(req('/api/bugs?lite=1', { key: BUG_KEY })))).body.bugs;
  assert.ok(lite.every((x) => !('shot' in x)));
  assert.equal((await store.get(a)).shot, 'data:image/png;base64,AAAA', 'stored snapshot survives a lite listing');

  await patchBug(req('/api/bug/' + a, { method: 'PATCH', key: BUG_KEY, body: { status: 'fixed' } }));
  const fixed = (await json(await listBugs(req('/api/bugs?status=fixed', { key: BUG_KEY })))).body.bugs;
  assert.deepEqual(fixed.map((x) => x.id), [a]);
});

test('records older than 45 days are swept from the list', async () => {
  const old = { id: 'bug_1000000000000_old', t: Date.now() - (TTL_S + 60) * 1000, status: 'new', desc: 'old' };
  await store.set(old.id, old);
  const { body } = await json(await listBugs(req('/api/bugs', { key: BUG_KEY })));
  assert.equal(body.bugs.length, 0);
  assert.equal(await store.get(old.id), null);
});

// ---- PATCH /api/bug/:id ----

test('triage update changes only status / approved / resolution', async () => {
  const id = (await json(await report())).body.id;
  const before = await store.get(id);
  const res = await json(await patchBug(req('/api/bug/' + id, {
    method: 'PATCH', key: BUG_KEY,
    body: { status: 'needs-auth', approved: true, resolution: 'swap font', id: 'bug_0_hax', t: 'never', shot: 'data:text/html,x', url: 'javascript:x', desc: 'rewritten' },
  })));
  assert.equal(res.status, 200);
  const after = await store.get(id);
  assert.deepEqual(
    { ...after, status: undefined, approved: undefined, resolution: undefined },
    { ...before, status: undefined, approved: undefined, resolution: undefined },
  );
  assert.equal(after.status, 'needs-auth');
  assert.equal(after.approved, true);
  assert.equal(after.resolution, 'swap font');

  await patchBug(req('/api/bug/' + id, { method: 'POST', key: BUG_KEY, body: { status: 'deleted' } }));
  assert.equal((await store.get(id)).status, 'needs-auth', 'unknown status ignored');
});

test('update is gated and only reaches bug records', async () => {
  const id = (await json(await report())).body.id;
  assert.equal((await patchBug(req('/api/bug/' + id, { method: 'PATCH', body: { status: 'fixed' } }))).status, 403);
  assert.equal((await patchBug(req('/api/bug/bug_1700000000000_nope', { method: 'PATCH', key: BUG_KEY, body: {} }))).status, 404);

  // a key-holder must not be able to rewrite the published menu through the bug route
  const published = { editor: 'capiche', t: 1, base: '', state: { edits: {} } };
  await store.set('menu_state_capiche', published);
  const res = await patchBug(req('/api/bug/menu_state_capiche', { method: 'PATCH', key: BUG_KEY, body: { status: 'fixed' } }));
  assert.equal(res.status, 404);
  assert.deepEqual(await store.get('menu_state_capiche'), published);
  assert.equal(store.map.get('menu_state_capiche').exp, null, 'still no expiry');
});

// ---- /api/menu-state/:editor ----

const publish = (editor, body, key = PUBLISH_KEY) =>
  menuState(req('/api/menu-state/' + editor, { method: 'POST', key, body }));

test('publish round-trip: nothing, then POST with PUBLISH_KEY, then public GET', async () => {
  assert.equal((await menuState(req('/api/menu-state/capiche'))).status, 404);

  const state = { edits: { n1: 'MARGHERITA' }, removed: [], added: [] };
  const post = await json(await publish('capiche', { state, base: 'v123', prev: null }));
  assert.equal(post.status, 200);
  assert.equal(post.body.ok, true);

  const get = await json(await menuState(req('/api/menu-state/capiche')));
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, { editor: 'capiche', t: post.body.t, base: 'v123', state });
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal(store.map.get('menu_state_capiche').exp, null, 'published state never expires');
});

test('a publish must name the version it started from', async () => {
  assert.equal((await publish('capiche', { state: {} })).status, 400, 'prev missing');
  assert.equal((await publish('capiche', { state: {}, prev: 'latest' })).status, 400, 'prev not a version');
  assert.equal(store.map.size, 0);
});

test('a stale copy can never overwrite a newer publish (409, nothing written)', async () => {
  const a = (await json(await publish('capiche', { state: { edits: { n1: 'A' } }, base: 'v1', prev: null }))).body.t;
  // someone else, who opened the editor after A, publishes B
  const b = (await json(await publish('capiche', { state: { edits: { n1: 'B' } }, base: 'v1', prev: a }))).body.t;
  assert.ok(b > a);
  // a device still holding A (or nothing) tries to publish its old copy
  for (const prev of [a, null]) {
    const res = await json(await publish('capiche', { state: { edits: { n1: 'OLD' } }, base: 'v1', prev }));
    assert.equal(res.status, 409, 'prev ' + prev);
    assert.equal(res.body.error, 'conflict');
    assert.equal(res.body.current.t, b, 'tells the client which version is current');
  }
  assert.deepEqual((await store.get('menu_state_capiche')).state, { edits: { n1: 'B' } }, 'B is untouched');
});

test('every replaced version is kept, listed and readable', async () => {
  let prev = null; const ts = [];
  for (const name of ['ONE', 'TWO', 'THREE']) {
    prev = (await json(await publish('capiche', { state: { edits: { n1: name } }, base: 'v1', prev }))).body.t;
    ts.push(prev);
  }
  const hist = await json(await menuState(req('/api/menu-state/capiche?history=1')));
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.versions.map((v) => [v.t, v.current, v.edits]), [[ts[2], true, 1], [ts[1], false, 1], [ts[0], false, 1]]);
  const old = await json(await menuState(req('/api/menu-state/capiche?v=' + ts[0])));
  assert.deepEqual(old.body.state, { edits: { n1: 'ONE' } });
  assert.deepEqual((await json(await menuState(req('/api/menu-state/capiche?v=' + ts[2])))).body.state, { edits: { n1: 'THREE' } }, 'current by version');
  assert.equal((await menuState(req('/api/menu-state/capiche?v=123'))).status, 404);
  assert.equal((await menuState(req('/api/menu-state/capiche?v=abc'))).status, 400);
  const ttl = (store.map.get('menu_hist_capiche_' + ts[0]).exp - Date.now()) / 1000;
  assert.ok(ttl > HIST_TTL_S - 5, 'history kept for a year');

  // restoring = publishing an old version's state on top of the current one
  const restored = await json(await publish('capiche', { state: old.body.state, base: 'v1', prev: ts[2] }));
  assert.equal(restored.status, 200);
  assert.deepEqual((await store.get('menu_state_capiche')).state, { edits: { n1: 'ONE' } });
  assert.equal((await json(await menuState(req('/api/menu-state/capiche?history=1')))).body.versions.length, 4);
});

test('history keeps the newest HIST_KEEP versions', async () => {
  let prev = null;
  for (let i = 0; i < HIST_KEEP + 6; i++) prev = (await json(await publish('churnd', { state: { i }, base: 'v', prev }))).body.t;
  const keys = await store.keys('menu_hist_churnd_');
  assert.equal(keys.length, HIST_KEEP);
  const versions = (await json(await menuState(req('/api/menu-state/churnd?history=1')))).body.versions;
  assert.equal(versions[0].t, prev);
  assert.equal(versions.length, HIST_KEEP + 1, 'the live one plus the kept history');
});

test('versions are strictly increasing even within the same millisecond', async () => {
  let prev = null; const ts = [];
  for (let i = 0; i < 5; i++) { prev = (await json(await publish('aiko', { state: { i }, base: 'v', prev }))).body.t; ts.push(prev); }
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1]);
});

test('a publish is read back before it is reported as done', async () => {
  // a store that loses the write (or has it overwritten by a simultaneous publish)
  const lossy = memoryStore();
  setStore({ ...lossy, set: async (k, v, o) => { if (!k.startsWith('menu_state_')) return lossy.set(k, v, o); } });
  const res = await json(await publish('capiche', { state: { edits: {} }, base: 'v', prev: null }));
  assert.equal(res.status, 502);
  assert.match(res.body.error, /could not be confirmed/);
});

test('publish is gated by PUBLISH_KEY, not BUG_KEY', async () => {
  const body = { state: { edits: {} }, prev: null };
  assert.equal((await menuState(req('/api/menu-state/aiko', { method: 'POST', body }))).status, 403);
  assert.equal((await publish('aiko', body, BUG_KEY)).status, 403);
  delete process.env.PUBLISH_KEY;
  assert.equal((await publish('aiko', body, '')).status, 403);
  assert.equal(store.map.size, 0);
});

test('publish validates the editor, the body and its size', async () => {
  const post = (path, body) => menuState(req(path, { method: 'POST', key: PUBLISH_KEY, body }));
  assert.equal((await post('/api/menu-state/drinks', { state: {}, prev: null })).status, 404, "the Aiko drinks editor publishes as 'aiko-drinks'");
  assert.equal((await post('/api/menu-state/bug_1', { state: {}, prev: null })).status, 404);
  assert.equal((await menuState(req('/api/menu-state/..%2Fbug_1'))).status, 404);
  assert.equal((await post('/api/menu-state/capiche', '{bad')).status, 400);
  assert.equal((await post('/api/menu-state/capiche', { base: 'v1', prev: null })).status, 400, 'no state');
  assert.equal((await post('/api/menu-state/capiche', { state: 'x', prev: null })).status, 400);
  assert.equal((await post('/api/menu-state/capiche', { state: [], prev: null })).status, 400);
  assert.equal((await post('/api/menu-state/capiche', { state: { blob: 'x'.repeat(250_000) }, prev: null })).status, 413, 'too big is refused, never stored truncated');
  assert.equal((await menuState(req('/api/menu-state/capiche', { method: 'DELETE' }))).status, 405);
  assert.equal(store.map.size, 0);
});

test('every editor key is publishable', async () => {
  for (const ed of EDITORS) {
    const res = await publish(ed, { state: { edits: {} }, prev: null });
    assert.equal(res.status, 200, ed);
  }
  assert.deepEqual([...EDITORS].sort(), ['aiko', 'aiko-drinks', 'beshak', 'capiche', 'capiche-ahm', 'capiche-surat', 'churnd']);
});

// ---- no store / failing store ----

test('without a store every data route answers 503, and auth is still checked first', async () => {
  setStore(null);
  for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
  assert.equal((await report()).status, 503);
  assert.equal((await listBugs(req('/api/bugs', { key: BUG_KEY }))).status, 503);
  assert.equal((await listBugs(req('/api/bugs'))).status, 403);
  assert.equal((await menuState(req('/api/menu-state/capiche'))).status, 503);
  assert.equal((await menuState(req('/api/menu-state/capiche', { method: 'POST', body: { state: {}, prev: null } }))).status, 403);
  const h = await json(await health(req('/api/health')));
  assert.deepEqual(h.body, { ok: false, store: 'none', storeOk: false, bugKey: true, publishKey: true });
});

test('a store that throws gives 502, never an unhandled error', async () => {
  const boom = async () => { throw new Error('down'); };
  setStore({ kind: 'broken', get: boom, mget: boom, set: boom, del: boom, keys: boom });
  assert.equal((await report()).status, 502);
  assert.equal((await listBugs(req('/api/bugs', { key: BUG_KEY }))).status, 502);
  assert.equal((await patchBug(req('/api/bug/bug_1700000000000_abc', { method: 'PATCH', key: BUG_KEY, body: {} }))).status, 502);
  assert.equal((await menuState(req('/api/menu-state/capiche'))).status, 502);
  assert.equal((await menuState(req('/api/menu-state/capiche', { method: 'POST', key: PUBLISH_KEY, body: { state: {}, prev: null } }))).status, 502);
  const h = await json(await health(req('/api/health')));
  assert.equal(h.body.ok, false);
  assert.equal(h.body.storeError, 'down');
});

test('health reports a working store', async () => {
  const h = await json(await health(req('/api/health')));
  assert.deepEqual(h.body, { ok: true, store: 'memory', storeOk: true, bugKey: true, publishKey: true });
});
