// Drink photos, shared by the photo routes (api/photo.mjs, api/photo/[id].mjs).
//
// The drinks menus print a photo beside each drink, and the person editing can upload a new one.
// A published menu names its photos by id; the bytes live here, so every device that opens the
// editor shows the same photos. (The old Chucky kept them in one browser's IndexedDB: a photo
// uploaded on one device never reached any other.)
//
// A photo's id is the SHA-256 of its bytes, computed here, never taken from the client. So a
// photo can't be swapped for another under the same id, the same image uploaded twice is stored
// once, and every published version — including the old ones kept in history — keeps pointing at
// exactly the image it was published with. Photos never expire: history can bring any of them back.

export const PHOTO_PREFIX = 'photo_';
export const photoKey = (id) => PHOTO_PREFIX + id;
export const isPhotoId = (id) => /^[0-9a-f]{64}$/.test(id || '');

// The editor re-encodes every upload to a JPEG at most 900px across (usually 100–250 KB). The cap
// keeps one stored photo, base64 in a JSON command, under Upstash's 1 MB request limit.
export const MAX_PHOTO = 600 * 1024;

// Only JPEG and PNG: the two formats a PDF can embed. Read from the bytes, not a header, so the
// type served back is always what the bytes are.
export function sniffImage(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// btoa/atob exist in the Edge runtime and in Node; Buffer only in Node. Chunked, because
// String.fromCharCode(...bytes) on a whole photo overflows the argument limit.
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
