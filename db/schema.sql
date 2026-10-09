-- Chucky's Postgres schema: every published menu, kept forever, and the drink photos they name.
-- Idempotent: `npm run db:migrate` runs it on every deploy without harm. Needs Postgres 15+
-- (NULLS NOT DISTINCT); Neon and any current Postgres qualify.

-- One row per Publish. The highest `t` for an editor is its live menu; every other row is history,
-- and nothing is ever pruned or expires.
CREATE TABLE IF NOT EXISTS menu_versions (
  editor       text        NOT NULL,
  t            bigint      NOT NULL,             -- version id: ms timestamp, strictly increasing per editor
  parent_t     bigint,                           -- the version this publish was edited from; null = the first
  base         text        NOT NULL DEFAULT '',  -- the base PDF the edits were made for ("v<bytes>")
  -- the editor's whole state exactly as it sent it. `json`, not `jsonb`: jsonb reorders object keys,
  -- and an editor gets back byte-for-byte what it published
  state        json        NOT NULL,
  summary      jsonb       NOT NULL DEFAULT '{}', -- the counts the Versions panel lists
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (editor, t),
  -- Two publishes edited from the same version can never both land: the second one fails here,
  -- inside its transaction, and is answered 409. This is the publish lock.
  CONSTRAINT menu_versions_one_child UNIQUE NULLS NOT DISTINCT (editor, parent_t)
);

-- Every editable value of every published version, one row each: a name, a description, a price, a
-- volume, a marker set, a badge or SPECIALS toggle, a photo and its crop, a removed or added item,
-- the order, add-ons, QR codes, the personalised cover. `path` addresses the value inside `state`
-- (keys joined with "/", "~" and "/" in a key escaped as "~0" and "~1", as in JSON Pointer):
--   edits/1:9                 Capiche: field 1:9's new text
--   added/0/name              the first added dish's name
--   markerEdits/1:0           a dish's marker set (a list is one value: the set is what is edited)
--   photos/1:3/id             a drink's photo (photos.id) and, beside it, /zoom /dx /dy /rot
--   bands/2/price             the Aiko drinks menu's third drink's price
CREATE TABLE IF NOT EXISTS menu_version_items (
  editor  text   NOT NULL,
  t       bigint NOT NULL,
  path    text   NOT NULL,
  section text   NOT NULL,      -- the first key of the path: edits, removed, added, photos, bands, qr…
  value   jsonb  NOT NULL,
  PRIMARY KEY (editor, t, path),
  FOREIGN KEY (editor, t) REFERENCES menu_versions (editor, t) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS menu_version_items_by_path ON menu_version_items (editor, path, t);

-- Drink photos. The id is the SHA-256 of the bytes, computed by the server, so an id always names the
-- same image and every old version keeps pointing at exactly the photo it was published with.
-- The bytes live in Vercel Blob (`url`). Without a Blob token (local dev) they are kept here instead.
CREATE TABLE IF NOT EXISTS photos (
  id         text        PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  type       text        NOT NULL CHECK (type IN ('image/jpeg', 'image/png')),
  size       integer     NOT NULL,
  url        text,
  bytes      bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (url IS NOT NULL OR bytes IS NOT NULL)
);

-- Bug reports (bug_<t>_<rand> -> the report as JSON text). A plain key-value table: the /bugs/ queue
-- only ever reads a report whole, and each one expires (expires_at, ms since the epoch; null = never).
CREATE TABLE IF NOT EXISTS kv (
  key        text   PRIMARY KEY,
  value      text   NOT NULL,
  expires_at bigint
);
