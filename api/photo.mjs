// POST /api/photo   PUBLISH_KEY   body: the image bytes (JPEG or PNG)  -> { ok, id, size }
//
// Stores a drink photo and returns its id, the SHA-256 of the bytes (see _lib/photos.mjs). The
// editor uploads a menu's new photos just before it publishes the menu that names them, so it needs
// the same key as publishing. Uploading a photo that is already stored changes nothing.
import { J, preflight, notConfigured, authed, readBytes } from './_lib/http.mjs';
import { MAX_PHOTO, photoKey, sniffImage, sha256Hex, toBase64 } from './_lib/photos.mjs';
import { getStore } from './_lib/store.mjs';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return J({ ok: false, error: 'method not allowed' }, 405);
  if (!authed(req, url, 'PUBLISH_KEY')) return J({ ok: false, error: 'forbidden' }, 403);

  const bytes = await readBytes(req, MAX_PHOTO);
  if (bytes === null) return J({ ok: false, error: 'photo too large — the limit is ' + Math.round(MAX_PHOTO / 1024) + ' KB' }, 413);
  const type = sniffImage(bytes);
  if (!type) return J({ ok: false, error: 'not a JPEG or PNG image' }, 415);
  const store = getStore();
  if (!store) return notConfigured();

  const id = await sha256Hex(bytes);
  const b64 = toBase64(bytes);
  try {
    const have = await store.get(photoKey(id));
    if (!have || have.b64 !== b64) {
      await store.set(photoKey(id), { type, size: bytes.length, t: Date.now(), b64 });
      // read back: the menu about to be published points at this photo, so it has to be there
      const check = await store.get(photoKey(id));
      if (!check || check.b64 !== b64) return J({ ok: false, error: 'the photo could not be confirmed as saved' }, 502);
    }
  } catch {
    return J({ ok: false, error: 'store unavailable' }, 502);
  }
  return J({ ok: true, id, size: bytes.length });
}
