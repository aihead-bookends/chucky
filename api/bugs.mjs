// GET /api/bugs[?status=new][&lite=1] — the bug queue for the /bugs/ dashboard. Gated by BUG_KEY.
import { J, preflight, notConfigured, authed } from './_lib/http.mjs';
import { listBugs } from './_lib/bugs.mjs';
import { getStore } from './_lib/store.mjs';

export async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return J({ ok: false, error: 'method not allowed' }, 405);
  if (!authed(req, url, 'BUG_KEY')) return J({ ok: false, error: 'forbidden' }, 403);
  const store = getStore();
  if (!store) return notConfigured();

  const status = url.searchParams.get('status');
  const lite = url.searchParams.get('lite') === '1';
  let bugs;
  try { bugs = await listBugs(store); } catch { return J({ ok: false, error: 'store unavailable' }, 502); }
  if (status) bugs = bugs.filter((b) => b.status === status);
  if (lite) bugs.forEach((b) => delete b.shot);
  return J({ ok: true, bugs });
}

// A Vercel Node.js function in the web-standard form: Request in, Response out.
export default { fetch: handler };
