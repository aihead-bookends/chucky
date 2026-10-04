/* FullFonts — swap a menu PDF's SUBSET fonts for the full typefaces, so an edit can use any letter.

   The designer PDFs embed only the glyphs their artwork used (Illustrator subsets): Capiche's name
   face, AOMonoBlack, has no Z, Q or digits, so TRUFFLE PIZZA could not be printed. The full .otf
   files live in /assets/fonts/. They are CFF-flavoured OpenType, and a PDF's Type1C font program IS
   a bare CFF table, so the swap is: lift the `CFF ` table out of the .otf, point the font's
   /FontDescriptor /FontFile3 at it, and widen /Widths to cover every WinAnsi code the font has.

   It runs on the LOADED document (pdf-lib), never on the base file, so the base PDF's bytes, its
   size (the version key published menus are checked against) and every fieldmap offset stay as
   they are. The content streams don't change either: the fonts keep their /WinAnsiEncoding, so the
   bytes an edit writes for "Z" now find a Z outline instead of nothing.

   FullFonts.embed(doc, { AOMonoBlack: '/assets/fonts/Aomono-Black.otf', … })
     -> { AOMonoBlack: 'ABC…', … }   the printable ASCII each face now holds (for the editor's
                                      character gate). Faces that failed to load are left out, and
                                      their subset stays in place. */
(function(){
  // WinAnsiEncoding codes 128-159 -> Unicode (0 = unused); 32-127 and 160-255 are Latin-1 as-is
  const WIN_HI = [0x20AC,0,0x201A,0x0192,0x201E,0x2026,0x2020,0x2021,0x02C6,0x2030,0x0160,0x2039,0x0152,0,0x017D,0,
                  0,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,0x02DC,0x2122,0x0161,0x203A,0x0153,0,0x017E,0x0178];
  const winUni = c => (c >= 128 && c < 160) ? WIN_HI[c-128] : c;

  function parseOtf(buf){
    const b = new DataView(buf), u8 = new Uint8Array(buf);
    const tag = o => String.fromCharCode(u8[o],u8[o+1],u8[o+2],u8[o+3]);
    if(tag(0) !== 'OTTO') throw new Error('not a CFF OpenType font');
    const t = {};
    for(let i=0, n=b.getUint16(4); i<n; i++){ const o=12+16*i; t[tag(o)] = { off:b.getUint32(o+8), len:b.getUint32(o+12) }; }
    for(const k of ['CFF ','cmap','hmtx','hhea','head']) if(!t[k]) throw new Error('font has no '+k+' table');
    const upm = b.getUint16(t.head.off+18), nH = b.getUint16(t.hhea.off+34);
    const adv = g => b.getUint16(t.hmtx.off + 4*Math.min(g, nH-1));
    // Unicode -> glyph id, from the first format-4 (BMP) subtable
    const cmap = new Map(), c = t.cmap.off;
    for(let i=0, n=b.getUint16(c+2); i<n; i++){
      const s = c + b.getUint32(c+8+8*i);
      if(b.getUint16(s) !== 4) continue;
      const segs = b.getUint16(s+6)/2, ends = s+14, starts = ends+2*segs+2, deltas = starts+2*segs, ranges = deltas+2*segs;
      for(let k=0; k<segs; k++){
        const end=b.getUint16(ends+2*k), start=b.getUint16(starts+2*k), delta=b.getInt16(deltas+2*k), ro=b.getUint16(ranges+2*k);
        for(let cp=start; cp<=end && cp!==0xFFFF; cp++){
          let g;
          if(!ro) g = (cp+delta) & 0xFFFF;
          else { const at = ranges+2*k+ro+2*(cp-start); g = b.getUint16(at); if(g) g = (g+delta) & 0xFFFF; }
          if(g) cmap.set(cp, g);
        }
      }
      break;
    }
    return { cff: u8.slice(t['CFF '].off, t['CFF '].off + t['CFF '].len), cmap, width: g => Math.round(adv(g)*1000/upm) };
  }

  async function embed(doc, faces){
    const { PDFName, PDFNumber, PDFDict, PDFRawStream } = PDFLib;
    const loaded = {};
    await Promise.all(Object.keys(faces).map(async name => {
      try{
        const r = await fetch(faces[name]); if(!r.ok) throw new Error('HTTP '+r.status);
        loaded[name] = parseOtf(await r.arrayBuffer());
      }catch(e){ console.warn('FullFonts: kept the subset of', name, '-', e.message||e); }
    }));
    const out = {};
    for(const [, obj] of doc.context.enumerateIndirectObjects()){
      if(!(obj instanceof PDFDict)) continue;
      if(String(obj.get(PDFName.of('Type'))) !== '/Font' || String(obj.get(PDFName.of('Subtype'))) !== '/Type1') continue;
      if(String(obj.get(PDFName.of('Encoding'))) !== '/WinAnsiEncoding') continue;   // codes must mean WinAnsi for the widths below
      const base = String(obj.get(PDFName.of('BaseFont'))||'').replace(/^\/([A-Z]{6}\+)?/, '');
      const f = loaded[base]; if(!f) continue;
      const fd = doc.context.lookup(obj.get(PDFName.of('FontDescriptor')), PDFDict);
      const sd = doc.context.obj({ Subtype: 'Type1C', Length: f.cff.length });
      fd.set(PDFName.of('FontFile3'), doc.context.register(PDFRawStream.of(sd, f.cff)));
      fd.delete(PDFName.of('CharSet'));   // listed the subset's glyphs; now wrong, and optional
      const widths = [];
      let chars = '';
      for(let code=32; code<=255; code++){
        const g = f.cmap.get(winUni(code));
        widths.push(g ? f.width(g) : 0);
        if(g && code < 127) chars += String.fromCharCode(code);   // editors write UTF-8, so only ASCII is a single byte
      }
      obj.set(PDFName.of('FirstChar'), PDFNumber.of(32));
      obj.set(PDFName.of('LastChar'), PDFNumber.of(255));
      obj.set(PDFName.of('Widths'), doc.context.obj(widths));
      out[base] = chars;
    }
    return out;
  }

  window.FullFonts = { embed, parseOtf };
})();
