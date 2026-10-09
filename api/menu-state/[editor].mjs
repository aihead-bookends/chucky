// GET  /api/menu-state/:editor             public       -> { editor, t, base, state } | 404
// GET  /api/menu-state/:editor?history=1   public       -> { ok, versions:[{t, base, current, edits, removed, added}] }
// GET  /api/menu-state/:editor?v=<t>       public       -> that version's record | 404
// POST /api/menu-state/:editor             PUBLISH_KEY  body { state, base, prev } -> { ok, t } | 409 conflict
//
// Publish: the edit overlay an editor applies on top of its pristine menu, stored per editor so every
// device that opens the editor loads the last-published menu. It stays until the next Publish.
// Where it is stored is api/_lib/menus.mjs's business: Postgres when DATABASE_URL is set (every
// version kept forever, every edited value as its own row), otherwise the key-value store.
//
// Reading is public on purpose — every device must see the current menu without a secret, and the
// state holds the same dish names and prices the editor already serves. Writing changes what
// everyone sees, so it needs PUBLISH_KEY, which is deliberately separate from BUG_KEY: a leaked bug
// key then exposes bug reports, never the live menu.
//
// NO PUBLISH IS EVER SILENTLY LOST. The old Chucky lost published menus three ways, and each has a
// guard:
//  - a stale copy overwrote a newer one (a tab open since before someone else published, or old
//    unsaved edits resumed). Every publish names the version it started from (`prev`, the `t` it
//    loaded, or null if nothing was published). If that is no longer the current version the publish
//    is refused with 409, and the editor tells the person to load the latest first.
//  - nothing could be recovered. Every replaced version is kept, listed by ?history=1, readable by
//    ?v=, and can be re-published.
//  - "Published" was shown for a write nobody checked. Postgres reports success only once the
//    publish's transaction has committed; the key-value store reads the record back.
import { J, preflight, notConfigured, authed, readBody } from '../_lib/http.mjs';
import { MAX_STATE } from '../_lib/bugs.mjs';
import { getMenus, Conflict, Unconfirmed } from '../_lib/menus.mjs';
export { stateKey, histPrefix, HIST_KEEP, HIST_TTL_S } from '../_lib/menus.mjs';

// The editors' own keys (the Aiko drinks editor lives at /drinks/ but publishes as 'aiko-drinks').
// Checked before anything is looked up, so this route can't read or write anything else.
export const EDITORS = new Set(['capiche', 'aiko', 'churnd', 'beshak', 'aiko-drinks', 'capiche-surat', 'capiche-ahm']);

async function getRoute(menus, editor, url) {
  if (url.searchParams.get('history') === '1') return J({ ok: true, versions: await menus.history(editor) });
  const v = url.searchParams.get('v');
  if (v !== null) {
    if (!/^\d{1,16}$/.test(v)) return J({ ok: false, error: 'bad version' }, 400);
    const rec = await menus.version(editor, Number(v));
    return rec ? J(rec) : J({ ok: false, error: 'no such version' }, 404);
  }
  const current = await menus.current(editor);
  return current ? J(current) : J({ ok: false, error: 'nothing published' }, 404);
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
  const menus = getMenus();
  if (!menus) return notConfigured();

  try {
    const { t } = await menus.publish(editor, { prev, base: String(body.base || '').slice(0, 200), state });
    return J({ ok: true, t });
  } catch (e) {
    if (e instanceof Conflict) return J({ ok: false, error: 'conflict', current: e.current }, 409);
    if (e instanceof Unconfirmed) return J({ ok: false, error: e.message }, 502);
    return J({ ok: false, error: 'store unavailable' }, 502);
  }
}

export async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return preflight();

  const editor = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!EDITORS.has(editor)) return J({ ok: false, error: 'unknown editor' }, 404);

  if (req.method === 'GET') {
    const menus = getMenus();
    if (!menus) return notConfigured();
    try { return await getRoute(menus, editor, url); } catch { return J({ ok: false, error: 'store unavailable' }, 502); }
  }
  if (req.method === 'POST') return postRoute(req, url, editor);
  return J({ ok: false, error: 'method not allowed' }, 405);
}

// A Vercel Node.js function in the web-standard form: Request in, Response out.
export default { fetch: handler };
