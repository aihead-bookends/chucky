// npm run db:import-upstash [-- --dry-run] — copy everything the old Upstash store holds into Postgres
// (and photo bytes into Vercel Blob), once, before the Postgres deployment goes live.
//
// Reads  KV_REST_API_URL / KV_REST_API_TOKEN (or the UPSTASH_REDIS_REST_* pair): the old store.
// Writes DATABASE_URL, and BLOB_READ_WRITE_TOKEN if set (otherwise photo bytes go into Postgres).
// Run `npm run db:migrate` first.
//
// What it copies:
//   menu_state_<editor> + menu_hist_<editor>_<t>  -> menu_versions (+ a menu_version_items row per
//        value), each version keeping its `t`, chained oldest to newest by parent_t. An editor that
//        already has versions in Postgres is skipped: the chain can't be spliced into a live history.
//   photo_<id>                                   -> photos (bytes checked against the id first)
//   bug_*                                        -> kv, keeping the time each report had left
// Running it again copies only what is missing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './server.mjs';
import { pgAdapter } from './pg.mjs';
import { upstashStore, pgKvStore } from '../api/_lib/store.mjs';
import { pgMenus, stateKey, histPrefix } from '../api/_lib/menus.mjs';
import { PHOTO_PREFIX, isPhotoId, fromBase64, sha256Hex, sniffImage, getPhotoStore } from '../api/_lib/photos.mjs';
import { PREFIX as BUG_PREFIX } from '../api/_lib/bugs.mjs';
import { EDITORS } from '../api/menu-state/[editor].mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(ROOT, '.env'));
const env = process.env;
const DRY = process.argv.includes('--dry-run');
const srcUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
const srcToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
const dbUrl = env.DATABASE_URL || env.POSTGRES_URL;
if (!srcUrl || !srcToken) { console.error('Set KV_REST_API_URL and KV_REST_API_TOKEN (the old Upstash store) in .env.'); process.exit(1); }
if (!dbUrl) { console.error('Set DATABASE_URL (the Postgres to copy into) in .env.'); process.exit(1); }

const src = upstashStore(srcUrl, srcToken);
const db = pgAdapter(dbUrl);
const menus = pgMenus(db);
const kv = pgKvStore(db.query);
const blob = getPhotoStore();
console.log(`${DRY ? 'DRY RUN — nothing is written. ' : ''}Copying Upstash -> Postgres${blob ? ' (photos to Vercel Blob)' : ''}\n`);

let failed = 0;
try {
  if (!(await menus.schemaOk())) throw new Error('Postgres has no tables yet: run npm run db:migrate first');

  // ---- published menus ----
  for (const editor of EDITORS) {
    const cur = await src.get(stateKey(editor));
    const histKeys = await src.keys(histPrefix(editor));
    const recs = [...(cur ? [cur] : []), ...(await src.mget(histKeys))]
      .filter((r) => r && typeof r.t === 'number' && r.state && typeof r.state === 'object')
      .sort((a, b) => a.t - b.t);
    if (!recs.length) { console.log(`  ${editor.padEnd(14)} nothing published`); continue; }
    const have = await db.query('SELECT t FROM menu_versions WHERE editor = $1', [editor]);
    const haveT = new Set(have.map((r) => Number(r.t)));
    if (have.length && !recs.every((r) => haveT.has(r.t) || r.t > Math.max(...haveT))) {
      console.log(`  ${editor.padEnd(14)} SKIPPED: Postgres already has a different history (${have.length} versions)`);
      continue;
    }
    let added = 0;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (haveT.has(r.t)) continue;
      if (!DRY && await menus.importVersion(editor, { t: r.t, parent_t: i ? recs[i - 1].t : null, base: r.base, state: r.state })) added++;
      if (DRY) added++;
    }
    console.log(`  ${editor.padEnd(14)} ${recs.length} versions (live: ${new Date(recs.at(-1).t).toISOString()}), ${added} copied`);
  }

  // ---- photos ----
  const photoKeys = await src.keys(PHOTO_PREFIX);
  let pCopied = 0, pHad = 0;
  for (let i = 0; i < photoKeys.length; i += 10) {
    const keys = photoKeys.slice(i, i + 10);
    const recs = await src.mget(keys);
    for (let j = 0; j < keys.length; j++) {
      const id = keys[j].slice(PHOTO_PREFIX.length), rec = recs[j];
      if (!isPhotoId(id) || !rec || typeof rec.b64 !== 'string') { console.log(`  photo ${keys[j]}: unreadable, skipped`); failed++; continue; }
      const bytes = fromBase64(rec.b64);
      const type = sniffImage(bytes);
      if (!type || (await sha256Hex(bytes)) !== id) { console.log(`  photo ${id.slice(0, 12)}…: bytes don't match its id, skipped`); failed++; continue; }
      if ((await db.query('SELECT 1 FROM photos WHERE id = $1', [id])).length) { pHad++; continue; }
      if (!DRY) await menus.putPhoto(id, type, bytes);
      pCopied++;
    }
  }
  console.log(`\n  photos         ${photoKeys.length} in Upstash, ${pCopied} copied, ${pHad} already there`);

  // ---- bug reports ----
  const bugKeys = await src.keys(BUG_PREFIX);
  let bCopied = 0;
  for (const key of bugKeys) {
    const rec = await src.get(key);
    if (!rec) continue;
    if (await kv.get(key)) continue;
    const ttl = await src.ttl(key);
    if (!DRY) await kv.set(key, rec, ttl ? { ex: ttl } : {});
    bCopied++;
  }
  console.log(`  bug reports    ${bugKeys.length} in Upstash, ${bCopied} copied`);
} catch (e) {
  console.error('\n✘ ' + (e.message || e));
  failed++;
} finally {
  await db.end();
}
console.log(failed ? `\n✘ finished with ${failed} problem(s) — see above` : `\n✔ ${DRY ? 'dry run complete' : 'import complete'}`);
process.exitCode = failed ? 1 : 0;
