// GET  /api/menu-state/:editor             public       -> { editor, t, base, state } | 404
// GET  /api/menu-state/:editor?history=1   public       -> { ok, versions:[{t, base, current, edits, removed, added}] }
// GET  /api/menu-state/:editor?v=<t>       public       -> that version's record | 404
// POST /api/menu-state/:editor             PUBLISH_KEY  body { state, base, prev } -> { ok, t } | 409 conflict
//
// Publish: the edit overlay an editor applies on top of its pristine menu, stored per editor so every
// device that opens the editor loads the last-published menu. It stays until the next Publish.
//
// Reading is public on purpose — every device must see the current menu without a secret, and the
// state holds the same dish names and prices the editor already serves. Writing changes what
// everyone sees, so it needs PUBLISH_KEY, which is deliberately separate from BUG_KEY: a leaked bug
// key then exposes bug reports, never the live menu.
//
// NO PUBLISH IS EVER SILENTLY LOST. The old Chucky lost published menus three ways, and each has a
// guard here:
//  - a stale copy overwrote a newer one (a tab open since before someone else published, or old
//    unsaved edits resumed). Every publish now names the version it started from (`prev`, the `t` it
//    loaded, or null if nothing was published). If that is no longer the current version the publish
//    is refused with 409, and the editor tells the person to load the latest first.
//  - nothing could be recovered. The version a publish replaces is archived (menu_hist_<editor>_<t>),
//    the newest HIST_KEEP are kept for HIST_TTL_S, and any of them can be read back and re-published.
//  - "Published" was shown for a write nobody checked. The record is read back after writing, and
//    the publish only succeeds if what is stored is exactly what was sent (a lost race shows up here).
// Compare-then-write is not atomic across two requests, but two publishes landing within the same few
// milliseconds is the only gap, and the read-back check reports that loser as a failure.
import { J, preflight, notConfigured, authed, readBody } from '../_lib/http.mjs';
import { MAX_STATE } from '../_lib/bugs.mjs';
import { getStore } from '../_lib/store.mjs';

export const config = { runtime: 'edge' };

// The editors' own keys (the Aiko drinks editor lives at /drinks/ but publishes as 'aiko-drinks').
// Checked before building a store key, so this route can't read or write arbitrary keys.
export const EDITORS = new Set(['capiche', 'aiko', 'churnd', 'beshak', 'aiko-drinks', 'capiche-surat', 'capiche-ahm']);
export const stateKey = (editor) => 'menu_state_' + editor;
export const histPrefix = (editor) => 'menu_hist_' + editor + '_';
export const HIST_KEEP = 50;
export const HIST_TTL_S = 60 * 60 * 24 * 365;

const summary = (rec, current) => {
  const s = rec.state || {};
  return {
    t: rec.t, base: rec.base, current,
    edits: Object.keys(s.edits || {}).length, removed: (s.removed || []).length, added: (s.added || []).length,
    // the Aiko drinks menu keeps its whole list of drinks (bands; the soft drinks share one) instead of edits
    ...(Array.isArray(s.bands) ? { drinks: s.bands.reduce((n, b) => n + (Array.isArray(b && b.lines) ? b.lines.length : 1), 0) } : {}),
  };
};

async function getRoute(store, editor, url) {
  const current = await store.get(stateKey(editor));
  if (url.searchParams.get('history') === '1') {
    const keys = await store.keys(histPrefix(editor));
    const old = (await store.mget(keys)).filter((r) => r && typeof r.t === 'number');
    const versions = [...(current ? [summary(current, true)] : []), ...old.map((r) => summary(r, false))]
      .sort((a, b) => b.t - a.t);
    return J({ ok: true, versions });
  }
  const v = url.searchParams.get('v');
  if (v !== null) {
    if (!/^\d{1,16}$/.test(v)) return J({ ok: false, error: 'bad version' }, 400);
    const rec = current && String(current.t) === v ? current : await store.get(histPrefix(editor) + v);
    return rec ? J(rec) : J({ ok: false, error: 'no such version' }, 404);
  }
  return current ? J(current) : J({ ok: false, error: 'nothing published' }, 404);
}

async function prune(store, editor) {
  const keys = await store.keys(histPrefix(editor));
  if (keys.length <= HIST_KEEP) return;
  const byAge = keys.sort((a, b) => Number(b.slice(b.lastIndexOf('_') + 1)) - Number(a.slice(a.lastIndexOf('_') + 1)));
  for (const k of byAge.slice(HIST_KEEP)) await store.del(k);
}

async function postRoute(req, url, editor) {
  if (!authed(req, url, 'PUBLISH_KEY')) return J({ ok: false, error: 'forbidden' }, 403);
  const raw = await readBody(req, MAX_STATE);
  if (raw === null) return J({ ok: false, error: 'payload too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return J({ ok: false, error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return J({ ok: false, error: 'bad json' }, 400);
  const { state, prev } = body;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return J({ ok: false, error: 'state must be an object' }, 400);
  if (!('prev' in body) || !(prev === null || Number.isFinite(prev))) {
    return J({ ok: false, error: 'prev is required: the t of the version this edit started from, or null if none was published' }, 400);
  }
  const store = getStore();
  if (!store) return notConfigured();

  try {
    const current = await store.get(stateKey(editor));
    const curT = current && typeof current.t === 'number' ? current.t : null;
    if (prev !== curT) {
      return J({ ok: false, error: 'conflict', current: curT === null ? null : { t: curT, base: current.base } }, 409);
    }
    // strictly increasing, so a version is never mistaken for the one before it (clock skew)
    const rec = { editor, t: Math.max(Date.now(), (curT || 0) + 1), base: String(body.base || '').slice(0, 200), state };
    if (current) await store.set(histPrefix(editor) + curT, current, { ex: HIST_TTL_S });
    await store.set(stateKey(editor), rec);
    const check = await store.get(stateKey(editor));
    if (!check || check.t !== rec.t || JSON.stringify(check.state) !== JSON.stringify(rec.state)) {
      return J({ ok: false, error: 'publish could not be confirmed — another publish may have landed at the same moment; reload and check' }, 502);
    }
    try { await prune(store, editor); } catch { /* history housekeeping never fails a publish */ }
    return J({ ok: true, t: rec.t });
  } catch {
    return J({ ok: false, error: 'store unavailable' }, 502);
  }
}

export default async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return preflight();

  const editor = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!EDITORS.has(editor)) return J({ ok: false, error: 'unknown editor' }, 404);

  if (req.method === 'GET') {
    const store = getStore();
    if (!store) return notConfigured();
    try { return await getRoute(store, editor, url); } catch { return J({ ok: false, error: 'store unavailable' }, 502); }
  }
  if (req.method === 'POST') return postRoute(req, url, editor);
  return J({ ok: false, error: 'method not allowed' }, 405);
}
