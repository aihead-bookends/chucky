# Chucky

Bookends' menu-editor site: the Bookends landing page, the passphrase-gated editor picker, seven brand
editors, the bug-report queue and the secret-menu page, plus the API behind them. A from-scratch
rebuild of <https://chucky-chi.vercel.app>, built from the UI kit in `../menu-editor`.

**Status:** the site and backend are complete. **Capiche and Aiko have their menus** and are fully
editable (see [The Capiche menu](#the-capiche-menu) and [The Aiko menu](#the-aiko-menu)). The other
five editors don't have theirs yet: they show the full chrome with an empty editing surface, and
Export, Publish, Full Preview and Personalise stay disabled.

## Run it locally

```bash
npm run dev          # http://localhost:3000, and phones on the same Wi-Fi (it prints the address)
npm run dev:local    # this computer only
npm test             # 38 tests: API routes, publish safety, Upstash client, every page over HTTP, the Capiche files
npm run check -- <url> # check a running site end to end, without changing any menu (see Deploy)
```

Needs Node 20+ and nothing else: there are no dependencies, so there's no `npm install`.

**Opening it on a phone or another computer.** `http://127.0.0.1:3000` and `localhost` only ever
mean "this same device", so they can't work anywhere else. `npm run dev` prints the address other
devices should use (for example `http://172.16.46.203:3000/ (Wi-Fi)`), and
it works for any device on the same Wi-Fi. If a network blocks devices from reaching each other,
which some office and guest Wi-Fi does, deploy to Vercel instead. Without https, browsers turn off
their built-in hashing, so the passphrase check falls back to its own SHA-256 (`sha256Hex` in
`site.js`, checked against Node's in the tests).

The dev server serves `public/` and runs the same `api/` handlers Vercel deploys. It stores data in
`.data/store.json`. Keys come from `.env` (copy `.env.example`). If a key isn't set there, the server
uses a local-only default (`dev-bug-key` / `dev-publish-key`) and prints it when it starts.

## Deploy (Vercel)

1. Import this folder as a Vercel project. No framework and no build command are needed:
   `vercel.json` serves `public/`, and `api/` becomes Edge Functions.
2. **Storage → Upstash Redis.** The integration adds `KV_REST_API_URL` / `KV_REST_API_TOKEN`
   (the `UPSTASH_REDIS_REST_*` names work too).
3. **Environment variables:** `BUG_KEY` (opens `/bugs/`) and `PUBLISH_KEY` (lets editors publish).
   Use two different values.
4. Deploy, then check it from your computer:
   ```bash
   npm run check -- https://your-site.vercel.app --publish-key <PUBLISH_KEY> --bug-key <BUG_KEY>
   ```
   It checks every page, the Capiche menu files, that storage is **Upstash** and reachable, both
   keys, every published menu and its history, and that publishing is protected. It ends with
   "✔ Everything checked is working". It never changes a menu: its publish test names an
   out-of-date starting version on purpose, so a healthy server refuses it with 409. Run it again
   after any change to the deployment.

To keep the data from the current chucky-chi deployment, connect the same Upstash database. Key names
(`bug_*`, `menu_state_<editor>`) and the JSON format are unchanged, so existing bug reports and
published menus carry over.

## Pages

| Path | Page |
|---|---|
| `/` | Bookends landing |
| `/chucky/` | Editor picker (passphrase `chucky`: a client-side check that keeps casual visitors out, not real access control) |
| `/capiche/` `/aiko/` `/churnd/` `/beshak/` | Food editors |
| `/drinks/` `/capiche-surat/` `/capiche-ahm/` | Drinks editors (Aiko, Capiche Surat, Capiche Ahmedabad) |
| `/bugs/` | Bug-report queue (asks for `BUG_KEY`) |
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
| `GET /api/health` | public | Which store is in use, whether it answers, and whether both keys are set. |

Editor keys: `capiche`, `aiko`, `churnd`, `beshak`, `aiko-drinks` (served at `/drinks/`),
`capiche-surat`, `capiche-ahm`.

## Layout

```
public/
  index.html  404.html  chucky/  bugs/  menu/
  <editor>/index.html        thin page: <html data-editor="…"> + the shared scripts
  capiche/                   + the menu: PDF, fieldmap, starting state, engine.js, dictionaries
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
api/                         Vercel Edge Functions; _lib/ holds shared code and isn't routable
dev/                         local dev server + file store, and check.mjs (not deployed)
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
| No way back | Every replaced version is kept: the newest 50 per editor, for a year. Click the live chip to see them, **Load** one, then **Publish** it. |
| The published menu fails to load | Retried 3 times. If it still fails, a red bar says so and **Publish is switched off**, so an old menu can't be published over the real one. |
| A menu made for a different PDF | Not applied. A bar says why. Publishing over it asks first, and the old one stays in the versions. |
| Old unsaved edits on a device | If they predate the latest publish, the resume bar says so and makes **Keep the published menu** the default. The old edits still go to History. |
| Not knowing what's live | The chip beside Publish always says: **Live · 4:14 PM**, **Unpublished changes**, **Not published**, or **Not connected**. The device autosave chip says **Saved on this device**, never just "Saved". Closing the tab with unpublished changes asks first. |
| A newer publish from another device | Picked up automatically when you come back to the tab (and every minute). If you have unpublished edits, a bar offers it instead of replacing them. |

The last two edge cases: two publishes arriving within the same few milliseconds are not locked
against each other, and the read-back check reports the one that lost. Photos and anything else a
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
   anything else must reach the server, or other devices won't have them.
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
