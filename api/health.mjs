// GET /api/health — is the backend wired up? Which store is in use, can it be reached, and are the
// two keys set. Never reveals the keys themselves or the store's URL.
import { J, preflight } from './_lib/http.mjs';
import { getStore } from './_lib/store.mjs';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return J({ ok: false, error: 'method not allowed' }, 405);

  const env = globalThis.process?.env || {};
  const store = getStore();
  let storeOk = false, storeError;
  if (store) {
    try { await store.get('health_probe'); storeOk = true; } catch (e) { storeError = String(e?.message || e).slice(0, 200); }
  }
  return J({
    ok: storeOk,
    store: store ? store.kind : 'none',
    storeOk,
    ...(storeError ? { storeError } : {}),
    bugKey: !!env.BUG_KEY,
    publishKey: !!env.PUBLISH_KEY,
  });
}
