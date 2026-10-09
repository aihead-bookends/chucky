// PATCH|POST /api/bug/:id — update a report's triage fields (status / approved / resolution).
// Gated by BUG_KEY. The id is parsed from the path itself so this doesn't depend on how the host
// passes dynamic segments.
import { J, preflight, notConfigured, authed, readBody } from '../_lib/http.mjs';
import { MAX_STATE, isBugId, sanitizePatch, putBug } from '../_lib/bugs.mjs';
import { getStore } from '../_lib/store.mjs';

export async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'PATCH' && req.method !== 'POST') return J({ ok: false, error: 'method not allowed' }, 405);
  if (!authed(req, url, 'BUG_KEY')) return J({ ok: false, error: 'forbidden' }, 403);

  const id = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!isBugId(id)) return J({ ok: false, error: 'not found' }, 404);
  const store = getStore();
  if (!store) return notConfigured();

  const raw = await readBody(req, MAX_STATE);
  if (raw === null) return J({ ok: false, error: 'payload too large' }, 413);
  let patch;
  try { patch = JSON.parse(raw); } catch { return J({ ok: false, error: 'bad json' }, 400); }

  try {
    const rec = await store.get(id);
    if (!rec) return J({ ok: false, error: 'not found' }, 404);
    Object.assign(rec, sanitizePatch(patch));
    await putBug(store, rec);
    return J({ ok: true, bug: rec });
  } catch {
    return J({ ok: false, error: 'store unavailable' }, 502);
  }
}

// A Vercel Node.js function in the web-standard form: Request in, Response out.
export default { fetch: handler };
