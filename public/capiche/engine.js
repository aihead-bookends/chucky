/* Capiche — the menu engine: byte-level edits to capiche.pdf, driven by fieldmap.json.
   Ported verbatim from the original Chucky editor (deploy/public/capiche/index.html); every change
   is marked "chucky-2". It runs inside the shell that assets/js/editor.js renders, and relies on
   pdf-lib (PDFLib) and pdf.js (pdfjsLib) loaded by index.html. */
const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let FM, BASE, CULINARY, ALLOWED, ADV, PAGES, FIELD={}, ICONS, SECTIONS, AC;
let BASE_LIST=[], CULINARY_LIST=[];
const IGNORED = new Set(), MENU = new Set();
const edits = {};
let removed = new Set();
let added = [];   // [{sec, name, desc, price, allergens:[], _id}]
let markerEdits = {};   // dishId -> [marker types] override (dairy/gluten/jain/spicy/new)
let persona = { occasion:'', guest:'' };   // personalised cover (occasion + guest name)
// personalise-cover config for THIS menu. `del` = spans to hide when active (none for Capiche —
// there's an empty gap under the logo). Coords are PDF points on the cover page.
const COVER = { page:0, cx:113, adv:0.63, del:[],   // soft coral, centred on the Capiche logo/tagline block (x~113)
  // Black, matching the motto block beneath it. Was a soft coral (0.95 0.62 0.57 rg) which printed
  // noticeably paler than the wordmark and read as a different, washed-out element on the cover.
  // `0 g` is the same ink this menu declares in add_const.ink_color, so it matches the motto exactly.
  occ:{ y:472, size:13,   font:'/T1_2', color:'0 g' },                 // AOMonoBold
  guest:{ y:454, size:11.5, font:'/T1_2', color:'0 g' } };
function personaLine(spec, text){
  const t=(text||'').toUpperCase(); if(!t) return '';
  const w=t.length*COVER.adv*spec.size;
  const x = spec.align==='right' ? (spec.right - w) : ((spec.cx!=null?spec.cx:COVER.cx) - w/2);
  return '\nq BT '+spec.color+' '+spec.font+' 1 Tf '+spec.size+' 0 0 '+spec.size+' '+x.toFixed(2)+' '+spec.y+' Tm ('+escPdf(t)+')Tj ET Q';
}
// {del:[spans to remove], add:'stamp'} for a given page when personalise is active
function personaCover(p){
  if(p!==COVER.page || (!persona.occasion && !persona.guest)) return { del:[], add:'' };
  return { del:(COVER.del||[]).slice(), add: personaLine(COVER.occ, persona.occasion)+personaLine(COVER.guest, persona.guest) };
}
// Korea is an AIKO marker and was never part of this menu: zero Capiche dishes carry it baked
// (dairy 37, gluten 35, jain 20, spicy 5, new 8). The printed legend is Dairy / Gluten /
// Jain possible / Chilli / Ghaslet hot sauce.
// Fixed print order: Dairy -> Gluten -> Jain -> Spicy -> Chilli -> NEW. The row flows in THIS order
// (see stampMarkers), so the array is the single source of truth for sequence.
const MARKER_TYPES=['dairy','gluten','jain','spicy','chilli','new'];
// `spicy` IS the Ghaslet flame — verified by render (AFFAIR shows bottle · wheat · red flame), so it
// keeps that label and takes the flame glyph; the pepper belongs to the separate CHILLI marker.
const MARKER_LABEL={dairy:'Dairy',gluten:'Gluten',jain:'Jain',chilli:'Chilli',spicy:'Ghaslet',korea:'Korea',new:'NEW'};
const MARKER_ICON={dairy:'🥛',gluten:'🌾',jain:'Ⓙ',chilli:'🌶️',spicy:'🔥',korea:'🇰🇷',new:'★'};
function dishMarkers(id){ return (id in markerEdits) ? new Set(markerEdits[id]) : new Set((FIELD[id]&&FIELD[id].markers)||[]); }
let addSeq = 0;          // field id -> new text
let doc, pageStreams=[], pdfBytesOrig;
let activePage = 0, lastBytes=null, pdfjsDoc=null, renderToken=0;

const enc = s => new TextEncoder().encode(s);
const escPdf = s => normTypo(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
const fmtNum = n => { let s=(+n).toFixed(4); return s.replace(/0+$/,'').replace(/\.$/,''); };
const normTypo = s => (s||'')
  .replace(/[\u2018\u2019\u201A\u201B\u2032\u02B9\u02BC\u02C8\u0091\u0092\u00B4\u0060\uFF07]/g,"'")
  .replace(/[\u201C\u201D\u201E\u201F\u2033\u0093\u0094\u00AB\u00BB\uFF02]/g,'"')
  .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u0096\u0097]/g,'-')
  .replace(/[\u2026\u0085]/g,'...')
  .replace(/[\u00A0\u2007\u2008\u2009\u200A\u200B\u202F]/g,' ');
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// monospace word-wrap to <= maxlines lines of <= maxchars
function greedyWrap(words, maxchars){
  const lines=[]; let cur='';
  /* A token longer than the line can never be broken on a space. Left whole it ran clean off the
     column and straight across the neighbouring ones on Capiche p1; sliced away by wrapDesc it
     vanished instead. Neither is acceptable, so hard-break it at the line width. The menu has no
     hyphenation, so a plain split is what the artwork itself does with long compound words. */
  const mc=Math.max(1,maxchars|0);
  for(let w of words){
    while(w.length>mc){ if(cur){ lines.push(cur); cur=''; } lines.push(w.slice(0,mc)); w=w.slice(mc); }
    if(!w) continue;
    if(!cur) cur=w; else if((cur+' '+w).length<=mc) cur+=' '+w; else { lines.push(cur); cur=w; }
  }
  if(cur) lines.push(cur); return lines;
}
// descriptions: natural greedy fill (shorter text just uses fewer lines)
function wrapDesc(text, maxchars, maxlines){
  const words=(text||'').split(/\s+/).filter(Boolean);
  let lines=greedyWrap(words, maxchars);
  const overflow=lines.length>maxlines;
  lines=lines.slice(0,maxlines); while(lines.length<maxlines) lines.push('');
  return {lines, overflow};
}
// names: balance across the ORIGINAL line count so allergen icons/price stay aligned
function wrapName(text, maxchars, maxlines){
  const words=(text||'').split(/\s+/).filter(Boolean);
  if(!words.length) return {lines:Array(maxlines).fill(''), overflow:false};
  if(greedyWrap(words, maxchars).length>maxlines) return {lines:greedyWrap(words,maxchars).slice(0,maxlines), overflow:true};
  const want=Math.min(maxlines, words.length);
  const maxWord=Math.max.apply(null, words.map(w=>w.length));
  let lo=maxWord, hi=maxchars, best=maxchars;
  while(lo<=hi){ const mid=(lo+hi)>>1; if(greedyWrap(words, mid).length<=want){ best=mid; hi=mid-1; } else lo=mid+1; }
  let lines=greedyWrap(words, best);
  while(lines.length<maxlines) lines.push('');
  return {lines:lines.slice(0,maxlines), overflow:false};
}
/* ---------- ROOMIER TEXT: descriptions use the real space below the dish, then auto-shrink ----------
   A baked desc is ONE text block:  <font> 1 Tf  <sz> 0 0 <sz> x y Tm (l0)Tj [0 <lead> Td (l1)Tj]... ET
   We reuse that block rather than re-stamping: extra lines are spliced into the LAST baked span as
   `Tj / Td / (line)` pairs (the block's own trailing Tj closes the final line), and a smaller size is
   just a Tm swap. Keeps the baked font/colour/position exactly, and rides reflow like any other span. */
const _pgTxt={};
function pageText(p){ if(_pgTxt[p]==null) _pgTxt[p]=new TextDecoder('latin1').decode(pageStreams[p].pristine); return _pgTxt[p]; }
function descLead(f){          // per-em line leading (negative), read from the baked block when possible
  if(f._lead!=null) return f._lead;
  let lead=(typeof AC!=='undefined'&&AC&&AC.desc_leading!=null)?AC.desc_leading:-1.385;
  if(f.line_spans&&f.line_spans.length>=2){
    const m=pageText(f.page).slice(f.line_spans[0][1],f.line_spans[1][0]).match(/0 (-?[\d.]+) Td/);
    if(m) lead=parseFloat(m[1]);
  }
  return (f._lead=lead);
}
/* ---------- NAMES CAN TAKE A SECOND LINE ------------------------------------------------------
   A baked name is the same shape as a baked description — one text block whose extra lines are
   `Tj / 0 <lead> Td / (line)` — so the same splice works. Measured on all five baked two-line names
   (1:0, 1:3, 1:12, 1:36, 1:45): every one uses `0 -1.2 Td`, i.e. 15.6pt at the universal size 13.
   `f.lines` is nested per-line-per-piece (Illustrator splits a visual line into kerned runs), so the
   gap to scan is line 0's LAST piece end -> line 1's FIRST piece start, not [0][1] -> [1][0]. */
function nameLead(f){
  if(f._nlead!=null) return f._nlead;
  let lead=-1.2;
  const L=f.lines||[];
  if(L.length>=2 && L[0].length && L[1].length){
    const a=L[0][L[0].length-1][1], b=L[1][0][0];
    const m=pageText(f.page).slice(a,b).match(/0 (-?[\d.]+) Td/);
    if(m) lead=parseFloat(m[1]);
  }
  return (f._nlead=lead);
}
/** Point distance between consecutive name baselines. */
function nameLineH(f){ return Math.abs(nameLead(f)*(f.size||13)); }
/* The name exactly as the designer baked it, read back per line from the stream. `f.display` is the
   whole name; this recovers how it was actually BROKEN across lines, which `display` cannot tell us.
   Used as the floor for the character budget: the artwork is proof that this text fits, so a budget
   below it would mean merely retyping the existing name triggered a wrap. */
function bakedNameLines(f){
  if(f._bakedLines) return f._bakedLines;
  const t=pageText(f.page), out=[];
  for(const pieces of (f.lines||[])){
    let s='';
    for(const sp of pieces) s+=t.slice(sp[0],sp[1]).replace(/^\(|\)$/g,'').replace(/\\([()\\])/g,'$1');
    out.push(s);
  }
  return (f._bakedLines=out);
}
const bakedLongestLine=f=>Math.max(0,...bakedNameLines(f).map(s=>s.trim().length));
// NB: never `.pop()` bakedNameLines() — it is cached on the field and pop would truncate the cache
const bakedLastLine=f=>{ const L=bakedNameLines(f); return (L.length?L[L.length-1]:'').trim(); };
/** Lines this name is ALLOWED to use: baked, plus any the column has agreed to pay for. */
function nameMaxLines(f,extra){ return (f.lines||[]).length + Math.max(0, Math.min(NAME_EXTRA_MAX, extra||0)); }
/** Lines this name will actually RENDER for `val`. Never below the baked count: unused baked lines
    are emitted as `()` rather than removed, so the block's own baselines still exist. */
function nameLines(f,val,extra){
  const w=wrapName(String(val==null?'':val), nameBudgetChars(f), nameMaxLines(f,extra));
  let n=w.lines.length; while(n>0 && !w.lines[n-1]) n--;
  return Math.max((f.lines||[]).length, n);
}
const NAME_EXTRA_MAX=1;        // the ask is "continue on a second line" — one extra, not two
function descTm(f){            // the block's Tm (so we can swap the size)
  if(f._tm!==undefined) return f._tm;
  const t=pageText(f.page), s0=f.line_spans[0][0];
  const bt=t.lastIndexOf('BT',s0), st=bt>=0?bt:Math.max(0,s0-200);
  const re=/([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g; let m,last=null;
  const seg=t.slice(st,s0); while((m=re.exec(seg))) last=m;
  f._tm=last?{s:st+last.index,e:st+last.index+last[0].length,size:parseFloat(last[1]),x:parseFloat(last[3]),y:parseFloat(last[4])}:null;
  return f._tm;
}
function mergeSpans(list){
  const s=list.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]), out=[];
  for(const sp of s){ const last=out[out.length-1];
    if(last && sp[0]<=last[1]) last[1]=Math.max(last[1],sp[1]); else out.push([sp[0],sp[1]]); }
  return out;
}
/* ---- STATE-PRESERVING DELETE ----------------------------------------------------------------
   Deleting a byte span can strip graphics/text state that LATER, UN-DELETED content inherits.
   The food editors hit this with fonts (see keepFont() in capiche/index.html + the knowledge doc
   docs/knowledge/fontless-block-inherit-bug.md); these drinks menus hit it with COLOUR. On AHM
   page 1 the baked Jain marker of MANGO PICANTE carries `0 0.993 1 0  scn`, and the NEW badge
   starburst immediately after it has NO colour operator of its own -- it renders red purely by
   inheriting that one. Renaming the drink (or toggling its markers) deletes the marker span, so
   the badge fell back to the body-text grey and printed dark.
   Fix: replace a deleted span with whatever state operators inside it are STILL IN EFFECT at the
   span's END (i.e. not undone by a `Q` within the span). That is exactly the state the original
   stream had at that byte offset, so the output can only become MORE faithful, never less.
   Nesting is tracked RELATIVE to the span start (level 0 = the level the span opens at); levels
   may go NEGATIVE, because photo_span deliberately ends one `Q` below where it began -- so never
   assume balance and never try to rebalance here (deleting a clip's `re W n` while keeping its
   `q` would change clipping semantics).
   NEVER add cm / Tm / Td / W to this set: everything preserved here is POSITION-INVARIANT, which
   is the only reason it composes with reflowOps (which rewrites every Tm/cm/re it sees) for free. */
const ST_CLASS={ cs:'cs', CS:'CS', gs:'gs', Tf:'Tf', Tc:'Tc', Tw:'Tw', Tz:'Tz', TL:'TL', Ts:'Ts', Tr:'Tr',
                 scn:'fill', sc:'fill', rg:'fill', k:'fill', g:'fill',
                 SCN:'stroke', SC:'stroke', RG:'stroke', K:'stroke', G:'stroke' };
const ST_ARITY={ cs:1, CS:1, gs:1, Tf:2, Tc:1, Tw:1, Tz:1, TL:1, Ts:1, Tr:1,
                 rg:3, RG:3, k:4, K:4, g:1, G:1 };   // scn/sc/SCN/SC arity depends on the colour space
// cs BEFORE fill: scn's operands are interpreted in the CURRENT colour space, so the space must be
// restored first. Same for CS/stroke.
const ST_ORDER=['cs','CS','gs','fill','stroke','Tf','Tc','Tw','Tz','TL','Ts','Tr'];
const PDF_DELIM=/[\s()<>\[\]{}\/%]/;
function keepState(seg){
  const n=seg.length, live=Object.create(null);
  let i=0, lvl=0, opStart=-1, nOps=0, sawOp=false;
  const operand=st=>{ if(opStart<0) opStart=st; nOps++; };
  while(i<n){
    const c=seg[i];
    if(c<=' '){ i++; continue; }                                            // whitespace / NUL
    if(c==='%'){ while(i<n&&seg[i]!=='\n'&&seg[i]!=='\r') i++; continue; }   // comment
    if(c==='('){ const st=i; let d=1; i++;                                   // (literal string): a `q`
      while(i<n&&d){ const ch=seg[i];                                        // inside description text
        if(ch==='\\') i++; else if(ch==='(') d++; else if(ch===')') d--;      // must NOT read as save-state
        i++; }
      operand(st); continue; }
    if(c==='<'||c==='['){ operand(i); i++; continue; }                       // <hex> / <<dict>> / [array]
    if(c==='>'||c===']'){ i++; continue; }
    if(c==='/'){ const st=i; i++; while(i<n&&!PDF_DELIM.test(seg[i])) i++; operand(st); continue; }
    if(c==='+'||c==='-'||c==='.'||(c>='0'&&c<='9')){ const st=i; i++;
      while(i<n&&(seg[i]==='.'||seg[i]==='-'||seg[i]==='+'||(seg[i]>='0'&&seg[i]<='9'))) i++; operand(st); continue; }
    const st=i; while(i<n&&!PDF_DELIM.test(seg[i])) i++;                     // bare token => operator
    const op=seg.slice(st,i) || seg[i++];
    if(op==='q') lvl++;
    else if(op==='Q'){ lvl--; for(const cl in live) if(live[cl].lvl>lvl) delete live[cl]; }
    else if(op==='BI'){ const e=seg.indexOf('EI',i); i=(e<0? n : e+2); }     // inline image: skip wholesale
    else if(ST_CLASS[op]){
      const want=ST_ARITY[op];
      // Guard against a span that began mid-operand-run (e.g. "...0.816  scn"): replaying a
      // truncated operand list would emit malformed PDF. Drop the class instead of guessing.
      const ok = opStart>=0 && (want!=null ? nOps===want : (nOps>=1 && (sawOp||opStart>0)));
      if(ok) live[ST_CLASS[op]]={txt:seg.slice(opStart,i), lvl:lvl};
      else   delete live[ST_CLASS[op]];
    }
    sawOp=true; opStart=-1; nOps=0;
  }
  let out=''; for(const cl of ST_ORDER) if(live[cl]) out+=live[cl].txt+'\n';
  return out;
}

/* Some text blocks in these menus do NOT set their own font (no `Tf`) — they inherit the font
   left active by an EARLIER block. Deleting a span that happens to carry that `Tf` (e.g. a dish's
   baked Jain marker) silently re-fonts every fontless block after it, which renders as missing
   letters (only glyphs present in the inherited subset survive). So when we delete a span, we
   leave its last `Tf` behind: same graphics state, nothing drawn. */
function keepFont(sp, p){
  // generalised: colour / Tc / Tw / gs are inherited by later blocks exactly as fonts are,
  // and dropping them re-colours or re-spaces the rest of the page (see keepState above)
    // The walk must start at byte 0, not at sp[0]: keepState tracks q/Q depth RELATIVE to where
  // it begins, so a span starting mid-nesting makes it mistake state that a later `Q` will
  // restore for live top-level state, and re-emitting that repaints the rest of the page
  // (a deleted NEW badge left its own white fill behind, blanking every dish below it).
  return keepState(pageText(p).slice(0,sp[1]));
}

const _pgRuns={};
function runsFor(p){ if(_pgRuns[p]==null) _pgRuns[p]=_textRuns(pageStreams[p].pristine); return _pgRuns[p]; }
const _divs={};
function dividersFor(p){ if(_divs[p]==null) _divs[p]=_dividerLines(pageStreams[p].pristine); return _divs[p]; }
function gapBelowF(f){         // usable room below: the nearer of the next field and the DIVIDER RULE
  if(f._gap!=null) return f._gap;
  let limit=null;   // the highest y we must stay above
  for(const g of FM.fields){
    if(g===f||g.page!==f.page||g.y==null) continue;
    if(Math.abs(g.x-f.x)>60) continue;
    if(g.y>=f.y-0.5) continue;
    const top=g.y+(g.size||7)*0.72;      // that field's glyphs rise ABOVE its baseline
    if(limit==null||top>limit) limit=top;
  }
  /* Ink the FIELDMAP does not model is still a floor. Capiche has no header fields at all, so a
     section heading sitting below a description was invisible here and the text was licensed to
     grow straight over it (SALADS, p1). Read the pristine stream instead: that catches headings,
     notes and art nothing else knows about. The field's own baked lines are skipped. */
  const _ownBot=f.y-Math.abs(descLead(f)*f.size)*Math.max(0,((f.line_spans||[]).length-1))-0.5;
  for(const r of runsFor(f.page)){
    if(r.y==null||r.x==null||Math.abs(r.x-f.x)>60||r.y>=_ownBot) continue;
    // Take the run's own em from its text matrix. A fixed 9pt guess under-measured the big red
     // section headings by 10pt (SALADS renders a 19pt ink box), so a growing description was
     // licensed to eat their clearance even though the reflow below it was correct.
    const top=r.y+Math.max(FURNITURE_RISE, r.size||0);
    if(limit==null||top>limit) limit=top;
  }
  for(const d of dividersFor(f.page)){   // the rule between dishes is the real floor — never cross it
    if(d.y<f.y-0.5 && d.x-8<=f.x && f.x<=d.x+d.w+8 && (limit==null||d.y>limit)) limit=d.y;
  }
  return (f._gap = limit!=null ? (f.y-limit) : Math.abs(descLead(f)*f.size)*(f.line_spans.length+1));
}
const DESC_CLEAR=1.4;          // min clearance above the rule — matches the menu's own tightest baked spacing
function maxLinesAt(f,sz,extra){ // how many lines actually fit at this size (never fewer than baked)
  const B=f.line_spans.length, lh=Math.abs(descLead(f)*sz);
  // Cap growth at +2 lines: a big empty gap (last dish in a column) shouldn't license a
  // 9-line description, and that space can hold art/headers this map doesn't know about.
  // `extra` is the number of ADDITIONAL lines the column has agreed to pay for by pushing the
  // dishes below this one down (see growPlan). It is granted, not measured, so it adds on top of
  // whatever the pristine gap already affords. extra=0 reproduces the pre-growth behaviour exactly.
  return Math.max(B, Math.min(B+2, (extra||0)+1+Math.floor((gapBelowF(f)-DESC_CLEAR)/lh)));
}
/* chucky-2: DESCRIPTIONS STOP BEFORE THE PRICES. A description line may not run into the price
   column: it ends at least DESC_PRICE_CLEAR short of where the column's prices start — the same 2pt a
   name keeps from its price (MARKER_CLEAR) — and a line that would reach further wraps to the next
   line. The limit is worked out per description from its own x, size and tracking and BECOMES its
   max_chars, so every wrap (fitDesc, the counters, the emitter) fills the line right up to it. The
   fieldmap's own max_chars was just the designer's longest line for that dish — BURRATA HOT HONEY
   wrapped at 33 characters with room for 45, so added words dropped to a new line beside empty
   space. It is replaced in both directions: wider where there is room, narrower where the
   designer's line ran under the prices. Baked descriptions whose
   own lines already run under the prices (AFFAIR and POMODORO in this artwork) are re-set with the
   limit on load: see REWRAP. */
const DESC_PRICE_CLEAR=2.0;
const _priceEdge={};
function priceEdgeAt(p, x){      // where the price column starts, for text starting at x
  const xs=_priceEdge[p]||(_priceEdge[p]=itemsForPage(p).items.flatMap(it=>(it.prices||[])
    .map(q=>(q.tm_vals&&q.tm_vals[4]!=null)?q.tm_vals[4]:q.x)));
  // only prices in this text's own column (the engine's column bounds): a dish with no price of its
  // own must never wrap across into the next column's prices
  const col=pageColumns(p).find(c=>x>=c.min && x<c.max);
  let edge=null;
  for(const qx of xs) if(qx>x+40 && (!col || qx<col.max) && (edge==null||qx<edge)) edge=qx;
  return edge;
}
function descCharsBeforePrice(p, x, size, tc){   // characters that fit on one line
  const e=priceEdgeAt(p, x); if(e==null) return Infinity;
  const adv=(ADV.desc+(tc||0))*size;               // origin to origin; the last glyph adds 0.63em of ink
  return Math.max(8, Math.floor((e-DESC_PRICE_CLEAR-x-ADV.desc*size)/adv+1e-9)+1);
}
const REWRAP=new Set();   // baked descriptions that run under the prices: always re-set, never left baked
// the characters a baked line actually prints: the contents of its (string) operands. A line can be
// one string, or — as on Aiko's page 2 — one string per letter with a positioning move between each.
function spanText(raw){
  let out='';
  for(let i=0;i<raw.length;i++){
    if(raw[i]!=='(') continue;
    let j=i+1, depth=1, s='';
    for(; j<raw.length; j++){
      const c=raw[j];
      if(c==='\\'){ const m=/^[0-7]{1,3}/.exec(raw.slice(j+1)); s+=m?'x':(raw[j+1]||''); j+=m?m[0].length:1; continue; }
      if(c==='(') depth++;
      else if(c===')' && --depth===0) break;
      s+=c;
    }
    out+=s; i=j;
  }
  return out;
}
function capDescsAtPrices(){
  for(const f of FM.fields){
    if(f.role!=='desc') continue;
    const n=descCharsBeforePrice(f.page, f.x, f.size, f.tc);
    if(!isFinite(n)) continue;          // no price column to the right: keep the fieldmap's width
    f.max_chars=n;
    const baked=(f.line_spans||[]).map(sp=>spanText(pageText(f.page).slice(sp[0],sp[1])).trim().length);
    if(baked.some(len=>len>n)) REWRAP.add(f.id);
  }
  rewrapBaked();
}
function rewrapBaked(){ for(const id of REWRAP) if(!(id in edits)) edits[id]=FIELD[id].display; }
// an added dish stamps its own `0 Tc`, so its description advances exactly 0.63em
const addDescChars=sec=>Math.min(56, descCharsBeforePrice(sec.page, sec.col_x, AC.desc_size, 0));
function fitDesc(f,val,extra){  // use every line that fits; only then shrink the size
  const FLOOR=+(f.size*0.72).toFixed(3);
  let sz=f.size, mc=f.max_chars;
  for(let i=0;i<18;i++){
    const w=wrapDesc(val, mc, maxLinesAt(f,sz,extra));
    if(!w.overflow) return {lines:w.lines, size:sz, overflow:false};
    if(sz<=FLOOR) break;
    sz=Math.max(FLOOR,+(sz*0.94).toFixed(3));
    mc=Math.max(4, Math.floor(f.max_chars*f.size/sz));   // smaller glyphs -> more chars in the same width
  }
  const w=wrapDesc(val, Math.max(4,Math.floor(f.max_chars*f.size/FLOOR)), maxLinesAt(f,FLOOR,extra));
  return {lines:w.lines, size:FLOOR, overflow:w.overflow};
}
/* DIGITS IN A DISH NAME. The name face (AOMonoBlack, /T1_3) is an Illustrator subset with no digit
   outlines at all — so a number cannot be drawn with it, and writing one anyway would print a blank.
   But the same page already embeds AOMonoRegular (/T1_4, the price face) which HAS all ten, and PDF
   font resources are page-level: every /T1_n lives in the one /Resources /Font dict that governs the
   one stream names are drawn in. So digits are borrowed with a mid-run `Tf`, changing nothing about
   /Resources. Precedent: the Jain "J" is already drawn from a third face inside this same stream.

   Two properties make this safe rather than fiddly:
     - `Tf` always carries size 1 here; the point size lives in the Tm scale. A borrowed digit
       therefore renders at the NAME's size automatically — no size operand, no Tm/Td arithmetic.
     - Every AO Mono weight is monospaced at 630/1000, which is exactly the 0.63 advance the layout
       already assumes, so wrapName / nameBudgetChars / the marker slide need no adjustment.
   Tc/Tw survive a Tf, so the name's own tracking keeps applying to the digits — which is wanted,
   since the advance is identical. The visible cost is weight: digits are two steps lighter than the
   Black caps. AOMonoBold is closer but its `4` outline is genuinely absent, which is worse. */
const NAME_DIGITS = '0123456789';
/* The donor digits come from AOMonoRegular, two weight steps lighter than the AOMonoBlack letters
   around them. Rather than accept mismatched weight (or AOMonoBold, whose `4` outline is missing),
   thicken them optically: text rendering mode 2 fills AND strokes the glyph, so a stroke width added
   to a Regular stem approximates a heavier cut. The stroke has to be given the NAME's colour in its
   stroking form (lowercase `k`/`g`/`rg` set fill, uppercase set stroke), or the outline would be
   drawn in whatever stroke colour the page last used. Restore `0 Tr` afterwards so nothing else in
   the block gets stroked. */
/* Two donors, because no single face has everything the name font lacks:
     digits 0-9  -> price face  (AOMonoRegular: all ten; AOMonoBold is missing `4`)
     . , : - /   -> desc face   (AOMonoBold: has them; AOMonoRegular has only `-` and `/`)
   Stroke thickening differs per donor because they sit different distances from Black: Regular is
   two weight steps away, Bold only one. Both tuned by render. */
const NAME_PUNCT  = '.,:-/';
const DIGIT_BOLD_W = 0.45;   // AOMonoRegular -> Black, at 13pt name size
const PUNCT_BOLD_W = 0.20;   // AOMonoBold    -> Black, one step, so much less
function strokeColourOf(fillOp){
  return String(fillOp||'0 g').replace(/\brg\s*$/,'RG').replace(/\bk\s*$/,'K').replace(/\bg\s*$/,'G');
}
function nameCharClass(ch){
  if(NAME_DIGITS.indexOf(ch) >= 0) return 'digit';
  if(NAME_PUNCT.indexOf(ch)  >= 0) return 'punct';
  return 'native';
}
let FULL_NAME_FACE = false;   // chucky-2: true when boot swapped in the full AOMonoBlack
function nameRunPdf(text, fonts){
  const s = String(text||'');
  // chucky-2: once the FULL AOMonoBlack is embedded (see FullFonts in boot) it has its own digits and
  // punctuation, so nothing is borrowed and they print at the name's real weight
  if(FULL_NAME_FACE || !/[0-9.,:\-\/]/.test(s)) return '('+escPdf(s)+')';   // nothing borrowed: byte-identical to before
  const nameF  = (fonts && fonts.name)  || '/T1_3';
  const digitF = (fonts && fonts.price) || '/T1_4';
  const punctF = (fonts && fonts.desc)  || '/T1_2';
  const SC = strokeColourOf(AC && AC.name_color);
  let out = '', run = '', cls = null, started = false;
  const flush = () => {
    if(!run) return;
    if(!started){ out += '('+escPdf(run)+')'; started = true; }          // first piece keeps the span's own Tj
    else if(cls === 'digit') out += 'Tj\n'+digitF+' 1 Tf\n'+SC+'\n2 Tr\n'+fmtNum(DIGIT_BOLD_W)+' w\n('+escPdf(run)+')';
    else if(cls === 'punct') out += 'Tj\n'+punctF+' 1 Tf\n'+SC+'\n2 Tr\n'+fmtNum(PUNCT_BOLD_W)+' w\n('+escPdf(run)+')';
    else out += 'Tj\n'+nameF+' 1 Tf\n0 Tr\n('+escPdf(run)+')';
    run = '';
  };
  for(const ch of s){
    const c = nameCharClass(ch);
    if(c !== cls){ flush(); cls = c; }
    run += ch;
  }
  const inDigits = (cls !== 'native');
  flush();
  // leave the resource AND the render mode as we found them, or everything drawn later in this block
  // inherits the digit face and keeps getting stroked
  if(inDigits) out += 'Tj\n'+nameF+' 1 Tf\n0 Tr\n()';
  return out;
}
/* REAL per-dish name budget. The baked `max_chars` is a legacy constant that does not describe the
   space available: MARGHERITA carries 12 while its row actually holds 22, which is why typing
   `MARGHERITA PI` was rejected. roomier-text-limits.md measured the opposite failure too — capiche
   0:18 has max_chars=24 but ends PAST its own price. Measure it instead: from the name x to the
   leftmost price to its RIGHT (same column), less the marker cluster the name must not run under.
   The cluster slides right with a longer name (see the marker pass), so only its WIDTH is reserved.
   Clamped with Math.max so this can only ever widen a budget, never narrow one. */
const _nameBudget={};
/* How many characters a dish name can hold before its marker row would hit the price.
   The budget MUST be derived from the same layout engine that draws the row. It used to take the
   cluster width from the baked `add_const icon_*` offsets and then return
   `Math.max(f.max_chars, computed)`. Both halves were unsafe:
     - the baked offsets disagree with the flowed cluster by up to 28.4pt (dish 0:28), and
     - the `max(...)` floor let a stale legacy `max_chars` override the computed safe value.
   Measured consequence: setting every name to exactly its advertised budget pushed the markers
   past the price on 25 of 37 dishes. Now it asks clusterWidth() — the same function stampMarkers
   flows against — so the advertised budget is the real one.
   Not memoised on id alone: the width depends on the dish's CURRENT marker set, which the user
   can change at any time, so the cache is keyed by that set too. */
function nameBudgetChars(f){
  const set = dishMarkers(f.id);
  const key = f.id + '|' + MARKER_TYPES.filter(t=>set.has(t)).join(',');
  if(_nameBudget[key]!=null) return _nameBudget[key];
  const base=f.max_chars||12;
  let px=null;
  for(const q of FM.fields){
    if(q.page!==f.page||q.role!=='price') continue;
    const x=(q.tm_vals&&q.tm_vals[4]!=null)?q.tm_vals[4]:q.x;
    if(x==null||x<=f.x) continue;                       // must be to the RIGHT (same column)
    if(Math.abs(q.y-f.y)>8) continue;                   // and on this dish's own row
    if(px==null||x<px) px=x;
  }
  if(px==null) return (_nameBudget[key]=base);           // no price bounds this row
  /* Solve the SAME expression rowAnchor() evaluates, or the budget promises room the layout will
     not honour. rowAnchor takes the max of two increasing terms, so bound each and take the lower:
       a) the baked anchor slid by the change in length:  clusterStart + (n - bakedLast)*adv
       b) the name's own right edge plus this dish's lead: f.x + n*adv + nameLeadFor(f)
     Budgeting only against (b) let a lengthened name ride term (a) past the price on 12 dishes. */
  const adv=nameAdv(f), W=clusterWidth(set), room=px-MARKER_CLEAR-W;
  const nA=bakedLastLine(f).length + (room - clusterStart(f))/adv;
  const nB=(room - (set.size ? nameLeadFor(f) : 0) - f.x)/adv;
  const n=Math.floor(Math.min(nA, nB)+1e-9);
  /* Never advertise less than the artwork already prints. CHILLI BUTTER CORN is 18 characters
     against a computed 17 — its baked cluster sits 4.4pt after the name where we enforce a 6pt
     lead, and our flowed cluster is 1.2pt wider — so without this floor, retyping the dish's own
     name would flag it as too long and spend a growth line on it. Unlike the legacy `max_chars`
     floor this replaced, the baked name is measured reality, not a stale constant. It applies only
     while the dish carries its BAKED marker set; add a marker and the computed budget governs. */
  const sameSet = MARKER_TYPES.filter(t=>set.has(t)).join(',') ===
                  MARKER_TYPES.filter(t=>(f.markers||[]).includes(t)).join(',');
  let floorN = sameSet ? bakedLongestLine(f) : 0;
  /* The floor is allowed to spend the house clearance, never to cause an OVERLAP. Our flowed
     cluster is a little wider than the designer's (uniform 2.18pt gaps in place of their
     2.16/0.96/1.80), so CHILLI BUTTER CORN's own name lands at ~0.7pt from the price rather than
     the 2pt we normally keep. That is tight but correct — it is what the printed menu already
     does. If a baked name ever DID overlap under this model, the floor stands down and the name
     wraps instead. */
  if(floorN>n){
    const right=Math.max(clusterStart(f), f.x+floorN*adv+(set.size?nameLeadFor(f):0))+W;
    if(right>px) floorN=0;
  }
  return (_nameBudget[key]=Math.max(1, n, floorN));
}
// `extra` = lines the column has agreed to fund by pushing what is below down. Names honour it too
// now: pinning maxlines to the baked count is exactly what made a long name truncate silently.
function wrapFor(f,val,extra){ if(f.role==='name') return wrapName(val,nameBudgetChars(f),nameMaxLines(f,extra)); const t=fitDesc(f,val,extra); return {lines:t.lines, overflow:t.overflow}; }
function isOverflow(f,val,extra){ return wrapFor(f,val,extra).overflow; }
/* ---------- GROWTH MODEL: how much room a column can lend a description that needs another line ----
   Measured from the PRISTINE artwork. The floor is the top of the highest thing BELOW the dish flow
   (the DAIRY/GLUTEN/JAIN legend is anchored to the page and must never be pushed), read from the
   STREAM rather than FM.fields so art the fieldmap knows nothing about still counts. Deliberately
   conservative: lending too little costs a line, lending too much prints over the legend. */
const FURNITURE_RISE=9;        // text runs carry no size; this clears the largest chrome on either page
const _colGeo={};
function colGeo(p, col){
  const k=p+'|'+col.x; if(_colGeo[k]!==undefined) return _colGeo[k];
  const mine=FM.fields.filter(f=>f.page===p&&f.y!=null&&f.x>=col.min&&f.x<col.max&&
    (f.role==='name'||f.role==='desc'||f.role==='grams'||f.role==='price'));
  if(!mine.length) return (_colGeo[k]={floor:null,budget:0});
  let flowBottom=Infinity;
  for(const f of mine){
    const ex=(f.role==='desc'&&f.line_spans)?Math.max(0,f.line_spans.length-1):0;
    const y=f.y-(ex?Math.abs(descLead(f)*f.size)*ex:0);
    if(y<flowBottom) flowBottom=y;
  }
  const b=pageStreams[p].pristine, inCol=x=> x!=null&&x>=col.min-6&&x<=col.max+6;
  let floor=null;
  for(const r of _textRuns(b)) if(inCol(r.x)&&r.y<flowBottom-2){ const t=r.y+FURNITURE_RISE; if(floor==null||t>floor) floor=t; }
  for(const q of _leafQBlocks(b)) if(q.kind==='q'&&inCol(q.x)&&q.y!=null&&q.y<flowBottom-2&&(floor==null||q.y>floor)) floor=q.y;
  if(floor==null) floor=18;                                    // nothing below it: keep a page margin
  return (_colGeo[k]={floor:floor, flowBottom:flowBottom, budget:Math.max(0, flowBottom-floor-DESC_CLEAR)});
}
/* Which descriptions may grow, and by how much the dishes under them must then move.
   D(f) = max(0, |lead|*size*(lines-1) + DESC_CLEAR - gapBelowF(f)) -- push by the OVERRUN, not by
   whole line-heights. At extra=0 this is provably <= 0, so no edits => no growth => byte identity.
   Resolved per column, TOP-DOWN in document order against one shared budget, which is what makes it
   deterministic. It is also what stops the maths being circular: pushing the dish below down raises
   this dish's own gapBelowF by exactly the push, so the binding constraint is the COLUMN FLOOR, not
   the neighbour. */
let _growSig=null, _growCache={};
/* chucky-2: markers and the added dishes' CONTENT are part of the key. Markers share a name's line
   (they set how much room it has) and an added dish's text sets how much of the column it takes.
   With only the added COUNT and no markers in the key, toggling a marker or editing an added dish
   kept serving the stale plan: a warning that no longer applied, Export stuck paused, and names
   laid out with the old room. */
function growSig(){
  return JSON.stringify([Object.keys(edits).sort().map(k=>k+'\u0001'+edits[k]),
    [...removed].sort(), (typeof added!=='undefined'&&added)?added:0,
    (typeof order!=='undefined')?order:0,
    (typeof markerEdits!=='undefined'&&markerEdits)?Object.keys(markerEdits).sort().map(k=>k+'\u0001'+markerEdits[k]):0]);
}
function growPlan(p){
  const sig=growSig(); if(sig!==_growSig){ _growSig=sig; _growCache={}; }
  if(_growCache[p]) return _growCache[p];
  const out={byDesc:{},extra:{},fit:{},over:{},left:{},byName:{},nameExtra:{},nameOver:{},nameShort:{}};
  for(const col of pageColumns(p)){
    let remaining=colGeo(p,col).budget;
    /* Added dishes spend from the SAME pot and are charged FIRST: a dish the user deliberately
       added must never be pushed off the page by a description that merely wants to be roomier. */
    if(typeof added!=='undefined'&&added.length&&typeof SECTIONS!=='undefined'&&SECTIONS){
      for(const it of added){ const sec=SECTIONS[it.sec];
        if(sec&&sec.page===p&&sec.col_x>=col.min&&sec.col_x<col.max) remaining-=(sec.slot||33); }
    }
    remaining=Math.max(0,remaining);
    /* NAMES ASK FIRST. A name that will not fit is a hard stop for the user — the text simply
       disappears — whereas a description can shrink its way out of trouble, so the name gets the
       budget before the description does.
       Cost is the FULL line height, not an overrun: the description has to end up the same distance
       below the name's LAST line as it was below its only line, so it moves down by exactly one
       lead. That is what the artwork does — its five baked two-line names sit 25.9-28.9pt above
       their descriptions, i.e. 15.6pt of lead plus the usual ~10.5pt gap. */
    const nms=FM.fields.filter(f=>f.page===p&&f.role==='name'&&f.x>=col.min&&f.x<col.max&&(f.id in edits))
      .sort((a,b)=>b.y-a.y);
    for(const f of nms){
      const val=edits[f.id];
      if(!wrapFor(f,val,0).overflow){ out.byName[f.id]=0; out.nameExtra[f.id]=0; out.nameOver[f.id]=false; continue; }
      const D=nameLineH(f);                                     // one extra baseline
      if(D<=remaining+1e-6 && !wrapFor(f,val,NAME_EXTRA_MAX).overflow){
        out.byName[f.id]=D; out.nameExtra[f.id]=NAME_EXTRA_MAX; out.nameOver[f.id]=false;
        remaining=Math.max(0,remaining-D);
      }else{
        // no room in this column, or still too long even with the extra line — say which
        out.byName[f.id]=0; out.nameExtra[f.id]=0; out.nameOver[f.id]=true;
        if(D>remaining+1e-6) out.nameShort[f.id]=D-remaining;
      }
    }
    const descs=FM.fields.filter(f=>f.page===p&&f.role==='desc'&&f.x>=col.min&&f.x<col.max&&(f.id in edits))
      .sort((a,b)=>b.y-a.y);                                    // top -> bottom, first to ask wins
    for(const f of descs){
      const val=edits[f.id], lead=Math.abs(descLead(f)), gap=gapBelowF(f);
      let best=null;
      for(let ex=0;ex<=2;ex++){
        const fit=fitDesc(f,val,ex);
        let n=fit.lines.length; while(n>0&&!fit.lines[n-1]) n--;
        n=Math.max(f.line_spans.length,n);
        const D=Math.max(0, lead*fit.size*(n-1)+DESC_CLEAR-gap);
        if(D>remaining+1e-6) break;                             // unaffordable, and so is anything bigger
        if(!best || (best.fit.overflow&&!fit.overflow) ||
           (best.fit.overflow===fit.overflow && fit.size>best.fit.size)) best={fit:fit,D:D,ex:ex};
      }
      if(!best) best={fit:fitDesc(f,val,0), D:0, ex:0};         // cannot afford even one extra line
      out.byDesc[f.id]=best.D; out.extra[f.id]=best.ex; out.fit[f.id]=best.fit; out.over[f.id]=!!best.fit.overflow;
      remaining=Math.max(0, remaining-best.D);
    }
    out.left[col.x]=remaining;
  }
  return (_growCache[p]=out);
}


/* Translate baked artwork rigidly by rewriting the absolute origin of everything inside a span.
   Used to carry a dish's allergen icons along when the dish is RENAMED, without redrawing them.
   Both forms appear and both are handled — path stamps (dairy/gluten) via their `q 1 0 0 1 x y cm`
   origin, glyph markers (the Jain "J", a BT block) via their text matrix. */
function shiftArtOrigins(txt, dx, dy){
  return txt
    .replace(/q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/g,
      (m,x,y)=>'q 1 0 0 1 '+fmtNum(parseFloat(x)+dx)+' '+fmtNum(parseFloat(y)+dy)+' cm')
    .replace(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g,
      (m,a,b,c,d,x,y)=>[a,b,c,d,fmtNum(parseFloat(x)+dx),fmtNum(parseFloat(y)+dy)].join(' ')+' Tm');
}
function spliceBytes(src, ops){
  ops = ops.slice().sort((a,b)=>a.s-b.s);
  /* ONE forward cursor walks src, so two ops covering the same bytes drive it BACKWARDS and the
     stream corrupts from that point on — every dish below vanishes. This has bitten three times
     (label vector overlay vs flourish_cm, badge vs leaf-block, strayRowIcons vs badge_span), each
     time surfacing only as "syntax error: unknown keyword" in a viewer. Drop the later op and say
     so: a missing tweak is recoverable, a corrupt content stream is not. */
  { const keep=[]; let end=-1;
    for(const o of ops){
      if(o.s<end){ try{console.warn('spliceBytes: dropped overlapping op ['+o.s+','+o.e+') — previous op ends at '+end);}catch(_){ } continue; }
      keep.push(o); end=o.e;
    }
    ops=keep; }
  let outLen = src.length + ops.reduce((d,o)=>d+(o.rep.length-(o.e-o.s)),0);
  const out=new Uint8Array(outLen); let si=0, oi=0;
  for(const o of ops){ out.set(src.subarray(si,o.s),oi); oi+=o.s-si; out.set(o.rep,oi); oi+=o.rep.length; si=o.e; }
  out.set(src.subarray(si),oi); return out;
}
// A deletion must never weld the byte before it to the byte after it: `Q`+`q` becomes the
// bogus operator `Qq`, and every PDF parser then abandons the REST of the content stream
// (dishes below simply vanish). Pad the replacement with a newline when it would weld.
// This matters most where a delete span does NOT land on an operator boundary — the divider/badge
// carve splits spans mid-stream, and keepFont() legitimately returns '' when no state needs
// restoring, so the two ends can meet directly.
function safeDel(p, s, e, rep){
  const t=pageText(p);
  const before = s>0 ? t[s-1] : '\n', after = e<t.length ? t[e] : '\n';
  let out = rep||'';
  if(out==='') return (/\S/.test(before) && /\S/.test(after)) ? '\n' : '';
  if(/\S/.test(before) && /\S/.test(out[0])) out='\n'+out;
  if(/\S/.test(out[out.length-1]) && /\S/.test(after)) out=out+'\n';
  return out;
}
// same weld guard for ops whose replacement is already encoded (divider / badge repositioning)
function safeOp(p, o){
  const t=pageText(p), nb=c=>/\S/.test(c||'');
  const before = o.s>0 ? t[o.s-1] : '\n', after = o.e<t.length ? t[o.e] : '\n';
  if(!o.rep.length) return (nb(before)&&nb(after)) ? {s:o.s,e:o.e,rep:enc('\n')} : o;
  const pre  = (nb(before) && nb(String.fromCharCode(o.rep[0]))) ? '\n' : '';
  const post = (nb(String.fromCharCode(o.rep[o.rep.length-1])) && nb(after)) ? '\n' : '';
  if(!pre && !post) return o;
  const a=enc(pre), b=enc(post), m=new Uint8Array(a.length+o.rep.length+b.length);
  m.set(a,0); m.set(o.rep,a.length); m.set(b,a.length+o.rep.length);
  return {s:o.s, e:o.e, rep:m};
}

/* ---------- structural reflow (add/remove) ---------- */
const _WS=new Set([32,9,13,10,0,12]), _DL=new Set([40,41,60,62,91,93,123,125,47,37]);
function _toks(b){const T=[];let i=0,n=b.length;while(i<n){const c=b[i];
  if(_WS.has(c)){i++;continue;}
  if(c===37){while(i<n&&b[i]!==13&&b[i]!==10)i++;continue;}
  if(c===40){let s=i;i++;let d=0;while(i<n){const ch=b[i];if(ch===92){i+=2;continue;}if(ch===40)d++;else if(ch===41){if(d===0){i++;break;}d--;}i++;}T.push({t:1,s,e:i});continue;}
  if(c===91||c===93||c===123||c===125){T.push({t:3,s:i,e:i+1});i++;continue;}
  if(c===47){let s=i;i++;while(i<n&&!_WS.has(b[i])&&!_DL.has(b[i]))i++;T.push({t:2,s,e:i});continue;}
  let s=i;while(i<n&&!_WS.has(b[i])&&!_DL.has(b[i]))i++;
  if(i>s){const c0=b[s];const isn=(c0>=48&&c0<=57)||c0===43||c0===45||c0===46;T.push({t:isn?0:3,s,e:i});}else i++;}
  return T;}
function _dec(b,k){let s='';for(let i=k.s;i<k.e;i++)s+=String.fromCharCode(b[i]);return s;}
const _nv=(b,k)=>parseFloat(_dec(b,k));
function _anchors(b){const T=_toks(b),A=[],nb=[];const qs=[];
  for(const k of T){if(k.t===0){nb.push(k);continue;}if(k.t===1||k.t===2){nb.length=0;continue;}
    const op=_dec(b,k);
    if(op==='q')qs.push(0);else if(op==='Q'){if(qs.length)qs.pop();}
    else if(op==='cm'){const a=nb.slice(-6).map(x=>_nv(b,x));if(a.length===6&&Math.abs(a[0]-1)<1e-6&&Math.abs(a[3]-1)<1e-6&&Math.abs(a[1])<1e-9&&Math.abs(a[2])<1e-9){const ty=nb[nb.length-1];A.push({kind:'cm',x:a[4],y:a[5],s:ty.s,e:ty.e});}}
    else if(op==='Tm'){const a=nb.slice(-6).map(x=>_nv(b,x));if(a.length===6){const ty=nb[nb.length-1];A.push({kind:'tm',x:a[4],y:a[5],s:ty.s,e:ty.e});}}
    nb.length=0;}
  return A;}
function _blocks(b){const T=_toks(b),B=[],nb=[];let dep=0,qs=-1,qa=null,bs=-1,ba=null;
  for(const k of T){if(k.t===0){nb.push(k);continue;}if(k.t===1||k.t===2){nb.length=0;continue;}
    const op=_dec(b,k);
    if(op==='q'){if(dep===0){qs=k.s;qa=null;}dep++;}
    else if(op==='Q'){dep--;if(dep===0&&qs>=0){B.push({span:[qs,k.e],kind:'q',x:qa?qa[0]:null,y:qa?qa[1]:null});qs=-1;}}
    else if(op==='cm'){const a=nb.slice(-6).map(x=>_nv(b,x));if(a.length===6&&Math.abs(a[0]-1)<1e-6&&Math.abs(a[3]-1)<1e-6&&Math.abs(a[1])<1e-9&&Math.abs(a[2])<1e-9){if(qa===null)qa=[a[4],a[5]];}}
    else if(op==='BT'){bs=k.s;ba=null;}
    else if(op==='Tm'){const a=nb.slice(-6).map(x=>_nv(b,x));if(a.length===6)ba=[a[4],a[5]];}
    else if(op==='ET'){if(bs>=0){B.push({span:[bs,k.e],kind:'text',x:ba?ba[0]:null,y:ba?ba[1]:null});bs=-1;}}
    nb.length=0;}
  return B;}
/* Sibling icons baked under ONE shared clip wrapper (`q .. re W n .. Q`, e.g. a dairy+gluten pair
   drawn back-to-back for one dish) collapse to a SINGLE _blocks() entry keyed off whichever icon's
   `cm` happened to come first, because _blocks() tracks one `qa` shared across every nesting depth.
   The other icon's own position is lost, its span balloons to cover both, and if that first icon's
   y falls outside _ownsArt's window the whole pair silently survives a removal (confirmed on
   PISTACHIO MOUSSE CAKE: removing it leaves its dairy+gluten group floating over whatever reflowed
   into its slot). Track `qa` PER OPEN q instead of globally, and emit a block for every q..Q pair
   (any depth) that captured its own direct `cm` -- so each icon (dairy's q, gluten's q, and a
   compound icon's own outer q even if it nests a further clip inside, like the Korea roundel) gets
   its own accurate span/position, while the outer wrapper (no `cm` of its own) yields x:null,y:null
   and is skipped by the existing `b.x===null` filter. */
function _leafQBlocks(b){const T=_toks(b),B=[],nb=[];const stack=[];
  for(const k of T){if(k.t===0){nb.push(k);continue;}if(k.t===1||k.t===2){nb.length=0;continue;}
    const op=_dec(b,k);
    if(op==='q'){stack.push({qs:k.s,qa:null});}
    else if(op==='Q'){const fr=stack.pop(); if(fr) B.push({span:[fr.qs,k.e],kind:'q',x:fr.qa?fr.qa[0]:null,y:fr.qa?fr.qa[1]:null});}
    else if(op==='cm'){const a=nb.slice(-6).map(x=>_nv(b,x));
      if(a.length===6&&Math.abs(a[0]-1)<1e-6&&Math.abs(a[3]-1)<1e-6&&Math.abs(a[1])<1e-9&&Math.abs(a[2])<1e-9){
        const top=stack[stack.length-1]; if(top&&top.qa===null) top.qa=[a[4],a[5]]; } }
    nb.length=0;}
  return B;}
/* ---- TEXT RUNS ------------------------------------------------------------------------------
   Illustrator does NOT put one dish per BT..ET. It bundles section headings, the page legend, the
   intro blurb and OTHER dishes' "NPCS" superscripts inside a neighbouring dish's block — e.g. the
   Sushi heading's "8pcs" is drawn at y=364 inside CORN TEMPURA's block, whose own name is at y=102.
   And _blocks() records only ONE position per block, taken from its LAST Tm. So a block is the
   wrong unit for both delete and reflow; the right unit is a single Tm-positioned run.
   A run spans from its Tm's first operand to the end of its last text-showing operator. State ops
   BETWEEN runs (Tc/Tw/Tf/rg) therefore belong to no run and can never be deleted — which is also
   what stops a delete from re-colouring the rest of the page. */
function _textRuns(b){
  const T=_toks(b), R=[], nb=[]; let inBT=false, cur=null;
  const close=()=>{ if(cur){ if(cur.draw>cur.span[0]){ cur.span[1]=cur.draw; R.push(cur); } cur=null; } };
  for(const k of T){
    if(k.t===0){nb.push(k);continue;}
    if(k.t===1){ if(cur) cur.draw=-1; nb.length=0; continue; }   // string: the operator decides
    if(k.t===2){nb.length=0;continue;}
    const op=_dec(b,k);
    if(op==='BT'){ close(); inBT=true; }
    else if(op==='ET'){ close(); inBT=false; }
    else if(op==='Tm'&&inBT){
      const a=nb.slice(-6).map(x=>_nv(b,x));
      if(a.length===6&&nb.length>=6){ close(); cur={span:[nb[nb.length-6].s,k.e],x:a[4],y:a[5],size:Math.abs(a[0])||0,draw:0}; }
    }
    else if(cur&&(op==='Tj'||op==='TJ'||op==="'"||op==='"')) cur.draw=k.e;
    nb.length=0;
  }
  close();
  return R;
}
/* Does a run at `ry` belong to the dish whose name baseline is `ny`? Dish content sits AT or BELOW
   its name (description, grams, price) and at most ~12pt above it (raised "6PCS" superscripts).
   Section headings sit ~25pt ABOVE their section's first name and the page legend a full row BELOW
   the last one, so both fall outside and are treated as chrome: never deleted, never shifted.
   Measured on aiko p0 — headings 24.1-33.3 above, "8pcs" 29.9 above, legend 49.7 below, while real
   dish content is 0-12 either way plus grams up to 26.8 BELOW. */
function _ownsRun(ny, ry, slotH){ const d=ny-ry; return d>=-12 && d<=Math.max(slotH,20)-2; }
/* Allergen/marker artwork (q..Q, positioned by `cm`) always sits slightly ABOVE its own dish's
   name — never below it. _ownsRun's downward reach is a whole slot, which overlaps the NEXT dish's
   raised artwork (at ny-slot+5.8) and would let a dish claim its neighbour's icons: reordering
   BURNT GARLIC RICE dragged MUSHROOM TRUFFLE's icon along with it, and removal had the same latent
   bug. Artwork therefore gets its own tight window. */
function _ownsArt(ny, ry, extraBelow){ const d=ny-ry; return d>=-12 && d<=0.5+(extraBelow||0); }
function _cluster(blocks,cmin,cmax,gap){gap=gap||18;
  const bs=blocks.filter(b=>b.x!==null&&b.x>=cmin&&b.x<=cmax&&b.y!==null).sort((a,b)=>b.y-a.y);
  const cl=[];let cur=[];for(const b of bs){if(!cur.length)cur=[b];else if(cur[cur.length-1].y-b.y<=gap)cur.push(b);else{cl.push(cur);cur=[b];}}
  if(cur.length)cl.push(cur);return cl;}
// columns for a page from its name x's
function pageColumns(p){
  const xs=[...new Set(FM.fields.filter(f=>f.page===p&&f.role==='name').map(f=>Math.round(f.x)))].sort((a,b)=>a-b);
  const W=FM.page_sizes?FM.page_sizes[p][0]:842;
  return xs.map((x,i)=>({x,min:x-12,max:(i<xs.length-1?xs[i+1]-12:W+20)}));
}
// per-page structural ops from the removed set
function structuralForPage(p, pristine){
  const removedHere=FM.fields.filter(f=>f.page===p&&f.role==='name'&&removed.has(f.id));
  /* A description that needs another line is structural too: the dishes under it must move down to
     make the room. growPlan already decided how far, bounded by the column's own budget. With no
     edits nothing grows, so this early return is unchanged and empty exports stay byte-identical. */
  const _G=growPlan(p), _grew=Object.keys(_G.byDesc).some(id=>_G.byDesc[id]>0.0005)
                            || Object.keys(_G.byName).some(id=>_G.byName[id]>0.0005);
  if(!removedHere.length&&!_grew) return {deletes:[],shiftOps:[],priceShift:{},skip:new Set(),fieldShift:{},growSlots:[],rowShift:[]};
  const blocks=_leafQBlocks(pristine), anchors=_anchors(pristine), runs=_textRuns(pristine);
  const cols=pageColumns(p);
  const priceTm=FM.fields.filter(f=>f.page===p&&f.role==='price');
  const deletes=[], shiftOps=[], priceShift={}, removedSlots=[], growSlots=[], fieldShift={}; const skip=new Set();
  const rowShift=[];      // chucky-2: each row's shift, for the preview's click boxes (pvBoxes) — read-only
  const _descByName={};   // name id -> its desc field, for reading growth per row
  for(const it of itemsForPage(p).items) if(it.name&&it.desc) _descByName[it.name.id]=it.desc;
  /* TM OWNERSHIP. A shift rewrites only the 6th operand of a Tm/cm. opsForPage, by contrast,
     rewrites a WHOLE matrix (or a whole run) for fields it edits — and those whole-matrix spans
     CONTAIN the operand this loop wants to patch. Emitting both puts two ops over one range, which
     spliceBytes cannot honour. Rule: if a field is edited, opsForPage owns its y and we hand the
     delta over in fieldShift; otherwise this function owns the raw operand. */
  const ownedSpans=[];
  for(const f of FM.fields){
    if(f.page!==p || !(f.id in edits)) continue;
    if(f.role==='desc'){ const sp=descTm(f); if(sp) ownedSpans.push({s:sp.s,e:sp.e,id:f.id}); }
    else if(f.role==='name'){
      // a renamed dish slides its allergen markers sideways, so the marker pass owns those spans
      const ms=f.markerSpans||{}; for(const t in ms) ownedSpans.push({s:ms[t][0],e:ms[t][1],id:f.id});
    }
  }   // (no header/grams roles in this fieldmap — Capiche folds grams into the description string)
  /* ACCUMULATE, never push twice for one anchor: two separate ops on one operand is the same
     corruption the ownership rule above avoids. Sum the deltas, emit one op per anchor. */
  const _shiftAcc=new Map();
  const addShift=(a,d)=>{ const k=a.s+':'+a.e, cur=_shiftAcc.get(k);
    if(cur) cur.d+=d; else _shiftAcc.set(k,{s:a.s,e:a.e,y:a.y,d:d}); };
  const routeShift=(a,d)=>{
    const pf=priceTm.find(q=>a.s>=q.tm_span[0]&&a.e<=q.tm_span[1]);   // composed with right-align
    if(pf){ priceShift[pf.id]=(priceShift[pf.id]||0)+d; return; }
    const ow=ownedSpans.find(o=>a.s>=o.s&&a.e<=o.e);
    if(ow){ fieldShift[ow.id]=(fieldShift[ow.id]||0)+d; return; }
    addShift(a,d);
  };
  for(const col of cols){
    const removedYs=removedHere.filter(f=>f.x>=col.min&&f.x<col.max).map(f=>f.y);
    const colGrows=FM.fields.some(f=>f.page===p&&f.x>=col.min&&f.x<col.max&&
      ((f.role==='desc'&&_G.byDesc[f.id]>0.0005)||(f.role==='name'&&_G.byName[f.id]>0.0005)));
    if(!removedYs.length&&!colGrows) continue;
    const colNameYs=FM.fields.filter(f=>f.page===p&&f.role==='name'&&f.x>=col.min&&f.x<col.max).map(f=>f.y);
    // NAME-ANCHORED rows, and per-RUN ownership. Block-level clustering bundled the section
    // headings into a neighbouring dish's block: removing MARGHERITA DELETED the "STAPLES" heading
    // and shifted "SPECIALS" by 53.86pt. A run judged on its own y cannot do that.
    const ny=[...colNameYs].sort((a,b)=>b-a);
    const cidx=y=>{ let bi=0,bd=1e9; ny.forEach((yy,i)=>{const d=Math.abs(yy-y); if(d<bd){bd=d;bi=i;}}); return bi; };
    const top=i=>ny[i];
    const remSet=new Set(removedYs.map(cidx));
    // Each row's dish id and SECTION, so a removal only reflows its own section. Capiche puts two
    // sections in one column (PIZZAS+PIZZA SPECIALS on p0; SIDES+SALADS, PASTAS+PASTA SPECIALS,
    // DESSERTS+DESSERT SPECIALS on p1), so a column-wide slot measures into the next section.
    const _nav=((FM&&FM.nav_sections)||[]).filter(s=>s.page===p);
    const _secAt=(x,y)=>{ let best=null,bg=Infinity,ba=null,bag=Infinity;
      for(const s of _nav){ const dx=Math.abs(s.x-x), gap=s.y-y; if(gap<-6) continue;
        if(gap<bag){bag=gap;ba=s;} if(dx<=140&&gap<bg){bg=gap;best=s;} }
      return (best||ba||{}).label||null; };
    const _rowSec=ny.map(yy=>{ const f=FM.fields.find(q=>q.page===p&&q.role==='name'&&Math.abs(q.y-yy)<0.01&&q.x>=col.min&&q.x<col.max);
      return f? _secAt(f.x,f.y) : null; });
    // a name that wraps to 2+ lines bakes its marker row near the LAST line, well below the name's
    // own (first-line) y -- e.g. PISTACHIO MOUSSE CAKE's dairy/gluten icons sit ~12pt under its own
    // baseline. _ownsArt's window is tight by design (see its own comment) to stop a dish claiming
    // its neighbour's icons, so widen it only for rows that actually wrap, by one line's worth.
    const _rowLines=ny.map(yy=>{ const f=FM.fields.find(q=>q.page===p&&q.role==='name'&&Math.abs(q.y-yy)<0.01&&q.x>=col.min&&q.x<col.max);
      return (f&&f.lines&&f.lines.length>1)? f.lines.length : 1; });
    // a row's own height: to the next name IN THE SAME SECTION, else the previous gap
    const slotH=i=>{ for(let k=i+1;k<ny.length;k++) if(_rowSec[k]===_rowSec[i]) return ny[i]-ny[k];
      for(let k=i-1;k>=0;k--) if(_rowSec[k]===_rowSec[i]) return ny[k]-ny[i];
      // last row of a section with no sibling: fall back to the gap ABOVE it rather than 0, or
      // flowBottom lands on this dish's own baseline and excludes it from its own reflow
      return i<ny.length-1? ny[i]-ny[i+1] : (i>0? ny[i-1]-ny[i] : 0); };
    const owner=y=>{ const j=cidx(y); return _ownsRun(ny[j],y,slotH(j))? j : -1; };
    // A section that shrinks must also close its own gap for every section stacked BELOW it in the
    // same column -- unlike the old column-wide clustering, slotH is section-correct now, so
    // cascading a section's total shrinkage downward can't borrow height from the wrong section.
    const _secOrder=[]; _rowSec.forEach(s=>{ if(s!=null&&_secOrder.indexOf(s)<0) _secOrder.push(s); });
    /* How far each row's OWN description pushes everything stacked beneath it. Capiche has no
       _rowId (its rows are addressed by baseline, and the section comes from nav_sections rather
       than a section model), so resolve name -> desc the same way _rowSec resolves the section:
       find the name field sitting on this row's baseline inside this column. Every entry is 0 when
       nothing is edited, which is what keeps an untouched export byte-identical. */
    const _rowName=ny.map(yy=>FM.fields.find(q=>q.page===p&&q.role==='name'&&Math.abs(q.y-yy)<0.01&&q.x>=col.min&&q.x<col.max)||null);
    const _rowGrow=_rowName.map(f=>{ const d=f&&_descByName[f.id]; return (d&&_G.byDesc[d.id])||0; });
    /* A NAME that took a second line grows its row too. Kept as its own map because it behaves
       differently from description growth in one crucial way — see the intra-row term in shiftFor. */
    const _rowNameGrow=_rowName.map(f=>(f&&_G.byName[f.id])||0);
    const _secShrink={}, _secGrow={};
    for(const k of remSet){ const s=_rowSec[k]; if(s==null) continue; _secShrink[s]=(_secShrink[s]||0)+slotH(k); }
    _rowGrow.forEach((g,i)=>{ const s=_rowSec[i]; if(g>0&&s!=null) _secGrow[s]=(_secGrow[s]||0)+g; });
    _rowNameGrow.forEach((g,i)=>{ const s=_rowSec[i]; if(g>0&&s!=null) _secGrow[s]=(_secGrow[s]||0)+g; });
    const _secOffset={}; let _running=0;
    for(const s of _secOrder){ _secOffset[s]=_running; _running+=(_secShrink[s]||0)-(_secGrow[s]||0); }
    // + moves UP (a removal closed a gap), - moves DOWN (a description above claimed more room).
    // A row's OWN growth never moves the row itself, only what is stacked under it.
    /* `ay` is the anchor's own y, needed for the INTRA-ROW term below. It is optional so the
       existing callers that shift a whole row keep working unchanged. */
    const shiftFor=(j,ay)=>{ let d=0;
      for(const k of remSet){ if(k<j && _rowSec[k]!=null && _rowSec[k]===_rowSec[j]) d+=slotH(k); }
      for(let k=0;k<j;k++){ if(_rowGrow[k]>0 && _rowSec[k]!=null && _rowSec[k]===_rowSec[j]) d-=_rowGrow[k]; }
      for(let k=0;k<j;k++){ if(_rowNameGrow[k]>0 && _rowSec[k]!=null && _rowSec[k]===_rowSec[j]) d-=_rowNameGrow[k]; }
      /* INTRA-ROW. Description growth deliberately never moves its own row: the description's Tm is
         fixed and it grows downward past it. A NAME is the opposite — its second line lands where
         the description already is, so everything in this row that sits BELOW the name's baseline
         (its description, its grams) must come down with it. Without this the marker consumers move
         the icons down while the description stays put, which is precisely how the previous attempt
         at this feature died. The PRICE is excluded by construction: it sits ~1.9pt ABOVE the name
         baseline and stays aligned with line one. */
      if(_rowNameGrow[j]>0 && ay!=null && ay < ny[j]-0.5) d-=_rowNameGrow[j];
      d+=_secOffset[_rowSec[j]]||0;
      return d; };
    // chucky-2: publish every row's shift — the name line, and what sits below it (its description)
    ny.forEach((yy,j)=>rowShift.push({cmin:col.min, cmax:col.max, y:yy, name:shiftFor(j), below:shiftFor(j,yy-1)}));
    /* The boundary is the bottom of the DISH FLOW -- the lowest name/desc field in the column, a
       description's baked extra lines discounted -- not `ny[last]-slotH(last)`. That was a guess
       derived from name pitch, and on page 0's right column it landed at 93.71: right through the
       middle of the unattached "Other prices" block, which spans y 65.85-101.55. The row at 101.55
       shifted while the three below it did not, so a reflow tore the footer list apart ("120"
       landed on "120/400"). Below the last dish's own text there is, by construction, no dish text
       -- only the legend, the strapline and that price list, none of which may ever move. This is
       strictly more conservative than what it replaces: it can skip more, never fewer.
       Computed BEFORE the delete sweep because deletes need the same boundary (see below). */
    let flowBottom = Infinity;
    for(const f of FM.fields){
      if(f.page!==p||f.y==null||f.x<col.min||f.x>=col.max) continue;
      if(f.role!=='name'&&f.role!=='desc') continue;
      const ex=(f.role==='desc'&&f.line_spans)?Math.max(0,f.line_spans.length-1):0;
      const y=f.y-(ex?Math.abs(descLead(f)*f.size)*ex:0);
      if(y<flowBottom) flowBottom=y;
    }
    if(!isFinite(flowBottom)) flowBottom = ny.length? ny[ny.length-1]-slotH(ny.length-1) : 0;
    // DELETE per run: only what the removed dish itself owns. The block's BT/colour/Tf prologue and
    // any inter-run Tc/Tw survive, so nothing downstream is re-coloured or re-spaced.
    /* Page furniture is not deletable either. slotH() is over-estimated for a section's LAST dish,
       so removing PICANTE (last of page 0's right column, slot read as ~100) put the ADD-ONS row at
       y 101.54 inside its ownership window and deleted "GHASLET HOT SAUCE" with it — and the
       containment filter in regenerate() then silently discarded addonOps' rewrite of the same
       bytes. The flowBottom rule the SHIFT pass already lives by applies verbatim here. */
    for(const r of runs){
      if(r.x<col.min||r.x>col.max) continue;
      if(r.y<flowBottom-0.05) continue;                  // page furniture, never dish-owned
      const j=owner(r.y);
      if(j>=0&&remSet.has(j)) deletes.push(r.span);
    }
    // self-contained q..Q artwork sits just ABOVE its own dish's name -> tighter window. `blocks`
    // is per-icon leaf blocks (see _leafQBlocks), so a multi-icon cluster's second/third icon each
    // carry their own accurate x/y instead of collapsing into one block keyed off the first.
    for(const b of blocks){
      if(b.kind!=='q'||b.x===null||b.y===null||b.x<col.min||b.x>col.max) continue;
      if(b.y<flowBottom-0.05) continue;                  // page furniture, never dish-owned
      const j=cidx(b.y);
      if(_ownsArt(ny[j],b.y,(_rowLines[j]-1)*16)&&remSet.has(j)) deletes.push(b.span);
    }
    for(const j of remSet) removedSlots.push({cmin:col.min,cmax:col.max,y:top(j),h:slotH(j)});
    // SHIFT per anchor, judged on its OWN y -- NOT on ownership. Chrome (section headings) must
    // still reflow with the column: a heading below a shrunk section has to rise with it, or the
    // next section's content lands on top of it. Page furniture below the last dish's own slot
    // (e.g. a legend) is the one exception and stays anchored to the page.
    for(const a of anchors){
      if(a.x===null||a.y===null||a.x<col.min||a.x>col.max) continue;
      // 0.05 epsilon: `a.y` is the stream operand (4dp) but flowBottom is built from the fieldmap's
      // round2 y (2dp). BURRATA SALAD's name Tm is 210.2057 against a flowBottom of 210.21, so a
      // hard `<` threw the NAME away as page furniture while its markers — which sit above the
      // baseline — shifted normally, and the J landed on the description.
      if(a.y<flowBottom-0.05) continue;                  // page furniture, not in the dish flow
      const j=cidx(a.y);                                 // positional: chrome reflows too
      if(remSet.has(j)&&owner(a.y)>=0) continue;         // being deleted with its own dish
      const d=shiftFor(j,a.y);
      if(Math.abs(d)<5e-4) continue;                     // was `d<=0` — growth shifts are negative
      routeShift(a,d);
    }
    // divider rules and art below a grown description ride down with the dishes they separate
    _rowGrow.forEach((g,i)=>{ if(g>0) growSlots.push({cmin:col.min,cmax:col.max,y:top(i),h:g}); });
    /* Name growth publishes a slot too, so dividers, badges and the dishes below ride down. The
       growing dish's OWN markers are not moved by it — `gs.y > nf.y` is false at its own baseline —
       which is correct, because they already follow the new last line via the rendered line count.
       Moving them here as well would drop the cluster twice. */
    _rowNameGrow.forEach((g,i)=>{ if(g>0) growSlots.push({cmin:col.min,cmax:col.max,y:top(i),h:g}); });
  }
  // mark removed items' field ids to skip in text edits
  for(const nf of removedHere){
    skip.add(nf.id);
    const it=FM.fields.filter(f=>f.page===p);
    // desc/prices belonging to this name (same column, nearest below/within slot) -- match by item grouping
  }
  for(const v of _shiftAcc.values()) if(Math.abs(v.d)>5e-4) shiftOps.push({s:v.s,e:v.e,rep:enc(fmtNum(v.y+v.d))});
  return {deletes,shiftOps,priceShift,skip,removedSlots,growSlots,fieldShift,rowShift};
}

function opsForPage(fields, priceShift, skip, fieldShift){
  priceShift = priceShift||{}; fieldShift = fieldShift||{};
  const ops=[];
  for(const f of fields){
    if(skip && skip.has(f.id)) continue;
    const hasEdit = (f.id in edits);
    const yShift = (f.role==='price') ? (priceShift[f.id]||0) : 0;
    if(!hasEdit && !yShift) continue;
    const val = hasEdit ? edits[f.id] : f.text;
    if(f.role==='price'){
      if(hasEdit) ops.push({s:f.tj_span[0],e:f.tj_span[1],rep:enc('('+escPdf(val)+')')});
      const digitChange = hasEdit && val.length!==f.text.length;
      if(digitChange || yShift){
        const [a,b,c,d,x,ff]=f.tm_vals, size=a, adv=ADV.price;
        const right = x + f.text.length*adv*size;
        const nx = right - val.length*adv*size;
        ops.push({s:f.tm_span[0],e:f.tm_span[1],rep:enc([a,b,c,d,(digitChange?nx:x),(ff+yShift)].map(fmtNum).join(' '))});
      }
    } else if(f.role==='name'){
      // budget, not the legacy max_chars — the UI gate and the emitter must agree or the field
      // accepts text it then silently truncates
      const _nex=growPlan(f.page).nameExtra[f.id]||0;
      const {lines}=wrapName(val, nameBudgetChars(f), nameMaxLines(f,_nex));
      const _nf=pageFonts(f.page), B=f.lines.length;
      /* Lines beyond the baked count are spliced INTO THE LAST BAKED LINE's first piece as
         `Tj / 0 <lead> Td / (line)` — the block's own trailing Tj closes the final one. Same trick
         the descriptions use; `Tc`/`Tw` are graphics state and survive, so only the Td is written.
         The other pieces of that line are still blanked, exactly as before. */
      f.lines.forEach((pieces,i)=>{
        let rep=nameRunPdf(lines[i]||'', _nf);
        if(i===B-1 && lines.length>B){
          for(let k=B;k<lines.length;k++){
            if(!lines[k]) continue;
            rep+='Tj\n0 '+fmtNum(nameLead(f))+' Td\n'+nameRunPdf(lines[k], _nf);
          }
        }
        ops.push({s:pieces[0][0],e:pieces[0][1],rep:enc(rep)});
        for(let k=1;k<pieces.length;k++) ops.push({s:pieces[k][0],e:pieces[k][1],rep:enc('()')});
      });
      for(const td of f.td_spans){ if(td[2]) continue; ops.push({s:td[0],e:td[1],rep:enc('0 0')}); }
    } else if(f.role==='desc'){
      // take the plan's own fit, so the lines we emit and the room we asked the column for can
      // never disagree (recomputing here would silently drift from the shift arithmetic)
      const fit=growPlan(f.page).fit[f.id]||fitDesc(f, val);
      const B=f.line_spans.length;
      let lines=fit.lines.slice();
      let last=lines.length; while(last>0 && !lines[last-1]) last--;      // drop trailing blanks
      const n=Math.max(B,last); lines=lines.slice(0,n); while(lines.length<n) lines.push('');
      // structuralForPage hands us the reflow delta for this block rather than patching the ty
      // operand itself, because the span we rewrite below CONTAINS that operand (see TM OWNERSHIP)
      const _dy=fieldShift[f.id]||0;
      if(Math.abs(fit.size-f.size)>0.005 || _dy){                          // auto-shrink -> swap the Tm size
        const tm=descTm(f);
        if(tm) ops.push({s:tm.s,e:tm.e,rep:enc(fmtNum(fit.size)+' 0 0 '+fmtNum(fit.size)+' '+fmtNum(tm.x)+' '+fmtNum(tm.y+_dy)+' Tm')});
      }
      const lead=descLead(f);
      f.line_spans.forEach((sp,i)=>{
        if(i<B-1){ ops.push({s:sp[0],e:sp[1],rep:enc('('+escPdf(lines[i]||'')+')')}); return; }
        // last baked span carries any lines beyond the baked count; the block's own Tj closes the final one
        let rep='('+escPdf(lines[i]||'')+')';
        for(let k=i+1;k<n;k++) rep+='Tj\n0 '+fmtNum(lead)+' Td\n('+escPdf(lines[k]||'')+')';
        ops.push({s:sp[0],e:sp[1],rep:enc(rep)});
      });
    }
  }
  return ops;
}

// ===================== ADD-ITEM ENGINE (appends native new items) =====================
/* ============================ ADD-ONS (the page-0 footer price list) ============================
   FM.addons (written by src/capiche/addon_data.js) records the four baked "name …leader… price"
   rows in the bottom-right of page 0 plus their measured geometry. The block is page furniture:
   it sits below flowBottom, its leader rules are pinned by furnitureRuleYs(), and the dish
   machinery never touches it. Everything here is REWRITE-ONLY — no baked block is ever deleted,
   because the group shares inherited graphics state (the first price block sets the fill and the
   0.05 Tc for every later row, and the GHASLET name block carries no Tf of its own), so deleting
   any one block would re-style the ones after it. An emptied slot is a blanked string `()` and a
   zero-length leader (a zero-length butt-cap stroke paints nothing); rows beyond the four baked
   slots are appended as self-contained blocks that set their own state. */
let addons=null;   // {rows:[{key,name,price,removed}], title:''}; stays null when FM has no addons
function addonsInit(){
  if(!FM.addons){ addons=null; return; }
  addons={ rows: FM.addons.rows.map((r,i)=>({key:'b'+i, name:r.name.text, price:(FIELD[r.price_id]||{}).text||'', removed:false})), title:'' };
}
function addonsSnap(){ return addons? { rows: addons.rows.map(r=>({key:r.key, name:r.name, price:r.price, removed:!!r.removed})), title:addons.title||'' } : null; }
/* The whole group inherits `0.05 Tc`, so a glyph really advances (0.63 + 0.05) em — proven by the
   baked price right edges, which only align on one common edge (804.15) under that advance. The
   0.63-only formula opsForPage uses for dish prices would drift these by 0.4pt per digit, which is
   why addonOps owns the block's price splices and the ids are skipped there. */
function addonAdv(){ return (0.63 + (FM.addons.tc||0)) * FM.addons.name_size; }
function addonPriceAdv(){ return (0.63 + (FM.addons.tc||0)) * FM.addons.price_size; }
function addonLive(){ return addons? addons.rows.filter(r=>!r.removed) : []; }
function addonCapacity(){   // baked slots + appended rows that still clear the red strapline
  const A=FM.addons; if(!A) return 0;
  const lastY=A.rows[A.rows.length-1].y;
  return A.rows.length + Math.max(0, Math.floor((lastY - A.floor_y - 2) / A.pitch));
}
function addonNameMax(priceText){   // chars that keep name + a minimum leader + price on one row
  const A=FM.addons;
  const priceLeft = A.right_edge - String(priceText||'').length*addonPriceAdv();
  const room = priceLeft - A.leader_end_pad - 8 - A.leader_gap - A.x;   // 8pt leader minimum
  return Math.max(0, Math.floor(room / addonAdv()));
}
/* ONE geometry function for baked and appended rows alike: the leader runs from the name's right
   edge (plus the measured gap) to just left of the price's left edge. */
function addonRowGeo(name, price){
  const A=FM.addons;
  const nameEnd = A.x + String(name||'').length*addonAdv();
  const priceLeft = A.right_edge - String(price||'').length*addonPriceAdv();
  const lx = nameEnd + A.leader_gap;
  const llen = Math.max(0, priceLeft - A.leader_end_pad - lx);
  return { nameEnd, priceLeft, lx, llen };
}
function addonOps(p){
  const A=FM.addons;
  if(!A || A.page!==p || !addons) return {ops:[], add:''};
  /* Legacy/harness compatibility: an `edits[<price_id>]` entry (the pre-panel way these four
     prices were edited — foodh.js EDITS and old autosaves still speak it) overrides the ROW that
     owns that baked price. opsForPage skips the ids, so this is the only reader. */
  const live=addonLive().map(r=>{
    const m=/^b(\d+)$/.exec(r.key);
    if(m && A.rows[+m[1]] && (A.rows[+m[1]].price_id in edits)) return Object.assign({}, r, {price: edits[A.rows[+m[1]].price_id]});
    return r;
  });
  const ops=[];
  for(let i=0;i<A.rows.length;i++){
    const slot=A.rows[i], pf=FIELD[slot.price_id];
    const want=live[i]||null;
    const name = want? want.name : '';
    const price = want? want.price : '';
    const sameName = name === slot.name.text;
    const samePrice = price === (pf?pf.text:'');
    if(sameName && samePrice) continue;                 // pristine slot: zero ops, byte-identical
    if(!sameName) ops.push({s:slot.name.tj_span[0], e:slot.name.tj_span[1], rep:enc('('+escPdf(name)+')')});
    if(!samePrice){
      ops.push({s:pf.tj_span[0], e:pf.tj_span[1], rep:enc('('+escPdf(price)+')')});
      const tv=pf.tm_vals, nx=A.right_edge - String(price).length*addonPriceAdv();
      ops.push({s:pf.tm_span[0], e:pf.tm_span[1], rep:enc([tv[0],tv[1],tv[2],tv[3],nx,tv[5]].map(fmtNum).join(' '))});
    }
    // the leader follows both of its ends whenever either changed; an emptied slot's goes to zero
    // (a row with no name AND no price is blank too, or it would draw one naked full-width line)
    const blank = !want || (!name && !price);
    const g=addonRowGeo(name, price), L=slot.leader;
    ops.push({s:L.full_span[0], e:L.full_span[1],
      rep:enc(!blank? 'q 1 0 0 1 '+fmtNum(g.lx)+' '+fmtNum(L.y)+' cm\n0 0 m\n'+fmtNum(g.llen)+' 0 l\nS\nQ'
                    : 'q 1 0 0 1 '+fmtNum(L.x)+' '+fmtNum(L.y)+' cm\n0 0 m\n0 0 l\nS\nQ')});
  }
  // rows beyond the baked slots: appended, self-contained (explicit fill, page-local font, tracking)
  let add='';
  const F=pageFonts(p), NC='0.727 0.668 0.652 0.813';
  const lastY=A.rows[A.rows.length-1].y, sz=PAGES[p]||[841.89,595.276];
  for(let k=A.rows.length;k<live.length;k++){
    const r=live[k], y=lastY - A.pitch*(k-A.rows.length+1);
    if(!r.name && !r.price) continue;                    // an empty row prints nothing
    if(y < A.floor_y + 2){ try{console.warn('addonOps: no room for add-on "'+r.name+'" below the block — skipped');}catch(_){ } continue; }
    const g=addonRowGeo(r.name, r.price);
    add += '\nBT\n'+NC+' k\n'+F.desc+' 1 Tf\n'+fmtNum(A.tc)+' Tc 0 Tw '+fmtNum(A.name_size)+' 0 0 '+fmtNum(A.name_size)+' '+fmtNum(A.x)+' '+fmtNum(y)+' Tm\n('+escPdf(r.name)+')Tj\nET';
    if(r.price) add += '\nBT\n'+F.price+' 1 Tf\n'+fmtNum(A.tc)+' Tc -0.05 Tw '+fmtNum(A.price_size)+' 0 0 '+fmtNum(A.price_size)+' '+fmtNum(g.priceLeft)+' '+fmtNum(y+0.2)+' Tm\n('+escPdf(r.price)+')Tj\nET';
    if(g.llen>0) add += '\nq\n0 '+jFmt(sz[1])+' '+jFmt(sz[0])+' '+jFmt(-sz[1])+' re\nW n\n'+NC+' K\n0.304 w \nq 1 0 0 1 '+fmtNum(g.lx)+' '+fmtNum(y-0.17)+' cm\n0 0 m\n'+fmtNum(g.llen)+' 0 l\nS\nQ\nQ';
  }
  /* optional printed heading above the first row. The artwork ships with NO heading here, so an
     empty title emits nothing and the block stays byte-identical. nameRunPdf borrows the price
     face for digits, exactly like a dish name. */
  const title=(addons.title||'').trim();
  if(title) add += '\nBT\n'+NC+' k\n'+F.name+' 1 Tf\n0 Tc 0 Tw 13 0 0 13 '+fmtNum(A.x)+' '+fmtNum(A.rows[0].y+18)+' Tm\n'+nameRunPdf(title.toUpperCase(), F)+'Tj\nET';
  return {ops, add};
}
function jFmt(v){ let s=(+v).toFixed(4).replace(/0+$/,'').replace(/\.$/,''); return s||'0'; }
function jEsc(s){ return normTypo(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }
function jStamp(parts, tx, ty){
  let out='';
  for(const p of parts){
    const b=p.bytes.replace(/1 0 0 1 -?[\d.]+ -?[\d.]+ cm/, '1 0 0 1 '+jFmt(tx+p.dx)+' '+jFmt(ty+p.dy)+' cm');
    out+=p.color+' '+b+'\n';
  }
  return out;
}
// ---- Korean-origin roundel: drawn from vector primitives (ported from Aiko), not an extracted
// PDF template -- self-contained fills/strokes only, no font resource dependency.
const FR=3.35, FCY=4.6, FD=2*FR;   // Ø≈6.7pt, centre 4.6pt above baseline
function _circ(cx,cy,r){ const k=0.5523*r,P=(a,b,c,d,e,f)=>[a,b,c,d,e,f].map(jFmt).join(' ')+' c';
  return jFmt(cx+r)+' '+jFmt(cy)+' m '+P(cx+r,cy+k,cx+k,cy+r,cx,cy+r)+' '+P(cx-k,cy+r,cx-r,cy+k,cx-r,cy)+' '+P(cx-r,cy-k,cx-k,cy-r,cx,cy-r)+' '+P(cx+k,cy-r,cx+r,cy-k,cx+r,cy)+' h'; }
function _halfdisk(cx,cy,r,top){ const k=0.5523*r,P=(a,b,c,d,e,f)=>[a,b,c,d,e,f].map(jFmt).join(' ')+' c'; const s=top?1:-1;
  return jFmt(cx-r)+' '+jFmt(cy)+' m '+P(cx-r,cy+s*k,cx-k,cy+s*r,cx,cy+s*r)+' '+P(cx+k,cy+s*r,cx+r,cy+s*k,cx+r,cy)+' h'; }
/* The Korean taegeuk's lobes meet along an S built from two half-circles of radius r/2 — NOT the
   straight diameter _halfdisk gives, which read as a flat red-over-blue disc and did not match the
   taegeuk the designer baked into the artwork. This is the RED (upper) lobe only: it rides over a
   full blue disc, so the two always share an exact seam. Red dips below the axis on the right and
   yields the left lobe to blue, matching the baked flag. */
function _taeguk(cx,cy,r){ const h=r/2, k=0.5523*r, kh=0.5523*h;
  const P=(a,b,c,d,e,f)=>[a,b,c,d,e,f].map(jFmt).join(' ')+' c';
  return jFmt(cx-r)+' '+jFmt(cy)+' m '
    + P(cx-r,cy+k,    cx-k,cy+r,    cx,cy+r)    + ' '   // over the top, left to right
    + P(cx+k,cy+r,    cx+r,cy+k,    cx+r,cy)    + ' '
    + P(cx+r,cy-kh,   cx+h+kh,cy-h, cx+h,cy-h)  + ' '   // dip under the axis on the right
    + P(cx+h-kh,cy-h, cx,cy-kh,     cx,cy)      + ' '
    + P(cx,cy+kh,     cx-h+kh,cy+h, cx-h,cy+h)  + ' '   // arc over the left lobe, leaving it blue
    + P(cx-h-kh,cy+h, cx-r,cy+kh,   cx-r,cy)    + ' h'; }
function flagBody(c){
  const CX=FR, CY=FCY, L=CX-FR, B=CY-FR, D=FD;
  const f=(col,p)=>col+' rg\n'+p+'\nf\n';
  /* Korea is not a rectangular flag squeezed into a circle — in the baked artwork the taegeuk IS
     the whole icon: full-bleed, no white field, no border ring. Drawing it like the others left a
     small disc rattling inside a grey ring, which is not what the printed menu shows. */
  if(c==='korea') return f('0.13 0.23 0.46',_circ(CX,CY,FR))+f('0.8 0.18 0.23',_taeguk(CX,CY,FR));
  let s='q\n'+_circ(CX,CY,FR)+'\nW n\n';
  s+='Q\n';
  s+='0.42 0.4 0.36 RG\n0.35 w\n'+_circ(CX,CY,FR)+'\nS\n';
  return s;
}
// Stamp a dish's marker set at its name-baseline anchor (bx0,Yb). Mirrors the baked packing:
// absolute per-icon offsets from add_const, so a re-stamp lands exactly where the originals were.
/* Marker row geometry. The row FLOWS on a cursor rather than using the baked `icon_*` offsets:
   those are the designer's hand-placed positions (0 / 5.52 / 7.93 / 12 / 39.67), so the gaps were
   uneven and removing a marker left a hole instead of closing up.

   Two things make an even flow possible:
     - `jStamp` places a template by its ORIGIN, and every template carries a different bearing, so
       packing on origins is exactly what produced the uneven gaps. `iconBox()` gives each glyph's
       REAL ink extent, and the cursor is aligned to the ink LEFT EDGE.
     - The baked `dy` values (4.33 / 5.94 / 3.4 / 9.6) are per-glyph bearing compensations, NOT
       spacing. They are replaced by seating every icon's ink CENTRE on one shared line. */
const MARKER_MID = 4.94;   // shared ink centre, above the name baseline (from the flame: 1.51..8.36)
/* CALIBRATED, not chosen. MARKER_GAP is the largest uniform ink-to-ink gap that keeps every marker
   combination clear of the price on every dish:
       G = min over dishes of (room - widest combination's ink) / (markers - 1)
       room = priceLeft - MARKER_CLEAR - clusterStart
   Solved over all 37 dishes x all 31 allergen combinations it gives 2.18pt, bound by dish 1:27
   SPICY TOMATO & CREAM, which has 31.4pt of room and needs exactly 31.4pt for all five.
   Re-derive with test/markers.matrix.mjs --calibrate if the artwork or the icon set ever changes.
   Sanity: the designer's own baked inter-icon gaps measure 2.16-2.30pt, so the calibration lands
   inside the artwork's own spacing rather than overriding it. The previous 3.0pt was a round
   number that overran the price on three dishes. */
const MARKER_GAP   = 2.18;
const MARKER_CLEAR = 2.0;    // ink slack required between the last marker and the price
/* The Jain "J" is TEXT, so no path parser can measure it and its metrics must be declared.
   Values are render-measured (600dpi, isolated, differential) and expressed relative to the text
   ORIGIN, then reduced by the same ~0.075pt-per-side antialias bleed that makes iconBox read
   uniformly 0.14-0.17pt narrower than rendered ink — so the J is described on the same basis as
   the vector markers it has to line up with.
     lsb    ink starts this far RIGHT of the text origin (the bug this replaces: the cursor was
            treated as the ink edge, so every gap before the J was ~0.36pt too wide)
     w      ink width. NOT the font advance (5.085) - the old JAIN_W=4.5 was neither.
     cy     ink centre above the text baseline, used to seat it on MARKER_MID */
const JAIN_GEO = { lsb: 0.535, w: 3.930, cy: 3.126 };
/* Ink geometry of one marker, in ONE vocabulary for all three kinds of marker, so the flow never
   has to special-case a bearing:
     ox  ink LEFT edge, relative to the point the renderer is handed
     cy  ink CENTRE, relative to that same point
     w   ink width
   The renderer therefore always stamps at (inkLeft - ox, mid - cy), whether the artwork is a
   vector template placed by its `cm` origin, a text glyph placed by its baseline origin, or the
   lifted chilli placed by its ink bottom. Mixing those three conventions is what produced uneven
   gaps: the J alone was positioned by origin while everything else was positioned by ink. */
function markerGeom(t){
  if(t === 'jain')   return { kind:'glyph',  ox: JAIN_GEO.lsb, w: JAIN_GEO.w, cy: JAIN_GEO.cy };
  if(t === 'chilli'){ const T = chilliTemplate(); if(!T) return null;
                      const s = T.h > 0 ? CHILLI_H / T.h : 1;
                      // chilliStamp is handed the ink LEFT edge and the ink BOTTOM
                      return { kind:'chilli', ox: 0, w: T.w * s, cy: CHILLI_H / 2 }; }
  const nm = (t === 'new') ? 'newbadge' : t;
  const bx = iconBox(nm);
  if(!bx || !ICONS[nm]) return null;
  return { kind:'template', ox: bx.minX, w: bx.w, cy: bx.minY + bx.h/2, name: nm };
}
/* Where each selected marker's INK goes. Pure: no PDF, no side effects, so the layout can be
   asserted directly and the emitter cannot disagree with the measurement.
   Vertical is a function of (baseline, this marker) ONLY — never of the siblings present — which
   is the invariance the marker row is required to hold when a sibling is toggled. */
function layoutMarkers(set, bx0, Yb){
  const out = []; let cur = bx0;
  for(const t of MARKER_TYPES){
    if(!set.has(t)) continue;
    const g = markerGeom(t);
    if(!g) continue;
    out.push({ id: t, geom: g, inkLeft: cur, inkRight: cur + g.w, mid: Yb + MARKER_MID });
    cur += g.w + MARKER_GAP;
  }
  return out;
}
/** Total ink width of a marker set, gaps included — the number capacity checks compare against. */
function clusterWidth(set){
  const L = layoutMarkers(set instanceof Set ? set : new Set(set), 0, 0);
  return L.length ? L[L.length - 1].inkRight : 0;
}
/* ---- RUN TRACKING (Tc) -----------------------------------------------------------------------
   The baked name runs are set with `0.05 Tc -0.05 Tw`, so a character does NOT advance
   `ADV.name * size`. In PDF the displacement is `(w0/1000 * Tfs + Tc + Tw) * Th`, and these runs
   put the point size in the Tm (`/T1_3 1 Tf … 13 0 0 13 … Tm`), so one character advances
   `(0.63 + Tc) * size` — 8.84pt at size 13, not 8.19pt. Ignoring Tc under-measured every name by
   7.9%, which is why setting a name to exactly its advertised budget pushed the marker row past
   the price on 23 of 37 dishes: the budget was computed from a width that was too small.

   Measured, not assumed: Tc is read per field from the stream, because it is inherited graphics
   state (36 of 37 names inherit 0.05, JAMUN CHEESECAKE inherits 0). Tw is deliberately NOT applied
   — it only affects spaces, it is never positive here, so ignoring it over-estimates width very
   slightly, which is the safe direction for a capacity budget. */
function readRunTracking(){
  for(const f of FM.fields){
    if(f.role!=='name' && f.role!=='desc') continue;
    const spans = f.lines ? f.lines.flat() : (f.line_spans||[]);
    const first = spans.length ? (Array.isArray(spans[0]) ? spans[0][0] : spans[0]) : null;
    if(first==null) continue;
    /* The LAST Tc set before this run wins. Found by scanning back from the run rather than with a
       negative-lookahead regex, which would be quadratic over a 300KB stream. */
    const t = pageText(f.page);
    const i = t.lastIndexOf(' Tc', first);
    let tc = 0;
    if(i > 0){
      const m = /(-?[\d.]+)\s*$/.exec(t.slice(Math.max(0, i-24), i));
      if(m) tc = parseFloat(m[1]);
    }
    f.tc = isFinite(tc) ? tc : 0;
  }
}
/** Advance of one name character, tracking included. */
function nameAdv(f){ return (((typeof ADV!=='undefined'&&ADV&&ADV.name)||0.63) + (f.tc!=null?f.tc:0.05)) * (f.size||13); }
/** Rendered width of a name string on this field. */
function nameWidth(f, s){ return String(s==null?'':s).length * nameAdv(f); }

/* ---- STRAY BAKED MARKERS ---------------------------------------------------------------------
   `fieldmap.json` does not record every marker that is actually printed. Three dishes carry a
   baked CHILLI whose bytes fall outside every span in `markerSpans` — BURRATAHOTHONEY (0:8),
   HELL BOY (0:28) and PICANTE (0:30). The fieldmap builder classifies markers by first-path
   signature and never learned the pepper, so for those dishes:
     - the chilli chip read OFF while the menu printed a chilli;
     - nothing deleted it, so it could not be removed;
     - switching chilli ON stamped a SECOND pepper beside the baked one.
   Found by rendering: a marker-cleared export still showed a red pepper on those rows.

   Rather than special-case them, adopt the artwork into the fieldmap at boot. Every downstream
   consumer — dishMarkers(), the chips, the delete pass, capacity — then behaves as if the builder
   had recorded it, with no extra code path to keep in step.

   A group qualifies only if it sits in a dish's own marker row, is not covered by a recorded span,
   and is not part of a NEW badge (whose letters are separate groups that badgeOps owns). */
function strayMarkerGroups(bytes, page){
  const s = new TextDecoder('latin1').decode(bytes);
  const badge = _badges(bytes);
  const names = FM.fields.filter(f => f.page === page && f.role === 'name' && f.markerBase);
  const re = /q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/g;
  const out = []; let m;
  while((m = re.exec(s))){
    const x = +m[1], y = +m[2], gs = m.index;
    const ge = s.indexOf('\nQ\n', gs) + 3;
    if(ge < 3) continue;
    if(badge.some(b => gs >= b.span[0] && gs < b.span[1])) continue;      // badgeOps owns this
    for(const f of names){
      const nl = (f.lines||[]).length || 1;
      const base = f.markerBase[1] - (nl-1)*(f.size||13)*1.2;
      if(Math.abs(y - (base + MARKER_MID)) > 5) continue;                 // not on this dish's row
      const x0 = clusterStart(f);
      if(x < x0 - 4 || x > x0 + 80) continue;                             // not in the marker run
      if(Object.values(f.markerSpans||{}).some(sp => gs >= sp[0] && gs < sp[1])) continue;
      out.push({ field: f, span: [gs, ge], x: x, y: y });
      break;
    }
  }
  return out;
}
function adoptStrayMarkers(){
  let n = 0;
  for(let p = 0; p < pageStreams.length; p++){
    for(const g of strayMarkerGroups(pageStreams[p].pristine, p)){
      const f = g.field;
      if((f.markers||[]).includes('chilli')) continue;      // already known
      f.markers = [...(f.markers||[]), 'chilli'];
      f.markerSpans = Object.assign({}, f.markerSpans, { chilli: g.span });
      n++;
      try{ console.warn('adopted an unrecorded baked chilli on '+f.id+' '+(f.display||'').trim()); }catch(_){ }
    }
  }
  return n;
}
const MARKER_LEAD = 6;   // gap from the name's ink to the first marker's ink
/* Where the row's INK starts. `markerBase` is the designer's stamp ORIGIN for the dairy bottle,
   whose ink begins 3.2pt to its LEFT — so anchoring the flow at markerBase pushed every re-stamped
   cluster 3.2pt right of where the artwork had it. Offsetting by dairy's own bearing reproduces
   the designer's position exactly, which is also what makes the capacity arithmetic below agree
   with the room the baked layout actually uses. */
function clusterStart(f){
  const d = markerGeom('dairy');
  return f.markerBase[0] + (d ? d.ox : 0);
}
/* ---- CAPACITY -------------------------------------------------------------------------------
   Some dishes physically cannot hold every marker. Dish 1:27 SPICY TOMATO & CREAM has 31.4pt
   between its cluster start and its price; the five allergen markers need exactly 31.4pt at the
   calibrated gap, and the NEW badge alone is another 20.16pt. Measured across the menu: 30 of the
   33 price-constrained dishes fit every combination, and every combination that does not fit
   contains `new`.
   No layout rule can create that width, so the editor refuses the set instead of printing a
   collision. Same shape as secCapacity() for adding dishes: the UI declines to reach the state. */
function priceLeftFor(f){
  const a = f.markerBase ? f.markerBase[0] : f.x;
  let best = null;
  for(const q of FM.fields){
    if(q.role !== 'price' || q.page !== f.page) continue;
    if(Math.abs(q.y - f.y) >= 8 || q.x <= a) continue;
    if(best === null || q.x < best) best = q.x;
  }
  return best;
}
/* Where this dish's marker row ACTUALLY starts, given the name it currently carries.
   `clusterStart` is the designer's baked anchor; a re-stamped dish slides that by the change in
   name length and is then floored at the name's own right edge. Capacity has to be measured against
   the same number the row is drawn at, or the two disagree: judging a shortened name against the
   baked anchor refused marker sets that would have fitted comfortably — SPICY TOMATO & CREAM
   gains ~44pt of room from dropping five characters, and the chip stayed disabled anyway. */
/* The gap this dish's ARTWORK leaves between the end of the name and the start of the icons.
   `MARKER_LEAD` is a house minimum, but it must never exceed what the designer actually used:
   CHILLI BUTTER CORN leaves 4.4pt, so enforcing 6pt made the dish's own baked name too long for
   its own row. Never widen a dish's gap beyond the artwork's; only narrow it to the house value. */
function nameLeadFor(f){
  if(f._nlgap!=null) return f._nlgap;
  const baked=bakedNameLines(f), last=(baked.length?baked[baked.length-1]:'').trim();
  const g=clusterStart(f) - (f.x + nameWidth(f, last));
  return (f._nlgap = (isFinite(g) && g>0) ? Math.min(MARKER_LEAD, g) : MARKER_LEAD);
}
function rowAnchor(f){
  const cur = (typeof edits!=='undefined' && f.id in edits) ? edits[f.id] : f.display;
  // honour a granted second line: the icons sit beside the LAST line, which a wrapped name makes
  // much shorter — that shorter line is exactly what frees the room a badge needs
  const budget = nameBudgetChars(f), nl = nameMaxLines(f, growPlan(f.page).nameExtra[f.id]||0);
  const lastOf = v => (wrapName(String(v==null?'':v), budget, nl).lines.filter(Boolean).pop() || '');
  /* `was` is the ARTWORK's last line, read from the stream — not the display re-wrapped at the
     current line budget. Re-wrapping made the comparison self-referential: granting a second line
     changed `was` too, so `dx` measured the shift against a baseline that had itself moved. On
     SPICY TOMATO & CREAM that slid the cluster 53pt right, straight through the price. */
  const now = lastOf(cur), was = bakedLastLine(f);
  const dx = (typeof edits!=='undefined' && f.id in edits) ? (now.length - was.length) * nameAdv(f) : 0;
  return Math.max(clusterStart(f) + dx, f.x + nameWidth(f, now) + nameLeadFor(f));
}
/** Usable ink width for this dish's marker row, or Infinity when no price bounds it. */
function markerRoom(f){
  if(!f || !f.markerBase) return Infinity;
  const pl = priceLeftFor(f);
  if(pl === null) return Infinity;
  return (pl - MARKER_CLEAR) - rowAnchor(f);
}
/** Does this marker set fit on this dish? */
function markerFits(f, set){ return clusterWidth(set) <= markerRoom(f) + 1e-6; }
/** The markers that can still be ADDED to `set` on this dish, in print order. */
function markerRoomFor(f, set){
  const have = set instanceof Set ? set : new Set(set);
  return MARKER_TYPES.filter(t => have.has(t) || markerFits(f, new Set([...have, t])));
}
function stampMarkers(bx0, Yb, set, page){
  const C=AC, F=pageFonts(page), IC=C.ink_color; let out='';
  const jf=F.j;   // AOMonoBold resource name differs per page (pageFonts folds in jfont_by_page)
  for(const m of layoutMarkers(set, bx0, Yb)){
    const g = m.geom;
    const X = m.inkLeft - g.ox, Y = m.mid - g.cy;   // one rule for every marker kind
    if(g.kind === 'chilli')      out += chilliStamp(X, Y);
    else if(g.kind === 'glyph')  out += 'BT\n'+IC+'\n'+jf+' 1 Tf\n0 Tc 0 Tw '+C.j_size+' 0 0 '+C.j_size+' '+jFmt(X)+' '+jFmt(Y)+' Tm\n(J)Tj\nET\n';
    else                         out += jStamp(ICONS[g.name], X, Y).trim()+'\n';
  }
  /* No icon template carries a fill of its own, so a cluster inherits whatever colour the previous
     drawing left set. Every dish is now re-stamped into ONE appended string, so a red template (the
     Ghaslet flame) leaked red into every dish below it — BURRATAHOTHONEY carries only dairy+gluten,
     both black, and printed its wheat in red. Pin the menu's ink at the head of each cluster. The
     chilli and the NEW badge set their own colours inside their own q..Q, so neither leaks onward. */
  return out ? (IC + '\n' + out) : '';
}
/* ---- CHILLI: the menu's fifth legend marker -------------------------------------------------
   Unlike dairy/gluten/spicy, CHILLI has no extracted template in `FM.icons`, so its artwork is
   lifted from the legend strip at the foot of page 0 and re-stamped verbatim — the designer's own
   vector, never redrawn and never rasterised. Three things this must get right, all learned from
   Aiko's Korea flag:
     1. The `cm` origin is an anchor INSIDE the glyph — the ink runs from x-7.455 to x+0.709 — so
        the visible LEFT EDGE is aligned to the cursor, not the origin.
     2. The group carries no fill of its own and would inherit whatever the page last set (that is
        how an added gluten icon once printed gold), so the colour is pinned explicitly.
     3. The fill is CMYK. Capiche's legend art is `0 0.993 1 0 k`, NOT the `rg` Korea uses — the
        wrong operator here silently prints the wrong colour space. */
/* Ink box of any ICONS template. A flowing marker row needs each glyph's REAL extent: `jStamp`
   places a template by its ORIGIN, and every template carries a different bearing, so packing on
   origins alone gives uneven gaps.

   This PARSES THE PATH. The previous version stringified the template and regex-scraped every
   number in pairs, which is wrong in two ways that both showed up as uneven spacing:
     - non-geometry numbers became coordinates. Every part is framed by `q 1 0 0 1 X Y cm`, and
       that identity matrix contributed the pair (1,0), so DAIRY's maxX read 1.000 instead of its
       true 0.480 and its width came out 0.52pt too wide — the measured dairy->gluten gap was 3.48
       against an intended 3.00. The CMYK `color` string donated pairs like (0.746, 0.676) too.
     - it ignored each part's dx/dy, which jStamp DOES apply. The NEW badge is four parts offset by
       0 / -13.3033 / -11.4227 / -6.0445, so its width read 23.12 against a true 20.02. That was
       harmless only because `new` prints last.
   It also assumed every part contributes an even count of numbers; one odd part would have swapped
   x and y for every part after it.

   Bezier control points are NOT used as bounds — a cubic stays inside its hull, so the hull
   overstates a curved glyph relative to a straight-edged one, which is exactly the kind of
   per-marker bias that makes gaps look uneven. Real extrema are solved instead. */
function _cubicExtrema(p0, p1, p2, p3){
  const out = [p0, p3];
  const a = 3*(-p0 + 3*p1 - 3*p2 + p3), b = 6*(p0 - 2*p1 + p2), c = 3*(p1 - p0);
  const at = t => { const u = 1-t; return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3; };
  if(Math.abs(a) < 1e-9){ if(Math.abs(b) > 1e-9){ const t = -c/b; if(t > 0 && t < 1) out.push(at(t)); } }
  else { const d = b*b - 4*a*c;
         if(d >= 0){ const r = Math.sqrt(d);
           for(const t of [(-b+r)/(2*a), (-b-r)/(2*a)]) if(t > 0 && t < 1) out.push(at(t)); } }
  return out;
}
/* Ink box of ONE template part, in that part's own coordinates (i.e. relative to its `cm` origin,
   which is what jStamp rewrites). Understands the operator vocabulary these templates actually
   use — m l c h re — and ignores everything else, so colour operands can never be read as points. */
function _partBox(bytes){
  const body = String(bytes || '').replace(/q\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+cm/, ' ');
  const tok = body.split(/\s+/).filter(Boolean);
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  const hit = (x, y) => { if(x < mnx) mnx = x; if(x > mxx) mxx = x; if(y < mny) mny = y; if(y > mxy) mxy = y; };
  const nums = [];
  let cx = 0, cy = 0;
  for(const t of tok){
    if(/^-?\d*\.?\d+$/.test(t)){ nums.push(+t); continue; }
    if(t === 'm' || t === 'l'){
      const y = nums.pop(), x = nums.pop();
      if(x != null && y != null){ hit(x, y); cx = x; cy = y; }
    } else if(t === 'c'){
      const p = nums.splice(-6);
      if(p.length === 6){
        for(const v of _cubicExtrema(cx, p[0], p[2], p[4])) hit(v, cy);      // x extrema
        for(const v of _cubicExtrema(cy, p[1], p[3], p[5])) hit(cx, v);      // y extrema
        // the two passes above pin each axis independently; corners are covered by the endpoints
        hit(p[4], p[5]); cx = p[4]; cy = p[5];
      }
    } else if(t === 're'){
      const p = nums.splice(-4);
      if(p.length === 4){ hit(p[0], p[1]); hit(p[0]+p[2], p[1]+p[3]); }
    }
    nums.length = 0;   // operands belong to the operator that just consumed them
  }
  return isFinite(mnx) ? { minX: mnx, maxX: mxx, minY: mny, maxY: mxy } : null;
}
const _iconBox = {};
function iconBox(name){
  if(_iconBox[name] !== undefined) return _iconBox[name];
  const t = ICONS && ICONS[name];
  if(!t || !Array.isArray(t)) return (_iconBox[name] = null);
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for(const p of t){
    const b = _partBox(p && p.bytes);
    if(!b) continue;
    const dx = +p.dx || 0, dy = +p.dy || 0;      // jStamp applies these; the measurement must too
    if(b.minX + dx < mnx) mnx = b.minX + dx;
    if(b.maxX + dx > mxx) mxx = b.maxX + dx;
    if(b.minY + dy < mny) mny = b.minY + dy;
    if(b.maxY + dy > mxy) mxy = b.maxY + dy;
  }
  if(!isFinite(mnx) || !isFinite(mny)) return (_iconBox[name] = null);
  return (_iconBox[name] = { minX: mnx, w: mxx - mnx, minY: mny, h: mxy - mny });
}
const CHILLI_FILL = '0 0.993 1 0 k';
let _chilliTpl;
function chilliTemplate(){
  if(_chilliTpl !== undefined) return _chilliTpl;
  for(let pg = 0; pg < pageStreams.length; pg++){
    const t = pageText(pg);
    const m = /q 1 0 0 1 (34\.07\d*) (21\.70\d*) cm/.exec(t);
    if(!m) continue;
    const gs = m.index, ge = t.indexOf('\nQ\n', gs) + 3;
    if(ge < 3) continue;
    const body = t.slice(gs, ge);
    // measured by the same path parser as every other marker (_partBox), so chilli's extent is
    // derived on the same basis as the icons it has to line up with. The previous number-scrape
    // read the fill colour's operands as coordinates, exactly as iconBox once did.
    const b = _partBox(body);
    if(!b) continue;
    return (_chilliTpl = { body: body, minX: b.minX, minY: b.minY,
                           w: b.maxX - b.minX, h: b.maxY - b.minY });
  }
  return (_chilliTpl = null);
}
/* The legend draws this pepper at ~9.79pt tall — roughly twice the height of the icons that sit in a
   dish row, which is why the unscaled stamp both dwarfed its neighbours and ran into the NEW badge.
   Scale it to the cluster's own icon height and let the width follow, so it reads as one of the set. */
const CHILLI_H = 6.2;
function chilliStamp(cur, baseline){
  const T = chilliTemplate();
  if(!T) return '';
  const s = (T.h > 0) ? (CHILLI_H / T.h) : 1;
  // the cm scales the glyph's own coordinates, so the translate has to carry the SCALED bbox offset
  const x = cur - T.minX * s, y = baseline - T.minY * s;   // left ink edge on `cur`, ink bottom on `baseline`
  const b = T.body.replace(/q 1 0 0 1 [\d.]+ [\d.]+ cm/,
                           'q ' + jFmt(s) + ' 0 0 ' + jFmt(s) + ' ' + jFmt(x) + ' ' + jFmt(y) + ' cm');
  return 'q\n' + CHILLI_FILL + '\n' + b + 'Q\n';           // own q..Q so the fill cannot leak onward
}
function chilliWidth(){ const T = chilliTemplate(); return T ? T.w * (CHILLI_H / T.h) : 0; }
/* ---- PER-PAGE FONT RESOURCES ----------------------------------------------------------------
   Font resource names (/T1_0, /TT2 …) are PAGE-LOCAL in PDF: the same name means different fonts on
   different pages. `add_const.fonts` is a single global map, so an added dish was stamped with page
   1's names wherever it landed. On page 0 that made `/T1_0` — a serif face with an incompatible
   encoding — render the description as "TOMATO, <notdef>SIL, MOZZARELLA" instead of "TOMATO, BASIL,
   MOZZARELLA". The bytes were valid; only the glyphs were wrong, which is why no byte-level test
   caught it.
   The codebase already knew this for one glyph — `FM.jfont_by_page` exists for exactly this reason —
   so this generalises that idea to name/desc/price by reading the resource the page's OWN baked
   fields use. Falls back to add_const.fonts when a page has no baked field of that role. */
const _pgFonts={};
function pageFonts(p){
  if(_pgFonts[p]) return _pgFonts[p];
  const F=AC.fonts, out={name:F.name, desc:F.desc, price:F.price, j:F.j};
  const t=pageText(p);
  const firstOff=f=> f.lines ? (f.lines[0]&&f.lines[0][0]&&f.lines[0][0][0])
                  : f.line_spans ? (f.line_spans[0]&&f.line_spans[0][0])
                  : (f.tj_span&&f.tj_span[0]);
  for(const role of ['name','desc','price']){
    const f=FM.fields.find(q=>q.page===p&&q.role===role);
    const off=f&&firstOff(f); if(off==null) continue;
    // scan the WHOLE prefix, not a fixed window: Illustrator sets a font once and draws a long run
    // under it, so on some pages the nearest `Tf` is thousands of bytes back (a 400-byte window
    // finds nothing there and silently falls back to the wrong global).
    const m=(t.slice(0,off).match(/\/[A-Za-z0-9_]+ 1 Tf/g)||[]).pop();
    if(m) out[role]=m.replace(/ 1 Tf$/,'');
  }
  out.j=(FM.jfont_by_page&&FM.jfont_by_page[p])||out.j;
  return _pgFonts[p]=out;
}
function addItemHeight(it,sec){ // total vertical space this item needs (name + desc lines)
  const dl=wrapDesc((it.desc||'').toUpperCase(), addDescChars(sec), 2).lines.filter(Boolean).length;
  return Math.max(sec.slot, 24 + (dl-1)*9.0);
}
function buildItemJS(it, sec, Y){
  const NX=sec.col_x, SZ=sec.name_size||13, adv=0.63*SZ;   // exact AO-Mono advance (630/1000 em)
  const C=AC, F=pageFonts(sec.page), NC=C.name_color, IC=C.ink_color;   // page-local resources, NOT the global map
  const DDY=(sec.desc_dy!=null?sec.desc_dy:C.desc_dy);
  const nm=(it.name||'').toUpperCase();
  let p=[];
  // nameRunPdf borrows the price face for digits, so an ADDED dish can carry a number too — without
  // it the name face has no digit outlines and a "PIZZA 4" would print with a blank where the 4 is
  p.push('BT\n'+NC+'\n'+F.name+' 1 Tf\n0 Tc 0 Tw '+SZ+' 0 0 '+SZ+' '+jFmt(NX)+' '+jFmt(Y)+' Tm\n'+nameRunPdf(nm, F)+'Tj\nET');
  const dlines=wrapDesc((it.desc||'').toUpperCase(), addDescChars(sec), 2).lines.filter(Boolean);
  if(dlines.length){
    let d='BT\n'+NC+'\n'+F.desc+' 1 Tf\n0 Tw '+C.desc_size+' 0 0 '+C.desc_size+' '+jFmt(NX)+' '+jFmt(Y+DDY)+' Tm\n('+jEsc(dlines[0])+')Tj';
    for(let i=1;i<dlines.length;i++) d+='\n0 -1.385 Td\n('+jEsc(dlines[i])+')Tj';   // 1.385 x 6.5 = 9.0pt, matches the real menu
    d+='\nET'; p.push(d);
  }
  const drawPrice=(val,rightX)=>{ val=String(val||''); if(!val) return; const pw=val.length*C.adv_price*C.price_size, px=rightX-pw;
    p.push('BT\n'+NC+'\n'+F.price+' 1 Tf\n-0.05 Tw '+C.price_size+' 0 0 '+C.price_size+' '+jFmt(px)+' '+jFmt(Y+1.89)+' Tm\n('+jEsc(val)+')Tj\nET'); };
  drawPrice(it.price, sec.price_right);
  if(sec.price_right_2!=null) drawPrice(it.price2, sec.price_right_2);
  /* Markers go through the SAME layout engine as an edited dish — stampMarkers/layoutMarkers.
     This path used to be a second implementation on the baked absolute slots (icon_dairy /
     icon_gluten / icon_j / icon_badge), which meant two things: an added dish's cluster was spaced
     differently from every edited dish's, and `spicy` and `chilli` were never emitted at all even
     though the ADD form offers both (it builds its checkboxes from MARKER_TYPES). A dish added with
     Ghaslet or Chilli silently lost it. */
  /* `adv` (0.63*SZ) is correct HERE and only here: an added dish stamps its own `0 Tc 0 Tw` above,
     so its characters really do advance 0.63*SZ. A baked dish inherits `0.05 Tc` and advances
     0.68*SZ, which is why edited dishes need nameWidth()/nameAdv() instead. Consequence worth
     noting: an added name renders 7.9% narrower than a baked one at the same size. */
  const bx=NX+nm.length*adv+MARKER_LEAD, al=new Set(it.allergens||[]);
  p.push(stampMarkers(bx, Y, al, sec.page).trim());
  /* An appended dish draws the rule that separates it from the dish above — but only if the artwork
     does not already have one there. In the RIGHT section of page 0 the appended item lands 1.2pt
     from a baked divider, and drawing anyway put TWO rules on top of each other, reading as one
     thick line above the new dish. Tolerance is 3pt: rules in this menu are ~0.46pt thick and real
     neighbouring dividers are tens of points apart, so nothing legitimate is suppressed. */
  const _ry=Y+19.5;
  const _dupRule=(dividersFor(sec.page)||[]).some(d=>{
    const dx=(d.x!=null)?d.x:parseFloat(d.xs), dw=(d.w!=null)?d.w:parseFloat(d.ws);
    return Math.abs(d.y-_ry)<3 && NX>=dx-8 && NX<=dx+dw+8;
  });
  if(!_dupRule) p.push('0.727 0.668 0.652 0.813 K\n0.464 w\nq 1 0 0 1 '+jFmt(NX)+' '+jFmt(_ry)+' cm\n0 0 m\n'+jFmt(sec.divider_w)+' 0 l\nS\nQ');
  const sz=PAGES[sec.page]||[841.89,595.276], W=sz[0], H=sz[1];
  return '\nq\n0 '+jFmt(H)+' '+jFmt(W)+' '+jFmt(-H)+' re\nW n\n'+p.join('\n')+'\nQ\n';
}
function appendedForPage(p, removedSlots, growSlots){
  if(!added.length) return '';
  let bySec={};
  added.forEach(it=>{ const s=SECTIONS[it.sec]; if(s && s.page===p){ (bySec[it.sec]=bySec[it.sec]||[]).push(it); } });
  let out='';
  for(const si in bySec){
    const sec=SECTIONS[si];
    let shift=0;  // ride the same reflow as the section's items when something above was removed
    for(const rs of (removedSlots||[])){ if(sec.col_x>=rs.cmin && sec.col_x<rs.cmax && rs.y>sec.last_y) shift+=Math.abs(rs.h); }
    /* ...and a description ABOVE that claimed another line pushes the append point down by exactly
       as much, or the new dish lands on top of the one it is supposed to follow. */
    for(const gs of (growSlots||[])){ if(sec.col_x>=gs.cmin && sec.col_x<gs.cmax && gs.y>sec.last_y) shift-=Math.abs(gs.h); }
    const _col=pageColumns(p).find(c=>sec.col_x>=c.min&&sec.col_x<c.max);
    const _floor=_col? colGeo(p,_col).floor : null;
    let cy=sec.last_y+shift;
    let prevName=sec.last_name_lines||1, prevDesc=sec.last_desc_lines||1;
    for(const it of bySec[si]){
      const dist = sec.slot + (prevDesc-2)*9.0 + (prevName-1)*13.5;   // gap depends on the PREVIOUS item's height
      cy -= dist;
      const _dl=wrapDesc((it.desc||'').toUpperCase(),addDescChars(sec),2).lines.filter(Boolean).length;
      const _bottom=cy-9.0*_dl-2;  // this item's own lowest ink, not just its name baseline
      // backstop: never run an appended dish off the bottom of its column onto the page legend.
      // growPlan charges added items against the budget first, so this should be unreachable —
      // which is exactly why it must be loud rather than a silent truncation.
      // Report, but still place it: silently dropping a dish the user deliberately added is
      // worse than printing it tight, and ADD behaviour must not change just because growth exists.
      if(_floor!=null && _bottom<_floor+DESC_CLEAR){ try{console.warn('appendedForPage: no room for "'+(it.name||'')+'" below '+(sec.label||sec.col_x)+' — skipped');}catch(_){ } }
      out += buildItemJS(it,sec,cy);
      prevName = 1; prevDesc = wrapDesc((it.desc||'').toUpperCase(),addDescChars(sec),2).lines.filter(Boolean).length;
    }
  }
  return out;
}


// ---- DIVIDER ENGINE: dividers are decoupled from icon-bundling blocks and positioned by their OWN y ----
function _dividerLines(bytes){
  const s = new TextDecoder('latin1').decode(bytes);
  const re = /q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\s+0 0 m\s+([\d.]+) 0 l\s+S\s+Q/g;
  const out=[]; let m;
  while((m=re.exec(s))){ out.push({x:+m[1], y:+m[2], w:+m[3], xs:m[1], ws:m[3], full:[m.index, m.index+m[0].length]}); }
  return out;
}
/* Baselines that belong to the page's own furniture, not to any dish: each unattached "Other
   prices" row carries a LEADER RULE on its own baseline (the dotted run between the label and the
   price). Those rules are dividers as far as `_dividerLines` can tell, so a reflow used to ride
   them up or down while the price text beside them stayed put — the footer list visibly came apart.
   Matching on the shared baseline is what distinguishes them from the full-width rule that closes
   the last dish's row, which sits in the same region and DOES have to move. */
function furnitureRuleYs(p){
  const ex=(itemsForPage(p).extras)||[];
  return ex.map(x=>x.y);
}
function dividerOps(divs, removedSlots, growSlots, pinnedYs){
  // Each divider sits just ABOVE the item it precedes (~0.4*pitch above the name top);
  // the first item of a section has no divider above it (section header sits there).
  // Removing an item must consume exactly ONE divider:
  //   - normal item -> the divider directly above its top
  //   - first item  -> the divider directly BELOW its top (above the next item), else
  //                    that line survives and parks itself under the section header
  // Then every surviving divider rides up by the height of each removed slot below it.
  // NOTE: rs.h (slot height) is unreliable for the LAST item of a section (it can be
  // grossly over-estimated), so the delete-window is derived from the column's own
  // divider PITCH, not from rs.h. rs.h is only used for the ride-up shift, where the
  // last-item over-estimate is harmless (nothing sits below the last item).
  const ops=[]; if(!((removedSlots&&removedSlots.length)||(growSlots&&growSlots.length))) return ops;
  removedSlots=removedSlots||[];
  const _pin=pinnedYs||[];
  const _pinned=y=>_pin.some(v=>Math.abs(y-v)<1.5);
  const killed=new Set();
  const slots=[...removedSlots].sort((a,b)=>b.y-a.y);
  for(const rs of slots){
    // pinned leader rules (the ADD-ONS footer list) are page furniture: they must not be
    // consumable as a removed dish's divider either, or removing the column's last dish
    // eats a leader while addonOps still owns (and rewrites) the same span
    const inCol=o=> o.d.x>=rs.cmin && o.d.x<rs.cmax && !_pinned(o.d.y);
    const colDivs=divs.map((d,i)=>({d,i})).filter(inCol).sort((a,b)=>b.d.y-a.d.y);
    let gaps=[]; for(let k=1;k<colDivs.length;k++) gaps.push(colDivs[k-1].d.y-colDivs[k].d.y);
    let pitch; if(gaps.length){ gaps.sort((a,b)=>a-b); pitch=gaps[gaps.length>>1]; }
    else pitch=Math.min(Math.abs(rs.h)||50, 80);   // single-divider column: clamp bad rs.h
    const G=pitch*0.7;
    // primary: divider sitting just above this item's top
    let pick=colDivs.find(o=>!killed.has(o.i) && o.d.y>rs.y+1 && o.d.y<=rs.y+G);
    // fallback (first item of section): the divider just below its top
    if(!pick) pick=colDivs.find(o=>!killed.has(o.i) && o.d.y<rs.y-1 && o.d.y>=rs.y-G);
    if(pick) killed.add(pick.i);
  }
  divs.forEach((d,i)=>{
    if(killed.has(i)){ ops.push({s:d.full[0], e:d.full[1], rep:enc('')}); return; }
    if(_pinned(d.y)) return;                           // a footer leader rule: page furniture
    let shift=0;
    for(const rs of removedSlots){
      if(!(d.x>=rs.cmin && d.x<rs.cmax)) continue;
      if(d.y <= rs.y-Math.abs(rs.h)/2) shift += Math.abs(rs.h);
    }
    /* A rule below a grown description rides DOWN with the dishes it separates. Kept as its own
       list rather than merged into removedSlots as a signed height: the kill logic above takes
       Math.abs(rs.h), so a negative entry there would silently break the divider-kill window that
       the per-dish removal sweeps pin. */
    for(const gs of (growSlots||[])){
      if(!(d.x>=gs.cmin && d.x<gs.cmax)) continue;
      if(d.y < gs.y) shift -= Math.abs(gs.h);
    }
    if(Math.abs(shift)>5e-4) ops.push({s:d.full[0], e:d.full[1], rep:enc('q 1 0 0 1 '+d.xs+' '+fmtNum(d.y+shift)+' cm 0 0 m '+d.ws+' 0 l S Q')});
  });
  return ops;
}

// ---- NEW-BADGE ENGINE: Illustrator groups multiple items' NEW badges into shared art
//      q-blocks keyed by ONE badge's position, so the coarse block reflow can't see them.
//      Like dividers, badges are decoupled and handled by their OWN position: a removed
//      item's badge is spliced out; a survivor's badge rides up with its item's reflow. ----
function _badges(bytes){
  const s=new TextDecoder('latin1').decode(bytes);
  const partRe=/q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n(?:[^Q]*?)\nf\nQ/g;   // a filled path part
  const parts=[]; let m;
  while((m=partRe.exec(s))){
    const pre=s.slice(Math.max(0,m.index-40), m.index);
    const ri=pre.search(/0 0\.988 1 0 k\s*$/);   // starburst fill is the brand red
    parts.push({s:m.index,e:m.index+m[0].length,x:+m[1],y:+m[2],red:ri>=0,colStart:ri>=0?(m.index-pre.length+ri):m.index});
  }
  const out=[];
  for(let i=0;i<parts.length;i++){
    const p=parts[i]; if(!p.red||p.e-p.s>900) continue;               // decor blobs are big; badge starburst ~473B
    let j=i+1,lo=p.s,hi=p.e,letters=0,prevEnd=p.e;
    while(j<parts.length&&letters<3){                                  // the 3 'NEW' letters sit on the starburst, contiguous in the stream
      const q=parts[j]; if(q.red) break;
      if(q.s-prevEnd<150&&Math.abs(q.y-p.y)<9&&q.x>=p.x-32&&q.x<=p.x+40&&(q.e-q.s)<900){lo=Math.min(lo,q.s);hi=Math.max(hi,q.e);prevEnd=q.e;letters++;j++;}
      else break;
    }
    if(letters>=3) out.push({span:[Math.min(p.colStart,lo),hi],x:p.x,y:p.y});
    i=j-1;
  }
  return out;
}
function badgeOwner(b,page){ let best=null,bd=1e9;
  for(const nf of FM.fields){ if(nf.page!==page||nf.role!=='name') continue;
    const dy=Math.abs(nf.y-b.y),dx=b.x-nf.x; if(dx<-4||dx>270) continue;   // badge sits to the RIGHT of its name, same column
    const d=dy+dx*0.05; if(dy<16&&d<bd){bd=d;best=nf;} }
  return best;
}
function badgeOps(bytes, page, removedSlots, growSlots){
  const badges=_badges(bytes); if(!badges.length) return {ops:[],spans:[]};
  const s=new TextDecoder('latin1').decode(bytes); const ops=[], spans=badges.map(b=>b.span);
  for(const b of badges){
    const owner=badgeOwner(b,page);
    if(owner&&(owner.id in markerEdits)&&!removed.has(owner.id)) continue;   // marker engine owns this dish's badge
    if(owner&&removed.has(owner.id)){ // _badges() extends this span BACKWARDS past the q to swallow
        // an un-nested `0 0.988 1 0 k`; dropping it turns later headings (APPETIZERS) grey.
        // ...but keep the state from the span's START, not its END. The badge is a self-contained
        // decoration: the artwork wraps it in its own `q .. Q` (the stream reads `f Q Q` at the
        // end), so its net effect on the enclosing state is nil. Its internal `0 0 0 0 k` — white,
        // for the NEW letters — is only ever contained by that wrapper, which this delete removes
        // along with everything else. Replaying the END state therefore leaked white to top level
        // and painted every dish below it invisible. The START state is what the surviving `Q`
        // would have restored, so it is right whether or not the wrapper survives.
        ops.push({s:b.span[0],e:b.span[1],rep:enc(keepState(s.slice(0,b.span[0])))}); continue; }   // removed item -> delete its badge
    let shift=0;   // survivor below a removed slot -> ride up by the removed height (same as dividers)
    for(const rs of (removedSlots||[])){ if(b.x>=rs.cmin&&b.x<rs.cmax&&b.y<=rs.y-Math.abs(rs.h)/2) shift+=Math.abs(rs.h); }
    // ...and ride DOWN under a grown description, exactly as dividerOps does. Badge bytes are
    // carved out of shiftOps (see `inBadge`), so without this a NEW badge below a growth stays
    // put while its own dish moves away underneath it.
    for(const gs of (growSlots||[])){ if(b.x>=gs.cmin&&b.x<gs.cmax&&b.y<gs.y) shift-=Math.abs(gs.h); }
    if(Math.abs(shift)>5e-4){ const txt=s.slice(b.span[0],b.span[1]).replace(/(1 0 0 1 -?[\d.]+ )(-?[\d.]+)( cm)/g,(mm,a,y,c)=>a+fmtNum(parseFloat(y)+shift)+c); ops.push({s:b.span[0],e:b.span[1],rep:enc(txt)}); }
  }
  return {ops,spans};
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

async function regenerate(){
  for(let p=0;p<pageStreams.length;p++){
    const ps=pageStreams[p];
    const st = structuralForPage(p, ps.pristine);
    const skip = new Set();
    if(removed.size){
      const grp=itemsForPage(p);
      for(const it of grp.items){ if(removed.has(it.name.id)){ skip.add(it.name.id); if(it.desc)skip.add(it.desc.id); for(const pr of it.prices)skip.add(pr.id);} }
    }
    // the ADD-ONS block owns its price splices (its advance model differs — see addonOps)
    if(FM.addons && FM.addons.page===p && addons) for(const r of FM.addons.rows) skip.add(r.price_id);
    const divs = _dividerLines(ps.pristine);
    const bdg = badgeOps(ps.pristine, p, st.removedSlots, st.growSlots);   // NEW badges decoupled like dividers
    // marker overrides: delete edited dishes' baked markers + restamp their chosen set at the anchor
    /* Markers are anchored to the name's RIGHT EDGE, so a RENAMED dish has to carry them along —
       otherwise a longer name prints straight through its own icons. Renamed dishes join the
       marker pass even when their marker set is untouched. */
    // the LAST rendered line is what the icons sit beside, so this has to honour a granted extra line
    const _mkLast=(f,s)=>{ const L=wrapName(String(s||''),nameBudgetChars(f),nameMaxLines(f,growPlan(f.page).nameExtra[f.id]||0)).lines.filter(Boolean);
                           return L.length? L[L.length-1] : ''; };
    // measured against the ARTWORK's last line, for the same reason rowAnchor is (see there)
    const _mkDx=f=> (f.id in edits)? (_mkLast(f,edits[f.id]).length-bakedLastLine(f).length)*nameAdv(f) : 0;
    /* REVERTED from "re-stamp every dish". Doing that rendered EVERY dish with the same six-marker
       row (dairy/gluten/jain/spicy/chilli/NEW) instead of its own set, and pushed the NEW badge onto
       the prices — confirmed from a full-page render, not a single dish.
       ROOT CAUSE NOT YET FOUND. My first guess — that dishMarkers() resolves through FIELD[] and is
       unreliable — is WRONG: boot does `FM.fields.forEach(f=>FIELD[f.id]=f)`, so FIELD holds the
       fieldmap's own objects and returns identical data. Do not re-apply the whole-menu re-stamp
       until the real cause is reproduced and understood; even spacing applies to edited dishes only
       in the meantime. Verify any retry with a FULL-PAGE render: the per-dish checks all passed
       while the page as a whole was visibly wrong. */
    /* A name that gained a LINE must be re-stamped even if its last line happens to be the same
       LENGTH as before — the icons have to come down to the new last line. CHILLI CRUNCH wrapping
       to "CCCCCC DDDDDD" is 13 characters either way, so the horizontal delta was zero and the
       cluster was left stranded beside line one with the name's second line printing under it. */
    const _mkRelines = f => nameLines(f, (f.id in edits)?edits[f.id]:f.display,
                                      growPlan(p).nameExtra[f.id]||0) !== ((f.lines||[]).length||1);
    const mkDishes = FM.fields.filter(f=>f.page===p && f.role==='name' && !removed.has(f.id) && f.markerBase
                      && ((f.id in markerEdits) || Math.abs(_mkDx(f))>0.005 || _mkRelines(f)));
    const mkDelSpans=[], mkMoveOps=[]; let mkAppend='';
    for(const nf of mkDishes){
      const sp=nf.markerSpans||{};
      for(const t in sp) mkDelSpans.push(sp[t]);   // horizontal shift now comes from rowAnchor()
      /* Ride the dish's OWN reflow. The hand-rolled loop this replaces tested markerBase[1] against
         each removed slot and came out ZERO for CASSATA, so its markers stayed at the baked y while
         the dish itself moved up ~56pt, stranding the icons on whatever now occupied that row.
         Measure the shift at the dish's own position instead, netting removals against growth. */
      let shift = 0;
      for(const rs of (st.removedSlots||[])) if(nf.x>=rs.cmin && nf.x<rs.cmax && rs.y>nf.y) shift += Math.abs(rs.h);
      for(const gs of (st.growSlots||[]))    if(nf.x>=gs.cmin && nf.x<gs.cmax && gs.y>nf.y) shift -= Math.abs(gs.h);
      /* Deliberately NOT adding st.fieldShift here. That map accumulates a delta once per ANCHOR
         inside a field's owned spans, and a dish owns one span per marker (four for CASSATA, each
         holding several cm anchors) - so it summed the same shift repeatedly and read 227.24pt when
         the dish had actually moved 56.81pt. The loop above measures the dish's own travel directly,
         which is the number the markers need. */
      /* markerBase records the name's FIRST line, but a wrapped name bakes its icons beside the
         LAST one — PISTACHIO MOUSSE CAKE's sit ~15.6pt below its own baseline. Harmless while only
         edited dishes were re-stamped; now that every dish is, all five 2-line dishes would jump. */
      /* RENDERED lines, not baked: a name that has just taken a second line must carry its icons
         down to it. Using the baked count here would leave the cluster beside line one with the
         name's own second line printing underneath it. */
      const _nmv = (nf.id in edits) ? edits[nf.id] : nf.display;
      const nlines = nameLines(nf, _nmv, growPlan(p).nameExtra[nf.id]||0);
      const anchorY = nf.markerBase[1] - (nlines-1)*nameLineH(nf) + shift;
      /* FLOOR the row at the name's real right edge. `markerBase + dx` assumes the length delta is
         always right; when it is not (or is zero) the cluster lands INSIDE the name — which is how
         a renamed CASSATA printed "CASSATA 2.0NEW", the badge sitting on the last glyph. Measuring
         where the name actually ends makes the overlap structurally impossible rather than relying
         on the delta being correct. AO Mono is monospaced at 0.63 em, the same advance the wrap and
         the budget already use. */
      /* ONE anchor function shared with markerRoom()/markerFits(), so what the capacity check
         permits and what the row is drawn at can never drift apart. */
      let _bx=rowAnchor(nf);
      /* CEILING. "No marker may overlap the price" has to be a structural guarantee, not a
         consequence of the width model being right — the name budget already keeps the row inside
         this bound, so the clamp never binds in normal use and exists so that a future error in
         wrapping or tracking degrades into a tight row rather than ink printed over the price. */
      const _mkSet=dishMarkers(nf.id), _pl=priceLeftFor(nf);
      if(_pl!=null && _mkSet.size){
        const _ceil=_pl - MARKER_CLEAR - clusterWidth(_mkSet);
        if(_bx > _ceil) _bx = Math.max(clusterStart(nf), _ceil);
      }
      mkAppend += stampMarkers(_bx, anchorY, _mkSet, p);
    }
    const inMarker=(s,e)=> mkDelSpans.some(sp=> sp[0]<=s && e<=sp[1]);
    const inBadge = (s,e)=> bdg.spans.some(sp=> sp[0]<=s && e<=sp[1]);
    const inDiv = (s,e)=> divs.some(d=> d.full[0]<=s && e<=d.full[1]);
    const shiftOps = st.shiftOps.filter(o=> !inDiv(o.s,o.e) && !inBadge(o.s,o.e) && !inMarker(o.s,o.e));   // divider/badge/marker cms handled by own-Y, not block-shift
    let ops = opsForPage(FM.fields.filter(f=>f.page===p), st.priceShift, skip, st.fieldShift).concat(shiftOps, mkMoveOps);
    /* ADD-ONS rewrites. Safe to join the shared ops list: every span is recorded in FM.addons,
       the block sits below flowBottom (no shiftOps land there), its leader rules are pinned by
       furnitureRuleYs (dividerOps skips them), and no dish owns its runs (no deletes reach it). */
    const ao = addonOps(p);
    for(const o of ao.ops) ops.push(o);
    // carve divider AND badge spans out of block-deletes so bundled ones are never collaterally deleted.
    // A removed dish's own NEW badge is a case where this now runs the OTHER way: the per-icon leaf
    // block for its badge (from `blocks`, small) can fall entirely INSIDE the badge span `_badges()`
    // found (bigger, since it groups the starburst + 3 letters into one span) -- the original carve
    // only checked "protect region inside the delete", so a smaller delete nested inside a protect
    // region sailed through untouched and collided with badgeOps' own op for the same bytes, and
    // spliceBytes (which assumes non-overlapping ops) corrupted the stream past that point. Carve out
    // ANY overlap, in either direction, not just full containment of protect-inside-delete.
    const protect=[...divs.map(v=>v.full), ...bdg.spans].sort((a,b)=>a[0]-b[0]);
    let dels=[];
    for(const d of st.deletes){
      const overlapping = protect.filter(v=> v[0]<d[1] && v[1]>d[0]);
      if(!overlapping.length){ dels.push(d); continue; }
      let segs=[[d[0],d[1]]];
      for(const v of overlapping){
        const next=[];
        for(const seg of segs){
          if(v[1]<=seg[0]||v[0]>=seg[1]){ next.push(seg); continue; }
          if(v[0]>seg[0]) next.push([seg[0],v[0]]);
          if(v[1]<seg[1]) next.push([v[1],seg[1]]);
        }
        segs=next;
      }
      for(const seg of segs) if(seg[1]>seg[0]) dels.push(seg);
    }
    // Merge before emitting. Deleting per TEXT RUN (rather than per BT..ET block) produces many
    // more spans, and adjacent runs' spans touch or nest -- spliceBytes assumes non-overlapping ops
    // and runs its cursor backwards if it ever meets an overlap. Worse, the nested span's own
    // keepFont op was being filtered out by the enclosing one below, so the state it was meant to
    // preserve vanished and survivors inherited an older fill (dish black -> chrome black).
    // keepFont is therefore computed over the MERGED range, never per original span.
    dels = mergeSpans(dels);
    for(const d of dels) ops.push({s:d[0],e:d[1],rep:enc(safeDel(p,d[0],d[1],keepFont(d,p)))});
    if(dels.length){
      ops = ops.filter(o=> !dels.some(d=> d[0]<=o.s && o.e<=d[1] && !(o.s===d[0]&&o.e===d[1])) );
    }
    for(const o of dividerOps(divs, st.removedSlots, st.growSlots, furnitureRuleYs(p))) ops.push(safeOp(p,o));   // reposition/delete each divider by its own Y
    /* A badge whose dish is being RE-STAMPED belongs to the marker pass, not here. Both wrote the
       SAME span - badgeOps riding it to a new y, mkDelSpans deleting it - and spliceBytes can only
       honour one, so the badge survived at its OLD x while the delete (and the re-stamp of the
       other three markers) was dropped. That is why removing a dish made CASSATA's NEW badge land
       on its renamed text and the bottle/wheat/J vanish. */
    for(const o of bdg.ops){
      // ANY overlap, either direction: the badge op's span is the whole badge block and CONTAINS
      // the fieldmap's narrower marker span, so a containment test in one direction misses it
      if(mkDelSpans.some(sp=> o.s < sp[1] && sp[0] < o.e)) continue;   // marker pass owns this badge
      ops.push(safeOp(p,o));   // delete removed items' NEW badges + ride survivors up by their own Y
    }
    for(const sp of mkDelSpans) ops.push({s:sp[0],e:sp[1],rep:enc(safeDel(p,sp[0],sp[1],keepFont(sp,p)))});   // strip edited dishes' baked markers (restamped below)
    const pc=personaCover(p);   // personalised cover: hide any `del` spans, stamp occasion + guest
    for(const sp of pc.del){ ops.push({s:sp[0],e:sp[1],rep:enc(safeDel(p,sp[0],sp[1],keepFont(sp,p)))}); }
    let edited = ops.length ? spliceBytes(ps.pristine, ops) : ps.pristine;
    const addStr = appendedForPage(p, st.removedSlots, st.growSlots) + mkAppend + pc.add + ao.add;
    if(addStr){ const ab=enc(addStr); const m=new Uint8Array(edited.length+ab.length); m.set(edited,0); m.set(ab,edited.length); edited=m; }
    ps.dict.set(PDFName.of('Length'), PDFNumber.of(edited.length));
    doc.context.assign(ps.ref, PDFRawStream.of(ps.dict, edited));
  }
  if(typeof QRK!=='undefined') QRK.apply(doc);   // QR codes: resize/move/remove/add (src/shared/qrtool)
  lastBytes = await doc.save({useObjectStreams:false}); try{MEM.tick();}catch(_){} try{MenuState.touch();}catch(_){}   // chucky-2
  return lastBytes;
}
/* ---------- click the preview to edit ----------
   Invisible boxes are laid over the rendered page, positioned in PERCENT of the page so they
   stay aligned at any preview scale / window size. Clicking one scrolls to that dish's card in
   the editor and focuses it. Boxes follow the removal reflow, so they track what's on screen. */
let _pvSel=null;
function pvHitLayer(){
  const cv=document.getElementById('preview'); if(!cv) return null;
  let st=document.getElementById('pstage');
  if(!st){                                   // wrap the canvas once so the overlay hugs it exactly
    st=document.createElement('div'); st.id='pstage';
    cv.parentNode.insertBefore(st,cv); st.appendChild(cv);
    const hl=document.createElement('div'); hl.id='hitlayer'; st.appendChild(hl);
  }
  return st.querySelector('#hitlayer');
}
// one box per visible dish on page p, in PDF space (y up), reflow included
/* chucky-2: boxes follow the SAME layout the PDF is written with — each row's shift from
   structuralForPage (a removal above moves it up; a description or name above that grew moves it
   down; its own second name line moves its description down), plus the description's rendered line
   count, size and real line pitch. It used to count the BAKED description lines at a fixed 9pt and
   follow removals only, so a description that grew stuck out below its box, and the boxes of the
   dishes under it were left behind. */
function pvBoxes(p){
  const st=structuralForPage(p, pageStreams[p].pristine), rows=st.rowShift||[], G=growPlan(p);
  const shiftOf=f=>rows.find(r=>f.x>=r.cmin && f.x<r.cmax && Math.abs(r.y-f.y)<0.01)||{name:0,below:0};
  const out=[];
  for(const it of itemsForPage(p).items){
    if(removed.has(it.name.id)) continue;
    // rendered lines, so a name that took a second one still has a click target covering it
    const n=it.name, sz=n.size||13, sh=shiftOf(n);
    const nL=nameLines(n, (n.id in edits)?edits[n.id]:n.display, G.nameExtra[n.id]||0)||1;
    const top = n.y + sh.name + sz*0.95;
    let bot = n.y + sh.name - (nL-1)*nameLineH(n) - 5;
    if(it.desc){
      const d=it.desc, fit=(d.id in edits)?(G.fit[d.id]||fitDesc(d, edits[d.id])):null;
      const dsz=fit?fit.size:(d.size||9);
      let dl=fit?fit.lines.length:(d.line_spans||[]).length;
      if(fit) while(dl>1 && !fit.lines[dl-1]) dl--;                 // trailing blank lines print nothing
      bot = d.y + sh.below - (Math.max(1,dl)-1)*Math.abs(descLead(d)*dsz) - dsz*0.35;
    }
    let right = n.x + 235;
    if(it.prices && it.prices.length){ const pr=it.prices[it.prices.length-1];
      right = pr.x + String(pr.text||'').length*(ADV.price||0.63)*(pr.size||8) + 5; }
    out.push({id:n.id, x0:n.x-6, x1:right, top, bot});
  }
  return out;
}
function pvSync(){
  const hl=pvHitLayer(); if(!hl) return;
  let boxes; try{ boxes=pvBoxes(activePage); }catch(e){ hl.innerHTML=''; return; }
  const sz=(PAGES&&PAGES[activePage])||[841.89,595.276], W=sz[0], H=sz[1];
  hl.innerHTML='';
  for(const b of boxes){
    const d=document.createElement('div');
    d.className='hitbox'+(_pvSel===b.id?' sel':'');
    d.style.left  = (b.x0/W*100)+'%';
    d.style.width = (Math.max(10,b.x1-b.x0)/W*100)+'%';
    d.style.top   = ((H-b.top)/H*100)+'%';
    d.style.height= (Math.max(8,b.top-b.bot)/H*100)+'%';
    d.title='Click to edit this item';
    d.addEventListener('click',()=>pvJump(b.id));
    hl.appendChild(d);
  }
  try{ if(typeof QRK!=='undefined') QRK.hits(hl, activePage, W, H); }catch(e){ console.error(e); }
}
function pvJump(id){
  _pvSel=id; pvSync();
  const el=document.querySelector('#editor [data-id="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]');
  const card=el?el.closest('.card'):null; if(!card) return;
  card.scrollIntoView({behavior:'smooth', block:'center'});
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  if(el&&el.isContentEditable) setTimeout(()=>el.focus(),260);
}
async function renderPreview(){
  const my = ++renderToken;
  document.getElementById('busy').classList.add('on');
  const bytes = lastBytes || await regenerate();
  try{
    if(pdfjsDoc){ pdfjsDoc.destroy(); pdfjsDoc=null; }
    const task = pdfjsLib.getDocument({data: bytes.slice(0)});
    const pdf = await task.promise;
    if(my!==renderToken){ pdf.destroy(); return; }
    pdfjsDoc = pdf;
    const page = await pdf.getPage(activePage+1);
    const pane = document.getElementById('previewPane');
    const avail = pane.clientWidth - 28;
    const base = page.getViewport({scale:1});
    const scale = Math.min(avail/base.width, 2.2);
    const vp = page.getViewport({scale: scale*window.devicePixelRatio});
    const canvas = document.getElementById('preview'), ctx=canvas.getContext('2d');
    canvas.width=vp.width; canvas.height=vp.height;
    canvas.style.width=(vp.width/window.devicePixelRatio)+'px';
    await page.render({canvasContext:ctx, viewport:vp}).promise;
  }catch(e){ if(!(e&&(e.name==='RenderingCancelledException'||String(e.message||e).includes('Rendering cancelled')))) console.error(e); }
  if(my===renderToken){ document.getElementById('busy').classList.remove('on'); try{ pvSync(); }catch(_){} }
}

// ---------- spell + glyph ----------
const deacc=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');   // JALAPEÑO -> JALAPENO for dictionary lookup
function wordAllowed(raw){
  const w = deacc(raw).replace(/[^A-Za-z']/g,'').toLowerCase().replace(/^'+|'+$/g,'');
  if(!w || w.length<2) return true;
  if(IGNORED.has(w)||CULINARY.has(w)||MENU.has(w)||BASE.has(w)) return true;
  if(w.endsWith('s') && (BASE.has(w.slice(0,-1))||CULINARY.has(w.slice(0,-1))||MENU.has(w.slice(0,-1)))) return true;
  if(w.includes("'") && BASE.has(w.replace(/'/g,''))) return true;
  // hyphen/slash compounds (IN-HOUSE, SWEET/SOUR): fine if every part is a word
  if(/[-\/]/.test(raw)){ const parts=raw.split(/[-\/]+/).filter(p=>/[A-Za-z]/.test(p)); if(parts.length>1 && parts.every(p=>wordAllowed(p))) return true; }
  return false;
}
function getCaret(el){ const s=getSelection(); if(!s.rangeCount) return null; const r=s.getRangeAt(0); const pre=r.cloneRange(); pre.selectNodeContents(el); pre.setEnd(r.endContainer,r.endOffset); return pre.toString().length; }
function setCaret(el,off){ if(off==null) return; let n, rem=off, w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null); while(n=w.nextNode()){ if(rem<=n.textContent.length){ const r=document.createRange(); r.setStart(n,rem); r.collapse(true); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return; } rem-=n.textContent.length; } const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r); }
function highlightField(el){
  const kind=el.dataset.kind, allowed=ALLOWED[kind]||ALLOWED.name;
  const text=normTypo(el.textContent).toUpperCase(), off=document.activeElement===el?getCaret(el):null;
  const toks=text.match(/(\s+|[^\s]+)/g)||[]; let html="";
  for(const tok of toks){
    if(/^\s+$/.test(tok)){ html+=tok.replace(/ /g,'&nbsp;'); continue; }
    let inner="", gb=false;
    for(const ch of tok){ if(allowed.indexOf(ch)===-1){ inner+="<span class='gl' title='“"+esc(ch)+"” isn’t in the menu font'>"+esc(ch)+"</span>"; gb=true; } else inner+=esc(ch); }
    if(!gb && !wordAllowed(tok)) html+="<span class='sp' data-w='"+esc(deacc(tok).replace(/[^A-Za-z']/g,''))+"'>"+inner+"</span>";
    else html+=inner;
  }
  el.innerHTML=html||"&nbsp;"; if(off!=null) setCaret(el,off);
}
function lev(a,b,max){ const m=a.length,n=b.length; if(Math.abs(m-n)>max) return max+1; let p=Array.from({length:n+1},(_,i)=>i); for(let i=1;i<=m;i++){ let c=[i],best=i; for(let j=1;j<=n;j++){ const d=a[i-1]===b[j-1]?0:1; c[j]=Math.min(p[j]+1,c[j-1]+1,p[j-1]+d); best=Math.min(best,c[j]); } if(best>max) return max+1; p=c; } return p[n]; }
function suggest(word){ word=word.toLowerCase(); const f=word[0],res=[]; const scan=arr=>{ for(const c of arr){ if(c[0]!==f||Math.abs(c.length-word.length)>2) continue; const d=lev(word,c,2); if(d<=2) res.push([d,c]); } }; scan(CULINARY_LIST); scan(BASE_LIST); res.sort((a,b)=>a[0]-b[0]||a[1].length-b[1].length); const seen=new Set(),out=[]; for(const[,c]of res){ if(!seen.has(c)){seen.add(c);out.push(c);} if(out.length>=3) break; } return out; }

// ---------- editor ----------
function itemsForPage(p){
  const names=FM.fields.filter(f=>f.role==='name'&&f.page===p);
  const descs=FM.fields.filter(f=>f.role==='desc'&&f.page===p);
  const prices=FM.fields.filter(f=>f.role==='price'&&f.page===p);
  const used=new Set();
  const items=names.map(n=>{
    const span=15.5*(n.lines.length-1);
    const pr=prices.filter(x=> x.x>n.x && x.x<n.x+260 && x.y<=n.y+6 && x.y>=n.y-span-7).sort((a,b)=>a.x-b.x);
    pr.forEach(x=>used.add(x.id));
    const d=descs.filter(x=>Math.abs(x.x-n.x)<6 && n.y>x.y && n.y-x.y<62).sort((a,b)=>b.y-a.y)[0]||null;
    return {name:n, prices:pr, desc:d, y:n.y, x:n.x};
  }).sort((a,b)=> (Math.abs(a.x-b.x)>40? a.x-b.x : b.y-a.y));
  const extras=prices.filter(x=>!used.has(x.id));
  return {items,extras};
}
function descText(d){ return (d.id in edits)? edits[d.id] : d.display; }

// ----- ADD-ITEM UI -----
function sectionsForPage(p){ let r=[]; (SECTIONS||[]).forEach((s,i)=>{ if(s.page===p) r.push(Object.assign({_i:i},s)); }); return r; }
function addedCountInSec(i){ return added.filter(a=>a.sec===i).length; }
function secCapacity(s){ return Math.max(1, Math.floor(s.gap_below/s.slot)); }
function colWord(x){ return x<200?'left':x<450?'middle':'right'; }
function renderAddZone(ed){
  const secs=sectionsForPage(activePage);
  if(!secs.length) return;
  /* Drop anything the target font cannot print, rather than letting it reach the PDF as a blank.
     ALLOWED.name was widened at boot to include digits and .,:-/ because the emitter borrows those
     glyphs from other embedded faces (see nameRunPdf), so this stays in step automatically. */
  /* Strip unprintable characters but PRESERVE THE TYPED CASE. Uppercasing here is what made typing
     run backwards: the menu prints uppercase, so the old version uppercased on every keystroke, which
     meant the field's text always differed from what the user had just typed, which forced a DOM
     rewrite on every character, which collapsed the caret to position 0. The data is uppercased at
     the point it is STORED instead, and the field is uppercased visually by CSS. */
  /* A contentEditable inserts a NON-BREAKING space (U+00A0), not a plain one — deliberately, because
     a plain TRAILING space collapses in HTML and would not render. So:
       - the field KEEPS its nbsp (allowed here), which is why nothing is rewritten and the space you
         type actually appears and holds the caret;
       - normTypo folds it to U+0020 only at the point the value is STORED, so the PDF gets a real
         space and never an nbsp.
     Stripping it in the field (the previous attempt) removed the character outright; converting it to
     a plain space (the attempt before that) made a trailing space collapse and vanish. */
  const cleanFor=(s,kind)=>{ const al=(ALLOWED[kind]||ALLOWED.name)+'\u00A0'   /* explicit: NBSP, what a contentEditable inserts for a space */;
    return [...String(s||'')].filter(c=>al.indexOf(c.toUpperCase())>=0).join(''); };
  const storeVal=(s)=>normTypo(String(s||'')).toUpperCase();
  /* Writing textContent on a contentEditable COLLAPSES THE CARET TO THE START, so rewriting on every
     keystroke made typing come out reversed. Put the caret back where it was, minus however many
     characters the clean-up removed — the same correction churnd's name input makes with
     setSelectionRange(p-1). Only touch the DOM when the text actually changed, so normal typing
     never moves the caret at all. */
  const setEditable=(el,v)=>{
    const prev=el.textContent;
    if(prev===v) return;
    const sel=document.getSelection();
    let off=null;
    if(sel&&sel.rangeCount&&el.contains(sel.anchorNode)) off=sel.anchorOffset;
    el.textContent=v;
    if(off==null) return;
    const want=Math.max(0, Math.min(off-(prev.length-v.length), v.length));
    try{ const node=el.firstChild||el; const r=document.createRange();
         r.setStart(node, node.nodeType===3?want:0); r.collapse(true);
         sel.removeAllRanges(); sel.addRange(r); }catch(_){ }
  };
  added.forEach((a,idx)=>{
    if(SECTIONS[a.sec].page!==activePage) return;
    /* An added dish gets the SAME `.card` a baked dish gets, not a read-only strip. It used to render
       as four spans with no separator ("HOT CHIPSNEW IN LEFT") and no way to change anything after
       adding \u2014 so a typo meant deleting the dish and re-entering it. Bound to `added[idx]` instead of
       `edits{}`, but reusing the baked markup so it inherits the styling, and reusing cleanField\u00e2\u2020\u2019
       ALLOWED / wrapDesc / MARKER_TYPES so the same rules apply as everywhere else. */
    const sec=SECTIONS[a.sec];
    const card=document.createElement('div'); card.className='card addedcard';
    const nrow=document.createElement('div'); nrow.className='nrow';
    const name=document.createElement('div'); name.className='name'; name.contentEditable='true';
    name.dataset.kind='name'; name.textContent=a.name||'';
    name.oninput=()=>{ const v=cleanFor(name.textContent,'name'); setEditable(name,v);
                       a.name=storeVal(v).trim(); schedulePreview(); };   // nbsp->space + uppercase, in the DATA only
    nrow.appendChild(name);
    const tag=document.createElement('span'); tag.className='ac-tag'; tag.textContent=' NEW IN '+sec.label+' ';
    nrow.appendChild(tag);
    const pwrap=document.createElement('div'); pwrap.className='prices';
    const _acols=(sec&&sec.cols)||[]; if(_acols.length) nrow.classList.add('withcols');
    [['price',_acols[0]||'Regular'],['price2',_acols[1]||'Large']].forEach(([k,ttl])=>{
      const w=document.createElement('div'); w.className='pwrap';
      const inp=document.createElement('input'); inp.className='price'; inp.title=ttl; inp.inputMode='numeric'; inp.value=a[k]||'';
      inp.oninput=()=>{ const v=cleanFor(inp.value,'price'); if(inp.value!==v) inp.value=v; a[k]=v.trim(); schedulePreview(); };
      w.appendChild(inp);
      if(_acols.length){ const col=document.createElement('div'); col.className='pcol'; const lbl=document.createElement('span'); lbl.className='plbl'; lbl.textContent=ttl; col.appendChild(lbl); col.appendChild(w); pwrap.appendChild(col); } else pwrap.appendChild(w);
    });
    nrow.appendChild(pwrap);
    const rm=document.createElement('button'); rm.className='rm'; rm.type='button'; rm.textContent='\u2715';
    rm.title='Remove this new item';
    rm.onclick=()=>{ const k=added.indexOf(a); if(k>=0)added.splice(k,1); buildEditor(); schedulePreview(); };
    nrow.appendChild(rm); card.appendChild(nrow);
    const desc=document.createElement('div'); desc.className='desc'; desc.contentEditable='true';
    desc.dataset.kind='desc'; desc.textContent=a.desc||'';
    const meta=document.createElement('div'); meta.className='metarow';
    const lbl=document.createElement('span'); lbl.className='lbl';
    const ctr=document.createElement('span'); ctr.className='ctr';
    const cap=2;                                    // buildItemJS wraps an added desc to 2 lines
    const syncDesc=()=>{ const w=wrapDesc((a.desc||'').toUpperCase(), addDescChars(sec), cap);
      lbl.textContent='Description \u00b7 up to '+cap+' lines';
      ctr.textContent=w.overflow ? 'too long \u2014 shorten it' : (w.lines.filter(Boolean).length+'/'+cap+' lines');
      ctr.classList.toggle('over', !!w.overflow); };
    desc.oninput=()=>{ const v=cleanFor(desc.textContent,'desc'); setEditable(desc,v);
                       a.desc=storeVal(v); syncDesc(); schedulePreview(); };   // nbsp->space + uppercase, in the DATA only
    card.appendChild(desc); meta.append(lbl,ctr); card.appendChild(meta); syncDesc();
    const mrow=document.createElement('div'); mrow.className='markrow';
    const ml=document.createElement('span'); ml.className='mlbl'; ml.textContent='Markers'; mrow.appendChild(ml);
    const cur=new Set(a.allergens||[]);
    for(const t of MARKER_TYPES){
      const chip=document.createElement('button'); chip.type='button';
      chip.className='mchip m-'+t+(cur.has(t)?' on':'');
      chip.textContent=(MARKER_LABEL[t]||t)+(t==='new'?' badge':'');
      chip.onclick=()=>{ if(cur.has(t)) cur.delete(t); else cur.add(t);
        a.allergens=MARKER_TYPES.filter(x=>cur.has(x)); chip.classList.toggle('on'); schedulePreview(); };
      mrow.appendChild(chip);
    }
    card.appendChild(mrow); ed.appendChild(card);
  });
  const zone=document.createElement('div'); zone.className='addzone';
  const btn=document.createElement('button'); btn.className='addbtn'; btn.textContent='+  Add a new item';
  const form=document.createElement('div'); form.className='addform';
  const opts=secs.map(s=>{ const cat=s.category||colWord(s.col_x).toUpperCase(); const sub=(s.label&&s.label!==cat)?(' \u00b7 '+s.label.charAt(0)+s.label.slice(1).toLowerCase()):(' \u00b7 '+colWord(s.col_x)+' column'); return '<option value="'+s._i+'">'+cat+sub+' \u00b7 room for '+(secCapacity(s)-addedCountInSec(s._i))+' more</option>'; }).join('');
  form.innerHTML='<label>Section</label><select class="af-sec">'+opts+'</select>'
    +'<label>Name</label><input type="text" class="af-name" maxlength="18" placeholder="DATE & HONEY">'
    +'<div class="afmeta af-nmeta"></div>'
    +'<label>Description</label><textarea class="af-desc" maxlength="120" placeholder="MEDJOOL DATES, ACACIA HONEY, MASCARPONE CREAM"></textarea>'
    +'<div class="afmeta af-dmeta"></div>'
    +'<div class="af2"><div><label>Grams</label><input type="text" class="af-grams" maxlength="4" placeholder="130"></div>'
    +'<div><label class="af-plabel">Price \u20b9</label><input type="text" class="af-price" maxlength="4" placeholder="560"></div>'
    +'<div class="af-p2wrap" style="display:none"><label class="af-p2label">Large \u20b9</label><input type="text" class="af-price2" maxlength="4" placeholder="760"></div></div>'
    +'<label>Markers</label><div class="afchk">'
    /* Built from MARKER_TYPES rather than hard-coded, so the ADD form can never drift from the dish
       cards again: this list still offered Korea (an Aiko marker, removed from this menu) and was
       missing both Ghaslet and Chilli. MARKER_LABEL supplies the wording. */
    +MARKER_TYPES.map(t=>'<label><input type="checkbox" class="af-a" value="'+t+'"'
        +((t==='dairy'||t==='gluten')?' checked':'')+'> '+(MARKER_LABEL[t]||t)+(t==='new'?' badge':'')+'</label>').join('')
    +'</div>'
    +'<div class="afbtns"><button class="afadd">Add to menu</button><button class="afcancel">Cancel</button></div>';
  btn.onclick=()=>{ form.classList.toggle('open'); if(form.classList.contains('open')) form.querySelector('.af-name').focus(); };
  zone.append(btn,form); ed.appendChild(zone);
  const nameEl=form.querySelector('.af-name'), descEl=form.querySelector('.af-desc'),
        nmeta=form.querySelector('.af-nmeta'), dmeta=form.querySelector('.af-dmeta'),
        addBtn=form.querySelector('.afadd'), secEl=form.querySelector('.af-sec'),
        gramsEl=form.querySelector('.af-grams'), priceEl=form.querySelector('.af-price'),
        price2El=form.querySelector('.af-price2'), p2wrap=form.querySelector('.af-p2wrap'), plabel=form.querySelector('.af-plabel');
  function bad(s,allowed){ const u=(s||'').toUpperCase(); const seen={}; const r=[]; for(const c of u){ if(allowed.indexOf(c)===-1&&!seen[c]){seen[c]=1;r.push(c);} } return r; }
  function validate(){
    const nm=normTypo(nameEl.value).toUpperCase().trim(), de=normTypo(descEl.value).toUpperCase().trim();
    const gr=gramsEl.value.trim(); const fullDesc=de+(gr?(' ['+gr+'GMS]'):'');
    const nb=bad(nm,ALLOWED.name), db=bad(fullDesc,ALLOWED.desc), gb=bad(gr,ALLOWED.price);
    const typos=s=>{const bad=[],warn=[];for(const w of (deacc(s).match(/[A-Za-z']+/g)||[])){ if(w.length>2 && !wordAllowed(w)){ const sg=suggest(w); if(sg.length) bad.push(w+' \u2192 '+sg[0].toUpperCase()+'?'); else warn.push(w.toUpperCase()); } } return {bad,warn};};
    const spN=typos(nm), spD=typos(de);   // bad = likely misspelling (blocks); warn = unrecognised word (soft)
    nmeta.textContent = nb.length?('can\u2019t print:  '+nb.map(c=>c===' '?'space':c).join('  ')):(spN.bad.length?('spelling: '+spN.bad.join('  ')):(spN.warn.length?('check: '+spN.warn.join(' ')):(nm.length+'/18'))); nmeta.className='afmeta'+((nb.length||spN.bad.length)?' bad':'');
    const ov=wrapDesc(fullDesc,addDescChars(SECTIONS[+secEl.value]),2).overflow;
    dmeta.textContent = db.length?('can\u2019t print:  '+db.map(c=>c===' '?'space':c).join('  ')):(ov?'too long \u2014 trim to fit 2 lines':(spD.bad.length?('spelling: '+spD.bad.join('  ')):(spD.warn.length?('check: '+spD.warn.join(' ')):(fullDesc.length+' chars')))); dmeta.className='afmeta'+((db.length||ov||spD.bad.length)?' bad':'');
    const si=+secEl.value, sec=SECTIONS[si], full=addedCountInSec(si)>=secCapacity(sec);
    const two=sec.price_right_2!=null; p2wrap.style.display=two?'':'none'; const _mc=(sec&&sec.cols)||[]; plabel.textContent=two?((_mc[0]||'Regular')+' \u20b9'):'Price \u20b9'; const _p2l=p2wrap.querySelector('.af-p2label'); if(_p2l) _p2l.textContent=(_mc[1]||'Large')+' \u20b9';
    const p2b=two?bad(price2El.value.trim(),ALLOWED.price):[];
    if(full){ nmeta.textContent='this section is full \u2014 remove one or pick another'; nmeta.className='afmeta bad'; }
    /* Spelling is ADVISORY, not a blocker. The suggestion line above still shows it, but a menu is
       full of words no dictionary has — NDUJA, GHASLET, BURRATA, STRACCIATELLA — so refusing to save
       on a dictionary miss stops legitimate dishes from being added. What still blocks is only what
       genuinely cannot be printed or placed: an empty field, a character with no glyph in the font,
       text too long for its space, or a section with no room left. */
    addBtn.disabled = !nm||!de||nb.length||db.length||gb.length||p2b.length||ov||full;
  }
  nameEl.oninput=descEl.oninput=gramsEl.oninput=priceEl.oninput=price2El.oninput=secEl.onchange=validate; validate();
  form.querySelector('.afcancel').onclick=()=>{ form.classList.remove('open'); };
  addBtn.onclick=()=>{
    if(addBtn.disabled) return;
    const gr=gramsEl.value.trim(); let de=normTypo(descEl.value).toUpperCase().trim();
    de=de.replace(/\s*\[\d+\s*GMS\]\s*$/i,''); if(gr) de+=' ['+gr+'GMS]';
    const al=[]; form.querySelectorAll('.af-a:checked').forEach(c=>al.push(c.value));
    added.push({sec:+secEl.value, name:normTypo(nameEl.value).toUpperCase().trim(), desc:de, price:priceEl.value.trim(), price2:price2El.value.trim(), allergens:al, _id:++addSeq});
    buildEditor(); schedulePreview();
  };
}

/* ---------- ADD-ONS panel: the page-0 footer price list, fully editable ---------- */
function addonBadChars(s, allowed){ const seen={}, r=[]; for(const c of String(s||'').toUpperCase()){ if(allowed.indexOf(c)===-1 && !seen[c]){ seen[c]=1; r.push(c); } } return r; }
function renderAddonsPanel(ed){
  const A=FM.addons;
  const eh=document.createElement('div'); eh.className='grouphd'; eh.textContent='Add-ons';
  ed.appendChild(eh);
  const card=document.createElement('div'); card.className='card';
  const note=document.createElement('div'); note.className='adnote';
  const syncNote=()=>{
    // an added DISH in the right column lands in this same footer space (sections[].gap_below
    // predates the block) — warn rather than block, and let the preview arbitrate
    const clash = added.some(a=>{ const s=SECTIONS[a.sec]; return s && s.page===A.page && Math.abs(s.col_x-A.x)<5; })
                  && (((addons.title||'').trim()) || addonLive().length>A.rows.length);
    note.textContent = clash
      ? 'Heads up: a dish added to the right column shares this space — check the preview for overlap.'
      : 'The red “ON THE HOUSE” line below this list is part of the artwork and can’t be edited yet.';
    note.classList.toggle('warn', clash);
  };
  // optional printed heading (the artwork ships without one; blank prints nothing)
  const hrow=document.createElement('div'); hrow.className='adhead';
  const hl=document.createElement('span'); hl.className='lbl'; hl.textContent='Heading';
  const hin=document.createElement('input'); hin.className='adn'; hin.placeholder='optional — e.g. ADD ONS (printed above the list)'; hin.value=addons.title||'';
  const hval=()=>{ const t=addons.title||'', bad=addonBadChars(t, ALLOWED.name), over=t.length>31;
    hin.classList.toggle('err', !!bad.length); hin.classList.toggle('over', !bad.length&&over);
    hin.title=bad.length? 'Not in the menu font: '+bad.join(' ') : over? 'Too long — up to 31 characters fit' : ''; };
  hin.addEventListener('input', ()=>{ addons.title=normTypo(hin.value).toUpperCase(); hval(); syncNote(); updateGate(); schedulePreview(); });
  hrow.appendChild(hl); hrow.appendChild(hin); card.appendChild(hrow); hval();
  addons.rows.forEach((r, idx)=>{
    if(r.removed){
      const strip=document.createElement('div'); strip.className='rmstrip';
      const nm=document.createElement('span'); nm.className='rmname'; nm.textContent=r.name||'(empty add-on)';
      const tag=document.createElement('span'); tag.className='rmtag'; tag.textContent='removed';
      const rb=document.createElement('button'); rb.className='restore'; rb.type='button'; rb.textContent='Restore';
      rb.addEventListener('click',()=>{ r.removed=false; buildEditor(); schedulePreview(); });
      strip.appendChild(nm); strip.appendChild(tag); strip.appendChild(rb); card.appendChild(strip);
      return;
    }
    const row=document.createElement('div'); row.className='adnrow';
    const nin=document.createElement('input'); nin.className='adn'; nin.placeholder='name'; nin.value=r.name;
    const pin=document.createElement('input'); pin.className='price'; pin.placeholder='price'; pin.value=r.price; pin.inputMode='numeric';
    const val=()=>{ const nb=addonBadChars(r.name, ALLOWED.desc), pb=addonBadChars(r.price, ALLOWED.price);
      const max=addonNameMax(r.price), over=r.name.length>max;
      nin.classList.toggle('err', !!nb.length); nin.classList.toggle('over', !nb.length&&over);
      nin.title=nb.length? 'Not in the menu font: '+nb.join(' ') : over? 'Too long — up to '+max+' characters fit beside this price' : '';
      pin.classList.toggle('err', !!pb.length); pin.title=pb.length? 'Not printable in the price font: '+pb.join(' ') : ''; };
    nin.addEventListener('input', ()=>{ r.name=normTypo(nin.value).toUpperCase(); val(); updateGate(); schedulePreview(); });
    pin.addEventListener('input', ()=>{ r.price=normTypo(pin.value).trim(); val(); updateGate(); schedulePreview(); });
    const up=document.createElement('button'); up.type='button'; up.className='admv'; up.textContent='↑'; up.title='Move up'; up.disabled=idx===0;
    up.addEventListener('click',()=>{ const t=addons.rows[idx-1]; addons.rows[idx-1]=addons.rows[idx]; addons.rows[idx]=t; buildEditor(); schedulePreview(); });
    const dn=document.createElement('button'); dn.type='button'; dn.className='admv'; dn.textContent='↓'; dn.title='Move down'; dn.disabled=idx===addons.rows.length-1;
    dn.addEventListener('click',()=>{ const t=addons.rows[idx+1]; addons.rows[idx+1]=addons.rows[idx]; addons.rows[idx]=t; buildEditor(); schedulePreview(); });
    const rm=document.createElement('button'); rm.type='button'; rm.className='rm'; rm.title='Remove this add-on'; rm.textContent='✕';
    rm.addEventListener('click',()=>{ r.removed=true; buildEditor(); schedulePreview(); });
    row.appendChild(nin); row.appendChild(pin); row.appendChild(up); row.appendChild(dn); row.appendChild(rm);
    card.appendChild(row); val();
  });
  const addB=document.createElement('button'); addB.type='button'; addB.className='adadd';
  const cap=addonCapacity(), liveN=addonLive().length;
  addB.textContent='+ Add add-on'; addB.disabled=liveN>=cap;
  addB.title=liveN>=cap? 'No room — the list may hold up to '+cap+' rows before the red line' : '';
  addB.addEventListener('click',()=>{ if(addonLive().length>=addonCapacity()) return;
    addons.rows.push({key:'n'+(++_adSeq), name:'', price:'', removed:false}); buildEditor();
    const inputs=ed.querySelectorAll('.adnrow .adn'); if(inputs.length) inputs[inputs.length-1].focus(); });
  card.appendChild(addB); card.appendChild(note); syncNote();
  ed.appendChild(card);
}
let _adSeq=0;
function buildEditor(){
  const ed=document.getElementById('editor'); ed.innerHTML="";
  const {items,extras}=itemsForPage(activePage);
  const rmCount=items.filter(it=>removed.has(it.name.id)).length;
  const _nav=((FM&&FM.nav_sections)||[]).filter(s=>s.page===activePage);
  const _secOf={}; let _order=items;
  if(_nav.length){
    const navOf=(it)=>{ const ix=it.name.x, iy=it.name.y; let best=null,bg=Infinity,ba=null,bag=Infinity;
      for(const s of _nav){ const dx=Math.abs(s.x-ix), gap=s.y-iy; if(gap<-6) continue; if(gap<bag){bag=gap;ba=s;} if(dx<=140&&gap<bg){bg=gap;best=s;} } return (best||ba||{}).label||''; };
    for(const it of items) _secOf[it.name.id]=navOf(it);
    const _idx=l=>{ for(let i=0;i<_nav.length;i++) if(_nav[i].label===l) return i; return 99; };
    _order=items.slice().sort((a,b)=>{ const d=_idx(_secOf[a.name.id])-_idx(_secOf[b.name.id]); return d||(b.name.y-a.name.y); });
  } else {
    const _secs=(typeof sectionsForPage==='function')?sectionsForPage(activePage):[];
    const so=(it)=>{ const ix=it.name.x, iy=it.name.y; let best='',bs=Infinity; for(const s of _secs){ const dx=Math.abs(s.col_x-ix); if(dx>140) continue; if(iy<(s.last_y-2)) continue; const sc=(iy-s.last_y)+dx*0.01; if(sc<bs){bs=sc;best=s.label;} } return best; };
    for(const it of items) _secOf[it.name.id]=so(it);
  }
  window.__secCounts={};
  for(const it of items){ const L=_secOf[it.name.id]||'—'; if(!(L in window.__secCounts)) window.__secCounts[L]={live:0}; if(!removed.has(it.name.id)) window.__secCounts[L].live++; }
  let _lastSec=null, _secIdx=-1;
  for(const it of _order){
    const _L=_secOf[it.name.id]||'';
    if(_L!==_lastSec){ _lastSec=_L; _secIdx++;
      const sh=document.createElement('div'); sh.className='grouphd sechd'; sh.id='sec-'+_secIdx; sh.dataset.sec=_L;
      const cnt=(window.__secCounts[_L]||{}).live||0;
      sh.innerHTML='<span>'+(_L||'Items')+'</span><span class="n">'+cnt+' item'+(cnt===1?'':'s')+'</span>';
      ed.appendChild(sh);
    }
    if(removed.has(it.name.id)){
      const strip=document.createElement('div'); strip.className='rmstrip';
      const nm=document.createElement('span'); nm.className='rmname'; nm.textContent=(it.name.id in edits)?edits[it.name.id]:it.name.display;
      const tag=document.createElement('span'); tag.className='rmtag'; tag.textContent='removed';
      const rb=document.createElement('button'); rb.className='restore'; rb.type='button'; rb.textContent='Restore';
      rb.addEventListener('click',()=>{ removed.delete(it.name.id); buildEditor(); regenerate().then(renderPreview); });
      strip.appendChild(nm); strip.appendChild(tag); strip.appendChild(rb); ed.appendChild(strip);
      continue;
    }
    const card=document.createElement('div'); card.className='card';
    const nrow=document.createElement('div'); nrow.className='nrow';
    const name=document.createElement('div'); name.className='name'; name.dataset.id=it.name.id; name.dataset.kind='name'; name.dataset.orig=it.name.display; name.contentEditable='true';
    name.textContent = (it.name.id in edits)? edits[it.name.id] : it.name.display;
    nrow.appendChild(name);
    const pr=document.createElement('div'); pr.className='prices';
    // size labels (e.g. 28 cm / 38 cm) come from the section's `cols` — the same source Churn'd uses
    const _psec=(SECTIONS||[]).filter(s=>s.page===it.name.page).sort((a,b)=>Math.abs(a.col_x-it.name.x)-Math.abs(b.col_x-it.name.x))[0];
    const _cols=(_psec&&Math.abs(_psec.col_x-it.name.x)<140&&_psec.cols)||[]; if(_cols.length) nrow.classList.add('withcols');
    it.prices.forEach((p,i)=>{ const w=document.createElement('div'); w.className='pwrap'; const inp=document.createElement('input'); inp.className='price'; inp.dataset.id=p.id; inp.dataset.orig=p.text; inp.value=(p.id in edits)?edits[p.id]:p.text; inp.inputMode='numeric'; w.appendChild(inp);
      if(_cols[i]){ const col=document.createElement('div'); col.className='pcol'; const lbl=document.createElement('span'); lbl.className='plbl'; lbl.textContent=_cols[i]; col.appendChild(lbl); col.appendChild(w); pr.appendChild(col); } else pr.appendChild(w); });
    nrow.appendChild(pr);
    const rm=document.createElement('button'); rm.className='rm'; rm.type='button'; rm.title='Remove this item from the menu'; rm.textContent='✕';
    rm.addEventListener('click',()=>{ removed.add(it.name.id); buildEditor(); regenerate().then(renderPreview); });
    nrow.appendChild(rm); card.appendChild(nrow);

    if(it.desc){
      const desc=document.createElement('div'); desc.className='desc'; desc.dataset.id=it.desc.id; desc.dataset.kind='desc'; desc.dataset.orig=it.desc.display; desc.contentEditable='true';
      desc.textContent = descText(it.desc);
      card.appendChild(desc);
      const meta=document.createElement('div'); meta.className='metarow';
      const _dcap=maxLinesAt(it.desc, it.desc.size, growPlan(it.desc.page).extra[it.desc.id]||0);
      const lbl=document.createElement('span'); lbl.className='lbl'; lbl.textContent='Description · up to '+_dcap+' line'+(_dcap>1?'s':'');
      const ctr=document.createElement('span'); ctr.className='ctr'; ctr.dataset.for=it.desc.id;
      meta.appendChild(lbl); meta.appendChild(ctr); card.appendChild(meta);
    }
    const hint=document.createElement('div'); hint.className='hint'; card.appendChild(hint);
    // marker chips — add/remove dairy / gluten / Jain / Ghaslet(spicy) / NEW per dish
    if(FIELD[it.name.id] && FIELD[it.name.id].markerBase){
      const mrow=document.createElement('div'); mrow.className='markrow';
      const ml=document.createElement('span'); ml.className='mlbl'; ml.textContent='Markers'; mrow.appendChild(ml);
      const nf=FIELD[it.name.id];
      const cur=dishMarkers(it.name.id);
      const chips={};
      /* Re-evaluate every chip after any toggle: a marker that does not fit is disabled rather
         than printed over the price. What fits depends on the whole set, so removing one marker
         can re-enable another (drop the NEW badge and all five allergens become available again). */
      const mnote=document.createElement('span'); mnote.className='mnote';
      const syncChips=()=>{
        const s=dishMarkers(it.name.id), room=markerRoom(nf);
        const blocked=[];
        for(const t of MARKER_TYPES){
          const c=chips[t], on=s.has(t);
          const fits=on || markerFits(nf, new Set([...s, t]));
          c.classList.toggle('on', on);
          c.disabled=!fits;
          c.title=!fits
            ? MARKER_LABEL[t]+' does not fit before the price on this dish'
              +' (needs '+(clusterWidth(new Set([...s,t]))-clusterWidth(s)).toFixed(1)+'pt more than the '
              +room.toFixed(1)+'pt this row has)'
            : (on?'Remove ':'Add ')+MARKER_LABEL[t]+' marker';
          if(!fits) blocked.push(t);
        }
        /* Say WHY in the card, not only in a tooltip. A struck-through chip with the explanation
           hidden behind a hover reads as a broken button — the first question asked about this was
           "why can't I select NEW?". Name the marker, the shortfall, and what to remove to fit it. */
        if(!blocked.length){ mnote.textContent=''; mnote.style.display='none'; return; }
        const t=blocked[0], need=clusterWidth(new Set([...s,t]))-room;   // how far over the row it goes
        // which single selected marker could be dropped to make room for it?
        const free=MARKER_TYPES.filter(x=>s.has(x) && markerFits(nf, new Set([...s, t].filter(y=>y!==x))));
        mnote.textContent='No room for '+MARKER_LABEL[t]+' — needs '+need.toFixed(1)+'pt more than this row has'
          + (free.length ? '. Remove '+free.map(x=>MARKER_LABEL[x]).join(' or ')+' to fit it.' : '.');
        mnote.style.display='';
      };
      for(const t of MARKER_TYPES){
        const chip=document.createElement('button'); chip.type='button'; chip.className='mchip m-'+t;
        chip.innerHTML=(MARKER_ICON[t]||'')+' '+MARKER_LABEL[t];
        chips[t]=chip;
        chip.addEventListener('click',()=>{ const s=dishMarkers(it.name.id); if(s.has(t))s.delete(t); else if(!markerFits(nf,new Set([...s,t]))) return; else s.add(t); markerEdits[it.name.id]=MARKER_TYPES.filter(x=>s.has(x)); syncChips();
          updateGate(); refreshCtrs();   // chucky-2: a marker changes the name's room, so re-check the warnings now
          schedulePreview(); });
        mrow.appendChild(chip);
      }
      mrow.appendChild(mnote);
      syncChips();
      card.appendChild(mrow);
    }
    ed.appendChild(card);
    highlightField(name); if(it.desc){ highlightField(card.querySelector('.desc')); updateCtr(card.querySelector('.desc')); }
  }
  const _adIds = (FM.addons && addons) ? new Set(FM.addons.rows.map(r=>r.price_id)) : new Set();
  if(FM.addons && addons && FM.addons.page===activePage) renderAddonsPanel(ed);
  const looseExtras = extras.filter(x=>!_adIds.has(x.id));
  if(looseExtras.length){ const eh=document.createElement('div'); eh.className='grouphd'; eh.textContent='Other prices'; ed.appendChild(eh);
    const card=document.createElement('div'); card.className='card'; const pr=document.createElement('div'); pr.className='prices';
    for(const p of looseExtras){ const w=document.createElement('div'); w.className='pwrap'; const inp=document.createElement('input'); inp.className='price'; inp.dataset.id=p.id; inp.dataset.orig=p.text; inp.value=(p.id in edits)?edits[p.id]:p.text; inp.inputMode='numeric'; w.appendChild(inp); pr.appendChild(w); }
    card.appendChild(pr); ed.appendChild(card);
  }
  updateGate();

  renderAddZone(ed);
  if(typeof syncRail==='function') syncRail();
}
/* The room is a COLUMN budget, shared: growing one description changes what every OTHER
   description in that column can still have. A single edit therefore has to refresh every counter
   on the page, or a neighbour keeps advertising capacity that has already been spent. */
function refreshCtrs(){ document.querySelectorAll('#editor .desc').forEach(el=>{ try{ updateCtr(el); }catch(_){ } }); }
function updateCtr(el){
  const f=FIELD[el.dataset.id]; if(!f) return;
  const ctr=document.querySelector(".ctr[data-for='"+el.dataset.id+"']"); if(!ctr) return;
  const val=el.textContent.replace(/\u00a0/g,' ').trim();
  const G=growPlan(f.page), ex=G.extra[f.id]||0;
  const fit=((f.id in edits)&&G.fit[f.id])||fitDesc(f, val, ex); const w={lines:fit.lines, overflow:fit.overflow};
  const _used=fit.lines.filter(Boolean).length, _cap=maxLinesAt(f, fit.size, ex), _fitted=fit.size<f.size-0.005;
  ctr.textContent = w.overflow ? 'no room left in this column — shorten this, or a description above it'
                  : (_used+'/'+_cap+' lines'+(_fitted?' · auto-fitted':'')+(ex?' · pushes the dishes below down':''));
  ctr.classList.toggle('over', w.overflow);
}

// ---------- events ----------
let etimer=null, ptimer=null;
function schedulePreview(){ clearTimeout(ptimer); ptimer=setTimeout(async()=>{ await regenerate(); renderPreview(); }, 380); }
document.getElementById('editor').addEventListener('input', e=>{
  const el=e.target;
  /* BAKED fields only. An added item's card reuses these same classes to inherit the styling, but it
     carries its own handlers and has no fieldmap id — so without this guard every keystroke there
     also ran through here, which (a) wrote edits[undefined], polluting the baked-edit map, and
     (b) called highlightField(), which rewrites the element's innerHTML to add spell underlines and
     so collapsed the caret to position 0 — the reason typing in an added card came out reversed. */
  if(!el.dataset.id) return;
  if(el.classList.contains('name')||el.classList.contains('desc')){
    const t=normTypo(el.textContent).toUpperCase().trim();
    // chucky-2: a REWRAP description stays an edit even at its original text — baked, it runs under the prices
    if(t===el.dataset.orig && !REWRAP.has(el.dataset.id)) delete edits[el.dataset.id]; else edits[el.dataset.id]=t;
    if(el.classList.contains('desc')) refreshCtrs();
    clearTimeout(etimer); etimer=setTimeout(()=>{ highlightField(el); updateGate(); }, 160);
    schedulePreview();
  } else if(el.classList.contains('price')){
    const t=el.value.trim();
    if(t===el.dataset.orig) delete edits[el.dataset.id]; else edits[el.dataset.id]=t;
    let bad=false; for(const ch of el.value) if(ALLOWED.price.indexOf(ch)===-1) bad=true;
    el.classList.toggle('err',bad); updateGate(); schedulePreview();
  }
});
const pop=document.getElementById('popover');
document.getElementById('editor').addEventListener('click', e=>{
  const sp=e.target.closest('.sp'); if(!sp){ pop.style.display='none'; return; }
  const word=sp.dataset.w, sug=suggest(word); let html="<div class='word'>"+esc(word)+"</div>";
  if(sug.length) for(const s of sug){ const disp=word===word.toUpperCase()?s.toUpperCase():s; html+="<button data-fix='"+esc(disp)+"'>"+esc(disp)+"</button>"; }
  else html+="<div style='font-size:12px;color:#9a8f7c;margin:2px 4px 6px'>no suggestion</div>";
  html+="<button class='ignore' data-ignore='"+esc(word.toLowerCase())+"'>Ignore — add to dictionary</button>";
  pop.innerHTML=html; pop.style.display='block'; const r=sp.getBoundingClientRect();
  pop.style.left=(scrollX+r.left)+'px'; pop.style.top=(scrollY+r.bottom+4)+'px'; pop._t=sp;
});
pop.addEventListener('click', e=>{
  const b=e.target.closest('button'); if(!b) return; const sp=pop._t, fieldEl=sp.closest('.name,.desc');
  if(b.dataset.fix!=null){
    /* Read innerText, not textContent: textContent drops <br> and block boundaries WITHOUT emitting
       a separator, so a word after a visual line break fused with the one before it
       ("PARMESAN,CHIMICHURRI"), normalised to a token that could never match, and the fix silently
       did nothing. innerText renders breaks as \n, which is then folded to a space — the field is
       one continuous value that merely wraps, so a break carries no meaning.
       Also replace the occurrence that was actually CLICKED rather than the first match, or a word
       appearing twice would have the wrong one corrected. Matching is case-insensitive because the
       highlighter stores the dictionary form while the field may hold any case. */
    const src=(fieldEl.innerText!=null?fieldEl.innerText:fieldEl.textContent).replace(/[\r\n]+/g,' ');
    const parts=src.match(/(\s+|[^\s]+)/g)||[];
    const key=t=>deacc(t).replace(/[^A-Za-z']/g,'').toUpperCase();
    const want=String(sp.dataset.w||'').toUpperCase();
    const spans=[...fieldEl.querySelectorAll('.sp')].filter(x=>String(x.dataset.w||'').toUpperCase()===want);
    let nth=Math.max(0, spans.indexOf(sp)), seen=-1;
    fieldEl.textContent=parts.map(t=>{
      if(!/[^\s]/.test(t)||key(t)!==want) return t;
      seen++; return seen===nth ? b.dataset.fix : t;
    }).join('');
    const t=normTypo(fieldEl.textContent).trim(); if(t===fieldEl.dataset.orig && !REWRAP.has(fieldEl.dataset.id)) delete edits[fieldEl.dataset.id]; else edits[fieldEl.dataset.id]=t;   // chucky-2: see REWRAP
    if(fieldEl.classList.contains('desc')) updateCtr(fieldEl);
    schedulePreview();
  } else if(b.dataset.ignore!=null){ IGNORED.add(b.dataset.ignore); try{ localStorage.setItem('capiche_dict', JSON.stringify([...IGNORED])); }catch(_){} }
  pop.style.display='none';
  document.querySelectorAll(".name,.desc").forEach(highlightField); updateGate();
});
document.addEventListener('click', e=>{ if(!e.target.closest('#popover')&&!e.target.closest('.sp')) pop.style.display='none'; });
document.querySelectorAll('.tabs button').forEach(b=> b.addEventListener('click', ()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
  activePage=+b.dataset.pg; document.getElementById('ptag').textContent='— '+(activePage===0?'Front':'Back');
  buildEditor(); renderPreview();
}));
/* chucky-2: a name that doesn't fit is printed cut down to what does, so the preview can look as if
   the edit never happened. The warning says what is actually printed, and why. Markers share the
   name's line, so each one turned on leaves the name less room. */
function nameTooLong(f, short){
  const G=growPlan(f.page), per=nameBudgetChars(f), mk=dishMarkers(f.id).size;
  const shown=wrapName(edits[f.id], per, nameMaxLines(f, G.nameExtra[f.id]||0)).lines.filter(Boolean).join(' ');
  const printed = shown ? 'only “'+shown+'” fits, so that’s all the menu shows. ' : 'none of it fits, so the menu shows no name. ';
  const why = short
    ? 'It needs a second line and this column has no room for one ('+short.toFixed(1)+'pt short) — shorten this name, or a description in this column.'
    : (mk ? 'With '+mk+' marker'+(mk>1?'s':'')+' on, this' : 'This')+' name has room for '+per+' characters a line — shorten it'+(mk?' or turn a marker off':'')+'.';
  return 'Too long to print: '+printed+why+' Export is paused until it fits.';
}
function updateGate(){
  let sp=0,spBase=0,gl=0,pe=0,ov=0;
  // spelling flags on untouched baseline text stay soft — the PDF already
  // prints it; only flags on text the user edited (or added) block export
  document.querySelectorAll('.name,.desc').forEach(el=>{ const n=el.querySelectorAll('.sp').length; if(!n) return; if(el.dataset.id in edits) sp+=n; else spBase+=n; });
  document.querySelectorAll('.name .gl,.desc .gl').forEach(()=>gl++);
  document.querySelectorAll('.price.err').forEach(()=>pe++);
  // ADD-ONS panel inputs: unprintable characters block like a font error, over-length like overflow
  document.querySelectorAll('.adn.err').forEach(()=>gl++);
  document.querySelectorAll('.adn.over').forEach(()=>ov++);
  document.querySelectorAll('.card').forEach(c=>{
    const g=c.querySelector('.gl'),s=c.querySelector('.sp'),h=c.querySelector('.hint'); if(!h) return;
    let over=false;
    // Neither a description NOR a name is "too long" until the COLUMN has run out of room to push
    // for it — that is growPlan's verdict. Asking isOverflow() directly still measures the pristine
    // gap, so a name that has legitimately taken a second line would be reported as too long.
    let short=0, longName=null;
    c.querySelectorAll('.name,.desc').forEach(el=>{ const f=FIELD[el.dataset.id]; if(!f||!(el.dataset.id in edits)) return;
      const G=growPlan(f.page);
      if(f.role==='desc' ? !!G.over[f.id] : !!G.nameOver[f.id]){ over=true;
        if(f.role==='name'){ longName=f; if(G.nameShort[f.id]) short=G.nameShort[f.id]; } } });
    if(over) ov++;
    if(over){c.classList.add('haswarn');
      h.textContent = longName ? nameTooLong(longName, short)
        : 'Text is too long for the space — shorten it so it fits the line limit.';}
    else if(g){c.classList.add('haswarn');h.textContent='Some characters aren’t in the menu font and can’t be printed.';}
    else if(s){c.classList.add('haswarn');h.textContent='Possible spelling issue — click the underlined word to fix or ignore.';}
    else c.classList.remove('haswarn');
  });
  /* Spelling is ADVISORY for EXPORT too, matching the Add button. A menu is full of words no
     dictionary has, and refusing to export over one is what stopped a finished menu going out. The
     pill still reports the count so it stays visible. What genuinely blocks is only what would
     print WRONG: a character with no glyph in the font, a bad price, or text too long for its space. */
  const blocking=gl+pe+ov, total=sp+blocking, pill=document.getElementById('flagpill'), ex=document.getElementById('export');
  if(total===0){ pill.className='pill ok'; pill.textContent='All clear'+(spBase?' \u00b7 '+spBase+' word'+(spBase>1?'s':'')+' to review':''); ex.disabled=false; }
  else{ pill.className='pill bad'; const b=[]; if(sp)b.push(sp+' spelling'); if(gl)b.push(gl+' font'); if(pe)b.push(pe+' price'); if(ov)b.push(ov+' too long'); pill.textContent=b.join(' · ')+(blocking?' to fix':' to review'); ex.disabled=blocking>0; }
}
/* ---- FULL-PAGE PREVIEW HANDOFF --------------------------------------------------------------
   Opens /preview/ in a new tab showing the ACTUAL current PDF. There is NO second generator here:
   this calls the same regenerate() that Export calls, so the preview and the exported file are the
   same bytes. The PDF reaches the viewer through IndexedDB (same-origin, client-only) — it never
   enters the URL, never hits the network and is never uploaded. The record is one-shot: the viewer
   deletes it the moment it loads, and sweeps anything stale.
   The tab is opened SYNCHRONOUSLY, before the await — opening it afterwards makes the browser treat
   it as a pop-up and block it. */
const PV_DB='chucky_preview', PV_STORE='jobs';
const PV_FILE=(typeof BRAND!=='undefined'&&BRAND&&BRAND.download)?BRAND.download:'Capiche_Menu.pdf';
const PV_TITLE="Capiche — Food";
function pvDB(){ return new Promise((res,rej)=>{ const r=indexedDB.open(PV_DB,1);
  r.onupgradeneeded=()=>{ if(!r.result.objectStoreNames.contains(PV_STORE)) r.result.createObjectStore(PV_STORE); };
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
function pvPut(id,rec){ return pvDB().then(d=>new Promise((res,rej)=>{
  const tx=d.transaction(PV_STORE,'readwrite'); tx.objectStore(PV_STORE).put(rec,id);
  tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); })); }
/* chucky-2: say it in the page's bar, not alert() (some phone browsers block alerts too, and then
   Full Preview did nothing at all). The button opens the preview from a fresh tap, which a pop-up
   blocker lets through. */
function pvNotice(msg, id){ try{ MenuState.notice('warn', msg, id? [['Open the preview', ()=>window.open('/preview/#'+id,'_blank')]] : [], 15000); }catch(_){ alert(msg); } }
async function openFullPreview(){
  const btn=document.getElementById('fullprev');
  const id='job_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
  const win=window.open('/preview/#'+id,'_blank');            // sync: must precede any await
  const label=btn?btn.textContent:'';
  if(btn){ btn.disabled=true; btn.textContent='Preparing\u2026'; }
  try{
    const bytes=await regenerate();
    await pvPut(id,{ bytes:(bytes instanceof Uint8Array)?bytes:new Uint8Array(bytes),
                     file:PV_FILE, title:PV_TITLE, back:location.pathname, t:Date.now() });
    if(!win) pvNotice('Your browser blocked the preview tab.', id);
  }catch(e){
    try{ await pvPut(id,{error:String((e&&e.message)||e), t:Date.now()}); }catch(_){}
    if(!win) pvNotice('Could not build the preview: '+String((e&&e.message)||e).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'.', null);
  }finally{ if(btn){ btn.disabled=false; btn.textContent=label||'Full Preview \u2197'; } }
}
(function(){ const b=document.getElementById('fullprev'); if(b) b.addEventListener('click', openFullPreview); })();   // guarded: a missing button must never kill the engine
document.getElementById('export').addEventListener('click', async ()=>{
  const bytes=await regenerate();
  const blob=new Blob([bytes],{type:'application/pdf'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='Capiche_Menu.pdf'; a.click(); URL.revokeObjectURL(url);
  try{MEM.snapshot('export');}catch(_){}
  showChucky('Capiche_Menu.pdf');
});
// ---- Publish: chucky-2 — the shared MenuState (assets/js/menustate.js) owns the Publish button:
// the version check, the conflict handling and the live status. Wired up at the end of boot().
// ---------- PERSONALISE COVER: occasion + guest name stamped on the cover, then Export/Share ----------
const OCCASIONS=[['','—'],['WELCOME','Welcome'],['HAPPY BIRTHDAY','Birthday'],['HAPPY ANNIVERSARY','Anniversary'],
  ['CONGRATULATIONS','Congratulations'],["LET'S CELEBRATE","Let's Celebrate"],['__custom','Custom message…']];
function openPersona(){
  if(document.querySelector('.persov')) return;
  const preset=OCCASIONS.find(o=>o[0]===persona.occasion) ? persona.occasion : (persona.occasion?'__custom':'');
  const ov=document.createElement('div'); ov.className='persov';
  ov.innerHTML='<div class="perscard"><div class="pershd">✨ Personalise the cover<span>occasion + guest name — printed on the menu cover</span></div>'
    +'<label class="perslbl">Occasion</label><select class="perssel">'+OCCASIONS.map(o=>'<option value="'+o[0]+'"'+(o[0]===preset?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>'
    +'<input class="persocc" maxlength="28" placeholder="OCCASION (e.g. HAPPY BIRTHDAY)" '+(preset==='__custom'?'':'style="display:none"')+' value="'+esc(preset==='__custom'?persona.occasion:'')+'">'
    +'<label class="perslbl">Guest / table name</label><input class="persguest" maxlength="24" placeholder="GUEST NAME" value="'+esc(persona.guest||'')+'">'
    +'<div class="persfoot"><button class="cropbtn ghost" data-a="clear" type="button">Clear</button><button class="cropbtn save" data-a="done" type="button">Done</button></div></div>';
  document.body.appendChild(ov);
  const sel=ov.querySelector('.perssel'), occ=ov.querySelector('.persocc'), guest=ov.querySelector('.persguest');
  const apply=()=>{ let o = sel.value==='__custom' ? occ.value : sel.value; persona.occasion=(o||'').toUpperCase(); persona.guest=(guest.value||''); schedulePreview(); try{MEM.tick();}catch(_){} document.getElementById('persona').classList.toggle('on', !!(persona.occasion||persona.guest)); };
  sel.onchange=()=>{ occ.style.display = sel.value==='__custom'?'':'none'; if(sel.value==='__custom') occ.focus(); apply(); };
  occ.oninput=apply; guest.oninput=apply;
  ov.addEventListener('click',e=>{ if(e.target===ov){ ov.remove(); return; } const b=e.target.closest('[data-a]'); if(!b)return;
    if(b.dataset.a==='clear'){ sel.value=''; occ.value=''; occ.style.display='none'; guest.value=''; apply(); }
    else ov.remove();
  });
  document.getElementById('persona').classList.toggle('on', !!(persona.occasion||persona.guest));
}
document.getElementById('persona').addEventListener('click', openPersona);

// ---------- boot ----------
// ---- edit-memory glue (capiche) ----
const MEM_BRAND='capiche';
let memBaseVer='';
function memSnapshot(){ return { qr:QRK.snap(), edits:{...edits}, removed:[...removed], added, markerEdits, persona:{...persona}, addons: addonsSnap() }; }
function memApply(st){ QRK.load(st&&st.qr); for(const k in edits) delete edits[k]; Object.assign(edits, st.edits||{}); rewrapBaked(); /* chucky-2 */ removed=new Set(st.removed||[]); added=st.added||[]; markerEdits=st.markerEdits||{}; persona=Object.assign({occasion:'',guest:''}, st.persona||{});
  if(addons){
    if(st.addons && st.addons.rows){ addons.rows=st.addons.rows.map(r=>({key:r.key, name:r.name, price:r.price, removed:!!r.removed})); addons.title=st.addons.title||''; }
    else addonsInit();
    /* legacy snapshots (before the ADD-ONS panel) carried these prices as plain edits; the ids are
       now skipped in opsForPage, so fold a saved edit into the matching row or it silently vanishes */
    FM.addons.rows.forEach((sr,i)=>{ if(sr.price_id in edits){ const br=addons.rows.find(r=>r.key==='b'+i); if(br) br.price=edits[sr.price_id]; delete edits[sr.price_id]; } });
  }
}
function memRebuild(){ buildEditor(); regenerate().then(renderPreview); }
// ============ EDIT MEMORY — autosave + resume + version history (per brand) ============
// Glue each editor must define BEFORE this block:
//   const MEM_BRAND = 'aiko-drinks';        // unique key
//   function memSnapshot(){ return {...}; }  // serialisable current edit state (order-stable)
//   function memApply(state){ ... }          // mutate editor vars from a saved state
//   function memRebuild(){ ... }             // rebuild UI + regenerate + render after apply
//   let   memBaseVer = '';                   // fingerprint of the base PDF (for #6 update detection)
const MEM = (function(){
  const K='chucky_mem_'+MEM_BRAND, AUTO=K+':auto', SNAPS=K+':snaps';
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
    timer=setTimeout(()=>{ try{ localStorage.setItem(AUTO, J({t:Date.now(), base:memBaseVer, pub:(window.MenuState?MenuState.version():null), s:memSnapshot()})); setStatus('Saved on this device','ok'); }catch(_){ setStatus('',''); } }, 500);
  }
  function snapshot(label){ if(!dirty()) return; try{ const a=P(localStorage.getItem(SNAPS))||[];
    a.unshift({t:Date.now(), label:label||'edit', base:memBaseVer, s:memSnapshot()});
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
    else list.forEach((v,i)=>{ h+='<div class="memrow" data-i="'+i+'"><span class="ml"><div>'+esc(v.label)+'</div><div class="mt">'+ago(v.t)+(v.base!==memBaseVer?' · older menu':'')+'</div></span><span class="mr">restore</span></div>'; });
    panel.innerHTML=h;
    panel.querySelectorAll('.memrow[data-i]').forEach(r=>r.addEventListener('click',()=>{ const v=snaps()[+r.dataset.i]; if(v){ snapshot('before restore'); restore(v.s); panel.classList.remove('on'); } }));
  }
  function esc(s){ return (s+'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function checkResume(){
    const a=P(localStorage.getItem(AUTO)); if(!a||!a.s||J(a.s)===initial) return;
    const bar=document.getElementById('membar'); if(!bar) return;
    const stale=a.base && memBaseVer && a.base!==memBaseVer;
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


async function boot(){
  try{
    document.getElementById('bootmsg').textContent='Loading dictionaries…';
    [FM, BASE_LIST, CULINARY_LIST] = await Promise.all([
      fetch('fieldmap.json?v='+Date.now()).then(r=>r.json()),
      fetch('base_words.json?v='+Date.now()).then(r=>r.json()),
      fetch('culinary.json?v='+Date.now()).then(r=>r.json())
    ]);
    BASE=new Set(BASE_LIST); CULINARY=new Set(CULINARY_LIST);
    ALLOWED=FM.allowed; ADV=FM.adv; PAGES=FM.page_sizes; ICONS=FM.icons; SECTIONS=FM.sections||[]; AC=FM.add_const;
    /* Digits are printable in a NAME even though the name face has no digit outlines, because the
       emitter draws them from the price face instead (see nameRunPdf). FM.allowed.name correctly
       describes AOMonoBlack's own inventory and is left alone; the editor's gate is widened here so
       it reflects what can actually be PRINTED rather than what one resource happens to hold. */
    ALLOWED = Object.assign({}, ALLOWED, { name: ALLOWED.name + NAME_DIGITS + NAME_PUNCT });
    FM.fields.forEach(f=>FIELD[f.id]=f);
    // decode PDF escapes (e.g. \\222) then normalize smart-punctuation baked into the SOURCE menu so the editor shows clean, printable text
    const _pdfEsc=s=>(s||'').replace(/\\([0-7]{1,3})/g,(m,o)=>String.fromCharCode(parseInt(o,8)&0xff)).replace(/\\([()\\])/g,'$1');
    FM.fields.forEach(f=>{ if(f.display) f.display=normTypo(_pdfEsc(f.display)); if(f.text) f.text=normTypo(_pdfEsc(f.text)); });
    for(const f of FM.fields){ if(f.role==='name'||f.role==='desc'){ for(const w of deacc((f.display||'').toLowerCase()).split(/[^a-z']+/)) if(w) MENU.add(w); } }
    try{ const saved=JSON.parse(localStorage.getItem('capiche_dict')||'[]'); saved.forEach(w=>IGNORED.add(w)); }catch(_){}
    document.getElementById('bootmsg').textContent='Loading your menu file…';
    pdfBytesOrig = new Uint8Array(await (await fetch('capiche.pdf?v='+Date.now())).arrayBuffer()); memBaseVer='v'+pdfBytesOrig.length;
    doc = await PDFDocument.load(pdfBytesOrig);
    /* chucky-2: the PDF's AO Mono faces are subsets (the name face has no Z, Q, X or digits), so swap
       in the full fonts from /assets/fonts/ and let the editor accept whatever they hold. Name runs
       are AOMonoBlack, descriptions AOMonoBold; prices stay digits-only. A face that fails to load
       keeps its subset and its old character list. */
    document.getElementById('bootmsg').textContent='Loading the menu fonts…';
    const full = await FullFonts.embed(doc, { AOMonoBlack:'/assets/fonts/Aomono-Black.otf',
      AOMonoBold:'/assets/fonts/Aomono-Bold.otf', AOMonoRegular:'/assets/fonts/Aomono-Regular.otf' });
    FULL_NAME_FACE = !!full.AOMonoBlack;
    if(full.AOMonoBlack) ALLOWED.name = full.AOMonoBlack;
    if(full.AOMonoBold)  ALLOWED.desc = full.AOMonoBold;
    for(let p=0;p<doc.getPageCount();p++){
      const page=doc.getPage(p); const ref=page.node.get(PDFName.of('Contents'));
      const stream=doc.context.lookup(ref);
      pageStreams.push({ref, dict:stream.dict, pristine:stream.contents.slice()});
    }
    /* chucky-2: the ADD-ONS list is initialised BEFORE a saved state is applied. It used to run
       after, so memApply() saw addons===null, skipped the saved rows, and addonsInit() then reset
       them — a published add-on price was silently dropped on every load. */
    addonsInit();                 // ADD-ONS footer list state, from FM.addons (no-op if absent)
    // Publish: load the last-published edit-state (if any) before running the pre-steps below or
    // building the UI, so any device opening this editor sees the last-published menu. Never blocks
    // boot: a down/slow API, or nothing ever published, leaves the menu's starting state in place.
    /* chucky-2: MenuState.boot retries the load, applies a published state only if it was made for
       THIS base PDF (its edits address byte spans in one file), falls back to the menu's starting
       state (start-state.json — the current menu, as edits over capiche.pdf), and — unlike the old
       silent 4s fallback — puts up a bar and locks Publish when the published menu can't be loaded. */
    const _st=await MenuState.boot({ editor:MEM_BRAND, base:memBaseVer, start:'start-state.json' });
    if(_st) memApply(_st);
    readRunTracking();            // per-field Tc, needed by every name width calculation
    capDescsAtPrices();           // chucky-2: descriptions wrap before the price column (needs Tc)
    adoptStrayMarkers();          // must run before buildEditor(): it changes what the chips show
    buildEditor(); try{MEM.init();}catch(e){console.error(e);}
    MenuState.ready({                 // chucky-2: publish, live status, newer-version pickup, versions
      snapshot: memSnapshot,
      apply: st=>{ memApply(st); memRebuild(); },
      beforePublish: ()=>regenerate(),        // refuse to publish a state that doesn't even export
      keep: label=>MEM.snapshot(label),       // park the current edits in History before replacing them
      rebase: ()=>MEM.rebase(),
    });
    await regenerate(); await renderPreview();
    document.getElementById('boot').style.display='none';
  }catch(e){
    document.getElementById('bootmsg').innerHTML='Couldn’t load. If you opened this file directly, it needs to be <b>served</b> (deploy it, or run a local server). <br>'+esc(String(e));
    console.error(e);
  }
}
// ---------- Chucky: mascot + greeting + export celebration (UI only; engine untouched) ----------
const CHUCKY_SVG='<svg viewBox="0 0 220 220" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">'
+'<path d="M58 188 C22 188 24 156 48 158" fill="#fff"/>'
+'<path d="M70 200 C34 200 36 150 60 128 C72 117 78 116 86 112 C104 124 124 124 142 114 C150 119 160 126 168 138 C190 168 178 201 138 200 C116 200 92 200 70 200 Z" fill="#fff"/>'
+'<path d="M96 199 q6 6 12 0 M120 199 q6 6 12 0" stroke-width="2.4"/>'
+'<path d="M74 70 L68 30 L94 54 C102 50 118 50 126 56 L152 32 L146 74 C156 96 150 120 110 121 C72 121 64 94 74 70 Z" fill="#fff"/>'
+'<path d="M139 67 L154 58" stroke-width="3.6"/>'
+'<rect x="74" y="64" width="32" height="20" fill="currentColor" stroke="none"/>'
+'<rect x="112" y="62" width="28" height="17" fill="currentColor" stroke="none"/>'
+'<rect x="103" y="69" width="10" height="5" fill="currentColor" stroke="none"/>'
+'<rect x="79" y="78" width="6.5" height="4.5" fill="#fff" stroke="none"/>'
+'<rect x="116" y="74" width="5" height="3.5" fill="#fff" stroke="none"/>'
+'<path d="M106 95 q5 6 10 1" stroke-width="2.6"/>'
+'<path d="M80 85 L56 79 M80 90 L54 91 M82 95 L58 103" stroke-width="2.2"/>'
+'<path d="M150 81 L174 75 M150 86 L176 87 M148 91 L172 99" stroke-width="2.2"/></svg>';
const CHUCKY_LINES=[
 "KILLED IT 😎","NAILED IT.","CHEF’S KISS 🤌","MENU SLAPS.","COOKED. LITERALLY.","SERVED 🍽️",
 "TOO COOL FOR THE KITCHEN.","CRISPY.","MIC DROP 🎤","FLAWLESS VICTORY.","BOOM. PLATED.","CERTIFIED BANGER.",
 "SHARPER THAN MY SHADES.","PURR-FECTION 🐾","ATE. NO CRUMBS.","HOT OUT THE OVEN.","CLEAN LIKE MY WHISKERS.",
 "BIG CHEF ENERGY.","WHISKED IT, RISKED IT, KILLED IT.","ANOTHER ONE. 🐾","DEVOURED.","SMOOTH OPERATOR.",
 "ICE COLD 🧊","THAT’S A WRAP.","SEASONED TO PERFECTION.","SLAYED THE PLATE.","FRESH OUTTA THE LAB.",
 "CRUSHED IT.","GORDON WHO?","WORLD-CLASS, BABY.","SIZZLIN’.","DROPPED A BANGER.","NO NOTES.",
 "ABSOLUTELY COOKED.","TOP TIER.","MASTERPIECE.","EXPORTED & FLEXED.","LOCKED IN 🔒","UNDEFEATED.",
 "SAUCY.","GO OFF, CHEF.","LEGENDARY.","SHADES ON, MENU DONE.","EASY. 😼"];
const CHUCKY_GREET=[
 "How can I help you today, you non-skilled human?","Oh. It's you again. Let's fix this menu.",
 "I brought the shades. You bring the typos.","Point. Click. Let me carry you.",
 "90% attitude, 10% PDF surgeon. Let's go.","Try not to break anything. I'm watching. 😎",
 "Cleaner. Shorter. Better. Sound familiar?","Cool cats edit fast. Keep up.",
 "I do the hard part. You take the credit.","Ready when you are, slowpoke.",
 "I've seen worse menus. Barely.","Sit. Stay. Watch a professional work.",
 "Another menu you couldn't handle alone? Adorable.","Relax, human. The cat's got it."];
let _chuckyN=0;
function _cbday(){ const n=new Date(); return Math.floor(new Date(n.getFullYear(),n.getMonth(),n.getDate()).getTime()/86400000); }
function chuckyLine(){ const i=((_cbday()*7+_chuckyN++)%CHUCKY_LINES.length+CHUCKY_LINES.length)%CHUCKY_LINES.length; return CHUCKY_LINES[i]; }
function chuckyGreet(){ let c=+(sessionStorage.getItem('chucky_g')||0); sessionStorage.setItem('chucky_g',c+1);
  return CHUCKY_GREET[((_cbday()*5+c)%CHUCKY_GREET.length+CHUCKY_GREET.length)%CHUCKY_GREET.length]; }
function showChucky(fn){ const el=document.getElementById('celebrate'); if(!el) return;
  el.querySelector('.cbline').textContent=chuckyLine(); el.querySelector('.cbsub').textContent=(fn||'menu')+' — exported';
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  clearTimeout(showChucky._t); showChucky._t=setTimeout(()=>el.classList.remove('on'),2700); }
function sayChucky(msg,ms){ const s=document.getElementById('chuckysay'); if(!s) return;
  s.textContent=msg||chuckyGreet(); s.classList.remove('on'); void s.offsetWidth; s.classList.add('on');
  clearTimeout(sayChucky._t); if(ms!==0) sayChucky._t=setTimeout(()=>s.classList.remove('on'),ms||6000); }
(function(){
  const o=document.createElement('div'); o.id='celebrate';
  o.innerHTML='<div class="cbcard"><div class="cbcat">'+CHUCKY_SVG+'</div><div class="cbline"></div><div class="cbsub"></div></div>';
  o.addEventListener('click',()=>o.classList.remove('on')); document.body.appendChild(o);
  /* chucky-2: the home link, the #chuckysay bubble and the greeting come from the shell
     (assets/js/editor.js); only the export celebration is made here. */
})();

// ===================== redesign shell (engine untouched) =====================
function syncRail(){
  const rail=document.getElementById('rail'); if(!rail) return;
  rail.querySelectorAll('.sec').forEach(e=>e.remove());
  [...document.querySelectorAll('#editor .sechd')].forEach(h=>{
    const b=document.createElement('button'); b.className='sec'; b.dataset.target=h.id;
    const cnt=h.querySelector('.n')?h.querySelector('.n').textContent.replace(/ items?$/,''):'';
    b.innerHTML='<span>'+(h.dataset.sec||'Items')+'</span><span class="ct">'+cnt+'</span>';
    b.onclick=()=>{ const t=document.getElementById(h.id); if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
      rail.querySelectorAll('.sec').forEach(x=>x.classList.remove('on')); b.classList.add('on');
      if(matchMedia('(max-width:640px)').matches) closeDrawers(); };
    rail.appendChild(b);
  });
  rail.querySelectorAll('.tabs button').forEach(t=>t.classList.toggle('on',+t.dataset.pg===activePage));
  const q=document.getElementById('q'); if(q&&q.value) filterItems(q.value);
}
(function(){ const ed=document.getElementById('editor'); if(!ed) return;
  ed.addEventListener('scroll',()=>{ const heads=[...ed.querySelectorAll('.sechd')]; if(!heads.length)return;
    const top=ed.getBoundingClientRect().top+70; let cur=heads[0];
    for(const h of heads){ if(h.getBoundingClientRect().top<=top) cur=h; }
    document.querySelectorAll('#rail .sec').forEach(s=>s.classList.toggle('on',s.dataset.target===cur.id));
  },{passive:true}); })();
function filterItems(q){ q=(q||'').trim().toLowerCase();
  document.querySelectorAll('#editor .card').forEach(c=>{ const nm=c.querySelector('.name'),ds=c.querySelector('.desc');
    const t=((nm?nm.textContent:'')+' '+(ds?ds.textContent:'')).toLowerCase(); c.style.display=(!q||t.includes(q))?'':'none'; });
  document.querySelectorAll('#editor .rmstrip').forEach(r=>{ const t=(r.textContent||'').toLowerCase(); r.style.display=(!q||t.includes(q))?'':'none'; });
  document.querySelectorAll('#editor .sechd').forEach(h=>{ let n=h.nextElementSibling,any=false;
    while(n&&!n.classList.contains('sechd')){ if((n.classList.contains('card')||n.classList.contains('rmstrip'))&&n.style.display!=='none') any=true; n=n.nextElementSibling; }
    h.style.display=(!q||any)?'':'none'; }); }
function togglePrev(force){ const p=document.getElementById('previewPane'),s=document.getElementById('scrim');
  const open=force!==undefined?force:!p.classList.contains('open');
  p.classList.toggle('open',open); document.getElementById('rail').classList.remove('open');
  s.classList.toggle('on',open&&matchMedia('(max-width:1080px)').matches); }
function closeDrawers(){ document.getElementById('previewPane').classList.remove('open'); document.getElementById('rail').classList.remove('open'); document.getElementById('scrim').classList.remove('on'); }
document.addEventListener('keydown',e=>{ if(e.key==='/'&&document.activeElement.tagName!=='INPUT'&&!document.activeElement.isContentEditable){e.preventDefault();const q=document.getElementById('q');if(q)q.focus();} });

boot();
