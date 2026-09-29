// Checks a running Chucky site end to end — WITHOUT changing any menu or leaving any data behind.
//
//   npm run check -- https://your-site.vercel.app
//   npm run check -- http://localhost:3000
//
// Keys come from --publish-key / --bug-key, else PUBLISH_KEY / BUG_KEY in the environment or .env.
// Without a key, the checks that need it are skipped (and say so).
//
// The publish check sends a publish that names an impossible starting version, so a healthy server
// must refuse it with 409: that proves the key is accepted and the stale-copy guard is on, and
// nothing is written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const site = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
if (!site) { console.error('usage: npm run check -- https://your-site.vercel.app [--publish-key K] [--bug-key K]'); process.exit(2); }

let dotenv = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) dotenv[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }
const PUBLISH_KEY = flag('publish-key') || process.env.PUBLISH_KEY || dotenv.PUBLISH_KEY || '';
const BUG_KEY = flag('bug-key') || process.env.BUG_KEY || dotenv.BUG_KEY || '';
const EDITORS = ['capiche', 'aiko', 'churnd', 'beshak', 'aiko-drinks', 'capiche-surat', 'capiche-ahm'];

let fails = 0, warns = 0;
const pass = (m) => console.log('  ✔ ' + m);
const fail = (m) => { fails++; console.log('  ✖ ' + m); };
const warn = (m) => { warns++; console.log('  ! ' + m); };
const skip = (m) => console.log('  - ' + m);
async function get(p, opts = {}) {
  const res = await fetch(site + p, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(20000), ...opts });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
  return { status: res.status, type, body, headers: res.headers };
}
const step = async (title, fn) => { console.log('\n' + title); try { await fn(); } catch (e) { fail('could not run: ' + (e.message || e)); } };

console.log('Checking ' + site);

await step('Pages', async () => {
  for (const p of ['/', '/chucky/', '/capiche/', '/bugs/', '/menu/', '/preview/']) {
    const r = await get(p);
    r.status === 200 && r.type.includes('html') ? pass(p) : fail(`${p} answered ${r.status} ${r.type}`);
  }
});

await step('Capiche menu files', async () => {
  const pdf = await get('/capiche/capiche.pdf');
  if (pdf.status !== 200) return fail('capiche.pdf answered ' + pdf.status);
  pass(`capiche.pdf (${pdf.body.length} bytes)`);
  const start = await get('/capiche/start-state.json');
  if (start.status !== 200 || !start.body) return fail('start-state.json answered ' + start.status);
  start.body.base === 'v' + pdf.body.length ? pass('start-state.json was made for this capiche.pdf')
    : fail(`start-state.json is for ${start.body.base}, but capiche.pdf is v${pdf.body.length} — the starting menu would not load`);
  const fm = await get('/capiche/fieldmap.json');
  fm.status === 200 ? pass('fieldmap.json') : fail('fieldmap.json answered ' + fm.status);
});

await step('Backend health', async () => {
  const r = await get('/api/health');
  if (r.status !== 200 && r.status !== 503) return fail('/api/health answered ' + r.status);
  const h = r.body || {};
  const local = /localhost|127\.0\.0\.1/.test(site);
  if (!h.storeOk) fail(`storage is not working (store: ${h.store}${h.storeError ? ', ' + h.storeError : ''}) — connect Upstash Redis`);
  else if (h.store !== 'upstash' && !local) fail(`storage is "${h.store}", not Upstash — published menus would not be shared or kept`);
  else pass(`storage: ${h.store}, reachable`);
  h.publishKey ? pass('PUBLISH_KEY is set') : fail('PUBLISH_KEY is not set — nobody can publish');
  h.bugKey ? pass('BUG_KEY is set') : fail('BUG_KEY is not set — the bug queue can’t be opened');
});

await step('Published menus (read-only)', async () => {
  const pdf = await get('/capiche/capiche.pdf');
  for (const ed of EDITORS) {
    const r = await get('/api/menu-state/' + ed);
    if (r.status === 404) { pass(`${ed}: nothing published`); continue; }
    if (r.status !== 200 || !r.body || typeof r.body.t !== 'number') { fail(`${ed}: answered ${r.status}`); continue; }
    const when = new Date(r.body.t).toLocaleString();
    if (ed === 'capiche' && pdf.status === 200 && r.body.base !== 'v' + pdf.body.length) {
      warn(`capiche: the published menu (${when}) was made for ${r.body.base}, not this capiche.pdf — the editor will not show it`);
    } else pass(`${ed}: published ${when}`);
    const h = await get('/api/menu-state/' + ed + '?history=1');
    h.status === 200 && Array.isArray(h.body?.versions) ? pass(`${ed}: version history readable (${h.body.versions.length})`) : fail(`${ed}: history answered ${h.status}`);
  }
});

await step('Publishing is protected (nothing is written)', async () => {
  const send = (key) => get('/api/menu-state/capiche', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ state: { edits: {} }, base: 'check', prev: 1 }),
  });
  const anon = await send('');
  anon.status === 403 ? pass('without the key: refused (403)') : fail(`without the key: answered ${anon.status} — publishing is not protected`);
  if (!PUBLISH_KEY) return skip('no PUBLISH_KEY given: pass --publish-key to check it is accepted');
  const r = await send(PUBLISH_KEY);
  if (r.status === 409) pass('publish key accepted, and a publish from an out-of-date copy is refused (409)');
  else if (r.status === 403) fail('the publish key was not accepted (403) — check PUBLISH_KEY on the server');
  else fail(`a publish from an out-of-date copy answered ${r.status} — it should be refused with 409`);
});

await step('Drink photos (nothing is written)', async () => {
  // every photo a published drinks menu names must load, or other devices show a gap
  for (const ed of EDITORS) {
    const r = await get('/api/menu-state/' + ed);
    const photos = (r.status === 200 && r.body?.state?.photos) || {};
    const ids = [...new Set(Object.values(photos).map((p) => p && p.id).filter(Boolean))];
    if (!ids.length) continue;
    let bad = 0;
    for (const id of ids) {
      const p = await get('/api/photo/' + id);
      if (p.status !== 200 || !/^image\//.test(p.type)) { bad++; fail(`${ed}: photo ${id.slice(0, 12)}… answered ${p.status}`); }
    }
    if (!bad) pass(`${ed}: all ${ids.length} published photo(s) load`);
  }
  const probe = await get('/api/photo/' + '0'.repeat(64));
  probe.status === 404 ? pass('photo route answers (unknown photo: 404)') : fail(`an unknown photo answered ${probe.status}`);
  // a body that isn't an image: refused without the key (403), and with it (415) — never stored
  const send = (key) => get('/api/photo', { method: 'POST', body: 'not an image', headers: { 'content-type': 'image/jpeg', ...(key ? { authorization: 'Bearer ' + key } : {}) } });
  const anon = await send('');
  anon.status === 403 ? pass('upload without the key: refused (403)') : fail(`upload without the key: answered ${anon.status} — photo uploads are not protected`);
  if (!PUBLISH_KEY) return skip('no PUBLISH_KEY given: pass --publish-key to check uploads accept it');
  const r = await send(PUBLISH_KEY);
  if (r.status === 415) pass('publish key accepted for uploads, and a non-image is refused (415)');
  else if (r.status === 403) fail('the publish key was not accepted for uploads (403)');
  else fail(`a non-image upload answered ${r.status} — it should be refused with 415`);
});

await step('Bug queue', async () => {
  const anon = await get('/api/bugs');
  anon.status === 403 ? pass('without the key: refused (403)') : fail(`without the key: answered ${anon.status} — the queue is not protected`);
  if (!BUG_KEY) return skip('no BUG_KEY given: pass --bug-key to check the queue opens');
  const r = await get('/api/bugs?lite=1', { headers: { authorization: 'Bearer ' + BUG_KEY } });
  r.status === 200 ? pass(`queue opens (${(r.body.bugs || []).length} reports)`) : fail(`queue answered ${r.status}${r.status === 403 ? ' — BUG_KEY not accepted' : ''}`);
});

console.log('\n' + (fails ? `✖ ${fails} problem(s)` : '✔ Everything checked is working') + (warns ? `, ${warns} warning(s)` : '') + '.');
process.exit(fails ? 1 : 0);
