// Bug-report records: ids, input clamps and the listing used by the /bugs/ dashboard.
//
// POST /api/bug is public and unauthenticated, so every field is hostile input. The dashboard
// renders these fields into markup in a browser that holds BUG_KEY, which is why each one is
// bounded and type-checked here as well as escaped there.

export const PREFIX = 'bug_';
export const TTL_S = 60 * 60 * 24 * 45;   // records expire after 45 days

export const MAX_BODY = 1_200_000;        // whole request; the snapshot is the only large field
export const MAX_SHOT = 900_000;          // ~660KB of image once base64-encoded
export const MAX_STATE = 200_000;         // serialised editor state

export const newId = () => PREFIX + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

// Only ids this module could have minted. Without this check PATCH /api/bug/menu_state_capiche
// would load the published menu, rewrite it as a bug record and give it a 45-day expiry.
export const isBugId = (id) => /^bug_\d{10,16}_[a-z0-9]{1,12}$/.test(id);

// a snapshot must be an inline raster image — never data:text/html, never a bare string
export const safeShot = (s) =>
  typeof s === 'string' && s.length <= MAX_SHOT && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : null;

// the dashboard operator opens these links: http(s) only, and bounded
export const safeUrl = (u) => {
  if (typeof u !== 'string' || !u) return '';
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? u.slice(0, 300) : '';
  } catch { return ''; }
};

// keep the editor state, but never let it grow a record without bound
export const clampState = (s) => {
  if (!s || typeof s !== 'object') return null;
  try {
    const j = JSON.stringify(s);
    return j.length > MAX_STATE ? { truncated: true, bytes: j.length } : s;
  } catch { return null; }
};

export function newRecord(b) {
  return {
    id: newId(),
    t: Date.now(),
    status: 'new',
    editor: String(b.editor || '').slice(0, 60),
    page: Number.isFinite(+b.page) && b.page !== null && b.page !== '' ? +b.page : null,
    desc: String(b.desc || '').slice(0, 2000),
    url: safeUrl(b.url),
    state: clampState(b.state),
    shot: safeShot(b.shot),
  };
}

// Only the triage fields are writable on update — a key-holder can't rewrite id/t/shot/url/state.
export const STATUSES = new Set(['new', 'triaged', 'fixed', 'needs-auth']);
export function sanitizePatch(b) {
  const out = {};
  if (b && typeof b === 'object') {
    if (typeof b.status === 'string' && STATUSES.has(b.status)) out.status = b.status;
    if (typeof b.approved === 'boolean') out.approved = b.approved;
    if (typeof b.resolution === 'string') out.resolution = b.resolution.slice(0, 2000);
  }
  return out;
}

export const putBug = (store, rec) => store.set(rec.id, rec, { ex: TTL_S });

// Every live record, newest first. Redis expires them on its own; the `t` check also drops any
// record whose TTL never landed.
export async function listBugs(store) {
  const keys = await store.keys(PREFIX);
  const recs = await store.mget(keys);
  const cutoff = Date.now() - TTL_S * 1000;
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const r = recs[i];
    if (!r || typeof r !== 'object') continue;
    if (typeof r.t === 'number' && r.t < cutoff) { await store.del(keys[i]).catch(() => {}); continue; }
    out.push(r);
  }
  return out.sort((a, b) => b.t - a.t);
}
