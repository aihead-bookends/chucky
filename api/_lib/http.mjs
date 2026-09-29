// Request/response helpers shared by every /api route.

export const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

// no-store: a published menu or the bug queue must never be served from a browser or CDN cache.
export const J = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors },
  });

export const preflight = () => new Response(null, { status: 204, headers: cors });

export const notConfigured = () =>
  J({ ok: false, error: 'store not configured — connect Upstash Redis (see README)' }, 503);

// Keys are sent as `Authorization: Bearer <key>`. `?k=<key>` still works for scripts written against
// the old API, but the header keeps the key out of access logs, history and Referer.
function presentedKey(req, url) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
  return (m ? m[1] : url.searchParams.get('k') || '').trim();
}

// constant-time for equal lengths, so response timing doesn't leak how much of a guess was right
function sameKey(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// An unset env var locks the route rather than opening it.
export function authed(req, url, envVar) {
  const want = globalThis.process?.env?.[envVar] || '';
  const got = presentedKey(req, url);
  return !!want && !!got && sameKey(got, want);
}

// Reads the body as text, refusing oversized requests before buffering when Content-Length says so.
// Returns null when the body is over `max`.
export async function readBody(req, max) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const raw = await req.text();
  return raw.length > max ? null : raw;
}

// The same for a binary body (a photo). Returns a Uint8Array, or null when it is over `max`.
export async function readBytes(req, max) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const raw = new Uint8Array(await req.arrayBuffer());
  return raw.length > max ? null : raw;
}
