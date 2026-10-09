// GET /api/photo/:id   public   -> the image bytes | 404
//
// Public for the same reason the published menu is: every device has to load the photos a menu
// names, and they are the photos printed on it. An id names one exact image forever (it is the
// SHA-256 of the bytes), so browsers and the CDN may keep it for a year.
import { J, cors, preflight, notConfigured } from '../_lib/http.mjs';
import { isPhotoId } from '../_lib/photos.mjs';
import { getMenus } from '../_lib/menus.mjs';

export async function handler(req) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return J({ ok: false, error: 'method not allowed' }, 405);
  const id = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!isPhotoId(id)) return J({ ok: false, error: 'bad photo id' }, 400);
  const menus = getMenus();
  if (!menus) return notConfigured();

  let rec;   // { type, bytes }: bytes from the record, or streamed from Vercel Blob
  try { rec = await menus.getPhoto(id); } catch { return J({ ok: false, error: 'store unavailable' }, 502); }
  if (!rec) return J({ ok: false, error: 'no such photo' }, 404);
  return new Response(rec.bytes, {
    headers: {
      'content-type': rec.type === 'image/png' ? 'image/png' : 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      ...cors,
    },
  });
}

// A Vercel Node.js function in the web-standard form: Request in, Response out.
export default { fetch: handler };
