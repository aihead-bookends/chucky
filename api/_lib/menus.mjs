// Published menus and drink photos: one interface, two stores.
//
//   current(editor)                 -> { editor, t, base, state } | null      the live menu
//   history(editor)                 -> [{ t, base, current, edits, removed, added, drinks? }]  newest first
//   version(editor, t)              -> { editor, t, base, state } | null
//   publish(editor, { prev, base, state }) -> { t }
//        throws Conflict (someone published since `prev`) or Unconfirmed (the write can't be shown to
//        have landed); either way the menu is unchanged
//   putPhoto(id, type, bytes)       -> void (throws Unconfirmed)
//   getPhoto(id)                    -> { type, bytes } | null
//   kind                            -> 'postgres' | the key-value store's kind, for /api/health
//
// pgMenus: Postgres (db/schema.sql). Every version is kept forever, and every editable value of each
// one is also written as its own row (flattenState), so any field can be followed across versions.
// kvMenus: the key-value store (Upstash, or the dev file store / the tests' memory store). This is
// how menus were kept before Postgres, unchanged: the live menu, the newest HIST_KEEP replaced
// versions for a year, and photos as base64.
//
// getMenus() picks Postgres when DATABASE_URL is set, otherwise the key-value store.
import { getDb } from './db.mjs';
import { getStore } from './store.mjs';
import { photoKey, toBase64, fromBase64, getPhotoStore } from './photos.mjs';

export class Conflict extends Error {
  constructor(current) { super('conflict'); this.current = current; }   // { t, base } | null
}
export class Unconfirmed extends Error {}

export function getMenus() {
  const db = getDb();
  if (db) return pgMenus(db);
  const store = getStore();
  return store ? kvMenus(store) : null;
}

// ---------------- what a version's list shows ----------------

// how many items a state's list holds: a plain list, or (the drinks menus) one list per page
const count = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.values(v).reduce((n, x) => n + count(x), 0) : 0);
export function summarise(state) {
  const s = state || {};
  return {
    edits: Object.keys(s.edits || {}).length, removed: count(s.removed), added: count(s.added),
    // the Aiko drinks menu keeps its whole list of drinks (bands; the soft drinks share one) instead of edits
    ...(Array.isArray(s.bands) ? { drinks: s.bands.reduce((n, b) => n + (Array.isArray(b && b.lines) ? b.lines.length : 1), 0) } : {}),
  };
}

// ---------------- one row per editable value ----------------

/* Walk a published state down to its values and return one { path, section, value } per value.
   Generic on purpose: the seven editors keep seven differently shaped states, and a field an editor
   gains later gets its rows with no change here.
     - object keys and array positions join with "/" (escaped as in JSON Pointer: ~ -> ~0, / -> ~1)
     - a list of plain values (removed dishes, a marker set) is ONE value: the set is what is edited
     - an empty object or list is kept as a value too, so the rows say everything the state does */
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
export function flattenState(state) {
  const out = [];
  const leaf = (path, value) => out.push({ path, section: path.split('/')[0], value });
  const walk = (v, path) => {
    if (v === undefined) return;
    if (v === null || typeof v !== 'object') return leaf(path, v);
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== 'object')) return leaf(path, v);
      return v.forEach((x, i) => walk(x, path + '/' + i));
    }
    const keys = Object.keys(v);
    if (!keys.length) return leaf(path, v);
    for (const k of keys) walk(v[k], path + '/' + esc(k));
  };
  for (const k of Object.keys(state || {})) walk(state[k], esc(k));
  return out;
}

// ---------------- Postgres ----------------

const num = (v) => (v == null ? null : Number(v));
const isUniqueViolation = (e) => e && (e.code === '23505' || /duplicate key|unique constraint/i.test(String(e.message || '')));

export function pgMenus(db) {
  const latest = async (editor) => {
    const rows = await db.query('SELECT t, base FROM menu_versions WHERE editor = $1 ORDER BY t DESC LIMIT 1', [editor]);
    return rows[0] ? { t: num(rows[0].t), base: rows[0].base } : null;
  };
  const record = (r) => (r ? { editor: r.editor, t: num(r.t), base: r.base, state: r.state } : null);

  return {
    kind: 'postgres',

    current: async (editor) => record((await db.query(
      'SELECT editor, t, base, state FROM menu_versions WHERE editor = $1 ORDER BY t DESC LIMIT 1', [editor]))[0]),

    version: async (editor, t) => record((await db.query(
      'SELECT editor, t, base, state FROM menu_versions WHERE editor = $1 AND t = $2', [editor, t]))[0]),

    history: async (editor) => {
      const rows = await db.query('SELECT t, base, summary FROM menu_versions WHERE editor = $1 ORDER BY t DESC', [editor]);
      return rows.map((r, i) => ({ t: num(r.t), base: r.base, current: i === 0, ...(r.summary || {}) }));
    },

    /* One transaction. The version row goes in only if `prev` is still the newest version (and the
       UNIQUE (editor, parent_t) constraint stops two publishes from the same `prev` both landing, even
       at the same instant); its value rows go in only alongside it. Committed = published, so there is
       no separate read-back. */
    publish: async (editor, { prev, base, state }) => {
      const t = Math.max(Date.now(), (prev || 0) + 1);   // strictly increasing, whatever the clock does
      const items = flattenState(state);
      let res;
      try {
        res = await db.tx([
          { text: `INSERT INTO menu_versions (editor, t, parent_t, base, state, summary)
                   SELECT $1::text, $2::bigint, $3::bigint, $4::text, $5::json, $6::jsonb
                   WHERE (SELECT max(t) FROM menu_versions WHERE editor = $1::text) IS NOT DISTINCT FROM $3::bigint
                   RETURNING t`,
            params: [editor, t, prev, base, JSON.stringify(state), JSON.stringify(summarise(state))] },
          { text: `INSERT INTO menu_version_items (editor, t, path, section, value)
                   SELECT $1::text, $2::bigint, i.path, i.section, i.value
                   FROM jsonb_to_recordset($3::jsonb) AS i(path text, section text, value jsonb)
                   WHERE EXISTS (SELECT 1 FROM menu_versions WHERE editor = $1::text AND t = $2::bigint AND parent_t IS NOT DISTINCT FROM $4::bigint)`,
            params: [editor, t, JSON.stringify(items), prev] },
        ]);
      } catch (e) {
        if (isUniqueViolation(e)) throw new Conflict(await latest(editor));
        throw e;
      }
      if (!res[0] || !res[0].length) throw new Conflict(await latest(editor));
      return { t };
    },

    /* For `npm run db:import-upstash` only: insert an existing version as it was, keeping its `t`.
       Re-running is harmless (an imported version is skipped). Returns whether it was inserted. */
    importVersion: async (editor, { t, parent_t, base, state }) => {
      const [ins] = await db.tx([
        { text: `INSERT INTO menu_versions (editor, t, parent_t, base, state, summary)
                 VALUES ($1::text, $2::bigint, $3::bigint, $4::text, $5::json, $6::jsonb)
                 ON CONFLICT DO NOTHING RETURNING t`,
          params: [editor, t, parent_t, base || '', JSON.stringify(state), JSON.stringify(summarise(state))] },
        { text: `INSERT INTO menu_version_items (editor, t, path, section, value)
                 SELECT $1::text, $2::bigint, i.path, i.section, i.value
                 FROM jsonb_to_recordset($3::jsonb) AS i(path text, section text, value jsonb)
                 ON CONFLICT DO NOTHING`,
          params: [editor, t, JSON.stringify(flattenState(state))] },
      ]);
      return ins.length > 0;
    },

    /* The bytes go to Vercel Blob when it is configured (the row keeps the URL), otherwise into the row.
       A photo already recorded is never uploaded again: its id is its content. */
    putPhoto: async (id, type, bytes) => {
      const have = await db.query('SELECT 1 FROM photos WHERE id = $1', [id]);
      if (!have.length) {
        const blob = getPhotoStore();
        if (blob) {
          const url = await blob.save(id, bytes, type);
          await db.query(`INSERT INTO photos (id, type, size, url) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
            [id, type, bytes.length, url]);
        } else {
          await db.query(`INSERT INTO photos (id, type, size, bytes) VALUES ($1, $2, $3, decode($4, 'base64'))
                          ON CONFLICT (id) DO NOTHING`, [id, type, bytes.length, toBase64(bytes)]);
        }
      }
      // the menu about to be published points at this photo: prove it is recorded, and that bytes kept
      // in the row really are this photo
      const rows = await db.query(
        `SELECT url IS NOT NULL OR encode(sha256(bytes), 'hex') = id AS ok FROM photos WHERE id = $1`, [id]);
      if (!rows[0] || !rows[0].ok) throw new Unconfirmed('the photo could not be confirmed as saved');
    },

    getPhoto: async (id) => {
      const rows = await db.query(`SELECT type, url, encode(bytes, 'base64') AS b64 FROM photos WHERE id = $1`, [id]);
      const r = rows[0];
      if (!r) return null;
      if (r.b64) return { type: r.type, bytes: fromBase64(r.b64.replace(/\s+/g, '')) };
      const blob = getPhotoStore();
      const stream = blob ? await blob.load(r.url) : null;
      return stream ? { type: r.type, bytes: stream } : null;
    },

    // /api/health: is the schema there (npm run db:migrate)?
    schemaOk: async () => !!(await db.query(`SELECT to_regclass('menu_versions') IS NOT NULL AS ok`))[0]?.ok,
  };
}

// ---------------- key-value store (Upstash / dev file / tests) ----------------

export const stateKey = (editor) => 'menu_state_' + editor;
export const histPrefix = (editor) => 'menu_hist_' + editor + '_';
export const HIST_KEEP = 50;
export const HIST_TTL_S = 60 * 60 * 24 * 365;

export function kvMenus(store) {
  const prune = async (editor) => {
    const keys = await store.keys(histPrefix(editor));
    if (keys.length <= HIST_KEEP) return;
    const byAge = keys.sort((a, b) => Number(b.slice(b.lastIndexOf('_') + 1)) - Number(a.slice(a.lastIndexOf('_') + 1)));
    for (const k of byAge.slice(HIST_KEEP)) await store.del(k);
  };
  const current = (editor) => store.get(stateKey(editor));

  return {
    kind: store.kind,
    current,

    version: async (editor, t) => {
      const cur = await current(editor);
      return cur && cur.t === t ? cur : store.get(histPrefix(editor) + t);
    },

    history: async (editor) => {
      const cur = await current(editor);
      const keys = await store.keys(histPrefix(editor));
      const old = (await store.mget(keys)).filter((r) => r && typeof r.t === 'number');
      return [...(cur ? [{ ...cur, current: true }] : []), ...old.map((r) => ({ ...r, current: false }))]
        .map((r) => ({ t: r.t, base: r.base, current: r.current, ...summarise(r.state) }))
        .sort((a, b) => b.t - a.t);
    },

    /* Compare-then-write is not atomic across two requests: two publishes landing within the same few
       milliseconds is the gap, and the read-back check reports the one that lost. */
    publish: async (editor, { prev, base, state }) => {
      const cur = await current(editor);
      const curT = cur && typeof cur.t === 'number' ? cur.t : null;
      if (prev !== curT) throw new Conflict(curT === null ? null : { t: curT, base: cur.base });
      const rec = { editor, t: Math.max(Date.now(), (curT || 0) + 1), base, state };
      if (cur) await store.set(histPrefix(editor) + curT, cur, { ex: HIST_TTL_S });
      await store.set(stateKey(editor), rec);
      const check = await current(editor);
      if (!check || check.t !== rec.t || JSON.stringify(check.state) !== JSON.stringify(rec.state)) {
        throw new Unconfirmed('publish could not be confirmed — another publish may have landed at the same moment; reload and check');
      }
      try { await prune(editor); } catch { /* history housekeeping never fails a publish */ }
      return { t: rec.t };
    },

    putPhoto: async (id, type, bytes) => {
      const b64 = toBase64(bytes);
      const have = await store.get(photoKey(id));
      if (have && have.b64 === b64) return;
      await store.set(photoKey(id), { type, size: bytes.length, t: Date.now(), b64 });
      const check = await store.get(photoKey(id));
      if (!check || check.b64 !== b64) throw new Unconfirmed('the photo could not be confirmed as saved');
    },

    getPhoto: async (id) => {
      const rec = await store.get(photoKey(id));
      return rec && typeof rec.b64 === 'string' ? { type: rec.type, bytes: fromBase64(rec.b64) } : null;
    },
  };
}
