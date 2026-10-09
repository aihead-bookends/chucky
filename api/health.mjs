// GET /api/health — is the backend wired up? Never reveals the keys themselves or any URL.
//   store / storeOk   the key-value store bug reports live in (Upstash in production)
//   menus / menusOk   where published menus and drink photos live: 'postgres' when DATABASE_URL is
//                     set, otherwise the same key-value store
//   schema            Postgres only: are the tables there (npm run db:migrate)
//   bugKey / publishKey  are the two keys set
import { J, preflight } from './_lib/http.mjs';
import { getStore } from './_lib/store.mjs';
import { getMenus } from './_lib/menus.mjs';

const why = (e) => String(e?.message || e).slice(0, 200);

export async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return J({ ok: false, error: 'method not allowed' }, 405);

  const env = globalThis.process?.env || {};
  const store = getStore();
  let storeOk = false, storeError;
  if (store) {
    try { await store.get('health_probe'); storeOk = true; } catch (e) { storeError = why(e); }
  }
  const menus = getMenus();
  let menusOk = false, menusError, schema;
  if (menus) {
    try {
      if (menus.schemaOk) {
        schema = await menus.schemaOk();
        if (!schema) menusError = 'the database has no tables yet — run npm run db:migrate';
      }
      else await menus.current('capiche');
      menusOk = schema !== false;
    } catch (e) { menusError = why(e); }
  }
  return J({
    ok: storeOk && menusOk,
    store: store ? store.kind : 'none',
    storeOk,
    ...(storeError ? { storeError } : {}),
    menus: menus ? menus.kind : 'none',
    menusOk,
    ...(schema !== undefined ? { schema } : {}),
    ...(menusError ? { menusError } : {}),
    bugKey: !!env.BUG_KEY,
    publishKey: !!env.PUBLISH_KEY,
  });
}

// A Vercel Node.js function in the web-standard form: Request in, Response out.
export default { fetch: handler };
