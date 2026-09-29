/* Beshak — the menu engine and editor: byte-level edits to beshak.pdf, driven by fieldmap.json.
   Ported verbatim from the original Chucky editor (deploy/public/beshak/index.html, which the old
   repo builds from src/beshak/engine.js + ui.js); every change is marked "chucky-2". It runs inside
   the shell that assets/js/editor.js renders, and relies on pdf-lib (PDFLib) and pdf.js (pdfjsLib)
   loaded by index.html. */
// ===================== BESHAK — byte-level menu engine =====================
// Loads the real designed PDF, splices new text/markers into its content streams, and re-saves.
// Nothing here re-typesets the menu: an untouched session exports bytes identical to the source.
//
// Three things make Beshak different from the other brands, and they shape the whole file:
//  * Editable bytes live in Form XObjects, not page content streams, so pristine bytes are kept
//    per STREAM (`PRISTINE[id]`) and every field says which stream its spans index.
//  * Text is Identity-H — each glyph is a 2-byte CID inside its own tiny string in a kerned TJ
//    array — so writing text means re-encoding through the font's unicode->CID table.
//  * On page 2 the dairy/gluten/sesame markers are baked into the background raster. Removing one
//    means painting its (pure white) box out; anything still wanted is re-stamped as a vector.

const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } = PDFLib;

let FM = null;                 // fieldmap.json
let pdfDoc = null;             // pdf-lib document
let pdfBytesOrig = null;       // the pristine file, for version fingerprinting
const PRISTINE = {};           // streamId -> original bytes as a latin1 string
const STREAM_REF = {};         // streamId -> PDFRef
const STREAM_DICT = {};        // streamId -> PDFDict

// ---- edit state (this, and only this, is what Publish and edit-memory persist) ----
const edits = {};              // fieldId -> new text
let removed = [];              // name-field ids that are hidden
let added = [];                // {col, name, desc, price, gram, markers}
let markerEdits = {};          // name-field id -> array of marker types

const ART = 10;                // artwork units per point (the page draws its XObject at 0.1)
const byId = {};               // fieldId -> field
const kidsOf = {};             // name id -> {desc, price, gram}

// ============================================================ small utilities
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = (v) => Math.round(v * 100) / 100;

/** Escape raw bytes (held as latin1 chars) into a PDF literal string body. */
function escPdf(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i], c = bytes.charCodeAt(i);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c === 13) out += '\\r';
    else if (c === 10) out += '\\n';
    else if (c < 32 || c === 127) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out;
}

/**
 * Apply byte-span replacements to a stream. Ops are applied right-to-left so earlier spans keep
 * their offsets; overlapping ops are dropped rather than silently corrupting the stream.
 */
function applyOps(text, ops) {
  const sorted = ops.slice().sort((a, b) => b.s - a.s);
  let out = text, guard = Infinity;
  for (const o of sorted) {
    if (o.e > guard) continue;
    out = out.slice(0, o.s) + o.t + out.slice(o.e);
    guard = o.s;
  }
  return out;
}

// ---- font access -------------------------------------------------------------
const famOf = (f) => FM.res_to_family[f.page + f.font];
const familyOf = (f) => FM.families[famOf(f)];

/** Text -> CIDs, or null if the menu's font has no glyph for some character. */
function toCids(text, fam) {
  const F = FM.families[fam];
  const out = [];
  for (const ch of text) {
    const c = F.uni2cid[ch];
    if (c === undefined) return null;
    out.push(c);
  }
  return out;
}
/** Characters this font cannot set — surfaced in the UI rather than silently dropped.
    chucky-2: one a fallback face can set is not missing (see encodeRuns), except in a gm/ml label. */
function missingChars(text, fam, noFallback) {
  const F = FM.families[fam];
  const bad = [];
  for (const ch of text) {
    if (F.uni2cid[ch] !== undefined || bad.includes(ch)) continue;
    if (!noFallback && typeof fallbackFams === 'function' && fallbackFams().some((f) => FM.families[f].uni2cid[ch] !== undefined)) continue;
    bad.push(ch);
  }
  return bad;
}

/** One show-op: every glyph its own string, separated by the field's baked tracking. */
function showOp(cids, kern) {
  if (!cids || !cids.length) return '';
  const parts = cids.map((c) => '(' + escPdf(String.fromCharCode(c >> 8) + String.fromCharCode(c & 255)) + ')');
  return '[' + parts.join(String(kern || 0)) + ']TJ';
}

/* chucky-2: FALLBACK GLYPHS. The display and body faces have no "/", "'", "(", ")" or "&", so the
   artwork sets those in NotoSans between runs of them: "Biryani w/Salan", "Bappa's Modak",
   "(Green Garlic Butter, Butter or Plain)", "Chocolate & Coconut". Edited text does the same — a
   character the field's face lacks is set in a NotoSans face that has it, with a font switch
   around it — so those dishes keep their punctuation when edited. It used to be refused as
   unprintable, and the check ran on untouched text too, so the menu opened with fields marked red
   and Export blocked.
   Only in the page's artwork stream: a gm/ml label is its own XObject with its own fonts. */
const FALLBACK_FAMS = ['NotoSans-Bold', 'NotoSans-Regular'];
const fallbackFams = () => FALLBACK_FAMS.filter((f) => FM.families[f]);
/** The font resource on `page` that draws family `fam`, e.g. '/R119'. */
function resFor(page, fam) {
  const k = Object.keys(FM.res_to_family).find((key) => key.startsWith(page + '/') && FM.res_to_family[key] === fam);
  return k ? k.slice(String(page).length) : null;
}
/** Text -> runs of [{res, cids}] in the field's font and any fallback, or null if some character
    has no glyph anywhere this field can use. */
function encodeRuns(text, fld) {
  const F = FM.families[famOf(fld)];
  const canFall = !FM.streams[fld.stream] || FM.streams[fld.stream].kind === 'main';
  const runs = [];
  for (const ch of text) {
    let res = fld.font, c = F.uni2cid[ch];
    if (c === undefined) {
      if (!canFall) return null;
      const fb = fallbackFams().find((f) => FM.families[f].uni2cid[ch] !== undefined && resFor(fld.page, f));
      if (!fb) return null;
      res = resFor(fld.page, fb); c = FM.families[fb].uni2cid[ch];
    }
    const last = runs[runs.length - 1];
    if (last && last.res === res) last.cids.push(c); else runs.push({ res, cids: [c] });
  }
  return runs;
}
/** The show-ops for text written into op `o`: a Tf wherever the font changes. `o` may have been
    drawn in another font than the field's (Sourdough's line 3 starts with a NotoSans "("), so the
    first run switches if it must, and the op's own font is put back after, for whatever follows. */
function showRuns(fld, o, runs) {
  if (!runs || !runs.length) return '';
  const start = (o && o.font) || fld.font;
  let cur = start, out = '';
  for (const r of runs) {
    if (r.res !== cur) { out += `${r.res} ${fld.size} Tf `; cur = r.res; }
    out += showOp(r.cids, fld.kern) + ' ';
  }
  if (cur !== start) out += `${start} ${fld.size} Tf`;
  return out.trim();
}
/** A character's advance in `fam`, else in the fallback face that would set it. */
function glyphW(fam, ch) {
  for (const f of [fam, ...fallbackFams()]) {
    const F = FM.families[f], c = F && F.uni2cid[ch];
    if (c !== undefined && F.widths[c] !== undefined) return F.widths[c];
  }
  return 500;
}

function textWidth(text, fam, size, kern) {
  let w = 0, n = 0;
  for (const ch of text) {
    w += glyphW(fam, ch);   // chucky-2: fallback glyphs measure as the face that sets them
    n++;
  }
  // TJ kerns tighten the run by kern/1000 em per gap
  return (w / 1000) * size - Math.max(0, n - 1) * ((kern || 0) / 1000) * size;
}

/** Greedy word wrap to a pixel width, capped at maxLines (the last line keeps the overflow). */
function wrapText(text, fam, size, width, maxLines, kern) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (cur && textWidth(next, fam, size, kern) > width) { lines.push(cur); cur = w; }
    else cur = next;
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

const maxCharsFor = (width, size, role) => Math.max(4, Math.floor(width / (size * (FM.adv[role] || 0.5))));

// ============================================================ geometry helpers
const colOf = (nameField) => FM.columns.find((c) => c.id === nameField.col);

/** Live x where a name ends, honouring an edit that made it longer or shorter. */
function nameRight(f) {
  const t = edits[f.id] !== undefined ? edits[f.id] : f.display;
  return r2(f.x + textWidth(t, famOf(f), f.size, f.kern));
}

/**
 * How far the trailing cluster (gm label + markers) has to slide because the name changed
 * length. The designer set the GAP between the name and that cluster, so keeping the gap — not
 * the absolute position — is what stops a longer name from running into its own icons.
 *
 * This measures the edit against the baked text with the SAME width function, rather than
 * against the stored `right`: a name split into several show-ops does not measure identically
 * either way, and an unedited dish must come out at exactly zero or its markers would be
 * needlessly re-stamped and the export would stop being byte-identical.
 */
function clusterShift(f) {
  if (edits[f.id] === undefined) return 0;
  const fam = famOf(f);
  return r2(textWidth(edits[f.id], fam, f.size, f.kern) - textWidth(f.display, fam, f.size, f.kern));
}

/** Marker slots for a dish, left to right, after any name-length change and reflow. */
function markerSlots(f, types, dx, dy) {
  const k = kidsOf[f.id] || {};
  const baked = (f.marker_boxes || []);
  let x;
  if (baked.length) x = baked[0].x + dx;
  else if (k.gram && k.gram.bbox[0] > f.x) x = k.gram.bbox[2] + dx + FM.marker_gap;
  else x = nameRight(f) + FM.marker_gap;
  const out = [];
  for (const t of FM.marker_order) {
    if (!types.includes(t)) continue;
    const ic = FM.icons[t];
    out.push({ type: t, x: r2(x), y: r2(f.y + (FM.marker_dy[t] || -1) + dy) });
    x += ic.w / ART + FM.marker_gap;
  }
  return out;
}

/** PDF ops that paint one marker at a point, in artwork units. */
function stampMarker(type, x, y) {
  const ic = FM.icons[type];
  const sc = ic.scale && ic.scale !== 1 ? ` ${ic.scale} 0 0 ${ic.scale} 0 0 cm` : '';
  return `q 1 0 0 1 ${r2(x * ART)} ${r2(y * ART)} cm${sc} ${FM.brand_k}\n${ic.body}\nf Q\n`;
}

/**
 * Paint out a box in paper white. This is how a marker that is part of page 2's background
 * raster gets removed — the artwork behind every marker slot is flat white, so a filled box is
 * invisible. `0 0 0 0 k` keeps the file in the CMYK space the rest of the artwork uses.
 */
function patchBox(b, bleed) {
  const m = bleed === undefined ? 0.45 : bleed;
  return `q 0 0 0 0 k ${r2((b.x - m) * ART)} ${r2((b.y - m) * ART)} ${r2((b.w + 2 * m) * ART)} ${r2((b.h + 2 * m) * ART)} re f Q\n`;
}

// ============================================================ regenerate
/**
 * Rebuild the PDF from the pristine bytes plus the current edit state.
 * With no edits every stream is written back unchanged, so the export is byte-identical.
 */
async function regenerate() {
  const ops = {};                       // streamId -> [{s,e,t}]
  const tail = {};                      // streamId -> appended ops (stamps, patches, new text)
  const push = (sid, s, e, t) => { (ops[sid] = ops[sid] || []).push({ s, e, t }); };
  const append = (sid, t) => { tail[sid] = (tail[sid] || '') + t; };

  // ---- reflow: everything below a removed dish rides up by that dish's slot ----
  const shift = {};
  for (const c of FM.columns) {
    let dy = 0;
    for (const id of c.ids) {
      if (removed.includes(id)) { dy += byId[id].slot || c.pitch; continue; }
      shift[id] = dy;
    }
  }

  for (const f of FM.fields) {
    if (f.role !== 'name') continue;
    const gone = removed.includes(f.id);
    // PDF y grows upward, so riding up into a removed dish's slot means ADDING its height
    const dy = gone ? 0 : (shift[f.id] || 0);
    const k = kidsOf[f.id] || {};
    const dx = gone ? 0 : clusterShift(f);

    // -------- text --------
    for (const fld of [f, k.desc, k.price, k.gram].filter(Boolean)) {
      if (gone) {                                   // hide: drop every show-op it owns
        if (fld.role === 'gram') { if (fld.do_span) push(f.stream, fld.do_span[0], fld.do_span[1], ''); continue; }
        for (const o of fld.ops || []) push(fld.stream, o.span[0], o.span[1], '');
        for (const L of fld.lines || []) for (const o of L.ops) push(fld.stream, o.span[0], o.span[1], '');
        continue;
      }
      writeField(fld, f, dx, dy, push, append);
    }

    // -------- markers --------
    const want = gone ? [] : (markerEdits[f.id] || f.markers || []);
    const baked = f.marker_boxes || [];
    const bakedTypes = baked.map((m) => m.type);
    const moved = dx !== 0 || dy !== 0;
    const changed = moved || want.length !== bakedTypes.length || want.some((t) => !bakedTypes.includes(t));
    if (!changed) continue;                          // untouched dish: leave its bytes alone

    for (const m of baked) {
      if (m.span) push(f.stream, m.span[0], m.span[1], '');   // a vector marker: delete it
      else append(f.stream, patchBox(m));                     // baked into the raster: paint it out
    }
    for (const s of markerSlots(f, want, dx, dy)) append(f.stream, stampMarker(s.type, s.x, s.y));
  }

  // ---- added dishes ----
  for (const a of added) {
    const c = FM.columns.find((x) => x.id === a.col);
    if (!c) continue;
    append('p' + c.page, addedDishOps(a, c));
  }

  // ---- write every stream back ----
  for (const sid of Object.keys(PRISTINE)) {
    let text = PRISTINE[sid];
    if (ops[sid] && ops[sid].length) text = applyOps(text, ops[sid]);
    if (tail[sid]) text = text + '\n' + tail[sid];
    setStream(sid, text);
  }
  if (typeof QRK !== 'undefined') QRK.apply(pdfDoc);   // QR codes: resize/move/remove/add (src/shared/qrtool)
  const bytes = await pdfDoc.save({ useObjectStreams: false });
  try { MenuState.touch(); } catch (_) { /* chucky-2: the live chip re-checks for unpublished changes */ }
  return bytes;
}

/** Write one field's current text back into its baked spans (and move it if reflow says so). */
function writeField(fld, name, dx, dy, push, append) {
  const fam = famOf(fld);
  const val = edits[fld.id] !== undefined ? edits[fld.id] : null;

  // reflow / cluster movement: rewrite the Tm origin of every block the field occupies
  if (dy !== 0 || (dx !== 0 && (fld.role === 'gram'))) {
    if (fld.role === 'gram') {
      // a label XObject is placed by its own BBox, so it can only be moved at the call site
      if (fld.do_span) {
        const inner = PRISTINE[name.stream].slice(fld.do_span[0], fld.do_span[1]);
        push(name.stream, fld.do_span[0], fld.do_span[1],
          `q 1 0 0 1 ${r2(dx * ART)} ${r2(dy * ART)} cm ${inner} Q`);
      }
    } else {
      for (const b of fld.blocks || []) {
        const tm = b.tm.slice();
        push(fld.stream, b.tm_span[0], b.tm_span[1], `${tm[0]} ${tm[1]} ${tm[2]} ${tm[3]} ${r2(tm[4])} ${r2(tm[5] + dy)}`);
      }
    }
  }

  if (val === null) return;                          // not edited: leave the baked glyphs alone

  if (fld.role === 'desc') {
    const c = colOf(name) || { width: 240 };
    const lines = wrapText(val, fam, fld.size, c.width, fld.lines.length + extraLines(name, fld), fld.kern);
    fld.lines.forEach((L, i) => {
      const text = lines[i] || '';
      const runs = text ? encodeRuns(text, fld) : [];                 // chucky-2: encodeRuns/showRuns
      L.ops.forEach((o, j) => push(fld.stream, o.span[0], o.span[1], j === 0 ? showRuns(fld, o, runs) : ''));
    });
    // any line the baked text did not have gets appended as its own text block
    for (let i = fld.lines.length; i < lines.length; i++) {
      const runs = encodeRuns(lines[i], fld);
      if (!runs) continue;
      const y = fld.lines[fld.lines.length - 1].y + dy - fld.pitch * (i - fld.lines.length + 1);
      append(fld.stream, textBlock(fld.font, fld.size, fld.x + 0, y, showRuns(fld, null, runs)));
    }
    return;
  }

  const runs = encodeRuns(val, fld);                 // chucky-2: encodeRuns/showRuns
  if (!runs) return;                                 // unprintable character: keep what was there
  (fld.ops || []).forEach((o, i) => push(fld.stream, o.span[0], o.span[1], i === 0 ? showRuns(fld, o, runs) : ''));
}

/** How many extra description lines will fit before running into the dish below. */
function extraLines(name, desc) {
  const c = colOf(name);
  if (!c) return 0;
  const i = c.ids.indexOf(name.id);
  const next = i >= 0 && i + 1 < c.ids.length ? byId[c.ids[i + 1]] : null;
  const bottom = desc.lines[desc.lines.length - 1].y;
  const floor = next ? next.y + 12 : 30;
  return Math.max(0, Math.floor((bottom - floor) / desc.pitch));
}

/** An absolute text block in the artwork's coordinate space. */
function textBlock(fontRes, size, x, y, show) {
  return `q\n10 0 0 10 0 0 cm BT\n${fontRes} ${size} Tf\n1 0 0 1 ${r2(x)} ${r2(y)} Tm\n${show}\nET\nQ\n`;
}

/** Ops for a dish the user added at the bottom of a column. */
function addedDishOps(a, c) {
  const last = byId[c.ids[c.ids.length - 1]];
  const liveIds = c.ids.filter((id) => !removed.includes(id));
  const bottomId = liveIds.length ? liveIds[liveIds.length - 1] : null;
  const bottom = bottomId ? byId[bottomId] : last;
  const bDesc = (kidsOf[bottom.id] || {}).desc;
  const dy = -(bottom.slot || c.pitch) * (a.index || 1);
  const y = r2(bottom.y + dy);
  const fam = { name: FM.res_to_family[c.page + last.font], desc: bDesc ? famOf(bDesc) : FM.families.desc };
  let out = '';

  // chucky-2: the name and description may use fallback glyphs, as an edited dish's can
  const nFld = { font: last.font, page: c.page, stream: 'p' + c.page, size: last.size, kern: last.kern };
  const nRuns = encodeRuns(a.name || '', nFld);
  if (nRuns) out += textBlock(last.font, last.size, c.x, y, showRuns(nFld, null, nRuns));

  const price = (kidsOf[bottom.id] || {}).price;
  if (a.price && price) {
    const pc = toCids(String(a.price), famOf(price));
    if (pc) out += textBlock(price.font, price.size, price.x, y + (price.y - bottom.y), showOp(pc, price.kern));
  }
  if (a.desc && bDesc) {
    const lines = wrapText(a.desc, famOf(bDesc), bDesc.size, c.width, 4, bDesc.kern);
    lines.forEach((t, i) => {
      const rs = encodeRuns(t, bDesc);
      if (rs) out += textBlock(bDesc.font, bDesc.size, c.x, y - (bottom.y - bDesc.y) - i * bDesc.pitch, showRuns(bDesc, null, rs));
    });
  }
  const gram = (kidsOf[bottom.id] || {}).gram;
  if (a.gram && gram) {
    const gc = toCids(String(a.gram), famOf(gram));
    const gx = c.x + textWidth(a.name || '', fam.name, last.size, last.kern) + FM.marker_gap;
    if (gc) out += textBlock(gram.font, gram.size, gx, y + (gram.y - bottom.y), showOp(gc, gram.kern));
  }
  let mx = c.x + textWidth(a.name || '', fam.name, last.size, last.kern) + FM.marker_gap
    + (a.gram ? textWidth(String(a.gram), fam.name, 8, 0) + FM.marker_gap : 0);
  for (const t of FM.marker_order) {
    if (!(a.markers || []).includes(t)) continue;
    out += stampMarker(t, mx, y + (FM.marker_dy[t] || -1));
    mx += FM.icons[t].w / ART + FM.marker_gap;
  }
  return out;
}

// ============================================================ stream plumbing
function setStream(sid, text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  const dict = STREAM_DICT[sid];
  dict.delete(PDFName.of('Filter'));
  dict.delete(PDFName.of('DecodeParms'));
  dict.set(PDFName.of('Length'), PDFNumber.of(bytes.length));
  pdfDoc.context.assign(STREAM_REF[sid], PDFRawStream.of(dict, bytes));
}

function loadStreams() {
  for (const [sid, info] of Object.entries(FM.streams)) {
    const [num, gen] = info.ref.split(' ').map(Number);
    const ref = PDFRef.of(num, gen);
    const obj = pdfDoc.context.lookup(ref);
    STREAM_REF[sid] = ref;
    STREAM_DICT[sid] = obj.dict;
    let s = '';
    const b = obj.contents;
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    PRISTINE[sid] = s;
  }
}

// Exported only when this file is required directly by a test; in the browser `module` is
// absent and the engine simply lives on the page.

// ===================== BESHAK — editor shell =====================
// Everything the person using the editor touches: the cards, the marker chips, add/remove,
// search + section rail, spell-check, live preview, Export and Publish. The byte engine above
// is untouched by any of it — this layer only ever changes `edits` / `removed` / `added` /
// `markerEdits` and then asks for a regenerate.

const MEM_BRAND = 'beshak';
let ready = false;
let activePage = 0;   // named to match the shared bug-reporter, which reads it
let previewTimer = null;
let pdfjsDoc = null;

const ALLERGEN_ICONS = {
  dairy: '<svg viewBox="0 0 12 22" aria-hidden="true"><path d="M3 6.5V3.2h6v3.3l1.6 2.4V20H1.4V8.9L3 6.5Z" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3.4" y="1" width="5.2" height="1.8" rx=".9" fill="currentColor"/></svg>',
  gluten: '<svg viewBox="0 0 12 22" aria-hidden="true"><path d="M6 21V8" stroke="currentColor" stroke-width="1.5"/><ellipse cx="6" cy="2.6" rx="1.6" ry="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 6.5 2 8.5v2l4-2 4 2v-2ZM6 10.5l-4 2v2l4-2 4 2v-2ZM6 14.5l-4 2v2l4-2 4 2v-2Z" fill="currentColor"/></svg>',
  sesame: '<svg viewBox="0 0 22 22" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="5" cy="7" rx="2" ry="1.4" transform="rotate(-25 5 7)"/><ellipse cx="11" cy="4" rx="2" ry="1.4" transform="rotate(20 11 4)"/><ellipse cx="17" cy="8" rx="2" ry="1.4" transform="rotate(-15 17 8)"/><ellipse cx="7" cy="13" rx="2" ry="1.4" transform="rotate(15 7 13)"/><ellipse cx="13" cy="11" rx="2" ry="1.4" transform="rotate(-30 13 11)"/><ellipse cx="16" cy="16" rx="2" ry="1.4" transform="rotate(25 16 16)"/><ellipse cx="9" cy="18" rx="2" ry="1.4" transform="rotate(-20 9 18)"/></g></svg>',
  jain: '<svg viewBox="0 0 12 22" aria-hidden="true"><path d="M8.6 2v12.2a4.4 4.4 0 0 1-8.1 2.4" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
};
const MARKER_LABEL = { dairy: 'Dairy', gluten: 'Gluten', sesame: 'Sesame', jain: 'Jain possible' };

// ============================================================ edit-state plumbing
const curText = (f) => (edits[f.id] !== undefined ? edits[f.id] : f.display);
const memBaseVer = () => 'v' + (pdfBytesOrig ? pdfBytesOrig.length : 0);

function memSnapshot() {
  return { qr: QRK.snap(), edits: JSON.parse(JSON.stringify(edits)), removed: removed.slice(), added: JSON.parse(JSON.stringify(added)), markerEdits: JSON.parse(JSON.stringify(markerEdits)) };
}
function memApply(s) {
  QRK.load(s && s.qr);
  for (const k of Object.keys(edits)) delete edits[k];
  Object.assign(edits, s.edits || {});
  removed = s.removed || [];
  added = s.added || [];
  markerEdits = s.markerEdits || {};
}
function memRebuild() { buildEditor(); schedulePreview(); }

// ============================================================ validation
/** Characters the menu's own fonts cannot set, plus a light spell check on edited text. */
let DICT = null;
const deacc = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
function wordAllowed(w) {
  if (!DICT) return true;
  const t = deacc(w).toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (t.length < 3) return true;
  if (DICT.has(t)) return true;
  if (t.endsWith('s') && DICT.has(t.slice(0, -1))) return true;
  return t.split(/[-/]/).every((p) => p.length < 3 || DICT.has(p));
}
function typosIn(text) {
  return (String(text).match(/[A-Za-zÀ-ɏ'’-]+/g) || []).filter((w) => !wordAllowed(w));
}

function fieldIssues(f) {
  const val = curText(f);
  const role = f.role === 'gram' ? 'gram' : f.role;
  // chucky-2: only text someone edited is re-set; untouched text prints as the artwork has it,
  // so it can't be "unprintable" (and flagging it blocked Export on a menu nobody had touched)
  const bad = edits[f.id] !== undefined ? missingChars(val, famOf(f), f.role === 'gram') : [];
  const out = [];
  if (bad.length) out.push({ kind: 'char', msg: 'This menu’s font has no ' + bad.map((c) => (c === ' ' ? 'space' : '“' + c + '”')).join(', ') });
  if (role === 'price' && !/^\d+$/.test(val.trim())) out.push({ kind: 'char', msg: 'Prices are digits only' });
  if (edits[f.id] !== undefined && (role === 'name' || role === 'desc')) {
    const t = typosIn(val);
    if (t.length) out.push({ kind: 'spell', msg: 'Check spelling: ' + t.slice(0, 3).join(', ') });
  }
  return out;
}

/**
 * Issues on an added dish. These are checked separately because an added item is not an
 * FM.field — and without this an unavailable glyph would just make the new dish print nothing,
 * which is the silent-drop failure the other editors already gate against.
 */
function addedIssues(a) {
  const out = [];
  const check = (label, text, fam, noFallback) => {
    const bad = missingChars(text || '', fam, noFallback);
    if (bad.length) out.push({ kind: 'char', msg: label + ': this menu’s font has no ' + bad.map((c) => (c === ' ' ? 'space' : '“' + c + '”')).join(', ') });
  };
  check('Name', a.name, FM.res_to_family[nameFamKeyFor(a)]);
  check('Size', a.gram, FM.res_to_family[nameFamKeyFor(a)], true);   // chucky-2: a size is set without fallback glyphs
  check('Price', a.price, FM.res_to_family[nameFamKeyFor(a)]);
  const dcol = FM.columns.find((c) => c.id === a.col);
  const dref = dcol && FM.fields.find((f) => f.role === 'desc' && f.of === dcol.ids[0]);
  if (dref) check('Description', a.desc, famOf(dref));
  if (a.price && !/^\d*$/.test(String(a.price).trim())) out.push({ kind: 'char', msg: 'Price: digits only' });
  if (!String(a.name || '').trim()) out.push({ kind: 'char', msg: 'Name: an added dish needs a name' });
  return out;
}
/** The display face used by a column, keyed the way res_to_family expects. */
function nameFamKeyFor(a) {
  const c = FM.columns.find((x) => x.id === a.col);
  const ref = c && byId[c.ids[c.ids.length - 1]];
  return ref ? ref.page + ref.font : 0 + '/R45';
}

function allIssues() {
  const out = [];
  for (const f of FM.fields) {
    if (f.role === 'name' && removed.includes(f.id)) continue;
    if (f.of && removed.includes(f.of)) continue;
    for (const i of fieldIssues(f)) out.push({ field: f, ...i });
  }
  for (const a of added) for (const i of addedIssues(a)) out.push({ added: a, ...i });
  return out;
}

function syncFlagPill() {
  const el = document.getElementById('flagpill');
  if (!el) return;
  const issues = allIssues();
  const blocking = issues.filter((i) => i.kind === 'char');
  if (blocking.length) { el.className = 'pill bad'; el.textContent = blocking.length + ' to fix'; }
  else if (issues.length) { el.className = 'pill warn'; el.textContent = '· ' + issues.length + ' to review'; }
  else { el.className = 'pill ok'; el.textContent = 'All clear'; }
  return blocking.length;
}

// ============================================================ the editor cards
function sectionsForPage(page) {
  const seen = [];
  for (const c of FM.columns) if (c.page === page && !seen.includes(c.section)) seen.push(c.section);
  return seen;
}

function dishesIn(page, section) {
  const ids = [];
  for (const c of FM.columns) if (c.page === page && c.section === section) ids.push(...c.ids);
  return ids.map((id) => byId[id]).sort((a, b) => (a.x - b.x) || (b.y - a.y));
}

function buildEditor() {
  const host = document.getElementById('editor');
  if (!host) return;
  host.innerHTML = '';
  for (const section of sectionsForPage(activePage)) {
    const dishes = dishesIn(activePage, section);
    const live = dishes.filter((d) => !removed.includes(d.id));
    const addedHere = added.filter((a) => (FM.columns.find((c) => c.id === a.col) || {}).section === section
      && (FM.columns.find((c) => c.id === a.col) || {}).page === activePage);
    const wrap = document.createElement('div');
    wrap.className = 'secgrp';
    wrap.innerHTML = `<h2 class="sechd" id="sec-${esc(section)}">${esc(section)}<span class="cnt">${live.length + addedHere.length}</span></h2>`;
    for (const d of dishes) wrap.appendChild(dishCard(d));
    for (const a of addedHere) wrap.appendChild(addedCard(a));
    const addBtn = document.createElement('button');
    addBtn.className = 'additem';
    addBtn.textContent = '+ Add item to ' + section;
    addBtn.onclick = () => openAdd(section);
    wrap.appendChild(addBtn);
    host.appendChild(wrap);
  }
  syncRail();
  syncFlagPill();
}

function fieldRow(f, label, opts) {
  const o = opts || {};
  const row = document.createElement('label');
  row.className = 'frow' + (o.wide ? ' wide' : '');
  const c = colOf(byId[f.of] || f) || { width: 240 };
  const width = f.role === 'name' ? Math.max(60, ((kidsOf[f.of] || {}).price ? 0 : 0) + c.width * 0.6) : c.width;
  const max = maxCharsFor(f.role === 'price' ? 40 : width, f.size, f.role === 'gram' ? 'gram' : f.role);
  const val = curText(f);
  row.innerHTML = `<span class="flbl">${esc(label)}</span>`;
  const input = document.createElement(o.area ? 'textarea' : 'input');
  input.value = val;
  input.maxLength = f.role === 'desc' ? max * (f.lines.length + 2) : max;
  input.dataset.fid = f.id;
  if (f.role === 'price') input.inputMode = 'numeric';
  input.oninput = () => {
    if (input.value === f.display) delete edits[f.id]; else edits[f.id] = input.value;
    markIssues(row, f);
    onChange();
  };
  row.appendChild(input);
  const note = document.createElement('span');
  note.className = 'fnote';
  row.appendChild(note);
  markIssues(row, f);
  return row;
}

function markIssues(row, f) {
  const note = row.querySelector('.fnote');
  const issues = fieldIssues(f);
  row.classList.toggle('bad', issues.some((i) => i.kind === 'char'));
  row.classList.toggle('warn', issues.length > 0 && !issues.some((i) => i.kind === 'char'));
  if (note) note.textContent = issues.length ? issues[0].msg : '';
}

function dishCard(d) {
  const card = document.createElement('article');
  card.className = 'card' + (removed.includes(d.id) ? ' gone' : '');
  card.dataset.id = d.id;
  card.dataset.name = (curText(d) + ' ' + ((kidsOf[d.id] || {}).desc ? curText(kidsOf[d.id].desc) : '')).toLowerCase();
  const k = kidsOf[d.id] || {};
  const head = document.createElement('div');
  head.className = 'chead';
  head.innerHTML = `<span class="cnum">${esc(d.section)}</span>`;
  const del = document.createElement('button');
  del.className = 'cdel';
  del.title = removed.includes(d.id) ? 'Put this item back' : 'Remove this item';
  del.textContent = removed.includes(d.id) ? '↺' : '✕';
  del.onclick = () => {
    if (removed.includes(d.id)) removed = removed.filter((x) => x !== d.id); else removed.push(d.id);
    buildEditor();
    onChange();
  };
  head.appendChild(del);
  card.appendChild(head);

  card.appendChild(fieldRow(d, 'Name'));
  if (k.gram) card.appendChild(fieldRow(k.gram, 'Size'));
  if (k.price) card.appendChild(fieldRow(k.price, 'Price'));
  if (k.desc) card.appendChild(fieldRow(k.desc, 'Description', { area: true, wide: true }));
  card.appendChild(markerChips(d));
  return card;
}

function markerChips(d) {
  const wrap = document.createElement('div');
  wrap.className = 'afchk';
  const cur = markerEdits[d.id] || d.markers || [];
  for (const t of FM.marker_order) {
    const on = cur.includes(t);
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox"${on ? ' checked' : ''}><span class="mkico">${ALLERGEN_ICONS[t]}</span>${esc(MARKER_LABEL[t])}`;
    lab.querySelector('input').onchange = (e) => {
      const now = (markerEdits[d.id] || d.markers || []).slice();
      const i = now.indexOf(t);
      if (e.target.checked) { if (i < 0) now.push(t); } else if (i >= 0) now.splice(i, 1);
      markerEdits[d.id] = FM.marker_order.filter((x) => now.includes(x));
      onChange();
    };
    wrap.appendChild(lab);
  }
  return wrap;
}

function addedCard(a) {
  const card = document.createElement('article');
  card.className = 'card added';
  card.dataset.id = 'add:' + added.indexOf(a);
  card.dataset.name = (a.name || '').toLowerCase();
  card.innerHTML = `<div class="chead"><span class="cnum">New item</span></div>`;
  const del = document.createElement('button');
  del.className = 'cdel';
  del.textContent = '✕';
  del.onclick = () => { added = added.filter((x) => x !== a); buildEditor(); onChange(); };
  card.querySelector('.chead').appendChild(del);
  const mk = (label, key, area) => {
    const row = document.createElement('label');
    row.className = 'frow' + (area ? ' wide' : '');
    row.innerHTML = `<span class="flbl">${esc(label)}</span>`;
    const inp = document.createElement(area ? 'textarea' : 'input');
    inp.value = a[key] || '';
    inp.oninput = () => { a[key] = inp.value; if (card._sync) card._sync(); onChange(); };
    row.appendChild(inp);
    return row;
  };
  card.appendChild(mk('Name', 'name'));
  card.appendChild(mk('Size', 'gram'));
  card.appendChild(mk('Price', 'price'));
  card.appendChild(mk('Description', 'desc', true));
  const note = document.createElement('div');
  note.className = 'addnote';
  card.appendChild(note);
  card._sync = () => {
    const iss = addedIssues(a);
    note.textContent = iss.length ? iss[0].msg : '';
    card.classList.toggle('bad', iss.length > 0);
  };
  card._sync();
  const chips = document.createElement('div');
  chips.className = 'afchk';
  for (const t of FM.marker_order) {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox"${(a.markers || []).includes(t) ? ' checked' : ''}><span class="mkico">${ALLERGEN_ICONS[t]}</span>${esc(MARKER_LABEL[t])}`;
    lab.querySelector('input').onchange = (e) => {
      a.markers = a.markers || [];
      if (e.target.checked) a.markers.push(t); else a.markers = a.markers.filter((x) => x !== t);
      a.markers = FM.marker_order.filter((x) => a.markers.includes(x));
      onChange();
    };
    chips.appendChild(lab);
  }
  card.appendChild(chips);
  return card;
}

function openAdd(section) {
  const cols = FM.columns.filter((c) => c.page === activePage && c.section === section);
  if (!cols.length) return;
  // put it in the column with the most room left below its last dish
  const col = cols.slice().sort((a, b) => b.bottom - a.bottom)[0];
  const n = added.filter((a) => a.col === col.id).length + 1;
  added.push({ col: col.id, index: n, name: 'New item', desc: '', price: '', gram: '', markers: [] });
  buildEditor();
  onChange();
}

// ============================================================ rail + search
function syncRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;
  rail.querySelectorAll('.sec').forEach((n) => n.remove());
  for (const s of sectionsForPage(activePage)) {
    const live = dishesIn(activePage, s).filter((d) => !removed.includes(d.id)).length
      + added.filter((a) => (FM.columns.find((c) => c.id === a.col) || {}).section === s).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sec';   // chucky-2: the shell's section button (was .railsec, styled by the old page)
    b.innerHTML = `<span>${esc(s)}</span><span class="ct">${live}</span>`;
    b.onclick = () => { const el = document.getElementById('sec-' + s); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    rail.appendChild(b);
  }
  rail.querySelectorAll('.tabs button').forEach((b) => { b.classList.toggle('on', +b.dataset.pg === activePage); b.setAttribute('aria-selected', +b.dataset.pg === activePage); });
}

function filterItems(q) {
  const t = String(q || '').trim().toLowerCase();
  document.querySelectorAll('#editor .card').forEach((c) => {
    c.style.display = (!t || (c.dataset.name || '').includes(t)) ? '' : 'none';
  });
  document.querySelectorAll('#editor .secgrp').forEach((g) => {
    const any = [...g.querySelectorAll('.card')].some((c) => c.style.display !== 'none');
    g.style.display = (!t || any) ? '' : 'none';
  });
}

function togglePrev(on) {
  const p = document.getElementById('previewPane');
  if (!p) return;
  const want = on === undefined ? !p.classList.contains('open') : on;
  p.classList.toggle('open', want);
  document.getElementById('scrim').classList.toggle('on', want && window.innerWidth <= 640);
}
function closeDrawers() { togglePrev(false); document.getElementById('scrim').classList.remove('on'); }

// ============================================================ change plumbing
function onChange() {
  syncFlagPill();
  schedulePreview();
  if (ready) { try { MEM.tick(); } catch (_) { /* memory is best-effort */ } }
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { renderPreview().catch(() => {}); }, 260);
}

/* QRTOOL:BEGIN — generated from src/shared/qrtool/qrtool.src.js by `npm run qr:inject`. Edit there, not here. */
/* ============ QR CODES — click one on the preview to resize / move / change link / remove; "+ QR" adds one ============
   Same tool, same interface in every editor. It never touches the page streams the byte engine owns:
   - A QR already in the artwork was baked (src/shared/qr_bake.mjs) into a Form XObject tagged /ChuckyQR.
     Resizing / moving it rewrites that Form's /Matrix; removing it zeroes its /BBox. Untouched => the
     Form's own pristine objects go back, so an unedited menu still exports byte-identical.
   - An ADDED QR is drawn in a separate overlay stream: the page's /Contents becomes
     [ "q", <the engine's own stream(s)>, "Q", overlay ] — the q/Q isolates whatever state the artwork
     leaves behind, and the engine keeps assigning its stream by ref exactly as before.
   Editor glue (4 lines each): QRK.apply(doc) just before doc.save(); QRK.hits(hitlayer, page, W, H) at the
   end of pvSync(); qr:QRK.snap() / QRK.load(st.qr) in memSnapshot/memApply; QRK.init({refresh}) at boot. */
const QRK = (() => {
  // ---- encoder: src/shared/qr/gf.mjs + encode.mjs, inlined verbatim by the build ----
  // --- src/shared/qr/gf.mjs
  // GF(256) arithmetic and Reed-Solomon codes exactly as QR codes use them.
  // Field: GF(2^8) with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1).
  // Generator element: alpha = 2. RS generator roots: alpha^0 .. alpha^(ecCount-1).
  // Dependency-free ES module (Node 18+).

  // ---------------------------------------------------------------------------
  // Lookup tables
  // ---------------------------------------------------------------------------

  // EXP has 512 entries so gfMul can index EXP[LOG[a] + LOG[b]] without a modulo.
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);

  {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  }

  // ---------------------------------------------------------------------------
  // Scalar field ops
  // ---------------------------------------------------------------------------

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function gfDiv(a, b) {
    if (b === 0) throw new Error('division by zero in GF(256)');
    if (a === 0) return 0;
    return EXP[(LOG[a] - LOG[b] + 255) % 255];
  }

  // ---------------------------------------------------------------------------
  // Encoding
  // ---------------------------------------------------------------------------

  // Generator polynomial prod_{i=0}^{ecCount-1} (x - alpha^i).
  // Returned as a Uint8Array of coefficients, HIGHEST degree first
  // (leading coefficient is always 1).
  function rsGeneratorPoly(ecCount) {
    let g = new Uint8Array([1]);
    for (let i = 0; i < ecCount; i++) {
      const next = new Uint8Array(g.length + 1);
      const a = EXP[i]; // alpha^i
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j]; // x * g(x)
        next[j + 1] ^= gfMul(g[j], a); // alpha^i * g(x)
      }
      g = next;
    }
    return g;
  }

  // EC codewords: the remainder of data(x) * x^ecCount divided by the generator.
  function rsEncode(data, ecCount) {
    const gen = rsGeneratorPoly(ecCount);
    const buf = new Uint8Array(data.length + ecCount);
    buf.set(data);
    for (let i = 0; i < data.length; i++) {
      const coef = buf[i];
      if (coef === 0) continue;
      for (let j = 1; j < gen.length; j++) {
        buf[i + j] ^= gfMul(gen[j], coef);
      }
      buf[i] = 0; // gen[0] === 1, quotient term eliminated
    }
    return buf.slice(data.length);
  }

  // ---------------------------------------------------------------------------
  // Decoding helpers (decoder-internal polynomials are plain Arrays,
  // LOWEST degree first)
  // ---------------------------------------------------------------------------

  // Evaluate a highest-degree-first byte polynomial (a codeword) at x (Horner).
  function polyEvalHigh(msg, x) {
    let y = msg[0];
    for (let i = 1; i < msg.length; i++) y = gfMul(y, x) ^ msg[i];
    return y;
  }

  // Evaluate a lowest-degree-first polynomial at x.
  function polyEvalLow(p, x) {
    let y = 0;
    let xp = 1;
    for (let i = 0; i < p.length; i++) {
      y ^= gfMul(p[i], xp);
      xp = gfMul(xp, x);
    }
    return y;
  }

  function polyMulLow(a, b) {
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === 0) continue;
      for (let j = 0; j < b.length; j++) out[i + j] ^= gfMul(a[i], b[j]);
    }
    return out;
  }

  function trim(p) {
    while (p.length > 1 && p[p.length - 1] === 0) p.pop();
    return p;
  }

  // out = a(x) + c * x^shift * b(x)   (lowest-first)
  function xorScaledShift(a, b, c, shift) {
    const out = a.slice();
    while (out.length < b.length + shift) out.push(0);
    for (let i = 0; i < b.length; i++) out[i + shift] ^= gfMul(c, b[i]);
    return trim(out);
  }

  function calcSyndromes(cw, ecCount) {
    const synd = new Array(ecCount);
    let allZero = true;
    for (let j = 0; j < ecCount; j++) {
      const s = polyEvalHigh(cw, EXP[j]);
      synd[j] = s;
      if (s !== 0) allZero = false;
    }
    return { synd, allZero };
  }

  // Errors-and-erasures Berlekamp-Massey. gamma is the erasure locator
  // (lowest-first, degree = numErasures); Lambda and B start from it, and the
  // iteration begins after the first numErasures syndromes.
  function berlekampMassey(synd, ecCount, gamma, numErasures) {
    let Lambda = gamma.slice();
    let B = gamma.slice();
    let L = numErasures;
    let m = 1;
    let b = 1;
    for (let r = numErasures; r < ecCount; r++) {
      let delta = 0;
      for (let i = 0; i < Lambda.length && i <= r; i++) {
        delta ^= gfMul(Lambda[i], synd[r - i]);
      }
      if (delta === 0) {
        m++;
        continue;
      }
      if (2 * L <= r + numErasures) {
        const T = Lambda.slice();
        Lambda = xorScaledShift(Lambda, B, gfDiv(delta, b), m);
        L = r + 1 - L + numErasures;
        B = T;
        b = delta;
        m = 1;
      } else {
        Lambda = xorScaledShift(Lambda, B, gfDiv(delta, b), m);
        m++;
      }
    }
    return trim(Lambda);
  }

  // Chien search: return the position values p (powers of x, i.e. p = n-1-index)
  // where Lambda(alpha^{-p}) === 0, or null if the root count does not match
  // the locator degree.
  function findErrataPositions(Lambda, n) {
    const degree = Lambda.length - 1;
    const positions = [];
    for (let p = 0; p < n; p++) {
      const xinv = EXP[(255 - (p % 255)) % 255]; // alpha^{-p}
      if (polyEvalLow(Lambda, xinv) === 0) positions.push(p);
    }
    return positions.length === degree ? positions : null;
  }

  // Omega(x) = S(x) * Lambda(x) mod x^ecCount   (lowest-first)
  function computeOmega(synd, Lambda, ecCount) {
    const out = new Array(ecCount).fill(0);
    for (let i = 0; i < Lambda.length; i++) {
      if (Lambda[i] === 0) continue;
      for (let j = 0; j < synd.length && i + j < ecCount; j++) {
        out[i + j] ^= gfMul(Lambda[i], synd[j]);
      }
    }
    return trim(out);
  }

  // ---------------------------------------------------------------------------
  // Decoding
  // ---------------------------------------------------------------------------

  // codewords: Uint8Array of data followed by ec (length n = k + ecCount).
  // erasures: array of known-bad positions, as indices into `codewords`.
  // Returns { data: Uint8Array (corrected data part), corrected: number }.
  // Throws Error('unrecoverable') when correction fails; success is verified
  // by recomputing all syndromes on the corrected codeword.
  function rsDecode(codewords, ecCount, erasures = []) {
    const n = codewords.length;
    const dataLen = n - ecCount;
    if (!Number.isInteger(ecCount) || ecCount <= 0 || dataLen < 0 || n > 255) {
      throw new Error('unrecoverable');
    }
    const cw = Uint8Array.from(codewords);

    const erasSet = [...new Set(erasures)];
    for (const e of erasSet) {
      if (!Number.isInteger(e) || e < 0 || e >= n) throw new Error('unrecoverable');
    }
    if (erasSet.length > ecCount) throw new Error('unrecoverable');

    const first = calcSyndromes(cw, ecCount);
    if (first.allZero) {
      return { data: cw.slice(0, dataLen), corrected: 0 };
    }
    const synd = first.synd;

    // Erasure locator Gamma(x) = prod (1 + X_j x), X_j = alpha^{n-1-index}.
    let gamma = [1];
    for (const e of erasSet) {
      gamma = polyMulLow(gamma, [1, EXP[(n - 1 - e) % 255]]);
    }

    const Lambda = berlekampMassey(synd, ecCount, gamma, erasSet.length);
    const degree = Lambda.length - 1;
    // Capacity: 2*errors + erasures <= ecCount, errors = degree - erasures.
    if (2 * degree - erasSet.length > ecCount) throw new Error('unrecoverable');

    const positions = findErrataPositions(Lambda, n);
    if (!positions) throw new Error('unrecoverable');

    const omega = computeOmega(synd, Lambda, ecCount);

    // Forney: e = X * Omega(X^{-1}) / Lambda'(X^{-1})   (roots at alpha^0..,
    // i.e. b = 0, so the extra factor is X itself).
    let corrected = 0;
    for (const p of positions) {
      const X = EXP[p % 255];
      const Xinv = EXP[(255 - (p % 255)) % 255];
      const Xinv2 = gfMul(Xinv, Xinv);
      // Formal derivative: only odd-degree terms of Lambda survive.
      let lp = 0;
      let xpow = 1; // Xinv^(i-1) for i = 1, 3, 5, ...
      for (let i = 1; i < Lambda.length; i += 2) {
        lp ^= gfMul(Lambda[i], xpow);
        xpow = gfMul(xpow, Xinv2);
      }
      if (lp === 0) throw new Error('unrecoverable');
      const magnitude = gfMul(X, gfDiv(polyEvalLow(omega, Xinv), lp));
      if (magnitude !== 0) {
        cw[n - 1 - p] ^= magnitude;
        corrected++;
      }
    }

    const recheck = calcSyndromes(cw, ecCount);
    if (!recheck.allZero) throw new Error('unrecoverable');

    return { data: cw.slice(0, dataLen), corrected };
  }

  // --- src/shared/qr/encode.mjs
  // encode.mjs — QR code matrix generator per ISO/IEC 18004.
  // BYTE mode only, versions 1..10, EC levels L/M/Q/H. Dependency-free ES module.
  //
  //   qrEncode(payload, { ecLevel: 'M', version: null /* auto-min */, mask: null /* auto */ })
  //     -> { version, ecLevel, mask, size, matrix: Uint8Array(size*size) /* row-major 0/1 */,
  //          toString() /* '##'/'  ' ASCII art */ }
  //
  // Also exports the internals the test suite re-derives placement from:
  //   buildCodewords(bytes, version, ecLevel)  — final interleaved data+EC codeword sequence
  //   functionModules(version)                 — { size, base, isFunc } function-pattern plane
  //   placementOrder(version)                  — [row, col] pairs in zigzag placement order
  //   formatBits(ecLevel, mask), versionBits(version), MASKS, EC_PARAMS, TOTAL_CODEWORDS



  // ---------------------------------------------------------------------------
  // Capacity tables (ISO/IEC 18004 Table 9), versions 1..10.
  // EC_PARAMS[level][version] = [ecPerBlock, g1Blocks, g1DataCW, g2Blocks, g2DataCW]
  // ---------------------------------------------------------------------------

  const TOTAL_CODEWORDS = [, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

  const EC_PARAMS = {
    L: [, [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
         [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
         [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]],
    M: [, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
         [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
         [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]],
    Q: [, [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
         [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
         [20, 4, 16, 4, 17], [24, 6, 19, 2, 20]],
    H: [, [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
         [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
         [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]],
  };

  // Module-load self-check: every row must account for the version's total codewords.
  for (const lvl of Object.keys(EC_PARAMS)) {
    for (let v = 1; v <= 10; v++) {
      const [ec, g1, d1, g2, d2] = EC_PARAMS[lvl][v];
      if (ec * (g1 + g2) + g1 * d1 + g2 * d2 !== TOTAL_CODEWORDS[v]) {
        throw new Error(`EC_PARAMS inconsistent at ${v}-${lvl}`);
      }
    }
  }

  // Alignment pattern centre coordinates per version (Table E.1).
  const ALIGN = [, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
                 [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // EC level indicator bits for the format information.
  const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  // The 8 data mask predicates (r = row, c = column); true = flip the module.
  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  // ---------------------------------------------------------------------------
  // Format / version information (BCH-protected)
  // ---------------------------------------------------------------------------

  // 15-bit format info: 5 data bits (2 EC level + 3 mask) + BCH(15,5) remainder
  // (generator 0x537), the whole thing XORed with 0x5412.
  function formatBits(ecLevel, mask) {
    const data = (EC_BITS[ecLevel] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  // 18-bit version info (v >= 7): 6 data bits + 12-bit BCH remainder (generator 0x1F25).
  function versionBits(version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    return (version << 12) | rem;
  }

  // ---------------------------------------------------------------------------
  // Data encoding — BYTE mode bit stream, padding, block split, RS, interleave
  // ---------------------------------------------------------------------------

  function dataCapacityCodewords(version, ecLevel) {
    const [, g1, d1, g2, d2] = EC_PARAMS[ecLevel][version];
    return g1 * d1 + g2 * d2;
  }

  function charCountBits(version) {
    return version <= 9 ? 8 : 16; // BYTE mode: 8 bits v1-9, 16 bits v10+
  }

  // Final interleaved codeword sequence (data blocks column-wise, then EC blocks
  // column-wise) for a BYTE-mode payload.
  function buildCodewords(bytes, version, ecLevel) {
    const [ec, g1, d1, g2, d2] = EC_PARAMS[ecLevel][version];
    const dataCW = g1 * d1 + g2 * d2;
    const ccBits = charCountBits(version);

    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4);              // mode indicator: BYTE
    push(bytes.length, ccBits);   // character count
    for (const b of bytes) push(b, 8);
    if (bits.length > dataCW * 8) {
      throw new Error(`payload (${bytes.length} bytes) does not fit version ${version}-${ecLevel}`);
    }
    push(0, Math.min(4, dataCW * 8 - bits.length)); // terminator (possibly shortened)
    while (bits.length % 8 !== 0) bits.push(0);     // pad to codeword boundary

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    for (let alt = 0; data.length < dataCW; alt ^= 1) data.push(alt ? 0x11 : 0xec);

    // Split into blocks (group 1 then group 2), RS-encode each.
    const blocks = [];
    let off = 0;
    for (let i = 0; i < g1; i++) { blocks.push(data.slice(off, off + d1)); off += d1; }
    for (let i = 0; i < g2; i++) { blocks.push(data.slice(off, off + d2)); off += d2; }
    const ecBlocks = blocks.map(b => rsEncode(Uint8Array.from(b), ec));

    // Interleave: i-th data codeword of every block, then i-th EC codeword of every block.
    const out = [];
    const maxD = Math.max(d1, d2);
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
    return Uint8Array.from(out);
  }

  // ---------------------------------------------------------------------------
  // Function patterns
  // ---------------------------------------------------------------------------

  // Build the function-pattern plane for a version: finders + separators, timing,
  // alignment patterns, dark module, version info (v >= 7), and reservations for
  // the format info (drawn per-mask later). Returns { size, base, isFunc }.
  function functionModules(version) {
    const size = 17 + 4 * version;
    const base = new Uint8Array(size * size);
    const isFunc = new Uint8Array(size * size);
    const set = (r, c, v) => { base[r * size + c] = v ? 1 : 0; isFunc[r * size + c] = 1; };

    // Timing patterns (row 6 and column 6): dark at even coordinates.
    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    // Finder patterns with their light separators (drawn as a 9x9 clipped block).
    const finder = (fr, fc) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = fr + dr, c = fc + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const ring = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
                       (dr === 0 || dr === 6 || dc === 0 || dc === 6);
          const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          set(r, c, ring || core);
        }
      }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // Alignment patterns: 5x5 at every centre pair except the three finder corners.
    const centers = ALIGN[version];
    const last = centers.length ? centers[centers.length - 1] : -1;
    for (const cr of centers) {
      for (const cc of centers) {
        if ((cr === 6 && cc === 6) || (cr === 6 && cc === last) || (cr === last && cc === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            set(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }

    // Reserve the format info modules (both copies); actual bits depend on the mask.
    for (let i = 0; i <= 8; i++) {
      if (i === 6) continue; // timing modules keep their pattern
      set(8, i, 0);
      set(i, 8, 0);
    }
    for (let i = 0; i < 8; i++) {
      set(8, size - 1 - i, 0);
      set(size - 1 - i, 8, 0);
    }

    // Version information, v >= 7: 6x3 top-right and 3x6 bottom-left.
    if (version >= 7) {
      const vb = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (vb >>> i) & 1;
        const longC = size - 11 + (i % 3); // size-11 .. size-9
        const shortC = Math.floor(i / 3);  // 0 .. 5
        set(shortC, longC, bit); // top-right block
        set(longC, shortC, bit); // bottom-left block
      }
    }

    // Dark module — always dark, at (4*version + 9, 8) = (size-8, 8).
    set(size - 8, 8, 1);

    return { size, base, isFunc };
  }

  // Zigzag placement order over the non-function modules: column pairs from the
  // right edge leftwards (skipping timing column 6), alternating up/down.
  function orderFrom(size, isFunc) {
    const order = [];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert++) {
        const row = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          if (!isFunc[row * size + col]) order.push([row, col]);
        }
      }
    }
    return order;
  }

  function placementOrder(version) {
    const { size, isFunc } = functionModules(version);
    return orderFrom(size, isFunc);
  }

  // Draw the 15 format bits into both of their homes. Bit i means (bits >>> i) & 1.
  function drawFormat(m, size, bits) {
    const b = i => (bits >>> i) & 1;
    // Copy 1, around the top-left finder.
    for (let i = 0; i <= 5; i++) m[i * size + 8] = b(i);
    m[7 * size + 8] = b(6);
    m[8 * size + 8] = b(7);
    m[8 * size + 7] = b(8);
    for (let i = 9; i <= 14; i++) m[8 * size + (14 - i)] = b(i);
    // Copy 2, split under the top-right and beside the bottom-left finders.
    for (let i = 0; i <= 7; i++) m[8 * size + (size - 1 - i)] = b(i);
    for (let i = 8; i <= 14; i++) m[(size - 15 + i) * size + 8] = b(i);
  }

  // ---------------------------------------------------------------------------
  // Mask evaluation — the four penalty rules (N1=3, N2=3, N3=40, N4=10)
  // ---------------------------------------------------------------------------

  function penaltyScore(m, size) {
    let score = 0;

    // N1: runs of >= 5 same-coloured modules in a row/column: 3 + (len - 5).
    for (let axis = 0; axis < 2; axis++) {
      for (let a = 0; a < size; a++) {
        let runVal = -1, runLen = 0;
        for (let b = 0; b < size; b++) {
          const v = axis === 0 ? m[a * size + b] : m[b * size + a];
          if (v === runVal) runLen++;
          else {
            if (runLen >= 5) score += 3 + runLen - 5;
            runVal = v;
            runLen = 1;
          }
        }
        if (runLen >= 5) score += 3 + runLen - 5;
      }
    }

    // N2: every 2x2 block of a single colour: +3.
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r * size + c];
        if (v === m[r * size + c + 1] && v === m[(r + 1) * size + c] && v === m[(r + 1) * size + c + 1]) {
          score += 3;
        }
      }
    }

    // N3: finder-like pattern 1011101 with 0000 on either side, rows and columns: +40.
    for (let axis = 0; axis < 2; axis++) {
      for (let a = 0; a < size; a++) {
        let w = 0;
        for (let b = 0; b < size; b++) {
          w = ((w << 1) | (axis === 0 ? m[a * size + b] : m[b * size + a])) & 0x7ff;
          if (b >= 10 && (w === 0b10111010000 || w === 0b00001011101)) score += 40;
        }
      }
    }

    // N4: 10 points per 5% that the dark-module proportion deviates from 50%.
    let dark = 0;
    for (let i = 0; i < m.length; i++) dark += m[i];
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;

    return score;
  }

  // ---------------------------------------------------------------------------
  // Main entry
  // ---------------------------------------------------------------------------

  function qrEncode(payload, { ecLevel = 'M', version = null, mask = null } = {}) {
    if (!EC_PARAMS[ecLevel]) throw new Error(`unknown EC level ${JSON.stringify(ecLevel)}`);
    if (mask !== null && (!Number.isInteger(mask) || mask < 0 || mask > 7)) {
      throw new Error(`mask must be null or an integer 0..7, got ${mask}`);
    }
    const bytes = typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : Uint8Array.from(payload);

    const fits = v => 4 + charCountBits(v) + 8 * bytes.length <= 8 * dataCapacityCodewords(v, ecLevel);
    let v = version;
    if (v == null) {
      for (v = 1; v <= 10 && !fits(v); v++);
      if (v > 10) throw new Error(`payload (${bytes.length} bytes) exceeds version 10-${ecLevel} capacity`);
    } else {
      if (!Number.isInteger(v) || v < 1 || v > 10) throw new Error(`version must be 1..10, got ${v}`);
      if (!fits(v)) throw new Error(`payload (${bytes.length} bytes) does not fit version ${v}-${ecLevel}`);
    }

    const codewords = buildCodewords(bytes, v, ecLevel);
    const { size, base, isFunc } = functionModules(v);
    const order = orderFrom(size, isFunc);
    const totalBits = codewords.length * 8;

    const render = mk => {
      const m = base.slice();
      const maskFn = MASKS[mk];
      for (let i = 0; i < order.length; i++) {
        const [r, c] = order[i];
        const bit = i < totalBits ? (codewords[i >> 3] >>> (7 - (i & 7))) & 1 : 0; // remainder bits are 0
        m[r * size + c] = bit ^ (maskFn(r, c) ? 1 : 0);
      }
      drawFormat(m, size, formatBits(ecLevel, mk));
      return m;
    };

    let chosenMask = mask;
    let matrix;
    if (mask === null) {
      let best = Infinity;
      for (let mk = 0; mk < 8; mk++) {
        const m = render(mk);
        const p = penaltyScore(m, size);
        if (p < best) { best = p; chosenMask = mk; matrix = m; }
      }
    } else {
      matrix = render(mask);
    }

    return {
      version: v,
      ecLevel,
      mask: chosenMask,
      size,
      matrix,
      toString() {
        const rows = [];
        for (let r = 0; r < size; r++) {
          let line = '';
          for (let c = 0; c < size; c++) line += matrix[r * size + c] ? '##' : '  ';
          rows.push(line);
        }
        return rows.join('\n');
      },
    };
  }


  const MIN_S = 0.4, MAX_S = 3, STEP = 0.1;             // existing QRs: scale factor
  const MIN_PT = 28, MAX_PT = 220, DEF_PT = 60;         // added QRs: code size in pt (1cm = 28.35pt)
  const QUIET = 2;                                      // white modules round an added code
  const SMALL_PT = 51;                                  // < 1.8cm: warn it may not scan from a table
  let st = { base: {}, added: [] };                     // base[id] = {s,dx,dy,off}; added[] = {id,page,url,cx,cy,size}
  let found = null;                                     // discovered per doc
  let hooks = { refresh() {} };
  let sel = null, stageRef = null, geo = null, timer = null;
  const encCache = {};

  const num = v => { const s = (+v).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' ? '0' : s || '0'; };
  const cm = pt => (pt * 2.54 / 72).toFixed(1) + ' cm';
  const txt = o => o ? (o.decodeText ? o.decodeText() : String(o)) : '';
  const neutral = s => !s || (!s.off && Math.abs((s.s == null ? 1 : s.s) - 1) < 1e-9 && !s.dx && !s.dy);

  function encode(url) {
    if (!encCache[url]) encCache[url] = qrEncode(url, { ecLevel: 'M' });
    return encCache[url];
  }

  function discover(doc) {
    const { PDFName, PDFDict, PDFArray } = PDFLib;
    const list = [], pages = [];
    doc.getPages().forEach((pg, p) => {
      pages.push({ node: pg.node, orig: pg.node.get(PDFName.of('Contents')), refs: null });
      let res = null; try { res = pg.node.Resources(); } catch (_) {}
      const xo = res && res.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xo) return;
      for (const [, ref] of xo.entries()) {
        const obj = doc.context.lookup(ref); const d = obj && obj.dict;
        if (!d || !d.get(PDFName.of('ChuckyQR'))) continue;
        const onPage = d.get(PDFName.of('ChuckyQRPage'));
        if (onPage && onPage.asNumber && onPage.asNumber() !== p) continue;
        const bb = d.lookup(PDFName.of('BBox'), PDFArray).asArray().map(n => n.asNumber());
        list.push({ id: txt(d.get(PDFName.of('ChuckyQR'))), page: p, dict: d,
                    label: txt(d.get(PDFName.of('ChuckyQRLabel'))) || 'QR code', url: txt(d.get(PDFName.of('ChuckyQRUrl'))),
                    box: bb, bboxObj: d.get(PDFName.of('BBox')), matrixObj: d.get(PDFName.of('Matrix')) });
      }
    });
    found = { doc, list, pages };
  }

  /* the one place geometry is decided: a QR's current box in PDF space (y up) */
  function boxOf(q) {
    if (q.url != null && q.cx != null) {                 // added
      const h = q.size / 2; return { x0: q.cx - h, y0: q.cy - h, x1: q.cx + h, y1: q.cy + h };
    }
    const s = st.base[q.id] || {}, k = s.s == null ? 1 : s.s;
    const [x0, y0, x1, y1] = q.box, cx = (x0 + x1) / 2 + (s.dx || 0), cy = (y0 + y1) / 2 + (s.dy || 0);
    const hw = (x1 - x0) / 2 * k, hh = (y1 - y0) / 2 * k;
    return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
  }

  function overlayOps(a) {
    const { size: n, matrix } = encode(a.url), N = n + 2 * QUIET, m = a.size / n;
    let o = `q\n1 0 0 1 ${num(a.cx - a.size / 2 - QUIET * m)} ${num(a.cy - a.size / 2 - QUIET * m)} cm\n${num(m)} 0 0 ${num(m)} 0 0 cm\n`;
    o += `0 0 0 0 k\n0 0 ${N} ${N} re\nf\n0 0 0 1 k\n`;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n;) {
        if (!matrix[r * n + c]) { c++; continue; }
        let e = c; while (e < n && matrix[r * n + e]) e++;
        o += `${QUIET + c} ${QUIET + n - 1 - r} ${e - c} 1 re\n`; c = e;
      }
    }
    return o + 'f\nQ\n';
  }

  /* called by the editor right before doc.save(): idempotent, derives everything from `st` */
  function apply(doc) {
    const { PDFName, PDFRawStream, PDFNumber } = PDFLib;
    if (!found || found.doc !== doc) discover(doc);
    for (const q of found.list) {
      const s = st.base[q.id], d = q.dict;
      if (neutral(s)) {                                   // put the artwork's own objects back
        d.set(PDFName.of('BBox'), q.bboxObj);
        if (q.matrixObj) d.set(PDFName.of('Matrix'), q.matrixObj); else d.delete(PDFName.of('Matrix'));
      } else if (s.off) {
        d.set(PDFName.of('BBox'), doc.context.obj([0, 0, 0, 0]));
      } else {
        const k = s.s == null ? 1 : s.s, [x0, y0, x1, y1] = q.box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        d.set(PDFName.of('BBox'), q.bboxObj);
        d.set(PDFName.of('Matrix'), doc.context.obj([k, 0, 0, k, +num(cx * (1 - k) + (s.dx || 0)), +num(cy * (1 - k) + (s.dy || 0))]));
      }
    }
    const raw = t => { const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 255;
                       return PDFRawStream.of(doc.context.obj({ Length: PDFNumber.of(b.length) }), b); };
    // last page first, so clearing several pages' overlays unwinds the object count in order
    for (let p = found.pages.length - 1; p >= 0; p--) {
      const pi = found.pages[p];
      const mine = st.added.filter(a => a.page === p);
      if (!mine.length) {
        if (!pi.refs) continue;
        /* drop the overlay objects entirely: an orphan stream would still be written by save(), and
           the object count in the trailer with it — clearing the last added QR must give back the
           byte-identical export */
        pi.node.set(PDFName.of('Contents'), pi.orig);
        for (const r of [pi.refs.open, pi.refs.close, pi.refs.over]) doc.context.delete(r);
        if (doc.context.largestObjectNumber === pi.refs.top) doc.context.largestObjectNumber = pi.refs.before;
        pi.refs = null; continue;
      }
      if (!pi.refs) {
        const before = doc.context.largestObjectNumber;
        pi.refs = { before, open: doc.context.register(raw('q\n')), close: doc.context.register(raw('\nQ\n')), over: doc.context.register(raw('')) };
        pi.refs.top = doc.context.largestObjectNumber;
      }
      doc.context.assign(pi.refs.over, raw(mine.map(overlayOps).join('')));
      const inner = pi.orig && pi.orig.asArray ? pi.orig.asArray() : [pi.orig];
      pi.node.set(PDFName.of('Contents'), doc.context.obj([pi.refs.open, ...inner, pi.refs.close, pi.refs.over]));
    }
  }

  // ---------------- state API (also what the tests drive) ----------------
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => { try { hooks.refresh(); } catch (e) { console.error(e); } }, 140); };
  const baseQ = id => found && found.list.find(q => q.id === id);
  const addQ = id => st.added.find(a => a.id === id);
  const bs = id => (st.base[id] = st.base[id] || { s: 1, dx: 0, dy: 0, off: false });
  function list(page) {
    const out = [];
    if (found) for (const q of found.list) if (page == null || q.page === page)
      out.push({ id: q.id, page: q.page, kind: 'artwork', label: q.label, url: q.url, off: !!(st.base[q.id] || {}).off, box: boxOf(q) });
    for (const a of st.added) if (page == null || a.page === page)
      out.push({ id: a.id, page: a.page, kind: 'added', label: 'QR code', url: a.url, off: false, box: boxOf(a) });
    return out;
  }
  function sizeOf(id) { const a = addQ(id); if (a) return a.size; const q = baseQ(id); const b = q && boxOf(q); return b ? b.x1 - b.x0 : 0; }
  function setSize(id, pt) {
    const a = addQ(id); if (a) { a.size = Math.max(MIN_PT, Math.min(MAX_PT, pt)); return; }
    const q = baseQ(id); if (!q) return; const s = bs(id);
    s.s = Math.max(MIN_S, Math.min(MAX_S, pt / (q.box[2] - q.box[0])));
  }
  function grow(id, dir) {                               // one click of - / +
    const a = addQ(id);
    if (a) setSize(id, a.size + dir * 5.67);             // 2mm a click
    else { const s = bs(id); s.s = Math.round(Math.max(MIN_S, Math.min(MAX_S, (s.s || 1) + dir * STEP)) * 100) / 100; }
  }
  function move(id, dx, dy) { const a = addQ(id); if (a) { a.cx += dx; a.cy += dy; return; } const s = bs(id); s.dx = (s.dx || 0) + dx; s.dy = (s.dy || 0) + dy; }
  function remove(id) { if (addQ(id)) st.added = st.added.filter(a => a.id !== id); else if (baseQ(id)) bs(id).off = true; }
  function restore(id) { if (st.base[id]) st.base[id].off = false; }
  function reset(id) { if (baseQ(id)) delete st.base[id]; }
  function checkUrl(url) {
    url = String(url || '').trim();
    if (!url) return { err: 'Paste the link the QR should open.' };
    try { encode(url); } catch (_) { return { err: 'That link is too long for a QR code (max ~210 characters).' }; }
    return { url };
  }
  function add(o) {
    const c = checkUrl(o.url); if (c.err) throw new Error(c.err);
    const a = { id: 'qa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), page: o.page | 0, url: c.url,
                cx: +o.cx, cy: +o.cy, size: Math.max(MIN_PT, Math.min(MAX_PT, +o.size || DEF_PT)) };
    st.added.push(a); return a.id;
  }
  /* a new link for an existing QR = hide the artwork's one, draw a fresh code in its place at its size */
  function setLink(id, url) {
    const c = checkUrl(url); if (c.err) throw new Error(c.err);
    const a = addQ(id); if (a) { a.url = c.url; return id; }
    const q = baseQ(id); if (!q) return id;
    const b = boxOf(q); bs(id).off = true;
    return add({ page: q.page, url: c.url, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, size: b.x1 - b.x0 });
  }
  const snap = () => JSON.parse(JSON.stringify(st));
  function load(o) {
    st = { base: {}, added: [] };
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o.base || {})) if (v && typeof v === 'object')
        st.base[k] = { s: +v.s || 1, dx: +v.dx || 0, dy: +v.dy || 0, off: !!v.off };
      for (const a of (Array.isArray(o.added) ? o.added : [])) {
        if (!a || checkUrl(a.url).err) continue;
        st.added.push({ id: String(a.id || ('qa' + st.added.length)), page: a.page | 0, url: String(a.url).trim(), cx: +a.cx || 0, cy: +a.cy || 0,
                        size: Math.max(MIN_PT, Math.min(MAX_PT, +a.size || DEF_PT)) });
      }
    }
    sel = null; closePanel();
  }
  function init(h) { hooks = Object.assign({ refresh() {} }, h || {}); }

  // ---------------- UI ----------------
  const CSS = `
.qrk-box{position:absolute;pointer-events:auto;cursor:grab;border-radius:3px;box-shadow:inset 0 0 0 1.5px rgba(40,120,255,.0);transition:box-shadow .12s,background .12s;z-index:3;touch-action:none}
.qrk-box:hover,.qrk-box.sel{box-shadow:inset 0 0 0 2px #2f7cf6,0 0 0 3px rgba(47,124,246,.18);background:rgba(47,124,246,.06)}
.qrk-box.drag{cursor:grabbing}
.qrk-box.off{box-shadow:inset 0 0 0 1.5px rgba(120,120,120,.8);background:repeating-linear-gradient(45deg,rgba(0,0,0,.05) 0 6px,transparent 6px 12px)}
.qrk-box .qrk-tag{position:absolute;left:0;top:-17px;font:600 10px/14px system-ui,sans-serif;background:#2f7cf6;color:#fff;padding:0 5px;border-radius:3px;white-space:nowrap;opacity:0;transition:opacity .12s;pointer-events:none}
.qrk-box:hover .qrk-tag,.qrk-box.sel .qrk-tag,.qrk-box.off .qrk-tag{opacity:1}
.qrk-box.off .qrk-tag{background:#777}
.qrk-add{position:absolute;right:8px;top:8px;z-index:4;font:600 12px/1 system-ui,sans-serif;padding:7px 10px;border-radius:8px;border:1px solid rgba(0,0,0,.15);background:#fff;color:#1b1b1b;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12)}
.qrk-add:hover{background:#f1f5ff;border-color:#2f7cf6}
.qrk-panel{position:fixed;z-index:9999;width:292px;background:#fff;color:#1b1b1b;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:12px 14px 14px;font:13px/1.35 system-ui,sans-serif}
.qrk-panel .qrk-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.qrk-panel .qrk-h b{font-size:14px}
.qrk-panel .qrk-x{margin-left:auto;border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#666;padding:0 2px}
.qrk-panel .qrk-sub{color:#666;font-size:11.5px;word-break:break-all;margin:-6px 0 10px}
.qrk-panel .qrk-row{display:flex;align-items:center;gap:6px;margin:8px 0}
.qrk-panel .qrk-row>span:first-child{width:38px;color:#555;font-size:12px}
.qrk-panel button.qb{min-width:30px;height:30px;border-radius:8px;border:1px solid #d5d5d5;background:#f7f7f7;cursor:pointer;font:600 15px/1 system-ui,sans-serif;color:#1b1b1b}
.qrk-panel button.qb:hover{border-color:#2f7cf6;background:#f1f5ff}
.qrk-panel input[type=range]{flex:1;min-width:0}
.qrk-panel .qrk-val{width:48px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px}
.qrk-panel .qrk-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.qrk-panel .qrk-acts button{flex:1;height:32px;border-radius:8px;border:1px solid #d5d5d5;background:#f7f7f7;cursor:pointer;font:600 12px system-ui,sans-serif;color:#1b1b1b;white-space:nowrap}
.qrk-panel .qrk-acts button:hover{border-color:#2f7cf6;background:#f1f5ff}
.qrk-panel .qrk-acts button.danger{color:#c62828}
.qrk-panel .qrk-acts button.primary{background:#2f7cf6;border-color:#2f7cf6;color:#fff}
.qrk-panel input[type=url]{width:100%;box-sizing:border-box;height:34px;border-radius:8px;border:1px solid #cfcfcf;padding:0 10px;font:13px system-ui,sans-serif}
.qrk-panel .qrk-warn{margin-top:8px;font-size:11.5px;color:#a35c00}
.qrk-panel .qrk-err{margin-top:6px;font-size:12px;color:#c62828}
.qrk-panel .qrk-hint{font-size:11px;color:#888}`;
  function css() { if (document.getElementById('qrk-css')) return; const s = document.createElement('style'); s.id = 'qrk-css'; s.textContent = CSS; document.head.appendChild(s); }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* boxes over every QR on the page + the "+ QR" button; called at the end of the editor's pvSync() */
  function hits(hl, page, W, H) {
    if (!hl || typeof document === 'undefined') return;
    css();
    geo = { hl, page, W, H };
    const stage = hl.parentNode;
    if (stage && !stage.querySelector('.qrk-add')) {
      if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
      const b = document.createElement('button'); b.className = 'qrk-add'; b.type = 'button';
      b.textContent = '+ QR'; b.title = 'Add a QR code to this page';
      b.addEventListener('click', e => { e.stopPropagation(); openAdd(b); });
      stage.appendChild(b);
    }
    stageRef = stage;
    hl.querySelectorAll('.qrk-box').forEach(n => n.remove());
    for (const q of list(page)) {
      const d = document.createElement('div');
      d.className = 'qrk-box' + (q.off ? ' off' : '') + (sel === q.id ? ' sel' : '');
      place(d, q.box);
      d.dataset.qr = q.id;
      d.title = q.off ? 'Removed QR — click to restore' : 'Click to resize, move, change link or remove · drag to move';
      d.innerHTML = `<span class="qrk-tag">${q.off ? 'QR removed' : '▣ ' + esc(q.label)}</span>`;
      drag(d, q.id);
      hl.appendChild(d);
    }
  }
  function place(d, b) {
    const { W, H } = geo;
    d.style.left = (b.x0 / W * 100) + '%'; d.style.width = ((b.x1 - b.x0) / W * 100) + '%';
    d.style.top = ((H - b.y1) / H * 100) + '%'; d.style.height = ((b.y1 - b.y0) / H * 100) + '%';
  }
  /* drag to move (page-space delta from the stage's on-screen size); a click without travel opens the panel */
  function drag(d, id) {
    d.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = geo.hl.getBoundingClientRect(), kx = geo.W / r.width, ky = geo.H / r.height;
      const x0 = e.clientX, y0 = e.clientY, L = parseFloat(d.style.left), T = parseFloat(d.style.top);
      let moved = false;
      try { d.setPointerCapture(e.pointerId); } catch (_) {}
      const mv = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true; d.classList.add('drag');
        d.style.left = (L + dx / r.width * 100) + '%'; d.style.top = (T + dy / r.height * 100) + '%';
      };
      const up = ev => {
        d.removeEventListener('pointermove', mv); d.removeEventListener('pointerup', up); d.removeEventListener('pointercancel', up);
        d.classList.remove('drag');
        if (!moved) { openEdit(id, d); return; }
        move(id, (ev.clientX - x0) * kx, -(ev.clientY - y0) * ky);
        sel = id; bump(); if (panel && panel.dataset.id === id) openEdit(id, d);
      };
      d.addEventListener('pointermove', mv); d.addEventListener('pointerup', up); d.addEventListener('pointercancel', up);
    });
    d.addEventListener('click', e => e.stopPropagation());
  }

  let panel = null;
  function closePanel() { if (panel) { panel.remove(); panel = null; } if (typeof document !== 'undefined') document.removeEventListener('pointerdown', outside, true); }
  function outside(e) { if (panel && !panel.contains(e.target) && !(e.target.closest && e.target.closest('.qrk-box,.qrk-add'))) { sel = null; closePanel(); resync(); } }
  function resync() { if (geo) hits(geo.hl, geo.page, geo.W, geo.H); }
  function shell(anchor, html) {
    closePanel(); css();
    panel = document.createElement('div'); panel.className = 'qrk-panel'; panel.innerHTML = html;
    document.body.appendChild(panel);
    const a = anchor.getBoundingClientRect(), pw = panel.offsetWidth || 292, ph = panel.offsetHeight || 260;
    let left = a.right + 10, top = a.top;
    if (left + pw > innerWidth - 8) left = a.left - pw - 10;
    if (left < 8) left = Math.max(8, Math.min(innerWidth - pw - 8, a.left));
    if (top + ph > innerHeight - 8) top = innerHeight - ph - 8;
    panel.style.left = Math.max(8, left) + 'px'; panel.style.top = Math.max(8, top) + 'px';
    panel.querySelector('.qrk-x').onclick = () => { sel = null; closePanel(); resync(); };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    return panel;
  }
  function openEdit(id, anchor) {
    const q = list().find(x => x.id === id); if (!q) return;
    sel = id; resync();
    const isAdd = q.kind === 'added';
    const lo = isAdd ? MIN_PT : Math.round(MIN_S * (baseQ(id).box[2] - baseQ(id).box[0])), hi = isAdd ? MAX_PT : Math.round(MAX_S * (baseQ(id).box[2] - baseQ(id).box[0]));
    const p = shell(anchor, `
      <div class="qrk-h"><b>QR code</b><button class="qrk-x" title="Close">×</button></div>
      <div class="qrk-sub">${esc(q.label)}${q.url ? ' · ' + esc(q.url) : ''}</div>
      ${q.off ? `<div class="qrk-row">This QR is removed from the menu.</div>
      <div class="qrk-acts"><button class="primary" data-a="restore">Restore it</button><button data-a="link">New link…</button></div>` : `
      <div class="qrk-row"><span>Size</span><button class="qb" data-a="minus" title="Smaller">−</button>
        <input type="range" min="${lo}" max="${hi}" step="1" value="${Math.round(sizeOf(id))}">
        <button class="qb" data-a="plus" title="Bigger">+</button><span class="qrk-val"></span></div>
      <div class="qrk-row"><span>Move</span><button class="qb" data-a="L" title="Left">←</button><button class="qb" data-a="U" title="Up">↑</button>
        <button class="qb" data-a="D" title="Down">↓</button><button class="qb" data-a="R" title="Right">→</button><span class="qrk-hint">or drag it</span></div>
      <div class="qrk-warn" hidden></div>
      <div class="qrk-acts"><button data-a="link">Change link…</button>${isAdd ? '' : '<button data-a="reset">Reset</button>'}<button class="danger" data-a="remove">Remove</button></div>`}
      <div class="qrk-linkbox" hidden><div class="qrk-row"><input type="url" placeholder="https://…" value="${esc(q.url || '')}"></div>
        <div class="qrk-err" hidden></div><div class="qrk-acts"><button class="primary" data-a="setlink">Use this link</button></div></div>`);
    p.dataset.id = id;
    const val = p.querySelector('.qrk-val'), rng = p.querySelector('input[type=range]'), warn = p.querySelector('.qrk-warn');
    const show = () => {
      const s = sizeOf(id); if (val) val.textContent = cm(s); if (rng) rng.value = Math.round(s);
      if (warn) { warn.hidden = s >= SMALL_PT; warn.textContent = 'Small QR codes can be hard to scan — keep it at least 1.8 cm.'; }
      const q2 = list().find(x => x.id === id), box = q2 && geo && geo.hl.querySelector(`.qrk-box[data-qr="${id}"]`);
      if (box) place(box, q2.box);
    };
    show();
    if (rng) rng.addEventListener('input', () => { setSize(id, +rng.value); show(); bump(); });
    const nudge = 1.4175;                                  // 0.5 mm
    p.addEventListener('click', e => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      const act = a.dataset.a;
      if (act === 'minus' || act === 'plus') { grow(id, act === 'plus' ? 1 : -1); show(); bump(); }
      else if ('LRUD'.includes(act)) { move(id, act === 'L' ? -nudge : act === 'R' ? nudge : 0, act === 'U' ? nudge : act === 'D' ? -nudge : 0); show(); bump(); }
      else if (act === 'remove') { remove(id); sel = null; closePanel(); resync(); bump(); }
      else if (act === 'restore') { restore(id); openEdit(id, anchor); bump(); }
      else if (act === 'reset') { reset(id); show(); bump(); }
      else if (act === 'link') { p.querySelector('.qrk-linkbox').hidden = false; const i = p.querySelector('input[type=url]'); i.focus(); i.select(); }
      else if (act === 'setlink') {
        const i = p.querySelector('input[type=url]'), er = p.querySelector('.qrk-err');
        try { const nid = setLink(id, i.value); sel = nid; closePanel(); resync(); bump(); }
        catch (x) { er.hidden = false; er.textContent = x.message; }
      }
    });
    const inp = p.querySelector('input[type=url]');
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') p.querySelector('[data-a=setlink]').click(); });
  }
  function openAdd(anchor) {
    if (!geo) return;
    sel = null; resync();
    const p = shell(anchor, `
      <div class="qrk-h"><b>Add a QR code</b><button class="qrk-x" title="Close">×</button></div>
      <div class="qrk-row"><input type="url" placeholder="Paste the link, e.g. https://instagram.com/…"></div>
      <div class="qrk-err" hidden></div>
      <div class="qrk-hint">It appears in the middle of this page — then drag it where you want it and set its size.</div>
      <div class="qrk-acts"><button class="primary" data-a="go">Add QR</button></div>`);
    const i = p.querySelector('input'), er = p.querySelector('.qrk-err');
    const go = () => {
      try {
        const id = add({ page: geo.page, url: i.value, cx: geo.W / 2, cy: geo.H / 2, size: DEF_PT });
        sel = id; closePanel(); resync(); bump();
        const box = geo.hl.querySelector(`.qrk-box[data-qr="${id}"]`); if (box) openEdit(id, box);
      } catch (x) { er.hidden = false; er.textContent = x.message; }
    };
    p.querySelector('[data-a=go]').onclick = go;
    i.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    setTimeout(() => i.focus(), 0);
  }

  return { apply, hits, init, snap, load, list, add, remove, restore, reset, setSize, grow, move, setLink, sizeOf, encode };
})();
/* QRTOOL:END */
QRK.init({ refresh: () => schedulePreview() });

// ============================================================ click the preview to edit
/* Invisible boxes are laid over the rendered page, positioned in PERCENT of the page so they stay
   aligned at any preview scale / window size. Clicking one scrolls to that dish's card and focuses
   it — the same gesture Aiko/Capiche/Churn'd already have. Boxes follow the removal reflow and a
   description that grew a line, so they track what is actually on screen. */
let _pvSel = null;

function pvHitLayer() {
  const cv = document.getElementById('preview');
  if (!cv) return null;
  let st = document.getElementById('pstage');
  if (!st) {                                  // wrap the canvas once so the overlay hugs it exactly
    st = document.createElement('div');
    st.id = 'pstage';
    cv.parentNode.insertBefore(st, cv);
    st.appendChild(cv);
    const hl = document.createElement('div');
    hl.id = 'hitlayer';
    st.appendChild(hl);
  }
  return st.querySelector('#hitlayer');
}

/** The same reflow `regenerate()` applies: everything below a removed dish rides up by its slot. */
function pvShifts() {
  const shift = {};
  for (const c of FM.columns) {
    let dy = 0;
    for (const id of c.ids) {
      if (removed.includes(id)) { dy += (byId[id] || {}).slot || c.pitch; continue; }
      shift[id] = dy;
    }
  }
  return shift;
}

/** How far a description's glyphs drop below their baseline — parentheses and “g” need ~0.39em. */
function descGap(desc) {
  return Math.max(3, (desc.size || 10) * 0.45);
}

/** Width of one description line as it will be drawn. */
function pvLineRight(desc, text, x) {
  return x + textWidth(text || '', famOf(desc), desc.size, desc.kern);
}

// one box per visible dish on `page`, in PDF space (y up)
function pvBoxes(page) {
  const shift = pvShifts();
  const out = [];
  for (const c of FM.columns) {
    if (c.page !== page) continue;
    for (const id of c.ids) {
      if (removed.includes(id)) continue;
      const n = byId[id];
      if (!n) continue;
      const k = kidsOf[id] || {};
      const dy = shift[id] || 0;
      const top = n.y + (n.size || 14) * 0.95 + dy;
      let bot = n.y - 5 + dy;
      let x0 = n.x;
      let x1 = nameRight(n);
      // the trailing cluster: gm label and allergen markers sit to the right of the name
      if (n.marker_geom && n.marker_geom.to) x1 = Math.max(x1, n.marker_geom.to);
      for (const m of n.marker_boxes || []) x1 = Math.max(x1, m.x + m.w);
      if (k.gram) x1 = Math.max(x1, k.gram.bbox ? k.gram.bbox[2] : k.gram.x);
      if (k.price) {
        x1 = Math.max(x1, k.price.x
          + textWidth(curText(k.price), famOf(k.price), k.price.size, k.price.kern));
      }
      if (k.desc) {
        const d = k.desc;
        const baked = d.lines || [];
        let live = baked.length;
        if (edits[d.id] !== undefined) {       // an edited description may have claimed a new line
          const wrapped = wrapText(edits[d.id], famOf(d), d.size, c.width,
            baked.length + extraLines(n, d), d.kern);
          live = Math.max(1, wrapped.length);
          wrapped.forEach((t) => { x1 = Math.max(x1, pvLineRight(d, t, d.x)); });
        } else {
          for (const L of baked) x1 = Math.max(x1, pvLineRight(d, L.text, L.x));
        }
        const lastY = baked.length ? baked[baked.length - 1].y : d.y;
        bot = Math.min(bot, lastY - Math.max(0, live - baked.length) * d.pitch - descGap(d) + dy);
        x0 = Math.min(x0, d.x);
      }
      out.push({ id, x0: x0 - 5, x1: x1 + 4, top, bot });
    }
  }
  // dishes the user added sit below the last live dish of their column (see addedDishOps)
  added.forEach((a, i) => {
    const c = FM.columns.find((x) => x.id === a.col);
    if (!c || c.page !== page) return;
    const liveIds = c.ids.filter((id) => !removed.includes(id));
    const bottom = byId[liveIds.length ? liveIds[liveIds.length - 1] : c.ids[c.ids.length - 1]];
    if (!bottom) return;
    const k = kidsOf[bottom.id] || {};
    const y = bottom.y - (bottom.slot || c.pitch) * (a.index || 1);
    const top = y + (bottom.size || 14) * 0.95;
    let bot = y - 5;
    let x1 = c.x + textWidth(a.name || '', famOf(bottom), bottom.size, bottom.kern);
    if (k.price && a.price) {
      x1 = Math.max(x1, k.price.x + textWidth(String(a.price), famOf(k.price), k.price.size, k.price.kern));
    }
    if (k.desc && a.desc) {
      const d = k.desc;
      const lines = wrapText(a.desc, famOf(d), d.size, c.width, 4, d.kern);
      lines.forEach((t) => { x1 = Math.max(x1, pvLineRight(d, t, c.x)); });
      bot = Math.min(bot, y - (bottom.y - d.y) - (lines.length - 1) * d.pitch - descGap(d));
    }
    out.push({ id: 'add:' + i, x0: c.x - 5, x1: x1 + 4, top, bot });
  });
  return out;
}

function pvSync() {
  const hl = pvHitLayer();
  if (!hl) return;
  let boxes;
  try { boxes = pvBoxes(activePage); } catch (e) { hl.innerHTML = ''; return; }
  const sz = (FM.page_sizes || [])[activePage] || [595.5, 842.25];
  const W = sz[0];
  const H = sz[1];
  hl.innerHTML = '';
  for (const b of boxes) {
    const d = document.createElement('div');
    d.className = 'hitbox' + (_pvSel === b.id ? ' sel' : '');
    d.style.left = (b.x0 / W * 100) + '%';
    d.style.width = (Math.max(10, b.x1 - b.x0) / W * 100) + '%';
    d.style.top = ((H - b.top) / H * 100) + '%';
    d.style.height = (Math.max(8, b.top - b.bot) / H * 100) + '%';
    d.title = 'Click to edit this item';
    d.addEventListener('click', () => pvJump(b.id));
    hl.appendChild(d);
  }
  try { QRK.hits(hl, activePage, W, H); } catch (e) { console.error(e); }
}

function pvJump(id) {
  _pvSel = id;
  pvSync();
  const sel = window.CSS && CSS.escape ? CSS.escape(id) : id;
  const card = document.querySelector('#editor .card[data-id="' + sel + '"]');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
  const input = card.querySelector('input:not([type=checkbox]), textarea');
  if (input) setTimeout(() => input.focus(), 260);
}

// ============================================================ preview / export
async function renderPreview() {
  const canvas = document.getElementById('preview');
  if (!canvas || typeof pdfjsLib === 'undefined') return;
  const busy = document.getElementById('busy');
  if (busy) busy.classList.add('on');   // chucky-2: the shell shows #busy by class
  try {
    const bytes = await regenerate();
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    pdfjsDoc = doc;
    const page = await doc.getPage(activePage + 1);
    const wrap = document.getElementById('wrap');
    const vw = Math.max(240, (wrap ? wrap.clientWidth : 480) - 8);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: vw / vp0.width });
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const tag = document.getElementById('ptag');
    if (tag) tag.textContent = '— Page ' + (activePage + 1);
    try { pvSync(); } catch (_) { /* overlay is best-effort */ }
  } catch (e) {
    if (!/Cancelled/i.test(String(e && e.message))) throw e;
  } finally { if (busy) busy.classList.remove('on'); }
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

/* chucky-2: a message in the page's bar rather than alert(), which some phone browsers block —
   a blocked alert reads as the button doing nothing */
const CANT_PRINT = 'Some text can’t be printed in this menu’s fonts — fix the highlighted fields first.';
function say(kind, html) { try { MenuState.notice(kind, html, [], 8000); } catch (_) { alert(html.replace(/<[^>]+>/g, '')); } }

async function doExport() {
  if (syncFlagPill()) { say('bad', '<b>Not exported:</b> ' + esc(CANT_PRINT)); return; }
  const bytes = await regenerate();
  download(bytes, 'Beshak_Menu.pdf');
  try { MEM.snapshot('export'); } catch (_) { /* history is best-effort */ }   // chucky-2: was MEM.push, which MEM never had
  celebrate();
}

// ---- Publish: chucky-2 — the shared MenuState (assets/js/menustate.js) owns the Publish button:
// the key, the version check, the conflict handling and the live status. Wired up at the end of
// boot(); its beforePublish hook refuses a menu with text the fonts can't print, as this did.

// ---- Full Preview: chucky-2 — the same /preview/ page as the other editors. It used to open a
// blob: URL after awaiting the PDF, which browsers treat as a pop-up and block. The tab opens
// first, synchronously, and the PDF reaches it through IndexedDB (one-shot, never uploaded).
const PV_DB = 'chucky_preview', PV_STORE = 'jobs';
function pvDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(PV_DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(PV_STORE)) r.result.createObjectStore(PV_STORE); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function pvPut(id, rec) {
  return pvDB().then((d) => new Promise((res, rej) => {
    const tx = d.transaction(PV_STORE, 'readwrite'); tx.objectStore(PV_STORE).put(rec, id);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  }));
}
async function openFullPreview() {
  const btn = document.getElementById('fullprev');
  const id = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const win = window.open('/preview/#' + id, '_blank');       // sync: must precede any await
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    const bytes = await regenerate();
    await pvPut(id, { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), file: 'Beshak_Menu.pdf', title: 'Beshak — Menu', back: location.pathname, t: Date.now() });
    if (!win) say('warn', 'Your browser blocked the preview tab. Allow pop-ups for this site, then press <b>Full Preview</b> again.');
  } catch (e) {
    try { await pvPut(id, { error: String((e && e.message) || e), t: Date.now() }); } catch (_) { /* the tab says it timed out */ }
    if (!win) say('bad', 'Couldn’t build the preview: ' + esc(String((e && e.message) || e)));
  } finally { if (btn) { btn.disabled = false; btn.textContent = label || 'Full Preview ↗'; } }
}

// ============================================================ export celebration
const CHUCKY_LINES = ['KILLED IT 😎', 'CHEF’S KISS 🤌', 'SERVED 🍽️', 'COOKED. LITERALLY.', 'MENU SLAPS.',
  'PLATED. 🐾', 'CERTIFIED BANGER.', 'ATE. NO CRUMBS.', 'HOT OUT THE OVEN.', 'THAT’S A WRAP.'];
let lineSeed = 0;
function celebrate() {
  const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
  const txt = CHUCKY_LINES[(day + lineSeed++) % CHUCKY_LINES.length];
  const ov = document.createElement('div');
  ov.id = 'celebrate';
  ov.className = 'on';   // chucky-2: the shell's stylesheet shows #celebrate by class
  ov.innerHTML = '<div class="cbcard"><div class="cbmark">BESHAK</div><div class="cbline">' + esc(txt) + '</div></div>';
  document.body.appendChild(ov);
  setTimeout(() => ov.remove(), 1900);
}

// ============================================================ wiring
function wire() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('export', () => { doExport().catch((e) => say('bad', 'Export failed: ' + esc(String((e && e.message) || e)))); });
  on('fullprev', openFullPreview);   // chucky-2: Publish is MenuState's (see boot)
  document.querySelectorAll('.rail .tabs button').forEach((b) => {
    b.onclick = () => { activePage = +b.dataset.pg; buildEditor(); schedulePreview(); };
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      const q = document.getElementById('q');
      if (q) q.focus();
    }
  });
  window.addEventListener('resize', () => { clearTimeout(previewTimer); previewTimer = setTimeout(() => renderPreview().catch(() => {}), 300); });
}

// ============================================================ boot
async function boot() {
  const msg = (t) => { const el = document.getElementById('bootmsg'); if (el) el.textContent = t; };
  msg('Reading the menu…');
  const v = '?v=' + Date.now();
  const [fmRes, pdfRes, baseRes, culRes] = await Promise.all([
    fetch('fieldmap.json' + v), fetch('beshak.pdf' + v), fetch('base_words.json' + v), fetch('culinary.json' + v),
  ]);
  FM = await fmRes.json();
  pdfBytesOrig = new Uint8Array(await pdfRes.arrayBuffer());
  try {
    const base = await baseRes.json(), cul = await culRes.json();
    DICT = new Set([].concat(base.words || base, cul.words || cul).map((w) => String(w).toLowerCase()));
    for (const f of FM.fields) for (const w of String(f.display || '').match(/[A-Za-z]+/g) || []) DICT.add(w.toLowerCase());
  } catch (_) { DICT = null; }

  for (const f of FM.fields) {
    byId[f.id] = f;
    if (f.of) { kidsOf[f.of] = kidsOf[f.of] || {}; kidsOf[f.of][f.role] = f; }
  }

  msg('Opening the artwork…');
  pdfDoc = await PDFDocument.load(pdfBytesOrig, { updateMetadata: false });
  loadStreams();

  msg('Checking for a published menu…');
  /* chucky-2: MenuState.boot retries the load, applies a published state only if it was made for
     THIS base PDF (its edits address byte spans in one file), falls back to the menu's starting
     state (start-state.json — beshak.pdf already IS the current menu, so it holds no edits), and —
     unlike the old silent fallback — puts up a bar and locks Publish when the published menu can't
     be loaded. */
  const st = await MenuState.boot({ editor: MEM_BRAND, base: memBaseVer(), start: 'start-state.json' });
  if (st) memApply(st);

  buildEditor();
  wire();
  try { MEM.init(); } catch (_) { /* memory is optional */ }
  MenuState.ready({                     // chucky-2: publish, live status, newer-version pickup, versions
    snapshot: memSnapshot,
    apply: (s) => { memApply(s); memRebuild(); },
    beforePublish: () => regenerate(),  // refuse to publish a state that doesn't even export
    // text this menu's fonts can't set prints as nothing, so a menu holding any is not published —
    // as the old Publish refused it (MenuState reports this reason as "Not published: …")
    prepare: () => { if (syncFlagPill()) throw new Error('some text can’t be printed in this menu’s fonts — fix the fields marked in red first'); },
    keep: (label) => MEM.snapshot(label),   // park the current edits in History before replacing them
    rebase: () => MEM.rebase(),
  });
  const b = document.getElementById('boot');
  if (b) b.style.display = 'none';
  ready = true;
  renderPreview().catch(() => {});
}


// ============ EDIT MEMORY — autosave + resume + version history (per brand) ============
// Glue each editor must define BEFORE this block:
//   const MEM_BRAND = 'aiko-drinks';        // unique key
//   function memSnapshot(){ return {...}; }  // serialisable current edit state (order-stable)
//   function memApply(state){ ... }          // mutate editor vars from a saved state
//   function memRebuild(){ ... }             // rebuild UI + regenerate + render after apply
//   let   memBaseVer = '';                   // fingerprint of the base PDF (for #6 update detection)
/* chucky-2: Beshak's memBaseVer is a FUNCTION (the PDF loads after this block is defined), but this
   block was written for the brands where it is a string: `base:memBaseVer` stored nothing, so edits
   made for an older PDF could never be told apart. Read it through baseVer(). */
const MEM = (function(){
  const K='chucky_mem_'+MEM_BRAND, AUTO=K+':auto', SNAPS=K+':snaps';
  const baseVer=()=>memBaseVer();
  let initial='', timer=null, statusEl=null, panel=null, ready=false;
  const J=o=>{ try{return JSON.stringify(o);}catch(_){return '';} };
  const P=s=>{ try{return JSON.parse(s);}catch(_){return null;} };
  function ago(t){ const s=Math.max(0,(Date.now()-t)/1000);
    if(s<45) return 'just now'; if(s<3600) return Math.round(s/60)+'m ago';
    if(s<86400) return Math.round(s/3600)+'h ago'; return Math.round(s/86400)+'d ago'; }
  const dirty=()=> J(memSnapshot())!==initial;
  function setStatus(txt,cls){ if(!statusEl)return; statusEl.querySelector('.memtxt').textContent=txt; statusEl.dataset.state=cls||''; statusEl.style.display=txt?'':'none'; }
  function tick(){
    if(!ready) return;
    clearTimeout(timer);
    if(!dirty()){ try{localStorage.removeItem(AUTO);}catch(_){}; setStatus('',''); return; }
    setStatus('Saving…','saving');
    /* chucky-2: `pub` is the published version these edits started from (see checkResume), and the
       chip says where they're saved — "Saved" alone read as saved for everyone */
    timer=setTimeout(()=>{ try{ localStorage.setItem(AUTO, J({t:Date.now(), base:baseVer(), pub:(window.MenuState?MenuState.version():null), s:memSnapshot()})); setStatus('Saved on this device','ok'); }catch(_){ setStatus('',''); } }, 500);
  }
  function snapshot(label){ if(!dirty()) return; try{ const a=P(localStorage.getItem(SNAPS))||[];
    a.unshift({t:Date.now(), label:label||'edit', base:baseVer(), s:memSnapshot()});
    localStorage.setItem(SNAPS, J(a.slice(0,12))); }catch(_){} }
  const snaps=()=> P(localStorage.getItem(SNAPS))||[];
  function restore(state){ try{ memApply(state); memRebuild(); }catch(e){ console.error('restore failed',e); } tick(); }
  // ---------- UI ----------
  function build(){
    if(document.getElementById('memwrap')) return;
    const css=document.createElement('style'); css.textContent=`
    #memwrap{position:fixed;left:16px;bottom:16px;z-index:60;font:12px/1.4 var(--mono,ui-monospace,monospace)}
    #memstat{display:none;align-items:center;gap:7px;background:rgba(20,18,12,.92);color:#CFC6B4;border:1px solid rgba(244,236,221,.16);
      border-radius:999px;padding:6px 12px;cursor:pointer;backdrop-filter:blur(6px);user-select:none;box-shadow:0 10px 30px -14px #000}
    #memstat:hover{border-color:rgba(244,236,221,.34)}
    #memstat .dot{width:7px;height:7px;border-radius:50%;background:#8F8676;flex:none}
    #memstat[data-state=ok] .dot{background:#7BC96F} #memstat[data-state=saving] .dot{background:#E0A44A;animation:mempulse 1s infinite}
    @keyframes mempulse{50%{opacity:.35}}
    #mempanel{display:none;position:absolute;left:0;bottom:42px;width:280px;max-height:340px;overflow:auto;background:rgba(18,16,11,.98);
      border:1px solid rgba(244,236,221,.16);border-radius:12px;padding:10px;box-shadow:0 24px 60px -24px #000}
    #mempanel.on{display:block} #mempanel h4{margin:2px 4px 8px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#8F8676;font-weight:600}
    .memrow{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;color:#CFC6B4}
    .memrow:hover{background:rgba(244,236,221,.07)} .memrow .ml{flex:1;min-width:0} .memrow .mt{font-size:10.5px;color:#8F8676}
    .memrow .mr{font-size:10px;color:#8F8676} .memrow.empty{color:#6f6858;cursor:default}
    #membar{position:fixed;left:0;right:0;top:0;z-index:70;display:none;align-items:center;justify-content:center;gap:14px;
      padding:10px 16px;background:linear-gradient(90deg,#2A1F12,#1c150c);border-bottom:1px solid rgba(224,164,74,.4);
      color:#F4ECDD;font:13px/1.4 var(--mono,ui-monospace,monospace);box-shadow:0 8px 24px -12px #000}
    #membar.on{display:flex} #membar b{color:#E0A44A}
    #membar button{font:inherit;font-size:12px;padding:5px 13px;border-radius:8px;cursor:pointer;border:1px solid rgba(244,236,221,.28);background:transparent;color:#F4ECDD}
    #membar button.pri{background:#E0A44A;border-color:#E0A44A;color:#1a1508;font-weight:600}
    #membar button:hover{filter:brightness(1.1)}
    @media(max-width:640px){#memwrap{left:10px;bottom:10px}#mempanel{width:min(280px,86vw)}}`;
    document.head.appendChild(css);
    const wrap=document.createElement('div'); wrap.id='memwrap';
    wrap.innerHTML='<div id="memstat" title="Edit memory — click for history"><span class="dot"></span><span class="memtxt"></span> · History</div><div id="mempanel"></div>';
    document.body.appendChild(wrap);
    const bar=document.createElement('div'); bar.id='membar'; document.body.appendChild(bar);
    statusEl=document.getElementById('memstat'); panel=document.getElementById('mempanel');
    statusEl.addEventListener('click',togglePanel);
    document.addEventListener('click',e=>{ if(panel&&!wrap.contains(e.target)) panel.classList.remove('on'); });
  }
  function togglePanel(e){ e&&e.stopPropagation(); if(!panel)return; const open=!panel.classList.contains('on'); if(open)renderPanel(); panel.classList.toggle('on',open); }
  function renderPanel(){
    const list=snaps(); let h='<h4>Version history</h4>';
    if(!list.length) h+='<div class="memrow empty">No saved versions yet.<br>Exports and edits are saved here.</div>';
    else list.forEach((v,i)=>{ h+='<div class="memrow" data-i="'+i+'"><span class="ml"><div>'+esc(v.label)+'</div><div class="mt">'+ago(v.t)+(v.base!==baseVer()?' · older menu':'')+'</div></span><span class="mr">restore</span></div>'; });
    panel.innerHTML=h;
    panel.querySelectorAll('.memrow[data-i]').forEach(r=>r.addEventListener('click',()=>{ const v=snaps()[+r.dataset.i]; if(v){ snapshot('before restore'); restore(v.s); panel.classList.remove('on'); } }));
  }
  function esc(s){ return (s+'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function checkResume(){
    const a=P(localStorage.getItem(AUTO)); if(!a||!a.s||J(a.s)===initial) return;
    const bar=document.getElementById('membar'); if(!bar) return;
    // chucky-2: autosaves from before this port carry no base (see baseVer) — their PDF is unknown
    const stale=!a.base || a.base!==baseVer();
    /* chucky-2: edits kept on this device are a WHOLE menu, not a list of changes. Resumed on top of a
       newer publish they bring back the old details — one way published changes went missing in the
       old Chucky — so say so, and make keeping the published menu the default (the edits still go to
       History). Edits made for a different menu PDF point at the wrong bytes: not offered at all. */
    const pubNow=(window.MenuState?MenuState.version():null);
    const older=!stale && ('pub' in a ? a.pub!==pubNow : pubNow!=null);
    const dismiss=(keep)=>{ try{ if(keep){ const L=P(localStorage.getItem(SNAPS))||[];
        L.unshift({t:a.t, label:'Unsaved edits from '+ago(a.t)+' (not resumed)', base:a.base, s:a.s});
        localStorage.setItem(SNAPS, J(L.slice(0,12))); }
      localStorage.removeItem(AUTO); }catch(_){}
      bar.classList.remove('on'); tick(); };
    if(stale) bar.innerHTML='<span>You have unsaved edits from '+ago(a.t)+' made for a <b>previous version</b> of this menu file. They can’t be applied to this one.</span><button class="pri" id="memfresh">OK</button>';
    else if(older) bar.innerHTML='<span>You have unsaved edits from '+ago(a.t)+', made <b>before the menu was last published</b>. Resuming them would bring back older details.</span>'
      +'<button class="pri" id="memfresh">Keep the published menu</button><button id="memres">Resume mine anyway</button>';
    else bar.innerHTML='<span>You left <b>unsaved edits</b> here '+ago(a.t)+'.</span><button class="pri" id="memres">Resume them</button><button id="memfresh">Start fresh</button>';
    bar.classList.add('on');
    const res=bar.querySelector('#memres'); if(res) res.addEventListener('click',()=>{ restore(a.s); bar.classList.remove('on'); });
    bar.querySelector('#memfresh').addEventListener('click',()=>dismiss(!stale));
  }
  // chucky-2: after a publish, or after loading the latest published menu, what's on screen IS the
  // published menu — nothing left to resume. Cancel a pending autosave too: publishing regenerates,
  // which queues one, and if the server answers first it would put the old edits back afterwards.
  function rebase(){ clearTimeout(timer); try{ initial=J(memSnapshot()); localStorage.removeItem(AUTO); }catch(_){ } setStatus('',''); }
  function init(){ try{ initial=J(memSnapshot()); }catch(_){ initial=''; } ready=true; build(); checkResume(); }
  return { init, tick, snapshot, restore, ago, rebase };
})();


boot().catch(e => {
  console.error(e);
  const m = document.getElementById('bootmsg');
  if (m) m.textContent = 'Could not open the menu: ' + ((e && e.message) || e);
});
