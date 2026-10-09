// POST /api/bug — an editor reports a bug. Public and unauthenticated; see _lib/bugs.mjs for the clamps.
import { J, preflight, notConfigured, readBody } from './_lib/http.mjs';
import { MAX_BODY, newRecord, putBug } from './_lib/bugs.mjs';
import { getStore } from './_lib/store.mjs';

export async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return J({ ok: false, error: 'method not allowed' }, 405);
  const store = getStore();
  if (!store) return notConfigured();

  const raw = await readBody(req, MAX_BODY);
  if (raw === null) return J({ ok: false, error: 'payload too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return J({ ok: false, error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return J({ ok: false, error: 'bad json' }, 400);
  if (!String(body.desc || '').trim()) return J({ ok: false, error: 'desc is required' }, 400);

  const rec = newRecord(body);
  try { await putBug(store, rec); } catch { return J({ ok: false, error: 'store unavailable' }, 502); }
  return J({ ok: true, id: rec.id });
}

// A Vercel Node.js function in the web-standard form: Request in, Response out.
export default { fetch: handler };
