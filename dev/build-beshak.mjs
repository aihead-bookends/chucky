#!/usr/bin/env node
/* dev/build-beshak.mjs — rebuilds the Beshak editor's base from the designer's Canva export.

     node dev/build-beshak.mjs "path/to/beshak menu.pdf" [--out public/beshak]

   Writes beshak.pdf, fieldmap.json and start-state.json. What it does (README, "The Beshak menu"):
   1. A page whose text is drawn upside down (Canva's 180° page, so the fold reads the right way up)
      is made upright INSIDE its artwork XObject and flipped back as a whole by the page's content
      stream — the print is identical, the editor sees an ordinary page (`page_flip` in the fieldmap).
   2. Each font family's per-page subsets are merged into one program, so both pages can set every
      letter the designer used anywhere in the menu.
   3. The streams the editor edits (the page artwork XObjects and the gm/ml label XObjects) are stored
      uncompressed, because the engine splices their bytes by offset.
   4. fieldmap.json is generated from the streams — dishes (name, description, price, gm label,
      allergen markers), sections and their rules, columns, fonts, icons — in the format the engine
      has always read; start-state.json is reset to the new base. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFDict, PDFArray, PDFRef, decodePDFRawStream } from 'pdf-lib';

const args = process.argv.slice(2);
const srcPath = args.find((a) => !a.startsWith('--'));
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'public/beshak';
if (!srcPath) { console.error('usage: node dev/build-beshak.mjs <canva-export.pdf> [--out public/beshak]'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const GLUTEN = JSON.parse(fs.readFileSync(path.join(here, 'beshak-gluten.json'), 'utf8'));

const ART = 10;                                   // artwork units per point (the page draws its XObject at 0.1)
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const fmt = (v) => { const s = String(r4(v)); return s === '-0' ? '0' : s; };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const latin1 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('latin1');
const bytesOf = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
const N = (k) => PDFName.of(k);

// ============================================================ content-stream tokenizer / walker
const WS = /[\s\0]/, DELIM = /[()<>[\]{}/%]/;
function tokenize(t) {
  const out = []; let i = 0; const n = t.length;
  while (i < n) {
    const ch = t[i];
    if (WS.test(ch)) { i++; continue; }
    if (ch === '%') { while (i < n && t[i] !== '\n' && t[i] !== '\r') i++; continue; }
    const s = i;
    if (ch === '(') {
      let d = 0, raw = ''; i++;
      while (i < n) {
        const c = t[i];
        if (c === '\\') {
          const nx = t[i + 1]; i += 2;
          if (nx === 'n') raw += '\n'; else if (nx === 'r') raw += '\r'; else if (nx === 't') raw += '\t'; else if (nx === 'b') raw += '\b'; else if (nx === 'f') raw += '\f';
          else if (/[0-7]/.test(nx)) { let o = nx; while (o.length < 3 && /[0-7]/.test(t[i])) o += t[i++]; raw += String.fromCharCode(parseInt(o, 8)); }
          else if (nx === '\n') { /* continuation */ } else if (nx === '\r') { if (t[i] === '\n') i++; } else raw += nx;
          continue;
        }
        if (c === '(') { d++; raw += c; i++; continue; }
        if (c === ')') { if (d === 0) { i++; break; } d--; raw += c; i++; continue; }
        raw += c; i++;
      }
      out.push({ t: 'str', v: raw, s, e: i }); continue;
    }
    if (ch === '<') {
      if (t[i + 1] === '<') { out.push({ t: 'delim', v: '<<', s, e: i + 2 }); i += 2; continue; }
      i++; let hex = ''; while (i < n && t[i] !== '>') { if (!WS.test(t[i])) hex += t[i]; i++; } i++;
      if (hex.length % 2) hex += '0'; let raw = ''; for (let k = 0; k < hex.length; k += 2) raw += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      out.push({ t: 'str', v: raw, s, e: i }); continue;
    }
    if (ch === '>' && t[i + 1] === '>') { out.push({ t: 'delim', v: '>>', s, e: i + 2 }); i += 2; continue; }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') { out.push({ t: 'delim', v: ch, s, e: i + 1 }); i++; continue; }
    if (ch === '/') { i++; while (i < n && !WS.test(t[i]) && !DELIM.test(t[i])) i++; out.push({ t: 'name', v: t.slice(s, i), s, e: i }); continue; }
    while (i < n && !WS.test(t[i]) && !DELIM.test(t[i])) i++;
    const w = t.slice(s, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) out.push({ t: 'num', v: parseFloat(w), s, e: i }); else out.push({ t: 'op', v: w, s, e: i });
  }
  return out;
}
/** Calls fn(op, operandTokens, opToken, startOffsetOfOperands) for every operator. */
function walk(text, fn) {
  let ops = [], start = null;
  for (const tk of tokenize(text)) {
    if (tk.t !== 'op') { if (start === null) start = tk.s; ops.push(tk); continue; }
    fn(tk.v, ops, tk, start === null ? tk.s : start);
    ops = []; start = null;
  }
}

// ============================================================ the 180° flip
/** Rewrite a stream drawn upside down so it reads upright, for a page that will draw it through
    `-1 0 0 -1 W H cm`. W,H are the page size in the stream's own units. Coordinates under the
    identity CTM are mirrored; a pure-scale `cm` (the `10 0 0 10 0 0 cm` every text block uses) is
    kept and the mirror carried through it; any other `cm` absorbs the mirror into its matrix. */
function flipContent(text, W, H) {
  const reps = [], stack = [{ W, H }];
  const put = (tk, v) => reps.push({ s: tk.s, e: tk.e, t: fmt(v) });
  walk(text, (op, a) => {
    const nums = a.filter((x) => x.t === 'num'), v = nums.map((x) => x.v), cur = stack[stack.length - 1];
    const six = () => { put(nums[0], -v[0]); put(nums[1], -v[1]); put(nums[2], -v[2]); put(nums[3], -v[3]); put(nums[4], cur.W - v[4]); put(nums[5], cur.H - v[5]); };
    switch (op) {
      case 'q': stack.push(cur); break;
      case 'Q': stack.pop(); break;
      case 'cm':
        if (!cur) break;
        if (v[1] === 0 && v[2] === 0 && v[4] === 0 && v[5] === 0 && v[0] === v[3] && v[0] > 0) { stack[stack.length - 1] = { W: cur.W / v[0], H: cur.H / v[0] }; break; }
        six(); stack[stack.length - 1] = null; break;
      case 'm': case 'l': if (cur) { put(nums[0], cur.W - v[0]); put(nums[1], cur.H - v[1]); } break;
      case 'c': case 'v': case 'y': if (cur) for (let i = 0; i < nums.length; i += 2) { put(nums[i], cur.W - v[i]); put(nums[i + 1], cur.H - v[i + 1]); } break;
      case 're': if (cur) { put(nums[0], cur.W - v[0] - v[2]); put(nums[1], cur.H - v[1] - v[3]); } break;
      case 'Tm': if (cur) six(); break;
      case 'd0': case 'd1': case 'sh': case 'BI': case 'ID': case "'": case '"': throw new Error('flip: unsupported operator ' + op);
      default: break;
    }
  });
  reps.sort((a, b) => b.s - a.s);
  let out = text; for (const r of reps) out = out.slice(0, r.s) + r.t + out.slice(r.e);
  return out;
}
const flipBox = ([x0, y0, x1, y1], W, H) => [W - x1, H - y1, W - x0, H - y0];

// ============================================================ TrueType subset merge
function parseTTF(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint16(4), T = {};
  for (let i = 0; i < n; i++) { const o = 12 + 16 * i; const tag = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]); const off = dv.getUint32(o + 8), len = dv.getUint32(o + 12); T[tag] = u8.subarray(off, off + len); }
  const d = (tbl) => new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength);
  const locFmt = d(T.head).getInt16(50), nG = d(T.maxp).getUint16(4), nH = d(T.hhea).getUint16(34);
  const loca = d(T.loca), off = [];
  for (let g = 0; g <= nG; g++) off.push(locFmt ? loca.getUint32(4 * g) : 2 * loca.getUint16(2 * g));
  const hm = d(T.hmtx);
  return {
    T, nG, nH,
    glyph: (g) => T.glyf.subarray(off[g], off[g + 1]),
    metric: (g) => { const i = Math.min(g, nH - 1); return [hm.getUint16(4 * i), g < nH ? hm.getInt16(4 * i + 2) : hm.getInt16(4 * nH + 2 * (g - nH))]; },
  };
}
function buildTTF(tables) {
  const tags = Object.keys(tables).sort(), n = tags.length;
  let es = 0; while ((1 << (es + 1)) <= n) es++;
  const sr = (1 << es) * 16, pad4 = (x) => (x + 3) & ~3;
  let total = 12 + 16 * n; const dir = [];
  for (const tag of tags) { dir.push({ tag, off: total, len: tables[tag].length }); total += pad4(tables[tag].length); }
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000); dv.setUint16(4, n); dv.setUint16(6, sr); dv.setUint16(8, es); dv.setUint16(10, n * 16 - sr);
  const csum = (s, l) => { let sum = 0; for (let i = 0; i < l; i += 4) sum = (sum + (((out[s + i] << 24) | (out[s + i + 1] << 16) | (out[s + i + 2] << 8) | out[s + i + 3]) >>> 0)) >>> 0; return sum; };
  dir.forEach((e, i) => { out.set(tables[e.tag], e.off); const o = 12 + 16 * i; for (let k = 0; k < 4; k++) out[o + k] = e.tag.charCodeAt(k); dv.setUint32(o + 4, csum(e.off, pad4(e.len))); dv.setUint32(o + 8, e.off); dv.setUint32(o + 12, e.len); });
  const head = dir.find((e) => e.tag === 'head').off;
  dv.setUint32(head + 8, 0); dv.setUint32(head + 8, (0xB1B0AFBA - csum(0, total)) >>> 0);
  return out;
}
/** Subsets of one font with the original glyph ids → one program holding every glyph any of them has. */
function mergeTTF(progs) {
  const P = progs.map(parseTTF).sort((a, b) => b.nG - a.nG), base = P[0], nG = base.nG;
  const glyphs = [], metrics = [];
  for (let g = 0; g < nG; g++) {
    let src = base; for (const p of P) if (g < p.nG && p.glyph(g).length) { src = p; break; }
    glyphs.push(g < src.nG ? src.glyph(g) : new Uint8Array(0)); metrics.push(g < src.nG ? src.metric(g) : [0, 0]);
  }
  let glen = 0; const offs = [];
  for (const g of glyphs) { offs.push(glen); glen += (g.length + 3) & ~3; } offs.push(glen);
  const glyf = new Uint8Array(glen); glyphs.forEach((g, i) => glyf.set(g, offs[i]));
  const loca = new Uint8Array(4 * (nG + 1)), ld = new DataView(loca.buffer); offs.forEach((o, i) => ld.setUint32(4 * i, o));
  const head = base.T.head.slice(); new DataView(head.buffer).setInt16(50, 1);
  const maxp = base.T.maxp.slice(), md = new DataView(maxp.buffer); md.setUint16(4, nG);
  for (const p of P.slice(1)) { const od = new DataView(p.T.maxp.buffer, p.T.maxp.byteOffset, p.T.maxp.byteLength); for (let o = 6; o + 2 <= Math.min(maxp.length, p.T.maxp.length); o += 2) md.setUint16(o, Math.max(md.getUint16(o), od.getUint16(o))); }
  const hhea = base.T.hhea.slice(); new DataView(hhea.buffer).setUint16(34, nG);
  const hmtx = new Uint8Array(4 * nG), hd = new DataView(hmtx.buffer); metrics.forEach(([a, l], i) => { hd.setUint16(4 * i, a); hd.setInt16(4 * i + 2, l); });
  const tables = { head, maxp, hhea, hmtx, loca, glyf };
  for (const t of ['post', 'cvt ', 'fpgm', 'prep', 'OS/2', 'name', 'cmap']) if (base.T[t]) tables[t] = base.T[t];
  return buildTTF(tables);
}

/** The merged program must hold every subset's glyphs byte for byte, every composite's parts, metrics for every glyph, and sound checksums. */
function verifyTTF(merged, progs) {
  const M = parseTTF(merged), dv = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
  for (const p of progs.map(parseTTF)) for (let g = 0; g < p.nG; g++) { const a = p.glyph(g), m = M.glyph(g); if (a.length && (m.length < a.length || Buffer.compare(Buffer.from(a), Buffer.from(m.subarray(0, a.length))) !== 0 || m.subarray(a.length).some((x) => x))) throw new Error('merged font: glyph ' + g + ' differs from its subset'); }
  for (let g = 0; g < M.nG; g++) {
    const d = M.glyph(g); if (d.length < 10) continue;
    const gd = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (gd.getInt16(0) >= 0) continue;                       // simple glyph
    let o = 10, flags; do { flags = gd.getUint16(o); const idx = gd.getUint16(o + 2); if (idx >= M.nG || !M.glyph(idx).length) throw new Error('merged font: composite ' + g + ' uses missing glyph ' + idx); o += 4 + ((flags & 1) ? 4 : 2) + ((flags & 8) ? 2 : (flags & 0x40) ? 4 : (flags & 0x80) ? 8 : 0); } while (flags & 0x20);
  }
  if (M.T.hmtx.length < 4 * M.nH || M.nH !== M.nG) throw new Error('merged font: hmtx does not cover every glyph');
  const n = dv.getUint16(4); let sum = 0;
  for (let i = 0; i < n; i++) { const o = 12 + 16 * i, off = dv.getUint32(o + 8), len = dv.getUint32(o + 12); let c = 0; for (let k = 0; k < ((len + 3) & ~3); k += 4) c = (c + (((merged[off + k] << 24) | (merged[off + k + 1] << 16) | (merged[off + k + 2] << 8) | merged[off + k + 3]) >>> 0)) >>> 0; const tag = String.fromCharCode(merged[o], merged[o + 1], merged[o + 2], merged[o + 3]); if (tag !== 'head' && c !== dv.getUint32(o + 4)) throw new Error('merged font: bad checksum for ' + tag); }
  for (let k = 0; k < merged.length; k += 4) sum = (sum + (((merged[k] << 24) | (merged[k + 1] << 16) | (merged[k + 2] << 8) | merged[k + 3]) >>> 0)) >>> 0;
  if (sum !== 0xB1B0AFBA) throw new Error('merged font: bad checkSumAdjustment');
}

// ============================================================ fonts: CMaps and widths
function parseCMap(t) {
  const map = {};
  for (const m of t.matchAll(/beginbfchar([^]*?)endbfchar/g)) for (const p of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) { let str = ''; for (let i = 0; i + 4 <= p[2].length; i += 4) str += String.fromCharCode(parseInt(p[2].slice(i, i + 4), 16)); map[parseInt(p[1], 16)] = str; }
  for (const m of t.matchAll(/beginbfrange([^]*?)endbfrange/g)) for (const p of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
    const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16);
    if (p[4]) { const b = parseInt(p[4], 16); for (let c = lo; c <= hi; c++) map[c] = String.fromCharCode(b + c - lo); }
    else { const arr = [...p[5].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]); for (let c = lo; c <= hi; c++) if (arr[c - lo]) map[c] = String.fromCharCode(parseInt(arr[c - lo].slice(0, 4), 16)); }
  }
  return map;
}
function cmapText(cid2uni) {
  const cids = Object.keys(cid2uni).map(Number).sort((a, b) => a - b);
  let s = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  for (let i = 0; i < cids.length; i += 100) {
    const chunk = cids.slice(i, i + 100);
    s += chunk.length + ' beginbfchar\n';
    for (const c of chunk) s += '<' + c.toString(16).padStart(4, '0') + '> <' + [...cid2uni[c]].map((ch) => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '>\n';
    s += 'endbfchar\n';
  }
  return s + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
}
function parseW(arr) {   // pdf-lib PDFArray → {cid: width}
  const out = {}, a = arr.asArray(); let i = 0;
  const num = (o) => o.asNumber();
  while (i < a.length) {
    const c = num(a[i]);
    if (a[i + 1] instanceof PDFArray) { a[i + 1].asArray().forEach((w, k) => { out[c + k] = num(w); }); i += 2; }
    else { const hi = num(a[i + 1]), w = num(a[i + 2]); for (let k = c; k <= hi; k++) out[k] = w; i += 3; }
  }
  return out;
}
function wArray(widths) {   // {cid: width} → the compact W form [c [w w w] c [w] ...]
  const cids = Object.keys(widths).map(Number).sort((a, b) => a - b), out = [];
  for (let i = 0; i < cids.length;) { let j = i; const ws = []; while (j < cids.length && cids[j] === cids[i] + (j - i)) ws.push(widths[cids[j++]]); out.push(cids[i], ws); i = j; }
  return out;
}

// ============================================================ load
const srcBytes = fs.readFileSync(srcPath);
const doc = await PDFDocument.load(srcBytes, { updateMetadata: false });
const ctx = doc.context;
const lookup = (ref, kind) => (kind ? ctx.lookup(ref, kind) : ctx.lookup(ref));
const decode = (stream) => latin1(decodePDFRawStream(stream).decode());
const streamOf = (ref) => { const s = lookup(ref); if (!(s instanceof PDFRawStream)) throw new Error('not a raw stream: ' + ref); return s; };
/** Replace a stream's bytes (uncompressed — the engine splices these by offset). */
function setRaw(ref, text) {
  const old = streamOf(ref), dict = old.dict, bytes = bytesOf(text);
  dict.delete(N('Filter')); dict.delete(N('DecodeParms')); dict.set(N('Length'), PDFNumber.of(bytes.length));
  ctx.assign(ref, PDFRawStream.of(dict, bytes));
}
/** Replace a stream's bytes, deflated. */
function setFlate(ref, text) {
  const old = streamOf(ref), dict = old.dict;
  const fresh = ctx.flateStream(bytesOf(text));
  for (const [k, v] of dict.entries()) if (!['Filter', 'DecodeParms', 'Length'].includes(k.decodeText())) fresh.dict.set(k, v);
  ctx.assign(ref, fresh);
}
const refKey = (ref) => ref.objectNumber + ' ' + ref.generationNumber + ' R';
const arr = (a) => a.asArray().map((x) => x.asNumber());

const pages = doc.getPages();
if (pages.length !== 2) console.warn('expected 2 pages, found ' + pages.length);

// ---- every Type0 font ----
const fontByRef = {};   // "n g R" → {ref, dict, fam, cid, desc, fileRef, tuRef, program, cid2uni, widths, dw}
for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
  if (!(obj instanceof PDFDict) || obj.get(N('Type')) !== N('Font') || obj.get(N('Subtype')) !== N('Type0')) continue;
  const base = obj.get(N('BaseFont')).decodeText(), fam = base.replace(/^[A-Z]{6}\+/, '');
  const cid = obj.lookup(N('DescendantFonts'), PDFArray).lookup(0, PDFDict);
  const desc = cid.lookup(N('FontDescriptor'), PDFDict);
  const fileRef = desc.get(N('FontFile2')), tuRef = obj.get(N('ToUnicode'));
  const W = cid.get(N('W')), dw = cid.get(N('DW'));
  fontByRef[refKey(ref)] = {
    ref, dict: obj, fam, cid, desc, fileRef, tuRef,
    program: decodePDFRawStream(streamOf(fileRef)).decode(),
    cid2uni: tuRef ? parseCMap(decode(streamOf(tuRef))) : {},
    widths: W ? parseW(ctx.lookup(W, PDFArray)) : {},
    dw: dw ? ctx.lookup(dw).asNumber() : 1000,
  };
}

// ---- pages: content, main artwork XObject, its resources ----
const P = pages.map((pg, i) => {
  const node = pg.node, size = arr(node.lookup(N('MediaBox'), PDFArray)), W = size[2] - size[0], H = size[3] - size[1];
  const contentsRef = node.get(N('Contents'));
  const xo = node.Resources().lookup(N('XObject'), PDFDict);
  let main = null;
  for (const [name, ref] of xo.entries()) {
    const s = lookup(ref); if (!(s instanceof PDFRawStream) || s.dict.get(N('Subtype')) !== N('Form')) continue;
    const t = decode(s); if (!main || t.length > main.text.length) main = { name: name.decodeText(), ref, stream: s, text: t };
  }
  const res = main.stream.dict.lookup(N('Resources'), PDFDict);
  const fonts = {}, forms = {}, images = {};
  const fd = res.lookupMaybe(N('Font'), PDFDict); if (fd) for (const [k, v] of fd.entries()) fonts['/' + k.decodeText()] = fontByRef[refKey(v)];
  const xd = res.lookupMaybe(N('XObject'), PDFDict);
  if (xd) for (const [k, v] of xd.entries()) {
    const s = lookup(v); const sub = s.dict.get(N('Subtype'));
    if (sub === N('Image')) images[k.decodeText()] = { ref: v, w: s.dict.get(N('Width')).asNumber(), h: s.dict.get(N('Height')).asNumber() };
    else if (sub === N('Form')) {
      const fr = s.dict.lookupMaybe(N('Resources'), PDFDict), ff = fr && fr.lookupMaybe(N('Font'), PDFDict), ffonts = {};
      if (ff) for (const [fk, fv] of ff.entries()) ffonts['/' + fk.decodeText()] = fontByRef[refKey(fv)];
      forms[k.decodeText()] = { ref: v, text: decode(s), bbox: arr(s.dict.lookup(N('BBox'), PDFArray)), fonts: ffonts };
    }
  }
  // upside down? every text block of the page sets `-1 0 0 -1 x y Tm`
  const tms = [...main.text.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm/g)].map((m) => m.slice(1, 5).map(Number));
  const flipped = tms.length > 0 && tms.every((t) => t[0] === -1 && t[3] === -1 && t[1] === 0 && t[2] === 0);
  const upright = tms.every((t) => t[0] === 1 && t[3] === 1 && t[1] === 0 && t[2] === 0);
  if (!flipped && !upright) throw new Error('page ' + (i + 1) + ': mixed text orientations — not handled');
  return { index: i, node, W, H, contentsRef, main, fonts, forms, images, flipped };
});

// ============================================================ 1. the flip
for (const pg of P) {
  if (!pg.flipped) continue;
  const W = pg.W * ART, H = pg.H * ART;
  // the artwork, upright
  pg.main.text = flipContent(pg.main.text, W, H);
  pg.main.stream.dict.set(N('BBox'), ctx.obj(flipBox(arr(pg.main.stream.dict.lookup(N('BBox'), PDFArray)), W, H)));
  // every form it draws (labels, markers, image wrappers) lives in the same space; images are placed by `cm`, which the flip absorbs
  for (const other of P) if (other !== pg) for (const f of Object.values(pg.forms)) if (Object.values(other.forms).some((g) => g.ref === f.ref)) throw new Error('form shared between pages: ' + f.ref);
  for (const f of Object.values(pg.forms)) {
    f.text = flipContent(f.text, W, H); f.bbox = flipBox(f.bbox, W, H);
    streamOf(f.ref).dict.set(N('BBox'), ctx.obj(f.bbox));
    f.rewritten = true;
  }
  // the page draws the upright artwork rotated back, so the print is unchanged
  const content = decode(streamOf(pg.contentsRef));
  const m = content.match(/^(q\s+0\.1 0 0 0\.1 0 0 cm[^]*?)(\/\w+ Do\s+Q\s*)$/);
  if (!m || !m[2].startsWith('/' + pg.main.name + ' ')) throw new Error('page ' + (pg.index + 1) + ': unexpected content stream: ' + JSON.stringify(content.slice(0, 120)));
  setRaw(pg.contentsRef, m[1] + 'q -1 0 0 -1 ' + fmt(W) + ' ' + fmt(H) + ' cm\n/' + pg.main.name + ' Do\nQ\nQ\n');
  console.log('page ' + (pg.index + 1) + ': drawn upside down — artwork made upright, page flips it back');
}

// ============================================================ 2. font merge
const fams = {};   // fam → {uni2cid, cid2uni, widths, chars}
{
  const byFam = {};
  for (const f of Object.values(fontByRef)) (byFam[f.fam] = byFam[f.fam] || []).push(f);
  for (const [fam, members] of Object.entries(byFam)) {
    const cid2uni = {}, widths = {};
    for (const f of members) { Object.assign(cid2uni, f.cid2uni); Object.assign(widths, f.widths); }
    for (const c of Object.keys(cid2uni)) if (widths[c] === undefined) widths[c] = members[0].dw;
    if (members.length > 1) {
      for (const f of members) for (const [c, u] of Object.entries(f.cid2uni)) if (cid2uni[c] !== u) throw new Error(fam + ': cid ' + c + ' means different characters in two subsets');
      const program = mergeTTF(members.map((f) => f.program));
      verifyTTF(program, members.map((f) => f.program));
      const fileRef = ctx.register(ctx.flateStream(program, { Length1: program.length }));
      const tuRef = ctx.register(ctx.flateStream(cmapText(cid2uni)));
      for (const f of members) {
        ctx.delete(f.fileRef); if (f.tuRef) ctx.delete(f.tuRef);
        const cs = f.desc.get(N('CIDSet')); if (cs) { ctx.delete(cs); f.desc.delete(N('CIDSet')); }
        f.desc.set(N('FontFile2'), fileRef); f.dict.set(N('ToUnicode'), tuRef);
        f.cid.set(N('W'), ctx.obj(wArray(widths)));
      }
      console.log('font ' + fam + ': ' + members.length + ' subsets merged → ' + Object.keys(cid2uni).length + ' characters, ' + program.length + ' bytes');
    }
    const uni2cid = {};
    for (const [c, u] of Object.entries(cid2uni)) if (u.length === 1 && uni2cid[u] === undefined) uni2cid[u] = +c;
    fams[fam] = { uni2cid, cid2uni, widths, chars: Object.keys(uni2cid).sort().join('') };
  }
}
const glyphW = (fam, cid) => { const w = fams[fam].widths[cid]; return w === undefined ? 500 : w; };
const runWidth = (fam, cids, size, kern) => { let w = 0; for (const c of cids) w += glyphW(fam, c); return (w / 1000) * size - Math.max(0, cids.length - 1) * ((kern || 0) / 1000) * size; };

// ============================================================ 3. read the artwork
/** Everything a stream draws that the fieldmap cares about. Text positions come out in points
    (every text block sits inside `10 0 0 10 0 0 cm`); paths and clips in artwork units. */
function readStream(text, fonts) {
  const shows = [], blocks = [], rules = [], groups = [], fills = [];
  const qs = []; let gs = { w: 1, K: '', k: '' };
  let font = null, size = 0, tm = null, lx = 0, ly = 0, adv = 0, TL = 0, block = null;
  const top = () => qs[qs.length - 1] || null;
  walk(text, (op, a, tk, start) => {
    const nums = a.filter((x) => x.t === 'num'), v = nums.map((x) => x.v);
    switch (op) {
      case 'q': { const g = { start: tk.s, end: null, depth: qs.length, parent: top(), clip: null, clipOp: null, dos: [], cm: null, path: [], pts: [], fills: 0, shows: 0 }; qs.push(g); groups.push(g); break; }
      case 'Q': { const g = qs.pop(); if (g) g.end = tk.e; break; }
      case 'w': gs = { ...gs, w: v[0] }; break;
      case 'K': gs = { ...gs, K: v.join(' ') }; break;
      case 'k': gs = { ...gs, k: v.join(' ') }; break;
      case 'cm': { const g = top(); if (g) g.cm = v; break; }
      case 're': { const g = top(); if (g) { g.lastRe = { x: v[0], y: v[1], w: v[2], h: v[3], s: start, e: tk.e }; g.pts.push([v[0], v[1]], [v[0] + v[2], v[1] + v[3]]); } break; }
      case 'W': case 'W*': { const g = top(); if (g && g.lastRe && !g.clip) { g.clip = g.lastRe; g.clipOp = op; } if (g) g.clipped = true; break; }
      case 'm': case 'l': case 'c': case 'v': case 'y': case 'h': {
        const g = top(); if (g) { g.path.push(op === 'h' ? 'h' : v.map(fmt).join(' ') + ' ' + op); for (let i = 0; i + 1 < v.length; i += 2) g.pts.push([v[i], v[i + 1]]); }
        if (op === 'm') gs = { ...gs, segStart: [v[0], v[1]] };
        if (op === 'l') gs = { ...gs, segEnd: [v[0], v[1]] };
        break;
      }
      case 'S': if (gs.segStart && gs.segEnd) rules.push({ x0: gs.segStart[0], y0: gs.segStart[1], x1: gs.segEnd[0], y1: gs.segEnd[1], w: gs.w, K: gs.K, start }); gs = { ...gs, segStart: null, segEnd: null }; break;
      case 'f': case 'f*': { const g = top(); if (g) g.fills++; fills.push({ group: g, k: gs.k }); break; }
      case 'Do': { const g = top(); const name = a[0].v.slice(1); if (g) g.dos.push({ name, start, end: tk.e }); break; }
      case 'BT': lx = ly = adv = 0; tm = null; block = null; break;
      case 'ET': block = null; break;
      case 'Tf': font = a[0].v; size = v[0]; break;
      case 'Tm': tm = v; lx = ly = adv = 0; block = { tm_span: [nums[0].s, nums[5].e], tm: v, start: tk.s }; blocks.push(block); break;
      case 'Td': lx += v[0]; ly += v[1]; adv = 0; break;
      case 'TD': lx += v[0]; ly += v[1]; adv = 0; TL = -v[1]; break;
      case 'TL': TL = v[0]; break;
      case 'T*': ly -= TL; adv = 0; break;
      case 'Tj': case 'TJ': {
        if (!tm) throw new Error('text shown before Tm at ' + start);
        if (tm[0] !== 1 || tm[1] !== 0 || tm[2] !== 0 || tm[3] !== 1) throw new Error('rotated/scaled Tm at ' + start + ': ' + tm.join(' '));
        const F = fonts[font]; if (!F) throw new Error('unknown font ' + font + ' at ' + start);
        const parts = op === 'Tj' ? [a[0]] : a.filter((x) => x.t === 'str' || x.t === 'num');
        const cids = [], kerns = []; let txt = '';
        for (const p of parts) {
          if (p.t === 'num') { kerns.push(p.v); continue; }
          for (let i = 0; i + 1 < p.v.length; i += 2) { const c = (p.v.charCodeAt(i) << 8) | p.v.charCodeAt(i + 1); cids.push(c); const u = fams[F.fam].cid2uni[c]; txt += u === undefined ? '�' : u; }
        }
        const small = kerns.filter((k) => Math.abs(k) < 50), kern = small.length ? r4(small.reduce((s, k) => s + k, 0) / small.length) : 0;
        const x = tm[4] + lx + adv, y = tm[5] + ly;
        const g = top(); if (g) g.shows++;
        shows.push({ span: [start, tk.e], text: txt, cids, kern, font, fam: F.fam, size, x: r4(x), y: r4(y), block, width: r4(runWidth(F.fam, cids, size, kern)) });
        let w = 0; for (const c of cids) w += glyphW(F.fam, c) / 1000 * size; for (const k of kerns) w -= k / 1000 * size; adv += w;
        break;
      }
      case 'd0': case 'd1': case 'sh': case 'BI': case "'": case '"': throw new Error('unsupported operator ' + op + ' at ' + start);
      default: break;
    }
  });
  if (qs.length) throw new Error('unbalanced q/Q');
  return { shows, blocks, rules, groups, fills };
}

// ---- per page ----
const FAM = { name: 'GTAmericaTrial-CmBd', desc: 'TestSohne-Buch', head: 'TGGasolineRegular', nb: 'NotoSans-Bold' };
const fields = [], sections = [], columns = [], floors = [], streams = {}, res_to_family = {};
const icons = {}, dyS = { dairy: [], gluten: [], jain: [] }, gapS = [];
let brand_k = null, colN = 0;

for (const pg of P) {
  const p = pg.index, sid = 'p' + p;
  streams[sid] = { page: p, ref: refKey(pg.main.ref), kind: 'main' };
  for (const [name, f] of Object.entries(pg.fonts)) res_to_family[p + name] = f.fam;
  for (const f of Object.values(pg.forms)) for (const [name, ff] of Object.entries(f.fonts)) res_to_family[p + name] = ff.fam;
  const A = readStream(pg.main.text, pg.fonts);
  const byName = {};
  for (const [name, f] of Object.entries(pg.forms)) { f.read = readStream(f.text, f.fonts); byName[name] = f; }

  // ---- headings + their rules → sections; the wide dividers → floors ----
  const heads = A.shows.filter((s) => s.fam === FAM.head && s.text.trim());
  const rules = A.rules.map((r) => ({ x0: Math.min(r.x0, r.x1) / ART, x1: Math.max(r.x0, r.x1) / ART, y: (r.y0 + r.y1) / 2 / ART, w: r.w, K: r.K })).filter((r) => Math.abs(r.x1 - r.x0) > 20);
  for (const r of rules) if (r.x0 < 10 && r.x1 > pg.W - 10) floors.push({ page: p, y: r2(r.y), x0: r2(r.x0), x1: r2(r.x1), what: 'rule' });
  const pageSections = [];
  for (const h of heads) {
    const mine = rules.filter((r) => r.y < h.y - 2 && r.y > h.y - 18 && r.x0 >= h.x - 10 && !heads.some((o) => o !== h && o.x > h.x && o.x - 10 <= r.x0 && Math.abs(o.y - h.y) < 6));
    if (!mine.length) continue;
    const spans = mine.sort((a, b) => a.x0 - b.x0).map((r) => [r2(r.x0), r2(r.x1)]);
    const sec = { label: h.text.trim().toUpperCase(), page: p, x: r2(h.x), y: r2(h.y), spans, x0: spans[0][0], x1: spans[spans.length - 1][1], rule_w: mine[0].w, rule_K: mine[0].K };
    pageSections.push(sec); sections.push(sec);
  }
  // the red: the stroke colour of the section rules (the headings are filled in the same ink)
  if (!brand_k && pageSections.length && pageSections[0].rule_K) brand_k = pageSections[0].rule_K + ' k';
  // artwork bands wider than half the page (the tiger, the logo) stop a column too
  const clipBox = (g) => { for (let k = g; k; k = k.parent) { if (k.clip) return { x0: k.clip.x, y0: k.clip.y, x1: k.clip.x + k.clip.w, y1: k.clip.y + k.clip.h }; if (k.clipped && k.pts.length) return { x0: Math.min(...k.pts.map((q) => q[0])), y0: Math.min(...k.pts.map((q) => q[1])), x1: Math.max(...k.pts.map((q) => q[0])), y1: Math.max(...k.pts.map((q) => q[1])) }; } return null; };
  for (const g of A.groups) for (const d of g.dos) { const b = clipBox(g); if (b && (b.x1 - b.x0) / ART > pg.W / 2 && (b.y1 - b.y0) / ART > 60 && !floors.some((f) => f.page === p && Math.abs(f.y - b.y1 / ART) < 1)) floors.push({ page: p, y: r2(b.y1 / ART), x0: r2(b.x0 / ART), x1: r2(b.x1 / ART), what: 'artwork' }); }

  // ---- names: display-face runs on one baseline, merged (the designer splits "Tawa Paratha" into three) ----
  const isCaption = (s) => s.block && A.shows.some((o) => o.block === s.block && o.fam === FAM.nb);   // "(Serves 2)"
  const nameShows = A.shows.filter((s) => s.fam === FAM.name && (Math.abs(s.size - 14) < 0.01 || Math.abs(s.size - 13.0774) < 0.01) && !/^[\d\s]*$/.test(s.text) && !isCaption(s));
  const blankNear = A.shows.filter((s) => (s.fam === FAM.name || s.fam === 'GTAmericaTrial-CmRg') && !s.text.trim() && Math.abs(s.size - 14) < 1.5);
  const names = [];
  for (const s of nameShows.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const prev = names[names.length - 1];
    if (prev && Math.abs(prev.y - s.y) < 0.6 && s.x > prev.x && s.x <= prev.right + prev.size * 1.2) {
      // the blanks between the two parts belong to the name as well
      for (const b of blankNear) if (Math.abs(b.y - s.y) < 0.6 && b.x >= prev.right - 0.5 && b.x < s.x && !prev.parts.includes(b)) prev.parts.push(b);
      prev.parts.push(s); prev.right = r4(s.x + s.width); continue;
    }
    names.push({ parts: [s], x: s.x, y: s.y, size: s.size, font: s.font, right: r4(s.x + s.width) });
  }
  for (const n of names) {
    n.parts.sort((a, b) => a.x - b.x);
    n.display = n.parts.map((q) => q.text).join('').replace(/\s+/g, ' ').trim();
    n.kern = r4(n.parts.filter((q) => q.text.trim()).reduce((s, q) => s + q.kern, 0) / n.parts.filter((q) => q.text.trim()).length);
    n.sec = pageSections.filter((S) => S.y > n.y && S.x0 - 6 <= n.x && n.x <= S.x1).sort((a, b) => a.y - b.y)[0] || null;
    if (!n.sec) console.warn('page ' + (p + 1) + ': "' + n.display + '" is under no section heading — skipped');
  }
  const dishes = names.filter((n) => n.sec);

  // ---- prices: digits in the display face, on a dish's baseline, to its right ----
  for (const s of A.shows.filter((q) => q.fam === FAM.name && /^\d+$/.test(q.text) && Math.abs(q.size - 14) < 1.5 && !isCaption(q))) {
    const d = dishes.filter((n) => Math.abs(n.y - s.y) <= 5 && n.x < s.x && !n.price).sort((a, b) => b.x - a.x)[0];
    if (d) d.price = s; else console.warn('page ' + (p + 1) + ': price ' + s.text + ' at ' + s.x + ',' + s.y + ' belongs to no dish');
  }
  // ---- descriptions: body-face lines under a dish, in its column ----
  const descShows = A.shows.filter((q) => (q.fam === FAM.desc || q.fam === 'NotoSans-Regular' || q.fam === FAM.nb) && Math.abs(q.size - 9.00339) < 0.01 && !isCaption(q)).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const s of descShows) {
    const L = lines.find((l) => Math.abs(l.y - s.y) < 0.6 && s.x > l.ops[l.ops.length - 1].x && s.x - l.right < 30 && s.x - l.right > -8);
    if (L) { L.ops.push(s); L.right = r4(s.x + s.width); continue; }
    lines.push({ y: s.y, x: s.x, ops: [s], right: r4(s.x + s.width) });
  }
  for (const L of lines) {
    L.text = L.ops.map((o) => o.text).join('').replace(/\s+/g, ' ').replace(/^ /, '');
    if (!L.text.trim()) continue;
    const d = dishes.filter((n) => Math.abs(n.x - L.x) <= 6 && n.y > L.y && n.y - L.y < 60).sort((a, b) => a.y - b.y)[0];
    if (!d) { console.warn('page ' + (p + 1) + ': text line "' + L.text.slice(0, 40) + '" at ' + L.x + ',' + L.y + ' is under no dish — left alone'); continue; }
    (d.lines = d.lines || []).push(L);
  }
  // ---- gm/ml labels: label XObjects drawn in a clip group ----
  const labelGroups = [], markerGroups = [];
  for (const g of A.groups) {
    for (const d of g.dos) {
      const f = byName[d.name], im = pg.images[d.name];
      let cg = g; while (cg && !cg.clip) cg = cg.parent;      // the group whose clip boxes it
      if (!cg) continue;
      if (f && f.read.shows.length && !f.read.fills.length) labelGroups.push({ name: d.name, form: f, group: cg, do: d });
      else if (f && f.read.fills.length && f.read.shows.length === 0 && cg.clip.w / ART < 8 && cg.clip.h / ART < 12) markerGroups.push({ name: d.name, form: f, group: cg, kind: 'vector' });
      else if (im && cg.clip.w / ART < 8 && cg.clip.h / ART < 12) markerGroups.push({ name: d.name, image: im, group: cg, cm: g.cm, kind: 'image' });
    }
  }
  for (const lg of labelGroups) {
    const f = lg.form, sh = f.read.shows, bbox = f.bbox.map((v) => r2(v / ART));
    const first = sh[0];
    if (!sh.every((s) => s.fam === FAM.name && Math.abs(s.size - 8.00304) < 0.01)) continue;   // DAIRY / GLUTEN / *Prices… legends
    const d = dishes.filter((n) => n.y >= bbox[1] - 3.5 && n.y <= bbox[1] + 6 && n.x < bbox[0] && bbox[0] - n.x < 300 && !n.gram).sort((a, b) => b.x - a.x)[0];
    if (!d) { console.warn('page ' + (p + 1) + ': label "' + sh.map((s) => s.text).join('') + '" belongs to no dish'); continue; }
    const key = 'x' + f.ref.objectNumber;
    streams[key] = { page: p, ref: refKey(f.ref), kind: 'label' };
    d.gram = { stream: key, x: first.x, y: first.y, size: first.size, font: first.font, kern: 0, ops: sh.map((s) => ({ span: s.span, text: s.text })), display: sh.map((s) => s.text).join('').replace(/\s+/g, ' ').trim(), bbox, do_span: [lg.group.start, lg.group.end] };
  }
  // ---- allergen markers ----
  for (const mg of markerGroups) {
    const c = mg.group.clip, box = { x: r2(c.x / ART), y: r2(c.y / ART), w: r2(c.w / ART), h: r2(c.h / ART) };
    let type, span = [mg.group.start, mg.group.end], originY;
    if (mg.kind === 'image') {
      type = 'gluten'; originY = mg.cm ? mg.cm[5] / ART : box.y;
      // Canva precedes the image with an empty copy of its clip group: take it along
      const before = pg.main.text.slice(0, mg.group.start), m = before.match(/q\s+([-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+) re W\*? n\s+Q\s*$/);
      if (m) span = [mg.group.start - m[0].length, mg.group.end];
    } else {
      const ops = mg.form.read.groups.flatMap((g) => g.path), nPath = ops.filter((o) => o !== 'h').length;
      type = nPath > 45 ? 'dairy' : 'jain';
      // the icon's own outline: bbox of the path points, not the clip rect
      const pp = []; for (const g of mg.form.read.groups) for (const o of g.path) if (o !== 'h') { const nums = o.split(' ').slice(0, -1).map(Number); for (let i = 0; i + 1 < nums.length; i += 2) pp.push([nums[i], nums[i + 1]]); }
      const minx = Math.min(...pp.map((q) => q[0])), miny = Math.min(...pp.map((q) => q[1])), maxx = Math.max(...pp.map((q) => q[0])), maxy = Math.max(...pp.map((q) => q[1]));
      originY = miny / ART;
      if (!icons[type]) icons[type] = { body: ops.map((o) => o === 'h' ? 'h' : o.split(' ').map((t, i, a) => i === a.length - 1 ? t : r2(+t - (i % 2 === 0 ? minx : miny)).toString()).join(' ')).join('\n'), w: r2(maxx - minx), h: r2(maxy - miny), source: 'vector' };
    }
    const d = dishes.filter((n) => n.y >= box.y - 3.5 && n.y <= box.y + 6 && n.x < box.x && box.x - n.x < 300).sort((a, b) => b.x - a.x)[0];
    if (!d) continue;   // the legend at the foot of the page
    (d.boxes = d.boxes || []).push({ type, x: box.x, y: box.y, w: box.w, h: box.h, span });
    dyS[type].push(r2(originY - d.y));
  }
  for (const d of dishes) if (d.boxes) { d.boxes.sort((a, b) => a.x - b.x); for (let i = 1; i < d.boxes.length; i++) gapS.push(r2(d.boxes[i].x - (d.boxes[i - 1].x + d.boxes[i - 1].w))); }

  // ---- columns: dishes of a section clustered by x ----
  const secOrder = pageSections.slice().sort((a, b) => (Math.abs(a.y - b.y) < 6 ? a.x - b.x : b.y - a.y));   // reading order: rows of headings, left to right
  const pageCols = [];
  for (const S of secOrder) {
    const mine = dishes.filter((d) => d.sec === S).sort((a, b) => a.x - b.x);
    const cls = [];
    for (const d of mine) { const c = cls.find((k) => Math.abs(k.x - d.x) <= 8); if (c) c.dishes.push(d); else cls.push({ x: d.x, dishes: [d] }); }
    for (const c of cls.sort((a, b) => a.x - b.x)) { c.dishes.sort((a, b) => b.y - a.y); c.x = r4(median(c.dishes.map((d) => d.x))); c.sec = S; c.id = 'c' + colN++; pageCols.push(c); }
  }
  for (const c of pageCols) {
    const top = c.dishes[0].y + 20, bot = Math.min(...c.dishes.map((d) => d.lines ? d.lines[d.lines.length - 1].y - 4 : d.y - 5));
    const next = pageCols.filter((o) => o !== c && o.x > c.x + 20 && o.dishes[0].y + 20 > bot && Math.min(...o.dishes.map((d) => d.y - 5)) < top).sort((a, b) => a.x - b.x)[0];
    let width = next ? next.x - c.x - 10 : c.sec.x1 - c.x;
    const span = c.sec.spans.find((s) => s[0] - 6 <= c.x && c.x <= s[1]); if (span) width = Math.min(width, span[1] - c.x);
    const slots = []; for (let i = 0; i + 1 < c.dishes.length; i++) slots.push(c.dishes[i].y - c.dishes[i + 1].y);
    c.pitch = r2(slots.length ? slots.reduce((a, b) => a + b, 0) / slots.length : 46);
    c.dishes.forEach((d, i) => { d.slot = r2(i + 1 < c.dishes.length ? d.y - c.dishes[i + 1].y : c.pitch); d.col = c.id; });
    c.bottom = r2(bot); c.width = r2(width);
  }
  // ---- fields, in column order ----
  let k = 0;
  for (const c of pageCols) {
    const ids = [];
    for (const d of c.dishes) {
      const id = p + ':' + k; ids.push(id);
      const blocksOf = (parts) => { const seen = []; for (const q of parts) if (q.block && !seen.includes(q.block)) seen.push(q.block); return seen.map((b) => ({ tm_span: b.tm_span, tm: b.tm })); };
      const name = { role: 'name', id, page: p, stream: sid, font: d.font, x: r2(d.x), y: r2(d.y), size: r4(d.size), display: d.display, ops: d.parts.map((q) => ({ span: q.span, text: q.text, font: q.font })), kern: d.kern, right: r2(d.right), blocks: blocksOf(d.parts), markers: [], section: c.sec.label, col: c.id, slot: d.slot };
      // the blanks that lead or trail the name are not its text — keep them out of ops
      while (name.ops.length > 1 && !name.ops[0].text.trim()) name.ops.shift();
      while (name.ops.length > 1 && !name.ops[name.ops.length - 1].text.trim()) name.ops.pop();
      if (d.boxes) { name.markers = d.boxes.map((b) => b.type); name.marker_boxes = d.boxes; }
      const to = Math.max(d.right + 1, ...(d.boxes || []).map((b) => b.x + b.w), d.gram ? d.gram.bbox[2] : 0);
      name.marker_geom = { from: r2(d.right + 1), to: r2(to), base_y: r2(d.y) };
      fields.push(name);
      if (d.lines) {
        const L = d.lines.sort((a, b) => b.y - a.y);
        const pitches = []; for (let i = 0; i + 1 < L.length; i++) pitches.push(L[i].y - L[i + 1].y);
        const fontCount = {}; for (const l of L) for (const o of l.ops) fontCount[o.font] = (fontCount[o.font] || 0) + o.text.length;
        const mainFont = Object.keys(fontCount).sort((a, b) => fontCount[b] - fontCount[a])[0];
        const kerns = L.flatMap((l) => l.ops.filter((o) => o.fam === FAM.desc && o.text.trim().length > 2).map((o) => o.kern));
        fields.push({ role: 'desc', id: p + ':' + (k + 1), page: p, stream: sid, of: id, x: r2(L[0].x), y: r2(L[0].y), size: r4(L[0].ops[0].size), font: mainFont, pitch: r2(pitches.length ? median(pitches) : (c.descPitch || 10.5)),
          lines: L.map((l) => ({ y: r2(l.y), x: r2(l.x), ops: l.ops.map((o) => ({ span: o.span, text: o.text, font: o.font, x: r2(o.x) })), text: l.text })),
          display: L.map((l) => l.text.trim()).join(' '), kern: r4(kerns.length ? median(kerns) : 2), blocks: blocksOf(L.flatMap((l) => l.ops)) });
        if (pitches.length) c.descPitch = r2(median(pitches));
      }
      if (d.price) fields.push({ role: 'price', id: p + ':' + (k + 2), page: p, stream: sid, of: id, x: r2(d.price.x), y: r2(d.price.y), size: r4(d.price.size), font: d.price.font, ops: [{ span: d.price.span, text: d.price.text }], display: d.price.text, kern: d.price.kern, blocks: blocksOf([d.price]) });
      if (d.gram) fields.push({ role: 'gram', id: p + ':' + (k + 3), stream: d.gram.stream, of: id, page: p, x: r2(d.gram.x), y: r2(d.gram.y), size: r4(d.gram.size), font: d.gram.font, ops: d.gram.ops, display: d.gram.display, bbox: d.gram.bbox, do_span: d.gram.do_span });
      k += 4;
    }
    columns.push({ id: c.id, page: p, section: c.sec.label, x: r2(c.x), ids, pitch: c.pitch, bottom: c.bottom, width: c.width });
  }
  console.log('page ' + (p + 1) + ': ' + pageSections.map((S) => S.label).join(', ') + ' — ' + dishes.length + ' dishes in ' + pageCols.length + ' columns' + (pg.flipped ? ' (upright coordinates)' : ''));
}
for (const S of sections) { delete S.rule_w; delete S.rule_K; }
icons.gluten = { body: GLUTEN.body, w: GLUTEN.w, h: GLUTEN.h, source: GLUTEN.source || 'traced' };
if (!icons.dairy || !icons.jain) throw new Error('could not find the dairy/jain icons in the artwork');
const marker_dy = { dairy: r2(median(dyS.dairy)), gluten: r2(median(dyS.gluten)), jain: r2(median(dyS.jain)) };
const marker_gap = r2(median(gapS)) || 2.4;

const nameChars = fams[FAM.name].chars, descChars = fams[FAM.desc].chars;
const fieldmap = {
  brand: 'beshak', built: new Date().toISOString().slice(0, 10), source: path.basename(srcPath),
  page_sizes: P.map((pg) => [r2(pg.W), r2(pg.H)]), page_flip: P.map((pg) => !!pg.flipped),
  streams, families: Object.fromEntries(Object.entries(fams).map(([f, v]) => [f, { uni2cid: v.uni2cid, widths: v.widths, chars: v.chars }])), res_to_family,
  allowed: { name: nameChars, desc: descChars, price: nameChars.replace(/[^0-9]/g, ''), gram: nameChars },
  icons, marker_order: ['dairy', 'gluten', 'jain'], marker_dy, marker_gap, brand_k: brand_k || '0.004 0.843 0.851 0.118 k',
  sections, floors, columns, adv: { name: 0.43, desc: 0.57, price: 0.43, gram: 0.43 }, fields,
};

// ============================================================ 4. write the streams and the files
for (const pg of P) {
  setRaw(pg.main.ref, pg.main.text);
  for (const f of Object.values(pg.forms)) {
    const key = 'x' + f.ref.objectNumber;
    if (streams[key]) setRaw(f.ref, f.text); else if (f.rewritten) setFlate(f.ref, f.text);
  }
}
fs.mkdirSync(outDir, { recursive: true });
const pdfBytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
fs.writeFileSync(path.join(outDir, 'beshak.pdf'), pdfBytes);
fs.writeFileSync(path.join(outDir, 'fieldmap.json'), JSON.stringify(fieldmap));
fs.writeFileSync(path.join(outDir, 'start-state.json'), JSON.stringify({ editor: 'beshak', base: 'v' + pdfBytes.length, state: { edits: {}, removed: [], added: [], markerEdits: {} } }, null, 2) + '\n');
console.log('wrote ' + outDir + '/beshak.pdf (' + pdfBytes.length + ' bytes), fieldmap.json (' + fields.length + ' fields), start-state.json (base v' + pdfBytes.length + ')');

// ============================================================ 5. verify against the saved file
{
  const check = await PDFDocument.load(pdfBytes);
  const texts = {};
  for (const [sid, info] of Object.entries(streams)) {
    const [n, g] = info.ref.split(' ').map(Number);
    const s = check.context.lookup(PDFRef.of(n, g));
    if (!(s instanceof PDFRawStream) || s.dict.get(N('Filter'))) throw new Error('stream ' + sid + ' is not stored raw');
    texts[sid] = latin1(s.contents);
  }
  const decodeOp = (fam, raw) => { const m = raw.match(/\(((?:\\.|[^\\)])*)\)/g) || []; let out = ''; for (const part of m) { const v = tokenize(part)[0].v; for (let i = 0; i + 1 < v.length; i += 2) out += fams[fam].cid2uni[(v.charCodeAt(i) << 8) | v.charCodeAt(i + 1)] || '?'; } return out; };
  let bad = 0;
  for (const f of fields) {
    const ops = f.role === 'desc' ? f.lines.flatMap((l) => l.ops) : f.ops;
    for (const o of ops) { const raw = texts[f.stream].slice(o.span[0], o.span[1]); const fam = res_to_family[f.page + (o.font || f.font)]; if (!/T[jJ]$/.test(raw) || decodeOp(fam, raw) !== o.text) { bad++; console.error('span mismatch ' + f.id + ' ' + f.role + ': ' + JSON.stringify(raw.slice(0, 60)) + ' ≠ ' + JSON.stringify(o.text)); } }
    for (const b of f.blocks || []) { const raw = texts[f.stream].slice(b.tm_span[0], b.tm_span[1]); if (raw.trim().split(/\s+/).length !== 6 || !texts[f.stream].slice(b.tm_span[1], b.tm_span[1] + 4).includes('Tm')) { bad++; console.error('tm span mismatch ' + f.id + ': ' + JSON.stringify(raw)); } }
    if (f.do_span) { const raw = texts[f.page != null ? 'p' + f.page : 'p0'].slice(f.do_span[0], f.do_span[1]); if (!/^q[^]*Do[^]*Q$/.test(raw)) { bad++; console.error('do span mismatch ' + f.id + ': ' + JSON.stringify(raw)); } }
    for (const m of f.marker_boxes || []) { const raw = texts[f.stream].slice(m.span[0], m.span[1]); if (!/^q[^]*Q$/.test(raw)) { bad++; console.error('marker span mismatch ' + f.id + ' ' + m.type + ': ' + JSON.stringify(raw.slice(0, 50)) + '…' + JSON.stringify(raw.slice(-20))); } }
  }
  console.log(bad ? 'VERIFY FAILED: ' + bad + ' bad spans' : 'verified: every span decodes to its text');
  if (bad) process.exit(1);
}
