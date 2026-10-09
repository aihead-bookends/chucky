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
//
// Where the bytes go (api/_lib/menus.mjs decides): Vercel Blob in production, as photos/<id>.jpg|png,
// with the Postgres `photos` table recording each photo and its Blob URL. Without a Blob token the
// bytes stay in that row (local dev), and without Postgres in the key-value record as base64.

export const PHOTO_PREFIX = 'photo_';
export const photoKey = (id) => PHOTO_PREFIX + id;
export const isPhotoId = (id) => /^[0-9a-f]{64}$/.test(id || '');

// The editor re-encodes every upload to a JPEG at most 900px across (usually 100–250 KB), so this
// cap is generous. It also keeps a base64 photo record (no Blob) well under a megabyte.
export const MAX_PHOTO = 600 * 1024;

// A Blob photo store has two async methods (+ a `kind` label):
//   save(id, bytes, type) -> the Blob URL
//   load(url) -> the image bytes as a ReadableStream, or null if Blob has no such photo
const env = (name) => globalThis.process?.env?.[name] || '';
let injected;          // undefined = not injected; null = injected "no Blob"
let cached = null;

export function setPhotoStore(photos) { injected = photos; }

export function getPhotoStore() {
  if (injected !== undefined) return injected;
  const token = env('BLOB_READ_WRITE_TOKEN');
  if (!token) return null;
  // A Blob store is created public or private. Photos are printed on the menu, so public is the
  // default; BLOB_ACCESS=private works too, since every read goes through GET /api/photo/:id.
  const access = env('BLOB_ACCESS') === 'private' ? 'private' : 'public';
  if (!cached || cached.token !== token || cached.access !== access) cached = { token, access, photos: blobPhotos(token, access) };
  return cached.photos;
}

export function blobPhotos(token, access = 'public', sdk = () => import('@vercel/blob')) {
  return {
    kind: 'blob',
    save: async (id, bytes, type) => {
      const { put } = await sdk();
      // The same id is always the same bytes, so overwriting is harmless, and re-uploading a photo
      // whose blob was deleted puts it back.
      const r = await put('photos/' + id + (type === 'image/png' ? '.png' : '.jpg'), bytes, {
        access, token, contentType: type, addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000,
      });
      return r.url;
    },
    load: async (url) => {
      const { get } = await sdk();
      const r = await get(url, { access, token });
      return r && r.statusCode === 200 ? r.stream : null;
    },
  };
}

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
