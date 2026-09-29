// The whole site over HTTP through the dev server: every page, the static-file rules, and the API
// end to end. Also checks the editors' config agrees with the API's allowlist.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDevServer } from '../dev/server.mjs';
import { setStore, memoryStore } from '../api/_lib/store.mjs';
import { EDITORS } from '../api/menu-state/[editor].mjs';

const EDITOR_PAGES = ['capiche', 'aiko', 'churnd', 'beshak', 'drinks', 'capiche-surat', 'capiche-ahm'];
let server, base;

before(async () => {
  process.env.BUG_KEY = 'bk';
  process.env.PUBLISH_KEY = 'pk';
  setStore(memoryStore());
  server = createDevServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path, opts) => fetch(base + path, { redirect: 'manual', ...opts });

test('every page is served as HTML', async () => {
  for (const path of ['/', '/chucky/', '/bugs/', '/menu/', '/preview/', ...EDITOR_PAGES.map((p) => `/${p}/`)]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /^text\/html/, path);
    assert.match(await res.text(), /^<!doctype html>/i, path);
  }
});

test('every asset a page references exists', async () => {
  const pages = ['index.html', '404.html', 'chucky/index.html', 'bugs/index.html', 'menu/index.html', 'preview/index.html', ...EDITOR_PAGES.map((p) => `${p}/index.html`)];
  const refs = new Set();
  for (const p of pages) {
    for (const m of fs.readFileSync(`public/${p}`, 'utf8').matchAll(/(?:href|src)="(\/[^"]*)"/g)) refs.add(m[1]);
  }
  for (const m of fs.readFileSync('public/assets/css/site.css', 'utf8').matchAll(/url\((\/[^)]+)\)/g)) refs.add(m[1]);
  for (const m of fs.readFileSync('public/assets/css/editor.css', 'utf8').matchAll(/url\((\/[^)]+)\)/g)) refs.add(m[1]);
  assert.ok(refs.size > 10);
  for (const ref of refs) {
    const res = await get(ref);
    assert.equal(res.status, 200, ref);
  }
  assert.match((await get('/assets/css/editor.css')).headers.get('content-type'), /^text\/css/);
  assert.match((await get('/assets/js/editor.js')).headers.get('content-type'), /^text\/javascript/);
  assert.equal((await get('/assets/brand/capiche.svg')).headers.get('content-type'), 'image/svg+xml');
});

test('directories redirect to their trailing-slash URL; unknown paths get the 404 page', async () => {
  const res = await get('/capiche?x=1');
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), '/capiche/?x=1');
  const nf = await get('/no-such-page');
  assert.equal(nf.status, 404);
  assert.match(await nf.text(), /Not on the menu/);
});

test('nothing outside public/ is reachable', async () => {
  for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/assets/..%2f..%2f.env.example']) {
    const res = await get(path);
    assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    assert.doesNotMatch(await res.text(), /"scripts"|PUBLISH_KEY=/, path);
  }
  assert.equal((await get('/api/_lib/store')).status, 404);
  assert.equal((await get('/api/_lib/store.mjs')).status, 404);
  assert.equal((await get('/api/nope')).status, 404);
});

test('bug report → queue → triage, end to end', async () => {
  const post = await get('/api/bug', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ editor: 'capiche', page: 0, desc: 'end-to-end', url: base + '/capiche/', state: { edits: {} }, shot: null }),
  });
  assert.equal(post.status, 200);
  const { id } = await post.json();

  assert.equal((await get('/api/bugs')).status, 403);
  const listed = await (await get('/api/bugs', { headers: { authorization: 'Bearer bk' } })).json();
  assert.equal(listed.bugs[0].id, id);
  assert.equal(listed.bugs[0].desc, 'end-to-end');

  const patch = await get('/api/bug/' + id, { method: 'PATCH', headers: { authorization: 'Bearer bk', 'content-type': 'application/json' }, body: '{"status":"fixed"}' });
  assert.equal(patch.status, 200);
  const fixed = await (await get('/api/bugs?status=fixed', { headers: { authorization: 'Bearer bk' } })).json();
  assert.deepEqual(fixed.bugs.map((b) => b.id), [id]);
});

test('publish → read back → stale publish refused → history, end to end', async () => {
  const send = (state, prev, key = 'pk') => get('/api/menu-state/aiko-drinks', {
    method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ state, base: 'v1', prev }),
  });
  assert.equal((await get('/api/menu-state/aiko-drinks')).status, 404);
  assert.equal((await send({ edits: { n1: 'YUZU SODA' } }, null, 'bk')).status, 403);
  const first = await send({ edits: { n1: 'YUZU SODA' } }, null);
  assert.equal(first.status, 200);
  const t1 = (await first.json()).t;
  const rec = await (await get('/api/menu-state/aiko-drinks')).json();
  assert.deepEqual(rec.state, { edits: { n1: 'YUZU SODA' } });

  const t2 = (await (await send({ edits: { n1: 'YUZU SPRITZ' } }, t1)).json()).t;
  const stale = await send({ edits: { n1: 'OLD COPY' } }, t1);          // a device still on t1
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).current.t, t2);
  assert.deepEqual((await (await get('/api/menu-state/aiko-drinks')).json()).state, { edits: { n1: 'YUZU SPRITZ' } });

  const hist = await (await get('/api/menu-state/aiko-drinks?history=1')).json();
  assert.deepEqual(hist.versions.map((v) => v.t), [t2, t1]);
});

test('health says the backend is up', async () => {
  const res = await get('/api/health');
  assert.deepEqual(await res.json(), { ok: true, store: 'memory', storeOk: true, bugKey: true, publishKey: true });
});

test('the passphrase check works without crypto.subtle (phones on http://<network address>)', async () => {
  const { createHash } = await import('node:crypto');
  const src = fs.readFileSync('public/assets/js/site.js', 'utf8');
  const fn = /function sha256Hex[\s\S]*?\n}\n/.exec(src)[0];
  const sha256Hex = vm.runInNewContext(fn + '; sha256Hex', { TextEncoder, Math, Uint8Array, Int32Array, DataView });
  const inputs = ['', 'chucky', 'Chucky passphrase ✓ चकी', ...Array.from({ length: 300 }, (_, n) => 'x'.repeat(n))];
  for (const s of inputs) assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'), `length ${s.length}`);
  const hash = /HASH: '([0-9a-f]{64})'/.exec(src)[1];
  assert.equal(sha256Hex('chucky'), hash, 'the staff passphrase unlocks');
});

const loadBrands = () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync('public/assets/js/brands.js', 'utf8'), ctx);
  return ctx.window.CHUCKY_BRANDS;
};

test('an editor with a menu has its engine, PDF and fieldmap, and a starting state made for that PDF', async () => {
  const withMenu = Object.entries(loadBrands()).filter(([, b]) => b.menu).map(([id]) => id);
  assert.ok(withMenu.includes('capiche'));
  for (const id of withMenu) {
    const dir = `public/${id}`;
    const engine = fs.readFileSync(`${dir}/engine.js`, 'utf8');
    assert.doesNotThrow(() => new vm.Script(engine, { filename: `${id}/engine.js` }), `${id}/engine.js compiles`);
    assert.match(fs.readFileSync(`${dir}/index.html`, 'utf8'), new RegExp(`src="/${id}/engine\\.js"`), `${id} page loads its engine`);

    // the files the engine fetches at boot, relative to its page
    // fetch('capiche.pdf…') in Capiche; a BRAND = { pdf:'aiko.pdf' } setting in Aiko
    const m = /fetch\('([\w.-]+\.pdf)/.exec(engine) || /\bpdf:\s*'([\w.-]+\.pdf)'/.exec(engine);
    const pdf = m?.[1];
    assert.ok(pdf, `${id}: engine names its PDF`);
    for (const f of [pdf, 'fieldmap.json', 'base_words.json', 'culinary.json']) {
      assert.equal((await get(`/${id}/${f}`)).status, 200, `${id}/${f} is served`);
    }

    // start-state.json: edits address byte spans in ONE PDF, so its base must be this PDF, and every
    // dish it touches must exist in this fieldmap
    const start = JSON.parse(fs.readFileSync(`${dir}/start-state.json`, 'utf8'));
    assert.equal(start.base, 'v' + fs.statSync(`${dir}/${pdf}`).size, `${id}: start-state base matches ${pdf}`);
    const ids = new Set(JSON.parse(fs.readFileSync(`${dir}/fieldmap.json`, 'utf8')).fields.map((f) => f.id));
    const s = start.state;
    for (const k of [...Object.keys(s.edits || {}), ...(s.removed || []), ...Object.keys(s.markerEdits || {})]) {
      assert.ok(ids.has(k), `${id}: start-state refers to field ${k}, which the fieldmap doesn't have`);
    }
  }
});

test('each editor page has a brand, and its API key is on the allowlist', () => {
  const brands = loadBrands();
  assert.deepEqual(Object.keys(brands).sort(), [...EDITOR_PAGES].sort());
  for (const id of EDITOR_PAGES) {
    assert.match(fs.readFileSync(`public/${id}/index.html`, 'utf8'), new RegExp(`data-editor="${id}"`), id);
    assert.ok(EDITORS.has(brands[id].mem), `${id} publishes as '${brands[id].mem}', which the API must allow`);
    assert.match(fs.readFileSync('public/assets/css/editor.css', 'utf8'), new RegExp(`\\[data-editor="${id}"\\]`), `${id} has a colour token block`);
  }
  assert.equal(new Set(Object.values(brands).map((b) => b.mem)).size, EDITOR_PAGES.length, 'mem keys are unique');
});
