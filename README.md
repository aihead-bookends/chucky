# Chucky

Bookends' menu-editor site: the Bookends landing page, the passphrase-gated editor picker, seven brand
editors, the bug-report queue and the secret-menu page, plus the API behind them. A from-scratch
rebuild of <https://chucky-chi.vercel.app>, built from the UI kit in `../menu-editor`.

**Status:** the site and backend are complete. **Capiche, Aiko, Aiko drinks, Capiche Surat, Capiche
Ahmedabad and Beshak have their menus** and are fully editable (see [The Capiche menu](#the-capiche-menu),
[The Aiko menu](#the-aiko-menu), [The Aiko drinks menu](#the-aiko-drinks-menu),
[The Capiche Surat drinks menu](#the-capiche-surat-drinks-menu),
[The Capiche Ahmedabad drinks menu](#the-capiche-ahmedabad-drinks-menu) and
[The Beshak menu](#the-beshak-menu)). The other editors don't have theirs yet: they show the full
chrome with an empty editing surface, and Export, Publish, Full Preview and Personalise stay disabled.

## Run it locally

```bash
npm run dev          # http://localhost:3003, and phones on the same Wi-Fi (it prints the address)
npm run dev:local    # this computer only
npm test             # API routes, publish safety, the Postgres store, every page over HTTP, the menu files
npm run check -- <url> # check a running site end to end, without changing any menu (see Deploy)
npm run db:migrate   # create the Postgres tables (db/schema.sql) in DATABASE_URL; safe to re-run
```

Needs Node 20+. Run `npm install` once: it installs the Postgres and Blob drivers the API uses.
The Postgres tests in `test/db.test.mjs` run only when `TEST_DATABASE_URL` points at a Postgres
they may write to (each run uses its own schema and drops it); without it they are skipped.

**Opening it on a phone or another computer.** `http://127.0.0.1:3003` and `localhost` only ever
mean "this same device", so they can't work anywhere else. `npm run dev` prints the address other
devices should use (for example `http://172.16.46.203:3003/ (Wi-Fi)`), and
it works for any device on the same Wi-Fi. If a network blocks devices from reaching each other,
which some office and guest Wi-Fi does, deploy to Vercel instead. Without https, browsers turn off
their built-in hashing, so the passphrase check falls back to its own SHA-256 (`sha256Hex` in
`site.js`, checked against Node's in the tests).

The dev server serves `public/` and runs the same `api/` handlers Vercel deploys. Settings come from
`.env` (copy `.env.example`):
- **With `DATABASE_URL`** (a local Postgres, e.g. `postgres://postgres:<password>@localhost:5432/chucky`;
  run `npm run db:migrate` once): menus, photos and bug reports go to Postgres, exactly as in
  production. Photo bytes stay in Postgres unless `BLOB_READ_WRITE_TOKEN` is set too.
- **Without it:** everything goes to `.data/store.json`, with no setup at all.

If a key isn't set, the server uses a local-only default (`dev-bug-key` / `dev-publish-key`) and
prints it when it starts.

## Deploy (Vercel)

1. Import this folder as a Vercel project. No framework and no build command are needed:
   `vercel.json` serves `public/`, and each file in `api/` becomes a Node.js function (each exports
   `default { fetch }`: a web Request in, a Response out). Not the Edge runtime: the Blob SDK needs
   Node's networking modules, which Edge doesn't have.
2. **Storage → Neon** (Postgres, from the Vercel Marketplace). It adds `DATABASE_URL`.
3. **Storage → Blob.** It adds `BLOB_READ_WRITE_TOKEN`. Drink photos go here. If you create the
   store as private, also set `BLOB_ACCESS=private`; every photo is served through `/api/photo/:id`
   either way.
4. **Create the tables.** Copy the Neon `DATABASE_URL` into your local `.env` and run
   `npm run db:migrate`. It's safe to run again after any change to `db/schema.sql`.
5. **Environment variables:** `BUG_KEY` (opens `/bugs/`) and `PUBLISH_KEY` (lets editors publish).
   Use two different values.
6. Deploy, then check it from your computer:
   ```bash
   npm run check -- https://your-site.vercel.app --publish-key <PUBLISH_KEY> --bug-key <BUG_KEY>
   ```
   It checks every page, the Capiche menu files, that menus and bug reports are stored in
   **Postgres** and the tables are there, both keys, every published menu and its history, and that
   publishing is protected. It ends with "✔ Everything checked is working". It never changes a
   menu: its publish test names an out-of-date starting version on purpose, so a healthy server
   refuses it with 409. Run it again after any change to the deployment.

**Bringing over the data from the Upstash deployment.** Put the old store's `KV_REST_API_URL` and
`KV_REST_API_TOKEN` in `.env` next to the Neon `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN`, then:
```bash
npm run db:import-upstash -- --dry-run   # counts what it would copy, writes nothing
npm run db:import-upstash
```
It copies every published menu with its kept history (each version keeps its time, chained oldest
to newest), every drink photo (to Blob, after checking the bytes match the id), and every bug report
(with the time it had left). It's safe to run again: it copies only what's missing. Run it before
anyone publishes on the new deployment; an editor that already has versions in Postgres is skipped.

### What Postgres holds (`db/schema.sql`)

| Table | One row per | Kept |
|---|---|---|
| `menu_versions` | Publish: `editor`, `t` (the version), `parent_t` (the version it was edited from), `base` (which PDF), `state` (the editor's whole state, exactly as published), `summary` | forever; the highest `t` is the live menu |
| `menu_version_items` | editable value in a version: `path` (e.g. `edits/1:9`, `added/0/name`, `markerEdits/1:0`, `photos/1:3/id`, `bands/2/price`), `section`, `value` | with its version |
| `photos` | drink photo: `id` (SHA-256), `type`, `size`, `url` (Vercel Blob); `bytes` only without Blob | forever |
| `kv` | bug report (`bug_*` → the report), with `expires_at` | 45 days |

`UNIQUE (editor, parent_t)` is the publish lock: two publishes edited from the same version can't
both land, even at the same instant. Every value of every version can be followed over time, for
example:
```sql
SELECT t, value FROM menu_version_items WHERE editor = 'capiche' AND path = 'edits/1:9' ORDER BY t;
```

## Pages

| Path | Page |
|---|---|
| `/` | Bookends landing |
| `/chucky/` | Editor picker (passphrase `chucky`: a client-side check that keeps casual visitors out, not real access control) |
| `/capiche/` `/aiko/` `/churnd/` `/beshak/` | Food editors |
| `/drinks/` `/capiche-surat/` `/capiche-ahm/` | Drinks editors (Aiko, Capiche Surat, Capiche Ahmedabad) |
| `/bugs/` | Bug-report queue (asks for `BUG_KEY` in the page, and remembers it on that device) |
| `/menu/` | Secret menu: links to the customer menu and the back door |
| `/preview/` | Full-size viewer the editors' "Full Preview ↗" button opens |

## API

Keys are sent as `Authorization: Bearer <key>`. `?k=<key>` is still accepted for older scripts.

| Route | Access | Does |
|---|---|---|
| `POST /api/bug` | public | File a report `{editor, page, desc, url, state, shot}`. Every field is clamped; it expires after 45 days. |
| `GET /api/bugs[?status=][&lite=1]` | `BUG_KEY` | List reports, newest first (`lite` drops snapshots). |
| `PATCH /api/bug/:id` | `BUG_KEY` | Triage: only `status`, `approved`, `resolution` can change. |
| `GET /api/menu-state/:editor` | public | The editor's last-published edit state, or 404. |
| `GET /api/menu-state/:editor?history=1` | public | Every kept version, newest first. |
| `GET /api/menu-state/:editor?v=<t>` | public | One version. |
| `POST /api/menu-state/:editor` | `PUBLISH_KEY` | Publish `{state, base, prev}` for every device. `prev` is the version the edit started from (`null` if none). If that's no longer current it answers 409 and writes nothing. The replaced version is kept. |
| `POST /api/photo` | `PUBLISH_KEY` | Store a drink photo (the JPEG or PNG bytes, up to 600 KB) and answer `{id}`: the SHA-256 of the bytes. The editor calls it while publishing. The same photo twice is stored once. |
| `GET /api/photo/:id` | public | A stored photo. An id always names the same image, so it may be cached for a year. |
| `GET /api/health` | public | Where menus and bug reports are stored, whether each answers, whether the Postgres tables exist, and whether both keys are set. |

Editor keys: `capiche`, `aiko`, `churnd`, `beshak`, `aiko-drinks` (served at `/drinks/`),
`capiche-surat`, `capiche-ahm`.

## Layout

```
public/
  index.html  404.html  chucky/  bugs/  menu/
  <editor>/index.html        thin page: <html data-editor="…"> + the shared scripts
  capiche/ aiko/ drinks/ capiche-surat/ capiche-ahm/ beshak/   + the menu: PDF, fieldmap, starting state, engine.js, dictionaries
  preview/index.html         full-size PDF viewer (Full Preview)
  assets/css/site.css        landing, hub, secret menu, 404
  assets/css/editor.css      all seven editors; one colour-token block per brand
  assets/js/brands.js        per-editor config: name, mark, tabs, API key
  assets/js/editor.js        editor shell: header, rail, editing surface, preview, backend status
  assets/js/menustate.js     loading and publishing the menu safely: live chip, bars, versions
  assets/js/bugreport.js     "Report a bug" button + form
  assets/js/chucky.js        the mascot and his lines
  assets/js/site.js          tile tilt + passphrase check
  assets/brand/*.svg         Capiche / Aiko marks, drawn as CSS masks so they take the brand colour
api/                         Vercel Node.js functions; _lib/ holds shared code and isn't routable
db/schema.sql                the Postgres tables (npm run db:migrate)
dev/                         local dev server, file store, Postgres adapter (pg.mjs), check.mjs,
                             db-migrate.mjs, db-import-upstash.mjs (not deployed)
test/                        node --test
```

Compared with the original, the eleven copy-pasted pages became one editor stylesheet and runtime
with a colour-token block per brand, as the kit's DESIGN.md recommends. The backend is now a single
Vercel implementation instead of three copies (Cloudflare, Netlify, Vercel).

## Publishing: changes are never lost silently

**What went wrong in the old Chucky.** Staff published a menu, everyone saw it, and later the
changes were gone. Comparing the old site's published menus with the files its editors load showed
the causes:

- **Aiko:** published on 2 Sep for one menu PDF. The PDF was replaced afterwards, and the old
  editor applied the saved edits to the new file anyway. Those edits point at byte positions in the
  old file, so they landed wrong or vanished.
- **Capiche:** the published Ghaslet price (150/400) was dropped on every load, by the add-ons bug
  described below.
- **Beshak and the three drinks menus:** nothing had ever been published to the server. The drinks
  editors' **Save** button saved on that device only, and uploaded photos never left it.
- Two more gaps made the same result easy to trigger:
  - Loading the published menu gave up after 4 seconds and quietly showed the old one.
  - Any stale copy (a tab left open, or old unsaved edits resumed) could publish over newer
    changes, with no way back.

**What the new Chucky does instead** (`api/menu-state/[editor].mjs` and `assets/js/menustate.js`):

| Risk | Guard |
|---|---|
| Publishing from an out-of-date copy | Every publish names the version it started from. If someone else has published since, the server refuses it (409) and writes nothing. The editor explains, and **Load the latest menu** fetches it. Your own edits go to History first. |
| A publish that didn't really save | The server reads the menu back after writing and only reports success if it matches. |
| No way back | Every published version is kept in Postgres, forever, with every edited value as its own row. Click the live chip to see them (the newest 50), **Load** one, then **Publish** it. Without Postgres (the dev file store), the newest 50 are kept for a year. |
| The published menu fails to load | Retried 3 times. If it still fails, a red bar says so and **Publish is switched off**, so an old menu can't be published over the real one. |
| A menu made for a different PDF | Not applied. A bar says why. Publishing over it asks first, and the old one stays in the versions. |
| Old unsaved edits on a device | If they predate the latest publish, the resume bar says so and makes **Keep the published menu** the default. The old edits still go to History. |
| Not knowing what's live | The chip beside Publish always says: **Live · 4:14 PM**, **Unpublished changes**, **Not published**, or **Not connected**. The device autosave chip says **Saved on this device**, never just "Saved". Closing the tab with unpublished changes asks first. |
| A newer publish from another device | Picked up automatically when you come back to the tab (and every minute). If you have unpublished edits, a bar offers it instead of replacing them. |

Two publishes arriving at the same instant: in Postgres, `UNIQUE (editor, parent_t)` lets exactly
one land and the other gets the 409. (The key-value store used without Postgres can't lock, so its
read-back check reports the one that lost.) Photos and anything else a
future editor stores must go to the server, never only into the browser, or the drinks-editor
problem comes back.

## The Capiche menu

The editor never re-typesets the menu. It edits the designer's PDF in place, splicing new text into
the page's bytes, so the export is the real artwork with surgical changes. `public/capiche/` holds:

| File | What it is |
|---|---|
| `capiche.pdf` | The original designer PDF (the "base"). It is never modified. |
| `fieldmap.json` | Where every dish's name, description, price and markers sit in that PDF's bytes |
| `start-state.json` | **The current menu**, stored as edits on top of `capiche.pdf` |
| `engine.js` | The editing engine, ported verbatim from the original editor. Changes are marked `chucky-2`. |
| `base_words.json`, `culinary.json` | Spell-check dictionaries |

The current menu is the `Capiche_Menu (2).pdf` export from 29 Sep 2026. Relative to the base PDF, it
renames HULK → HULK 2.O and CASSATA → CASSATA 2.O, rewrites three descriptions, adds HOT CHIPS,
removes Pistachio Mousse Cake and Truffle Mac & Cheese, and changes some markers. The editor rebuilds
it exactly, except for the four descriptions that the price-column rule (below) re-wraps: AFFAIR,
HOT CHIPS, POMODORO pasta and ALFREDO. Every other line prints exactly as in that file.

**Descriptions fill the line up to the prices, then wrap.** Every description line uses the whole
width up to the price column, ending at least 2pt before the column's prices start (the same margin
a name keeps from its price). Only then does it wrap onto the next line. The fieldmap's own limit was
just the designer's longest line for each dish, so BURRATA HOT HONEY used to wrap at 33 characters
with room for 45, dropping new words onto a new line beside empty space. This applies to edited text, added dishes, and
the two designer lines that ran under the prices (AFFAIR and POMODORO pasta). Those two are always
re-set, even when untouched. Every other designer line already obeys the rule and is left as designed.
The closest is APOLLO's first line, at about 2pt.

**What an editor shows when it opens:** the last published menu, if there is one and it was made for
this `capiche.pdf`; otherwise the menu in `start-state.json`. A published state made for a different
base PDF is ignored, because its edits point at the wrong bytes.

**Ghaslet hot sauce price.** The live site's published state has this at **150/400**, but the
29 Sep export (made later) shows **120/400**, and `start-state.json` follows the export. The difference comes
from a bug in the old editor, fixed here: it loaded a published state before creating the add-ons
list, so published add-on prices were dropped on every load. If 150/400 is right, change it in the
editor and Publish.

**Names that don't fit.** A name shares its line with the dish's markers, so each marker turned on
leaves it less room. MARGHERITA has 20 characters a line with its usual 3 markers, and 16 with all
6. It can take a second line only if the column has space. A name that still doesn't fit is printed
cut down to what does fit, which can look as if the edit did nothing. The card says exactly what
prints and how to fix it, and Export is paused until the name fits.

**Fixed from the original engine** (each marked `chucky-2` in `engine.js`):
- Published add-on prices were dropped on every load (add-ons were set up after the state was applied).
- The layout plan was cached without the markers, so toggling a marker kept using the old room. The
  result was a warning that no longer applied, Export stuck paused, or a name laid out with the old
  room. A marker click now re-checks the warnings straight away.
- The "too long" warning now says what actually prints and why.
- The preview's click-to-edit boxes counted each description's original lines at a fixed 9pt, and
  only followed removals. So a description that grew stuck out below its box, and the boxes under it
  were left behind. They now use the same row positions and line counts the PDF is written with.
- Added dishes wrapped their description at a fixed 56 characters, whatever the column, so HOT CHIPS
  ran under its prices. They now use the price-column rule above.
- The fieldmap glued six descriptions' printed lines together with no space: "CHERRY TOMATO,STONE
  FRUIT", "HOTHONEY", "OLIVE OIL,CHILLI" and three more. The menu printed fine until someone edited
  one of them; the edit then printed the glued words. The ALFREDO edit already had: the 29 Sep menu
  prints "FRIED LEEKS,CHIMICHURRI". The fieldmap now has the spaces (read from the PDF's own lines),
  and so does the starting menu. **A published menu that still holds the old ALFREDO text** (the live
  site's does) keeps it until that description is fixed in the editor and published. The editor
  underlines it as a spelling issue.
- LABNEH and TRIPOLINE were flagged as spelling mistakes on the starting menu; they're in the
  dictionary now, so every page opens "All clear".

**Known quirk (inherited from the original):** in the edit boxes, long descriptions can wrap in the
middle of a word, because the engine joins words with non-breaking spaces. It only affects how text
wraps on screen. The PDF wraps correctly.

## The Aiko menu

`public/aiko/` holds the same kinds of files as Capiche: `aiko.pdf`, `fieldmap.json`,
`start-state.json`, `engine.js` and the dictionaries. The current menu is the `Aiko_Menu.pdf` export
from 29 Sep 2026: `aiko.pdf` with VOLCANO ROLL removed and a new CHEESE & CHILLI DUMPLINGS
description. The editor rebuilds it exactly, except that the description now fills its first line up
to the price instead of breaking early.

- **The old site's published Aiko menu was never wrong, only mislabelled.** It was made for the
  PDF before the 21 Sep QR bake (1,836,681 bytes). The bake left page 1's text bytes identical and
  kept every byte of page 2 in place, so its two changes still apply to today's `aiko.pdf`. They are
  what `start-state.json` holds. If the old database is connected, the editor still flags that
  record as made for another PDF (by file size) and shows the starting menu. That's the same menu,
  so publish once to replace it.
- **The weight tag.** Aiko prints each dish's weight ("[250gms]") in small type right after the
  last line of its description. Wrapping now reserves the tag's width on that last line, for
  existing dishes (including an edited weight) and for added ones. So filling a line up to the price
  never pushes the tag into the price column. Tested across 25 description lengths: the tag never
  came closer than 12pt to the prices.
- **Also fixed in Aiko:**
  - The grams box on each dish card had a hard-coded white background; it now matches the editor.
  - The name warning is re-checked when a marker is toggled, and says what actually prints.
  - The click boxes follow the real layout.
  - Everything loads and publishes through MenuState.
- Aiko's names never take a second line, and its markers don't feed the layout plan, so Capiche's
  marker-cache fix doesn't apply here.

## The Aiko drinks menu

`public/drinks/` (editor key `aiko-drinks`) holds `drinks.pdf`, `fieldmap.json`, the dictionaries,
`engine.js` and `start-state.json`. This editor works differently from the others. It doesn't splice
the artwork: it redraws the whole drinks page from a list of *bands*. Each band has a gradient, a
name, a description, a volume and a price, and the soft drinks share one band at the bottom. Its
state is that whole list (`{bands, qr}`), not edits over the PDF, so Versions counts drinks instead of
edits. The "Menu" tab is PDF page 2 and "Cover" is page 1 (`pages: [1, 0]` in `brands.js`).

The starting menu is `Aiko_Drinks_Menu.pdf` (sent on 29 Sep 2026; exported from the old editor on 7
Aug): the fieldmap's drinks with MANGO CHAMOY removed. The editor rebuilds that file byte for byte,
apart from the date. For the same edits (renames, prices, volumes, gradients, reordering, removing and
adding drinks, soft drinks) it writes the same PDF as the old editor.

- **Five gradients run the other way from the original artwork.** When the fieldmap was made, the
  bands for MINT MOJITO, TROPICAL POP, MANGO CHAMOY, RASPBERRY KAFIR FIZZ and the soft drinks were
  read with their start and end colours swapped. The attached menu, and so the starting menu, print
  them that way. Swap the two colour boxes on a drink's card to flip one back.
- **Fixed:** the state is now a copy of the drinks. The old editor handed out its live list, so an
  edit after a snapshot also changed the snapshot (History entries, and the menu kept before loading
  the latest).
- Loading and publishing go through MenuState, as in the other editors.

## The Capiche Surat drinks menu

`public/capiche-surat/` holds `capiche-surat.pdf`, `fieldmap.json`, the dictionaries, `engine.js`
and an empty `start-state.json`. The PDF is the old site's processed copy of `Capiche_st_new.pdf`
(the menu sent on 29 Sep 2026). It prints the same page as that file; one photo tile differs by
under a pixel, because the SPECIALS bar was separated out so it can be switched on and off. With no
edits, the editor exports that page pixel for pixel. For the same edits (names, descriptions,
prices, volumes, removing and adding drinks, markers, NEW badges, SPECIALS bars, reordering) it
writes the same PDF as the old editor, byte for byte apart from the date.

Changes from the old editor:

- **Every letter and digit can be printed.** The PDF's AO Mono fonts are subsets of the artwork's
  own letters, so a name with X or Q printed with gaps and a price with 7 or 9 fell back to bold
  RobotoMono. Like Capiche, the editor now swaps in the full fonts from `assets/fonts/` when it
  loads (`assets/js/fullfonts.js`), on the loaded copy only, so `capiche-surat.pdf` and every
  published menu are unchanged. Names and prices accept everything AOMonoRegular has (prices stay
  digits only), descriptions and volumes everything AOMonoBold has. Ahmedabad does the same.
- **Photos are published.** The old editor kept an uploaded photo in that browser only, so no other
  device ever saw it. Worse, a device without the photo that published put the drink's old photo
  back for everyone. Now the menu names each drink's photo by id, with its crop:
  - a new upload is kept on this device until Publish;
  - Publish uploads it first (`POST /api/photo`, the same key) and only then publishes the menu that
    names it;
  - every other device loads it from `/api/photo/:id` and keeps a copy.

  If a photo can't be loaded, the bar names the drink and Export waits. The photo is never dropped
  from the menu by the next publish.
- **No separate Save button.** Its named saves lived only in one browser. Edits are autosaved on the
  device (with History, bottom left), and Publish keeps the menu, with its photos, for every device
  and in Versions.
- Loading and publishing go through MenuState, as for Capiche and Aiko.
- Discarding an added drink moves the photos of the added drinks after it up with them. They used to
  stay put, which put the wrong photos on the wrong drinks.
- Opening a page no longer counts as an edit.
- The "couldn't read that image" note is no longer shown as a font warning.

## The Capiche Ahmedabad drinks menu

`public/capiche-ahm/` holds `capiche-ahm.pdf`, `fieldmap.json`, the dictionaries, `engine.js` and an
empty `start-state.json`. The PDF is the old site's processed copy of `Capiche_Ahm_new.pdf` (the menu
sent on 28 Sep 2026: a cover and three menu pages, specials and soft drinks, coffee and matcha, iced
and V60). The cover has nothing to edit, so the tabs are the three menu pages. With no edits, the
editor exports every page exactly as the PDF has it.

The engine is Capiche Surat's with the brand swapped (`BRAND`, `MEM_BRAND`, the preview file name and
title). It works the same way, photos included (see above). Keep the two in step: `diff` between them should show only those lines. For
the same edits (the Surat list, on all three pages, plus uploaded photos) it writes the same page
content as the old Ahmedabad editor.

**Removing a drink, in both drinks editors** (`rowMap` and `reflowOps`):

- **The rows stretch to fill the page.** Removing a drink used to slide the rows below it up and leave
  an empty row at the bottom. Now the surviving rows share the freed height: text is spread through
  each taller row, and each photo's tile grows with it, the photo zooming slightly so it still
  covers the tile. Added drinks keep their fixed-height slots under the survivors, so once added
  drinks fill every freed row the page is laid out exactly as before. A page heading above the rows
  (Ahmedabad's COFFEE & MATCHA) stays put.
- **The photo of the drink above no longer slides within its tile.** A photo is often a tall image
  clipped to its tile and drawn from a point below it; the reflow moved the image but not the clip.
  Everything in a photo block now moves with its tile.
- **A removed drink's unlisted artwork goes with it.** Ahmedabad's V60 drinks draw their heading and
  their "Ask your server…" line outside the fieldmap's spans (the line is a separate Form XObject),
  so removing INTERNATIONAL left both behind, and INDIAN's line stayed put when its row moved. Now
  artwork inside a removed row's band is dropped, and such a line moves with its row.

Carried over from the old editor, not yet fixed:

- A drink added in a freed slot has its markers close against the end of its name.

## The Beshak menu

`public/beshak/` holds `beshak.pdf`, `fieldmap.json`, the dictionaries, `engine.js` and an empty
`start-state.json`. The PDF is `Beshak New.pdf` (the Canva export of 17 Sep 2026, sent on 29 Sep: 31
dishes over APPS, BREADS and MAINS on page 1 and DRINKS and DESSERT on page 2) run through the old
repo's builder, `src/beshak/build_beshak.js`. That uncompresses the streams the editor writes and
merges each font's two per-page subsets, and changes nothing that prints. Beshak's text is not in
the page stream but in a Form XObject per page, one glyph per string, so the fieldmap names a stream
for every field. With no edits, the editor exports every one of those streams exactly as the PDF
has it.

**The builder needed one fix, made for this build.** A text block can switch fonts part-way (the
artwork sets `/`, `'`, `(`, `)` and `&` in NotoSans between runs of the display and body faces), and
the builder labelled every run in a block with the block's *last* font. So Bappa's Modak's
description was filed as NotoSans, which has no letters, and its "&" and Sourdough Naan's ")" were
left out of their descriptions. The fix records each show-op's own font (`parseText` in `lib.js`)
and uses it wherever a run is measured or written (`build_beshak.js`), keeping the block's font for
deciding which runs are names. Against the unfixed build it changes exactly those two descriptions
and the BREADS column's width, which had run 4pt into MAINS. Apply the same fix before rebuilding.

Changes from the old editor:

- **Punctuation the faces don't have is set the way the artwork sets it.** An edit that uses `/`,
  `'`, `(`, `)` or `&` (in a name, a description or an added dish) sets that character in NotoSans,
  with a font switch around it, so "Biryani w/Salan", "Bappa's Modak" and the dessert and bread
  descriptions keep their punctuation when edited. The old editor refused those characters, and a
  description line holding one printed blank.
- **Only edited text is checked for characters the fonts can't print.** The check used to run on
  untouched text too, so the old editor opened with fields marked red and Export blocked. What is
  still refused: letters the display face lacks (capital H, I, L, O, Q, X, Y, Z and lowercase q, x,
  z; the Canva export subsets the fonts) and anything no NotoSans face has. Publish refuses the menu
  while any remain, as the old one did.
- Loading and publishing go through MenuState, as for Capiche and Aiko.
- Edit memory records which PDF edits were made for. It stored a function instead, so edits for an
  older PDF could not be told apart; autosaves from the old editor are shown but not resumed.
- Exports go to History (the old editor called a function the edit memory didn't have).
- Full Preview opens the shared `/preview/` page. The old one opened a new tab only after building
  the PDF, which browsers block as a pop-up.
- Messages appear in the page's bar instead of `alert()`, which some phone browsers block.

Carried over from the old editor, not yet fixed: a dish added to a column that has no room below its
last dish is drawn over whatever comes next (the heading of the next section). "+ Add item" puts it
in the section's roomiest column, so this needs several added to one section.

## Adding another editor's menu

Follow Capiche:

1. Copy the editor's PDF, `fieldmap.json` and dictionaries from the old repo
   (`deploy/public/<editor>/`) into `public/<id>/`. Write its `start-state.json`: the current menu as
   edits over that PDF, with `base` set to `"v"` + the PDF's size in bytes.
2. Extract its engine from `../menu-editor/reference/<editor>.html` into `public/<id>/engine.js`.
3. **Hand loading and publishing to MenuState.** Delete the engine's own Publish button code and its
   published-state fetch in `boot()`. Call `MenuState.boot()` there instead, and `MenuState.ready()`
   once the editor is built. Call `MenuState.touch()` after each regenerate, and make the same
   `MEM` changes (`pub` in the autosave, the resume warning, `rebase`). Search Capiche's `engine.js`
   for `MenuState` and `chucky-2` to see each one. Never keep work only in the browser: photos and
   anything else must reach the server, or other devices won't have them. A drinks editor with
   photos does what Capiche Surat's does (see below).
4. Make the other `chucky-2` fixes wherever that engine has the same code:
   - add-ons before state
   - markers in the layout plan's cache key
   - the clearer too-long warning
   - click boxes from the row shifts
   - the price-column rule for descriptions
5. In the page, load `menustate.js` and then the engine after `editor.js`. Set `menu: true` for the
   brand in `brands.js`.

`test/site.test.mjs` checks the engine compiles, its files are served, and its starting state
matches its PDF. Then run the browser checks: publish, reopen, publish from a stale tab, and open it
offline.

Adding a brand-new editor also needs an entry in `brands.js`, a token block in `editor.css`, and its
key in the `EDITORS` allowlist in `api/menu-state/[editor].mjs`. The tests fail if any is missing.
