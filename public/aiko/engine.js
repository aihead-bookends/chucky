/* Aiko — the menu engine: byte-level edits to aiko.pdf, driven by fieldmap.json.
   Ported verbatim from the original Chucky editor (deploy/public/aiko/index.html); every change is
   marked "chucky-2". It runs inside the shell that assets/js/editor.js renders, loads and publishes
   through assets/js/menustate.js, and relies on pdf-lib (PDFLib) and pdf.js (pdfjsLib) loaded by
   index.html. */
const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const BRAND = { name:'Aiko', pdf:'aiko.pdf', download:'Aiko_Menu.pdf', dictKey:'aiko_dict',
  markers:['dairy','gluten','sesame','jain','korea','new'] };
let FM, BASE, CULINARY, ALLOWED, ADV, PAGES, FIELD={}, ICONS, SECTIONS, AC;
let BASE_LIST=[], CULINARY_LIST=[];
const IGNORED = new Set(), MENU = new Set();
const edits = {};
const allerEdits = {};   // nameId -> [allergens]  (per-item allergen toggles on existing items)
let removed = new Set();
let added = [];   // [{sec, name, desc, price, allergens:[], _id}]
let order = {};   // 'page|SECTION' -> [dishId,...] user reordering WITHIN that section
let addSeq = 0;          // field id -> new text
let doc, pageStreams=[], pdfBytesOrig;
let activePage = 0, lastBytes=null, pdfjsDoc=null, renderToken=0;

const enc = s => new TextEncoder().encode(s);
let persona = { occasion:'', guest:'' };   // personalised cover (occasion + guest name)
// Aiko cover: the intro paragraph is REPLACED by the occasion/guest line when personalising.
// matches Menual: large, grey, right-aligned in the header where the intro was
const COVER = { page:0, cx:458, adv:0.6, delFind:'Aiko is our way', delEnd:'made with care',
  occ:{ align:'right', right:575, y:800, size:21, font:'/TT0', color:'0.72 0.72 0.72 rg' },
  guest:{ align:'right', right:575, y:774, size:17, font:'/TT0', color:'0.72 0.72 0.72 rg' } };
function coverDel(){ if(COVER._del) return COVER._del;
  try{ const raw=new TextDecoder('latin1').decode(pageStreams[COVER.page].pristine);
    const i=raw.indexOf(COVER.delFind); if(i<0) return COVER._del=[];
    const bt=raw.lastIndexOf('BT',i), e=raw.indexOf(COVER.delEnd,i), et=raw.indexOf('ET',e)+2;
    return COVER._del=(bt>=0&&e>=0&&et>1)?[[bt,et]]:[];
  }catch(_){ return COVER._del=[]; } }
function personaLine(spec, text){ const t=(text||'').toUpperCase(); if(!t) return '';
  const w=t.length*COVER.adv*spec.size;
  const x = spec.align==='right' ? (spec.right - w) : ((spec.cx!=null?spec.cx:COVER.cx) - w/2);
  return '\nq BT '+spec.color+' '+spec.font+' 1 Tf '+spec.size+' 0 0 '+spec.size+' '+x.toFixed(2)+' '+spec.y+' Tm ('+escPdf(t)+')Tj ET Q'; }
function personaCover(p){ if(p!==COVER.page || (!persona.occasion && !persona.guest)) return { del:[], add:'' };
  return { del:coverDel().slice(), add: personaLine(COVER.occ, persona.occasion)+personaLine(COVER.guest, persona.guest) }; }
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
function descTm(f){            // the block's Tm (so we can swap the size)
  if(f._tm!==undefined) return f._tm;
  const t=pageText(f.page), s0=f.line_spans[0][0];
  const bt=t.lastIndexOf('BT',s0), st=bt>=0?bt:Math.max(0,s0-200);
  const re=/([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g; let m,last=null;
  const seg=t.slice(st,s0); while((m=re.exec(seg))) last=m;
  f._tm=last?{s:st+last.index,e:st+last.index+last[0].length,size:parseFloat(last[1]),x:parseFloat(last[3]),y:parseFloat(last[4])}:null;
  return f._tm;
}
/* ---- GRAMS TAG FOLLOWS THE DESCRIPTION ------------------------------------------------------
   The grams tag ("[250gms]") is NOT part of the description run: it is its own Tj with its own
   absolute Tm, parked at the end of the baked LAST description line. Editing the description
   re-flows that line, but the tag used to stay put — so a longer last line printed straight
   through it (CHEESE & CHILLI DUMPLINGS: "chillies, Water Chestnut" collided with "[250gms]").
   The added-dish stamp already derives the tag's x from its rendered last line; baked rows now do
   the same. Shift by the DELTA from the baked geometry rather than recomputing absolutely, so the
   designer's own gap survives and an UNCHANGED last line re-emits a byte-identical matrix.
   Aiko-only: Capiche folds grams into the description string and Churn'd has no descriptions. */
const _gPairByPage={};
function gramsForDesc(f){                 // the grams field belonging to this desc field, or null
  const p=f.page;
  if(_gPairByPage[p]===undefined){
    const m={};
    for(const it of itemsForPage(p).items) if(it.desc && it.grams) m[it.desc.id]=it.grams;
    _gPairByPage[p]=m;
  }
  return _gPairByPage[p][f.id]||null;
}
// grams matrices carry a hair of skew (`5 0.0005 -0.0005 5 x y`), so this cannot reuse descTm's
// stricter `a 0 0 d` pattern — that would find no match and silently leave the tag behind.
function gramsTm(g){
  if(g._gtm!==undefined) return g._gtm;
  const t=pageText(g.page), s0=g.tj_span[0];
  const bt=t.lastIndexOf('BT',s0), st=bt>=0?bt:Math.max(0,s0-200);
  const re=/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g;
  let m,last=null; const seg=t.slice(st,s0);
  while((m=re.exec(seg))) last=m;
  g._gtm = last ? {s:st+last.index, e:st+last.index+last[0].length, v:last.slice(1,7).map(Number)} : null;
  return g._gtm;
}
function bakedDescLine(f,i){              // text of one baked description line, parens stripped
  const sp=f.line_spans && f.line_spans[i]; if(!sp) return '';
  const m=/^\(([\s\S]*)\)$/.exec(pageText(f.page).slice(sp[0],sp[1]));
  return m ? m[1].replace(/\\([()\\])/g,'$1') : '';
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
  // `extra` is the number of ADDITIONAL lines the column has agreed to pay for by pushing the
  // dishes below this one down (see growPlan). It is granted, not measured, so it adds on top of
  // whatever the pristine gap already affords. extra=0 reproduces the pre-growth behaviour exactly.
  // Cap growth at +2 lines: a big empty gap (last dish in a column) shouldn't license a
  // 9-line description, and that space can hold art/headers this map doesn't know about.
  return Math.max(B, Math.min(B+2, (extra||0)+1+Math.floor((gapBelowF(f)-DESC_CLEAR)/lh)));
}
/* chucky-2: DESCRIPTIONS FILL THE LINE UP TO THE PRICES, THEN WRAP. A description line may not run
   into the price column: it ends at least DESC_PRICE_CLEAR short of where the column's prices start,
   and a line that would reach further wraps to the next line. The limit is worked out per
   description from its own x, size and tracking and BECOMES its max_chars (the fieldmap's value was
   just the designer's longest line for that dish), so every wrap fills the line right up to it.
   Baked descriptions whose own lines already run under the prices are re-set on load: see REWRAP. */
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
/* chucky-2: THE GRAMS TAG TAKES ROOM ON THE LAST LINE. Aiko prints a dish's weight ("[250gms]") in
   small type straight after the last line of its description (see the grams move in opsForPage).
   Wrapping never counted it, so a description that filled its line up to the price pushed the tag
   into the price column. The tag is wrapped as one more word (a placeholder as wide as the tag) and
   then taken out again: every line fills up to the prices, and the last one leaves the tag room. */
const GRAMS_MARK='\u0001';   // a character no menu text contains
function gramsChars(f, sz){        // the tag's width in characters of this description at size sz; 0 if none
  const g=gramsForDesc(f); if(!g) return 0;
  const tag=String((g.id in edits)?edits[g.id]:(g.display||'')).trim();      // an edited weight counts as typed
  return Math.max(1, Math.ceil(tag.length*ADV.desc*(g.size||5)/((ADV.desc+(f.tc||0))*sz)));
}
// wrap text as if a tag n characters wide followed its last word, then take the tag out
function withGramsTag(text, mc, maxlines, n){
  if(!n) return wrapDesc(text, mc, maxlines);
  const P=GRAMS_MARK.repeat(n), w=wrapDesc(text+' '+P, mc, maxlines), L=w.lines.slice();
  let i=L.length-1; while(i>=0 && !L[i]) i--;
  if(i>=0 && L[i]===P){                        // the tag alone on the last line: bring the last word down to it
    if(i>0 && L[i-1]){ const ws=L[i-1].split(' '), last=ws.pop(); L[i-1]=ws.join(' '); L[i]=last; } else L[i]='';
  } else if(i>=0 && L[i].endsWith(' '+P)) L[i]=L[i].slice(0,-(P.length+1));
  return {lines:L, overflow:w.overflow};
}
function wrapWithGrams(f, val, mc, maxlines, sz){ return withGramsTag(val, mc, maxlines, gramsChars(f, sz)); }
// an ADDED dish's weight tag is drawn after its last line too (buildItemJS), in the same face
function addedDescWrap(desc, grams, sec){
  const tag=grams ? ('['+grams+'gms]').length : 0;
  return withGramsTag(String(desc||'').toUpperCase(), descWidthFor(sec), 2, tag ? Math.ceil(tag*AC.grams_size/AC.desc_size) : 0);
}
function fitDesc(f,val,extra){  // use every line that fits; only then shrink the size
  const FLOOR=+(f.size*0.72).toFixed(3);
  let sz=f.size, mc=f.max_chars;
  for(let i=0;i<18;i++){
    const w=wrapWithGrams(f, val, mc, maxLinesAt(f,sz,extra), sz);
    if(!w.overflow) return {lines:w.lines, size:sz, overflow:false};
    if(sz<=FLOOR) break;
    sz=Math.max(FLOOR,+(sz*0.94).toFixed(3));
    mc=Math.max(4, Math.floor(f.max_chars*f.size/sz));   // smaller glyphs -> more chars in the same width
  }
  const w=wrapWithGrams(f, val, Math.max(4,Math.floor(f.max_chars*f.size/FLOOR)), maxLinesAt(f,FLOOR,extra), FLOOR);
  return {lines:w.lines, size:FLOOR, overflow:w.overflow};
}
/* REAL per-dish name budget. The baked `max_chars` is a legacy constant that does not describe the
   space available: MARGHERITA carries 12 while its row actually holds 22, which is why typing
   `MARGHERITA PI` was rejected. roomier-text-limits.md measured the opposite failure too — capiche
   0:18 has max_chars=24 but ends PAST its own price. Measure it instead: from the name x to the
   leftmost price to its RIGHT (same column), less the marker cluster the name must not run under.
   The cluster slides right with a longer name (see the marker pass), so only its WIDTH is reserved.
   Clamped with Math.max so this can only ever widen a budget, never narrow one. */
/* ---- NAME WIDTH: the runs carry tracking, and it is not optional -----------------------------
   Aiko's name runs are set with `-0.024 Tc 0.024 Tw`. PDF advances a glyph by
   `(w0/1000*Tfs + Tc + Tw_if_space) * Th`, and the point size lives in the Tm, so a character
   advances `(0.587 - 0.024) = 0.563 em` while a SPACE advances the full `0.587` — the Tw exactly
   cancels the Tc. Measured: TTEOKBOKKI, the one probe name with no spaces, has a glyph pitch of
   0.5618 em against a predicted 0.563.
   Unlike Capiche (whose Tw is negative, so ignoring it over-estimates and is safe), Aiko's Tw is
   POSITIVE — ignoring it would UNDER-estimate any name containing a space, which is the unsafe
   direction for a capacity budget. Both terms are therefore applied.
   Tc is read per field because it is inherited graphics state: 40 of 46 names inherit -0.024, six
   inherit 0. */
function readRunTracking(){
  for(const f of FM.fields){
    if(f.role!=='name'&&f.role!=='desc') continue;
    const spans=f.lines? f.lines.flat() : (f.line_spans||[]);
    const first=spans.length? (Array.isArray(spans[0])?spans[0][0]:spans[0]) : null;
    if(first==null) continue;
    const t=pageText(f.page);
    const pick=(op)=>{ const i=t.lastIndexOf(' '+op, first); if(i<=0) return 0;
      const m=/(-?[\d.]+)\s*$/.exec(t.slice(Math.max(0,i-24), i)); return m? parseFloat(m[1]) : 0; };
    const tc=pick('Tc'), tw=pick('Tw');
    f.tc=isFinite(tc)?tc:0; f.tw=isFinite(tw)?tw:0;
  }
}
const _advBase=()=>((typeof ADV!=='undefined'&&ADV&&ADV.name)||0.587);
/** Advance of one non-space name character, tracking included. */
function nameAdv(f){ return (_advBase()+(f.tc!=null?f.tc:0))*(f.size||11); }
/** Rendered width of a name string on this field, spaces charged at their own advance. */
function nameWidth(f,s){
  const v=String(s==null?'':s), sp=(v.match(/ /g)||[]).length;
  return v.length*nameAdv(f) + sp*((f.tw!=null?f.tw:0)*(f.size||11));
}
/** Ink width of a marker cluster, gaps included — what markerBody actually lays out. */
function markerClusterWidth(al){
  const set=al instanceof Set? al : new Set(al||[]);
  const order=(AC&&AC.marker_order)||(BRAND&&BRAND.markers)||[];
  const gap=(AC&&AC.icon_gap!=null)?AC.icon_gap:1.7;
  let w=0,n=0;
  for(const m of order){ if(!set.has(m)) continue;
    const g=markerGeomFor(m); w+=(g.w||8); n++; }
  return n? w+gap*(n-1) : 0;
}
const NAME_CLEAR=2.0;    // ink slack required between the marker row and the price
const _nameBudget={};
function nameBudgetChars(f){
  /* The cluster width depends on the dish's CURRENT marker set, so the cache is keyed by it. */
  const set=(f.id in allerEdits)? new Set(allerEdits[f.id]) : new Set(f.allergens||[]);
  const order=(AC&&AC.marker_order)||[];
  const key=f.id+'|'+order.filter(t=>set.has(t)).join(',');
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
  if(px==null) return (_nameBudget[key]=base);
  /* The cluster reservation used to look up `add_const.icon_dairy` / `icon_gluten` / `icon_j` —
     CAPICHE's key names. Aiko keeps its geometry in `marker_geo` and has no such keys, so the
     lookup always failed and `clusterW` was ALWAYS 0 despite the comment claiming otherwise.
     Consequence: 42 of 46 dishes overran their own price when typed to the budget the UI allowed.
     It now asks the same function markerBody lays the row out with. */
  const gap=(AC&&AC.marker_gap!=null)?AC.marker_gap:4;
  const room=px-NAME_CLEAR-markerClusterWidth(set)-(set.size?gap:0);
  const n=Math.floor((room-f.x)/nameAdv(f));
  /* Never advertise less than the artwork already prints — the baked name is measured proof that
     it fits. Stands down if it would actually overlap (it does not on any of the 46). */
  let floorN=String(f.display||'').trim().length;
  if(floorN>n && f.x+nameWidth(f,String(f.display||'').trim())+(set.size?gap:0)+markerClusterWidth(set)>px) floorN=0;
  return (_nameBudget[key]=Math.max(1, n, floorN));
}
function wrapFor(f,val,extra){ if(f.role==='name') return wrapName(val,nameBudgetChars(f),f.lines.length); const t=fitDesc(f,val,extra); return {lines:t.lines, overflow:t.overflow}; }
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
  return (_colGeo[k]={floor:floor, budget:Math.max(0, flowBottom-floor-DESC_CLEAR)});
}
/* Which descriptions may grow, and by how much the dishes under them must then move.
   D(f) = max(0, |lead|*size*(lines-1) + DESC_CLEAR - gapBelowF(f)) -- push by the OVERRUN, not by
   whole line-heights. At extra=0 this is provably <= 0, so no edits => no growth => byte identity.
   Resolved per column, TOP-DOWN in document order against one shared budget, which is what makes it
   deterministic. It is also what stops the maths being circular: pushing the dish below down raises
   this dish's own gapBelowF by exactly the push, so the binding constraint is the COLUMN FLOOR, not
   the neighbour. */
let _growSig=null, _growCache={};
function growSig(){
  return JSON.stringify([Object.keys(edits).sort().map(k=>k+'\u0001'+edits[k]),
    [...removed].sort(), (typeof added!=='undefined'&&added)?added.length:0,
    (typeof order!=='undefined')?order:0]);
}
function growPlan(p){
  const sig=growSig(); if(sig!==_growSig){ _growSig=sig; _growCache={}; }
  if(_growCache[p]) return _growCache[p];
  const out={byDesc:{},extra:{},fit:{},over:{},left:{}};
  for(const col of pageColumns(p)){
    let remaining=colGeo(p,col).budget;
    /* Added dishes spend from the SAME pot and are charged FIRST: a dish the user deliberately
       added must never be pushed off the page by a description that merely wants to be roomier. */
    if(typeof added!=='undefined'&&added.length&&typeof SECTIONS!=='undefined'&&SECTIONS){
      for(const it of added){ const sec=SECTIONS[it.sec];
        if(sec&&sec.page===p&&sec.col_x>=col.min&&sec.col_x<col.max) remaining-=(sec.slot||33); }
    }
    remaining=Math.max(0,remaining);
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
/* Sibling icons baked under ONE shared clip wrapper (`q .. re W n .. Q`, e.g. a dairy+jain pair
   drawn back-to-back for one dish) collapse to a SINGLE _blocks() entry keyed off whichever icon's
   `cm` happened to come first, because _blocks() tracks one `qa` shared across every nesting depth.
   The other icon's own position is lost, its span balloons to cover both, and if that first icon's
   y falls outside _ownsArt's window the whole pair silently survives a removal. Track `qa` PER OPEN
   q instead of globally, and emit a block for every q..Q pair (any depth) that captured its own
   direct `cm` -- so each icon gets its own accurate span/position, while the outer wrapper (no `cm`
   of its own) yields x:null,y:null and is skipped by the existing `b.x===null` filter. */
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
  // Merge x's that are the same column in practice. Aiko p0 names sit at 26.99 / 319.83 / 320.89,
  // which rounded to 27/320/321 and produced a DEGENERATE 1pt-wide column plus one column holding
  // both Dimsum and Sushi — which is why removing a Dimsum item used to reflow the Sushi list.
  const gx=[]; for(const x of xs){ if(gx.length&&x-gx[gx.length-1]<=12) continue; gx.push(x); }
  const W=FM.page_sizes?FM.page_sizes[p][0]:842;
  return gx.map((x,i)=>({x,min:x-12,max:(i<gx.length-1?gx[i+1]-12:W+20)}));
}
// per-page structural ops from the removed set
function structuralForPage(p, pristine){
  const removedHere=FM.fields.filter(f=>f.page===p&&f.role==='name'&&removed.has(f.id));
  const reorderHere=Object.keys(order).some(k=>k.split('|')[0]==String(p)&&order[k]&&order[k].length);
  /* A description that needs another line is structural too: the dishes under it have to move down
     to make the room. growPlan already decided how far, bounded by the column's own budget. With no
     edits nothing grows, so this early return is unchanged and empty exports stay byte-identical. */
  const _G=growPlan(p), _grew=Object.keys(_G.byDesc).some(id=>_G.byDesc[id]>0.0005);
  if(!removedHere.length&&!reorderHere&&!_grew) return {deletes:[],shiftOps:[],priceShift:{},skip:new Set(),fieldShift:{},growSlots:[],rowShift:[]};
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
     delta over in fieldShift; otherwise this function owns the raw operand.
     Grams is the exception — opsForPage rewrites the grams matrix whenever the PAIRED DESC is
     edited, so grams is routed on the desc's edit state, never its own. */
  const ownedSpans=[];
  for(const f of FM.fields){
    if(f.page!==p || !(f.id in edits)) continue;
    if(f.role==='name'){
      // a renamed dish slides its allergen cluster sideways, so the marker pass owns those stamps
      for(const sp of (f.marker_stamps||[])) ownedSpans.push({s:sp[0],e:sp[1],id:f.id});
    } else if(f.role==='desc'){
      const sp=descTm(f); if(sp) ownedSpans.push({s:sp.s,e:sp.e,id:f.id});
      const gf=(typeof gramsForDesc==='function')?gramsForDesc(f):null;      // Aiko only
      if(gf){ const gs=gramsTm(gf); if(gs) ownedSpans.push({s:gs.s,e:gs.e,id:gf.id}); }
    } else if(f.role==='header' && f.run_span){
      ownedSpans.push({s:f.run_span[0],e:f.run_span[1],id:f.id});
      const vs=labelVectorSpan(f); if(vs) ownedSpans.push({s:vs[0],e:vs[1],id:f.id});
      // renaming a serif word MOVES its decorative label, so opsForPage owns that label's run and
      // its stroked overlay as well, even though the label itself was never edited
      const pf=f.pair && FM.fields.find(q=>q.id===f.pair);
      if(pf && pf.run_span && !(pf.id in edits)){
        ownedSpans.push({s:pf.run_span[0],e:pf.run_span[1],id:pf.id});
        const pvs=labelVectorSpan(pf); if(pvs) ownedSpans.push({s:pvs[0],e:pvs[1],id:pf.id});
      }
    }
  }
  /* ACCUMULATE, never push twice for one anchor. A removal and a reorder inside the same section
     both legitimately move the same Tm; two separate ops on one operand is the same corruption the
     ownership rule above avoids. Sum the deltas and emit exactly one op per anchor. */
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
    const colGrows=FM.fields.some(f=>f.page===p&&f.role==='desc'&&f.x>=col.min&&f.x<col.max&&_G.byDesc[f.id]>0.0005);
    if(!removedYs.length&&!colGrows) continue;
    const colNameYs=FM.fields.filter(f=>f.page===p&&f.role==='name'&&f.x>=col.min&&f.x<col.max).map(f=>f.y);
    // NAME-ANCHORED clustering: assign every block in the column to its nearest name
    // baseline. Robust regardless of inter-item gap — Aiko items sit ~33pt apart with a
    // stacked name/desc/grams, where gap-based clustering would chain neighbours together.
    const ny=[...colNameYs].sort((a,b)=>b-a);                 // top -> bottom
    const cidx=y=>{ let bi=0,bd=1e9; ny.forEach((yy,i)=>{const d=Math.abs(yy-y); if(d<bd){bd=d;bi=i;}}); return bi; };
    const top=i=>ny[i];
    const remSet=new Set(removedYs.map(cidx));
    /* Slot height and reflow are SECTION-scoped, not column-scoped. Two sections share a column
       (SIDES+MAINS on the left, DIMSUM+SUSHI on the right), so measuring a slot as "distance to the
       next name in the column" makes the LAST dish of a section look enormous — TOKYO PIZZA scored
       81.19 instead of its real ~41, because the next name down is THAI CURRY in MAINS. Removing it
       then shifted the whole MAINS section (heading included) up by 81pt, straight onto the
       description above it. A section is its own stack: removing from one must never move another. */
    const _model=sectionModel(p);
    // Precompute, ONCE per column, each name-row's dish id / section / own height. Doing this by
    // "nearest dish y across all sections" was fragile and silently returned the wrong section,
    // which stopped MAINS reflowing inside itself.
    const _rowId=[], _rowSec=[], _rowH=[];
    ny.forEach((yy,i)=>{
      const f=FM.fields.find(q=>q.page===p&&q.role==='name'&&Math.abs(q.y-yy)<0.01&&q.x>=col.min&&q.x<col.max);
      _rowId[i]=f?f.id:null; _rowSec[i]=null; _rowH[i]=null;
      if(!f) return;
      for(const L in _model){ const m=_model[L];
        if(m.ids.indexOf(f.id)>=0){ _rowSec[i]=L; _rowH[i]=m.h[f.id]; break; } }
    });
    // a dish's own height, from its section's stack (the last dish uses the section's gap_below,
    // NOT the distance to the next name in the column — that crosses into the next section)
    const slotH=i=> (_rowH[i]!=null)? _rowH[i]
      : (i<ny.length-1? ny[i]-ny[i+1] : (i>0? ny[i-1]-ny[i]:0));
    // owner of a y: the nearest name that actually CLAIMS it (see _ownsRun); -1 means page chrome
    const owner=y=>{ const j=cidx(y); return _ownsRun(ny[j],y,slotH(j))? j : -1; };
    // A section that shrinks must also close its own gap for every section stacked BELOW it in the
    // same column (e.g. removing a SIDES dish should also lift MAINS' heading and dishes), not just
    // reflow inside itself. This is safe now because slotH is section-correct (uses gap_below for a
    // section's last row) -- unlike the old column-wide clustering this replaced, it can't borrow
    // height from the wrong section. dividerOps/appendedForPage already cascade this way; this brings
    // the text/header anchor path in line with them.
    const _secOrder=[]; _rowSec.forEach(s=>{ if(s!=null&&_secOrder.indexOf(s)<0) _secOrder.push(s); });
    // how far each row's OWN description pushes everything beneath it (0 for all rows when nothing
    // is edited, which is what keeps an empty export byte-identical)
    const _rowGrow=_rowId.map(id=>{ const d=id!=null&&_descByName[id]; return (d&&_G.byDesc[d.id])||0; });
    const _secShrink={}, _secGrow={};
    for(const k of remSet){ const s=_rowSec[k]; if(s==null) continue; _secShrink[s]=(_secShrink[s]||0)+slotH(k); }
    _rowGrow.forEach((g,i)=>{ const s=_rowSec[i]; if(g>0&&s!=null) _secGrow[s]=(_secGrow[s]||0)+g; });
    const _secOffset={}; let _running=0;
    for(const s of _secOrder){ _secOffset[s]=_running; _running+=(_secShrink[s]||0)-(_secGrow[s]||0); }
    // removals in the SAME section push a dish up its own stack; removals in an EARLIER section
    // (same column) push the whole section up via _secOffset
    // + moves UP (a removal closed a gap), - moves DOWN (a description above claimed more room).
    // A row's OWN growth never moves the row itself, only what is stacked under it.
    const shiftFor=j=>{ let d=0;
      for(const k of remSet){ if(k<j && _rowSec[k]!=null && _rowSec[k]===_rowSec[j]) d+=slotH(k); }
      for(let k=0;k<j;k++){ if(_rowGrow[k]>0 && _rowSec[k]!=null && _rowSec[k]===_rowSec[j]) d-=_rowGrow[k]; }
      d+=_secOffset[_rowSec[j]]||0;
      return d; };
    // chucky-2: publish every row's shift (Aiko names never take a second line, so a row moves as one)
    ny.forEach((yy,j)=>{ const d=shiftFor(j); rowShift.push({cmin:col.min, cmax:col.max, y:yy, name:d, below:d}); });
    // DELETE per RUN, not per block: only the text runs the removed dish actually owns. The block's
    // BT/rg/Tf prologue and any inter-run Tc/Tw survive, so nothing downstream is re-coloured.
    for(const r of runs){
      if(r.x<col.min||r.x>col.max) continue;
      const j=owner(r.y);
      if(j>=0&&remSet.has(j)) deletes.push(r.span);
    }
    // self-contained q..Q artwork (allergen icons, photos) still goes whole
    for(const b of blocks){
      if(b.kind!=='q'||b.x===null||b.y===null||b.x<col.min||b.x>col.max) continue;
      const j=cidx(b.y);
      if(_ownsArt(ny[j],b.y)&&remSet.has(j)) deletes.push(b.span);
    }
    for(const j of remSet) removedSlots.push({cmin:col.min,cmax:col.max,y:top(j),h:slotH(j)});
    // SHIFT per ANCHOR, judged on its OWN y — NOT on the block it happens to live in.
    // Chrome is never DELETED but it must still reflow: a section heading below a removed dish has
    // to rise with the column, or the next section lands on top of it. The exception is page
    // furniture BELOW the last dish's slot (the DAIRY/GLUTEN/JAIN legend at y~19), which is
    // anchored to the page and must stay.
    const flowBottom = ny.length? ny[ny.length-1]-slotH(ny.length-1) : 0;
    for(const a of anchors){
      if(a.x===null||a.y===null||a.x<col.min||a.x>col.max) continue;
      // 0.05 epsilon: `a.y` is the stream operand (4dp) but flowBottom is built from the fieldmap's
      // round2 y (2dp). BURRATA SALAD's name Tm is 210.2057 against a flowBottom of 210.21, so a
      // hard `<` threw the NAME away as page furniture while its markers — which sit above the
      // baseline — shifted normally, and the J landed on the description.
      if(a.y<flowBottom-0.05) continue;                  // page furniture, not in the dish flow
      const j=cidx(a.y);                                 // positional: chrome reflows too
      if(remSet.has(j)&&owner(a.y)>=0) continue;         // being deleted with its dish
      const d=shiftFor(j);
      if(Math.abs(d)<5e-4) continue;                     // was `d<=0` — growth shifts are negative
      routeShift(a,d);
    }
    // rules/art below a grown description ride down with the dishes (Capiche only in practice —
    // Aiko's artwork has no divider rules at all)
    _rowGrow.forEach((g,i)=>{ if(g>0) growSlots.push({cmin:col.min,cmax:col.max,y:top(i),h:g}); });
  }
  /* ---- REORDER WITHIN A SECTION -------------------------------------------------------------
     A dish is RELOCATED, never retyped: we shift every run it owns by one delta. That is why this
     is safe where the drinks editors' drag-drop is not — that one writes a dish's text into another
     dish's baked skeleton, so content lands in a slot whose line counts don't match. Here the bytes
     move; nothing is re-rendered.
     Ownership uses the same _ownsRun rule as deletion, so descriptions, grams, the price and the
     allergen q..Q artwork all travel with the name, while section headings and page chrome stay. */
  if(reorderHere){
    const model=sectionModel(p);
    for(const label in model){
      const m=model[label], lay=secLayout(p,label);
      const dy={};                                   // dishId -> delta
      for(const id of m.ids){ const d=+( (lay[id]!=null? lay[id] : m.y[id]) - m.y[id] ).toFixed(3); if(d) dy[id]=d; }
      if(!Object.keys(dy).length) continue;
      const secs=sectionsForPage(p);
      for(const id in dy){
        const d=dy[id], ny=m.y[id], h=m.h[id];
        const nf=FM.fields.find(f=>f.id===id);
        if(!nf||removed.has(id)) continue;
        // text runs reach a slot below the name; artwork sits just ABOVE it and must not be
        // claimed from the dish below (see _ownsArt)
        const own=(y,kind)=> kind==='cm'? _ownsArt(ny,y) : _ownsRun(ny,y,h);
        // Ownership above is judged on Y ALONE, so without a column guard reordering SIDES (top y
        // 695.03) also claims DIMSUM's name Tm at y 691.98 in the other column.
        const ncol=cols.find(c=>nf.x>=c.min&&nf.x<c.max);
        for(const a of anchors){
          if(a.x===null||a.y===null) continue;
          if(ncol&&(a.x<ncol.min||a.x>ncol.max)) continue;
          if(!own(a.y,a.kind)) continue;
          routeShift(a,d);
        }
      }
    }
  }
  // mark removed items' field ids to skip in text edits
  for(const nf of removedHere) skip.add(nf.id);
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
    // A decorative label moves when its PAIRED serif word is renamed, so it has to be visited even
    // though nothing edited the label itself.
    const pairMove = f.role==='header' && f.kind==='script' && f.pair && (f.pair in edits);
    if(!hasEdit && !yShift && !pairMove && !(fieldShift[f.id])) continue;
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
      const {lines}=wrapName(val, nameBudgetChars(f), f.lines.length);
      f.lines.forEach((pieces,i)=>{
        ops.push({s:pieces[0][0],e:pieces[0][1],rep:enc('('+escPdf(lines[i]||'')+')')});
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
      // ...and move the grams tag to the end of whatever the last line now is (see gramsForDesc)
      const _gf=gramsForDesc(f), _gtm=_gf&&gramsTm(_gf);
      if(_gtm){
        const _bi=B-1, _li=Math.max(0,last-1);
        // measure to the last VISIBLE glyph plus one space: the artwork gets its gap from a trailing
        // space inside the baked run ("red chillies "), which retyping strips — without this the tag
        // butts straight against the final letter. Both sides get the same +1, so an unchanged line
        // still yields a zero delta and a byte-identical matrix.
        const _rt=s=>String(s).replace(/\s+$/,'').length+1;
        const _bLast=bakedDescLine(f,_bi), _nLast=lines[_li]||'';
        const _nx=_gf.x + ADV.desc*(fit.size*_rt(_nLast) - f.size*_rt(_bLast));
        const _ny=_gf.y + lead*(fit.size*_li - f.size*_bi) + (fieldShift[_gf.id]||0);
        if(Math.abs(_nx-_gf.x)>0.005 || Math.abs(_ny-_gf.y)>0.005){
          const _v=_gtm.v.slice(); _v[4]=_nx; _v[5]=_ny;
          ops.push({s:_gtm.s,e:_gtm.e,rep:enc(_v.map(fmtNum).join(' ')+' Tm')});
        }
      }
    } else if(f.role==='header'){
      const _hdy=fieldShift[f.id]||0;
      /* A decorative label is positioned by its paired serif word's RIGHT EDGE, so renaming the
         serif word has to move the label too. This used to bail out unless the LABEL ITSELF was
         edited, so "Sides" -> "Sides moin" left "Starters" sitting where it was and the widened
         word slid straight underneath it. */
      const _pairEdited = f.kind==='script' && f.pair && (f.pair in edits);
      if(!hasEdit && !_pairEdited && !_hdy) continue;
      let hx=f.x;
      if(f.kind==='script'){                       // keep its offset from the serif word's right edge
        const sf=FM.fields.find(q=>q.id===f.pair);
        if(sf){ const sv=(sf.id in edits)?edits[sf.id]:sf.display;
                hx=f.x + (headerAdv(sf,sv)-headerAdv(sf,sf.display)); }
      }
      if(!hasEdit){
        /* MOVE ONLY — the word is unchanged. Slide the baked run and its stroked overlay by the
           same delta instead of retyping (see headerTmSpan): that keeps the filled text and the
           gold outline in exact register, and keeps the artwork the designer drew. */
        const _dx=hx-f.x;
        if(Math.abs(_dx)>0.005 || Math.abs(_hdy)>0.005){
          const _tm=headerTmSpan(f);
          if(_tm) ops.push({s:_tm.s,e:_tm.e,rep:enc(fmtNum(hx)+' '+fmtNum(f.y+_hdy))});
          const _mv=labelVectorSpan(f);
          if(_mv) ops.push({s:_mv[0],e:_mv[1],rep:enc(shiftArtOrigins(pageText(f.page).slice(_mv[0],_mv[1]), _dx, _hdy))});
        }
        continue;
      }
      /* Headers are drawn per kerning group — (Ri)Tj 0 Tc 0 Tw (c)Tj 1.471 0 Td (e)Tj — so patching
         the string literals would leave the stale Td offsets behind. Replace the WHOLE run with one
         Tm + Tj. The gold `rg` and the /TTn Tf sit BETWEEN the two runs, so they are untouched. */
      ops.push({s:f.run_span[0],e:f.run_span[1],
        rep:enc(fmtNum(f.size)+' 0 0 '+fmtNum(f.size)+' '+fmtNum(hx)+' '+fmtNum(f.y+(fieldShift[f.id]||0))+' Tm\n0 Tc 0 Tw\n('+escPdf(val)+')Tj')});
      /* A decorative label exists TWICE in the artwork: as this /TT2 text run AND as stroked vector
         letterforms drawn on top of it (8 `q..Q` groups and ~15.5KB for "Starters" alone, spanning
         exactly the word's x-range). Editing only the text left the old word's outline in place, so
         the new label rendered on top of the old one — which is why this was left "script WIP".
         The stroke is redundant with the filled text (removing it alone is visually identical to
         the baked artwork, verified by render), so drop it whenever the label changes. */
      if(f.kind==='script'){ const vs=labelVectorSpan(f); if(vs) ops.push({s:vs[0],e:vs[1],rep:enc('\n')}); }
      // The gold flourish under a script word is a stroked path whose cm origin sits INSIDE the
      // word. It cannot stretch, so move it by exactly the delta the word moved — that preserves
      // its baked offset from the word's start. Without this a wider retyped word slides underneath
      // the stationary squiggle and the two collide.
      // ...but only when that artwork still exists. `flourish_cm` points INSIDE the vector overlay
      // deleted just above (it is that overlay's first `cm` x), so emitting both puts two ops over
      // one range — spliceBytes assumes non-overlapping ops and the stream corrupts from there
      // (the heading vanished and the label reverted to the old word in black).
      const _vec=(f.kind==='script')?labelVectorSpan(f):null;
      const _flourishGone=!!(_vec && f.flourish_cm && f.flourish_cm[0]>=_vec[0] && f.flourish_cm[1]<=_vec[1]);
      if(f.flourish_cm && !_flourishGone && Math.abs(hx-f.x)>0.005)
        ops.push({s:f.flourish_cm[0],e:f.flourish_cm[1],rep:enc(fmtNum(f.flourish_x+(hx-f.x)))});
    } else if(f.role==='grams'){
      if(hasEdit) ops.push({s:f.tj_span[0],e:f.tj_span[1],rep:enc('('+escPdf(val)+')')});
    }
  }
  return ops;
}

// ===================== ADD-ITEM ENGINE (appends native new items) =====================
function jFmt(v){ let s=(+v).toFixed(4).replace(/0+$/,'').replace(/\.$/,''); return s||'0'; }
function jEsc(s){ return normTypo(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }
function jStamp(parts, tx, ty, s){
  const k=(s==null||!(s>0))?1:s;
  let out='';
  for(const p of parts){
    /* The whole template is scaled by rewriting the `cm` matrix, not the path data — so the
       designer's own curves are reproduced exactly, just smaller. Each part's own dx/dy is in
       TEMPLATE space and must be scaled with it, or a multi-part icon comes apart. */
    const b=p.bytes.replace(/1 0 0 1 -?[\d.]+ -?[\d.]+ cm/,
      jFmt(k)+' 0 0 '+jFmt(k)+' '+jFmt(tx+p.dx*k)+' '+jFmt(ty+p.dy*k)+' cm');
    out+=p.color+' '+b+'\n';
  }
  return out;
}
/* Ink box of an ICONS template, in template space, with each part's own dx/dy applied. Parses the
   path's numbers with the framing `cm` stripped; the |v|>60 filter drops the absolute page origin
   the template was harvested at (the NEW badge's is x 754.24, off a 595pt-wide page). */
const _tplBox={};
function templateBox(name){
  if(_tplBox[name]!==undefined) return _tplBox[name];
  const t=ICONS&&ICONS[name];
  if(!t||!t.length) return (_tplBox[name]=null);
  let mnx=Infinity,mxx=-Infinity,mny=Infinity,mxy=-Infinity;
  for(const p of t){
    const nums=(String(p.bytes||'').replace(/q [^\n]*cm/,' ').match(/-?\d+(?:\.\d+)?/g)||[]).map(Number);
    for(let i=0;i+1<nums.length;i+=2){
      const x=nums[i]+(+p.dx||0), y=nums[i+1]+(+p.dy||0);
      if(Math.abs(nums[i])>60||Math.abs(nums[i+1])>60) continue;
      if(x<mnx)mnx=x; if(x>mxx)mxx=x; if(y<mny)mny=y; if(y>mxy)mxy=y;
    }
  }
  return (_tplBox[name]=isFinite(mnx)?{minX:mnx,w:mxx-mnx,minY:mny,h:mxy-mny}:null);
}
/* Effective geometry for one marker: `marker_geo` as declared, EXCEPT for the NEW badge.
   The badge template is stored UNSCALED. `add_const.icon_scale_applied` (0.6267) records the size
   the designer's own badge is drawn at, but jStamp only ever rewrote the translate — so ticking NEW
   stamped a badge 1.6x the one the menu already prints. `marker_geo.new` compounds it: w:22 is
   neither the template width (20.024) nor the scaled one (12.549). Measured across all eight baked
   badges the real ink is 12.48-12.54pt, i.e. exactly template x scale. So the badge's geometry is
   DERIVED from the artwork and the scale rather than read from either wrong number. */
const NEW_CENTRE=5.26;   // ink centre above the baseline, median of the eight baked badges
function markerGeomFor(m){
  const g=Object.assign({dy:0,ox:0,w:8}, (AC&&AC.marker_geo&&AC.marker_geo[m])||{});
  const s=(AC&&+AC.icon_scale_applied)||0;
  if(m!=='new'||!(s>0)) return g;
  const b=templateBox('new');
  if(!b) return g;
  return { scale:s, ox:b.minX*s, w:b.w*s, dy:NEW_CENTRE-((b.minY+b.h/2)*s) };
}
function descWidthFor(sec){           // chars per desc line for a section (mono advance)
  const C=AC, w=(sec.price_right||sec.col_x+233)-sec.col_x-14;
  // chucky-2: measured to the price's RIGHT edge that ran under the price; stop before it instead
  // (an added dish stamps its own 0 Tc, so it advances exactly 0.63em)
  return Math.min(Math.max(20, Math.floor(w/(C.adv_name*C.desc_size))), descCharsBeforePrice(sec.page, sec.col_x, C.desc_size, 0));
}
/* THE KOREA FLAG IS REAL ARTWORK, not one of the extracted ICONS templates: two path groups that
   share a single origin (red 0.773 0.125 0.196, then blue 0.133 0.227 0.455), each preceded by its
   own `rg`. Redrawing it from primitives never matches the mark the menu actually prints, so lift
   the designer's own bytes out of the pristine stream and re-stamp those verbatim.
   Placement is SELF-CALIBRATED from the donor dish, so nothing new has to be baked into the
   fieldmap: replay the donor's own cluster advance, then measure where its flag really sat. */
let _koreaTpl;
function koreaTemplate(){
  if(_koreaTpl!==undefined) return _koreaTpl;
  const C=AC, geo=(C&&C.marker_geo)||{}, order=(C&&C.marker_order)||(BRAND.markers||[]);
  const gap=(C&&C.icon_gap!=null)?C.icon_gap:1.7;
  for(const f of FM.fields){
    if(f.role!=='name'||!(f.baked||[]).includes('korea')||f.marker_bx==null) continue;
    const sp=f.marker_stamps||[], t=pageText(f.page);
    const org=s=>{ const m=/q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/.exec(t.slice(s[0],s[1])); return m?[+m[1],+m[2]]:null; };
    const col=s=>{ const m=/([\d.]+ [\d.]+ [\d.]+) rg\s*$/.exec(t.slice(Math.max(0,s[0]-40), s[0])); return m?m[1]:null; };
    for(let i=0;i<sp.length-1;i++){
      const a=org(sp[i]), b=org(sp[i+1]);
      if(!a||!b||Math.abs(a[0]-b[0])>0.01||Math.abs(a[1]-b[1])>0.01) continue;   // the two halves
      const c1=col(sp[i]), c2=col(sp[i+1]); if(!c1||!c2) continue;
      const parts=[[c1,t.slice(sp[i][0],sp[i][1])],[c2,t.slice(sp[i+1][0],sp[i+1][1])]];
      /* Measure the artwork's real ink box rather than trusting the cm origin — the origin is an
         arbitrary anchor inside the glyph, not its left edge, so aligning `cur` to it made the flag
         sit back on top of the sesame icon. Path operands are all coordinate PAIRS relative to the
         origin (m/l take one, c takes three), so every even-indexed number is an x. */
      let minX=Infinity, maxX=-Infinity, minY=Infinity;
      for(const [,body] of parts){
        const nums=(body.replace(/q 1 0 0 1 -?[\d.]+ -?[\d.]+ cm/,'').match(/-?\d+(?:\.\d+)?/g)||[]).map(Number);
        for(let n=0;n<nums.length-1;n+=2){
          if(nums[n]<minX) minX=nums[n];
          if(nums[n]>maxX) maxX=nums[n];
          if(nums[n+1]<minY) minY=nums[n+1];
        }
      }
      if(!isFinite(minX)){ minX=0; maxX=(geo.korea||{}).w||7; minY=0; }
      return (_koreaTpl={ minX:minX, w:maxX-minX, dy:a[1]-f.y, parts:parts });
    }
  }
  return (_koreaTpl=null);
}
function koreaStamp(cur, baseline, g){
  const T=koreaTemplate();
  // no baked flag to copy: fall back to the drawn taegeuk
  if(!T) return 'q 1 0 0 1 '+jFmt(cur-(g.ox||0))+' '+jFmt(baseline+(g.dy||0))+' cm\n'+flagBody('korea')+'Q\n';
  const x=cur-T.minX, y=baseline+T.dy;             // align the artwork's LEFT INK EDGE to the cursor
  let out='q\n';                                   // its own q..Q so its fills never leak onward
  for(const [c,body] of T.parts)
    out+=c+' rg\n'+body.replace(/q 1 0 0 1 -?[\d.]+ -?[\d.]+ cm/, 'q 1 0 0 1 '+jFmt(x)+' '+jFmt(y)+' cm')+'\n';
  return out+'Q\n';
}
// pack allergen icons left->right from cursor bx, advancing only for present ones
function markerBody(al, bx, baseline){
  const C=AC, geo=C.marker_geo||{}, order=C.marker_order||(BRAND.markers||[]);
  const gap=(C.icon_gap!=null?C.icon_gap:1.7);
  const set=new Set(al); let cur=bx, body='';
  for(const m of order){
    if(!set.has(m)) continue;
    const g=markerGeomFor(m);
    if(m==='korea'){   // the menu's own flag artwork, re-stamped verbatim (see koreaTemplate)
      const kt=koreaTemplate();
      body+=koreaStamp(cur, baseline, g);
      cur+=((kt&&kt.w)||g.w||8)+gap;               // advance by the artwork's measured width
      continue;
    }
    if(!ICONS||!ICONS[m]) continue;
    body+=jStamp(ICONS[m], cur-(g.ox||0), baseline+(g.dy||0), g.scale);   // ink left edge on cur
    cur+=(g.w||8)+gap;                                                     // advance by real ink width
  }
  if(!body) return '';
  /* No ICONS template carries a fill colour of its own, so an appended cluster inherits whatever
     the page's last drawing op left set — gold, on a page that ends with a decorative label, which
     is how an added gluten icon came out yellow. Pin the menu's ink colour at the top of the
     cluster. The NEW badge and the Korea flag set their own colours inside their own q..Q, so
     neither leaks into whatever is stamped after them. */
  return ((C&&C.ink_color)||'0 g')+'\n'+body;
}
// standalone clip-wrapped marker group (for re-stamping an existing item on allergen toggle)
/* ---- BAKED NEW BADGES THE FIELDMAP DOES NOT RECORD ------------------------------------------
   Eight dishes print a gold NEW badge, but no `baked` or `allergens` list mentions `new`. The
   badge's geometry IS inside `marker_stamps` (its fill operator sits ~21 bytes before the span, a
   pattern shared by 100 of the 344 stamps), so the re-stamp path DELETES it and then redraws the
   cluster from `desired` — which cannot contain `new` — and the badge silently vanishes from the
   printed menu. Verified by render: dropping Jain from KOREAN MANDU removed its NEW badge.

   The artwork is the truth about what is printed, so the badge is recorded on both lists at boot:
   `baked` so a re-stamp reproduces it, and `allergens` so `desired` matches and no spurious
   re-stamp fires (which would also break byte identity). Every downstream consumer — the chip
   state, the delete pass, `sameSet` — then behaves as if the builder had recorded it. */
const NEW_BADGE_FILL='0.933 0.698 0.169 rg';
function adoptBakedBadges(){
  let n=0;
  for(const f of FM.fields){
    if(f.role!=='name'||!(f.marker_stamps||[]).length) continue;
    if((f.baked||[]).includes('new')) continue;
    const t=pageText(f.page);
    const has=(f.marker_stamps||[]).some(sp=>
      t.slice(Math.max(0,sp[0]-40), sp[1]).includes(NEW_BADGE_FILL));
    if(!has) continue;
    f.baked=[...(f.baked||[]), 'new'];
    if(!(f.allergens||[]).includes('new')) f.allergens=[...(f.allergens||[]), 'new'];
    n++;
    try{ console.warn('adopted an unrecorded baked NEW badge on '+f.id+' '+String(f.display||'').trim()); }catch(_){ }
  }
  return n;
}
/* Where a dish's marker cluster starts.
   `marker_bx` is the designer's own anchor and is normally right, but it is fieldmap data and one
   entry is not: SRI LANKAN CURRY (0:63) sits at x 26.99 with a `marker_bx` of 435.87 — 409pt away,
   in the NEXT COLUMN. Toggling any marker on it stamped dairy and gluten onto AVO CRISPY RICE, i.e.
   allergen icons on the wrong dish. Verified by render.
   So the anchor is validated rather than trusted: it must sit inside the dish's own column and
   within a sane distance of the name's right edge, otherwise fall back to the computed position.
   The fallback is the same expression the fieldmap's own anchors follow (name end + marker_gap). */
function markerAnchor(f){
  const adv=(ADV&&ADV.name)||0.587, gap=(AC&&AC.marker_gap!=null)?AC.marker_gap:4;
  const nameEnd=f.x+String(f.display||'').length*adv*(f.size||11);
  const fallback=nameEnd+gap;
  const bx=f.marker_bx;
  if(bx==null) return fallback;
  const col=(pageColumns(f.page)||[]).find(c=>f.x>=c.min&&f.x<c.max);
  if(col && (bx<col.min || bx>=col.max)) return fallback;   // anchor escaped the dish's own column
  if(bx < f.x) return fallback;                             // anchor left of the name
  if(bx - nameEnd > 120) return fallback;                   // implausibly far past the name
  return bx;
}
function markerGroup(al, bx, baseline, page){
  const body=markerBody(al,bx,baseline); if(!body) return '';
  const sz=PAGES[page]||[595.276,841.89];
  return '\nq\n0 '+jFmt(sz[1])+' '+jFmt(sz[0])+' '+jFmt(-sz[1])+' re\nW n\n'+body+'Q\n';
}
// how far an item shifts up when items above it in the same column were removed
// Net vertical travel of a dish: removals above pull it UP, descriptions above that claimed another
// line push it DOWN. Re-stamped allergen clusters ride on this, so both terms have to be here.
function itemShift(f, removedSlots, growSlots){ let d=0;
  for(const rs of (removedSlots||[])){ if(f.x>=rs.cmin && f.x<rs.cmax && rs.y>f.y) d+=Math.abs(rs.h); }
  for(const gs of (growSlots||[])){ if(f.x>=gs.cmin && f.x<gs.cmax && gs.y>f.y) d-=Math.abs(gs.h); }
  return d; }

// ---- cuisine-origin flags: tiny PDF-native flags drawn from authored shapes ----
// ROUND flag roundels — exact replica of the menu's Korea taegeuk: Ø≈6.7pt, centre 4.6pt above baseline
const FR=3.35, FCY=4.6, FD=2*FR;
function _re(x,y,w,h){ return jFmt(x)+' '+jFmt(y)+' '+jFmt(w)+' '+jFmt(h)+' re'; }
function _circ(cx,cy,r){ const k=0.5523*r,P=(a,b,c,d,e,f)=>[a,b,c,d,e,f].map(jFmt).join(' ')+' c';
  return jFmt(cx+r)+' '+jFmt(cy)+' m '+P(cx+r,cy+k,cx+k,cy+r,cx,cy+r)+' '+P(cx-k,cy+r,cx-r,cy+k,cx-r,cy)+' '+P(cx-r,cy-k,cx-k,cy-r,cx,cy-r)+' '+P(cx+k,cy-r,cx+r,cy-k,cx+r,cy)+' h'; }
function _star(cx,cy,r){ let pts=''; for(let i=0;i<10;i++){ const ang=-Math.PI/2+i*Math.PI/5, rad=i%2?r*0.42:r; const x=cx+rad*Math.cos(ang), y=cy+rad*Math.sin(ang); pts+=(i?' '+jFmt(x)+' '+jFmt(y)+' l':jFmt(x)+' '+jFmt(y)+' m'); } return pts+' h'; }
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
  // circle centre at (FR, FCY); content fills its bbox and is clipped to the circle
  const CX=FR, CY=FCY, L=CX-FR, B=CY-FR, D=FD;
  const f=(col,p)=>col+' rg\n'+p+'\nf\n';
  /* Korea is not a rectangular flag squeezed into a circle — in the baked artwork the taegeuk IS
     the whole icon: full-bleed, no white field, no border ring. Drawing it like the others left a
     small disc rattling inside a grey ring, which is not what the printed menu shows. */
  if(c==='korea') return f('0.13 0.23 0.46',_circ(CX,CY,FR))+f('0.8 0.18 0.23',_taeguk(CX,CY,FR));
  let s='q\n'+_circ(CX,CY,FR)+'\nW n\n';                 // clip to circle
  if(c==='japan'){ s+=f('1 1 1',_re(L,B,D,D))+f('0.74 0 0.18',_circ(CX,CY,FR*0.55)); }
  else if(c==='china'){ s+=f('0.85 0.16 0.08',_re(L,B,D,D))+f('1 0.87 0',_star(CX,CY,FR*0.82)); }
  else if(c==='thailand'){ s+=f('0.62 0.1 0.2',_re(L,B,D,D))+f('0.97 0.97 0.98',_re(L,B+D*0.18,D,D*0.64))+f('0.13 0.16 0.34',_re(L,B+D*0.36,D,D*0.28)); }
  else if(c==='india'){ s+=f('1 0.6 0.2',_re(L,B+D*2/3,D,D/3))+f('1 1 1',_re(L,B+D/3,D,D/3))+f('0.05 0.53 0.03',_re(L,B,D,D/3))+'0.05 0.29 0.64 RG 0.35 w\n'+_circ(CX,CY,FR*0.34)+'\nS\n'; }
  else if(c==='srilanka'){ s+=f('1 0.74 0.16',_re(L,B,D,D))+f('0 0.33 0.3',_re(L,B,D*0.22,D))+f('0.93 0.45 0',_re(L+D*0.22,B,D*0.16,D))+f('0.55 0.13 0.16',_re(L+D*0.42,B,D*0.58,D))+f('1 0.74 0.16',_circ(L+D*0.7,CY,FR*0.4)); }
  else if(c==='korea'){ s+=f('1 1 1',_re(L,B,D,D))+f('0.13 0.23 0.46',_circ(CX,CY,FR*0.62))+f('0.8 0.18 0.23',_taeguk(CX,CY,FR*0.62)); }
  s+='Q\n';                                              // end clip
  s+='0.42 0.4 0.36 RG\n0.35 w\n'+_circ(CX,CY,FR)+'\nS\n';   // round border
  return s;
}
function addItemHeight(it,sec){ // total vertical space this item needs (name + desc lines)
  const dl=addedDescWrap(it.desc, it.grams, sec).lines.filter(Boolean).length;   // chucky-2: leaves the weight tag room
  return Math.max(sec.slot, 24 + (dl-1)*Math.abs(AC.desc_leading*AC.desc_size));
}
/* ---- PER-PAGE FONT RESOURCES ----------------------------------------------------------------
   Font resource names (/TT0, /TT2 …) are PAGE-LOCAL in PDF: the same name means a different font on
   a different page. `add_const.fonts` is one global map. Aiko happens to use `/TT0` on BOTH pages
   today, so this resolver returns the same values it replaces and changes nothing here right now.
   It is carried for parity with Capiche — where that same global map corrupted page-0 adds outright
   — and so that a future artwork rebuild introducing a second font resource cannot reintroduce the
   bug silently. Resolve the resource the page's OWN baked fields use; fall back to add_const.fonts. */
const _pgFonts={};
function pageFonts(p){
  if(_pgFonts[p]) return _pgFonts[p];
  const F=AC.fonts, out={name:F.name, desc:F.desc, price:F.price, grams:F.grams};
  const t=pageText(p);
  const firstOff=f=> f.lines ? (f.lines[0]&&f.lines[0][0]&&f.lines[0][0][0])
                  : f.line_spans ? (f.line_spans[0]&&f.line_spans[0][0])
                  : (f.tj_span&&f.tj_span[0]);
  for(const role of ['name','desc','price','grams']){
    const f=FM.fields.find(q=>q.page===p&&q.role===role);
    const off=f&&firstOff(f); if(off==null) continue;
    // scan the WHOLE prefix, not a fixed window: Illustrator sets a font once and draws a long run
    // under it, so on page 0 the nearest `Tf` is thousands of bytes back and a small window finds
    // nothing, silently falling back to the global map.
    const m=(t.slice(0,off).match(/\/[A-Za-z0-9_]+ 1 Tf/g)||[]).pop();
    if(m) out[role]=m.replace(/ 1 Tf$/,'');
  }
  return _pgFonts[p]=out;
}
function buildItemJS(it, sec, Y){
  const C=AC, F=pageFonts(sec.page), NC=C.name_color, IC=C.ink_color;   // page-local resources, NOT the global map
  const NX=sec.col_x, SZ=sec.name_size||11, adv=C.adv_name*SZ;   // real Aiko mono advance (~0.587 em)
  const NTC=(C.name_tc!=null?C.name_tc:0);                       // names carry -0.024 tracking
  const DDY=(sec.desc_dy!=null?sec.desc_dy:C.desc_dy);
  const DW=descWidthFor(sec), LEAD=C.desc_leading!=null?C.desc_leading:-1.385;
  const nm=(it.name||'').toUpperCase();
  let p=[];
  p.push('BT\n'+NC+'\n'+F.name+' 1 Tf\n'+jFmt(NTC)+' Tc 0 Tw '+jFmt(SZ)+' 0 0 '+jFmt(SZ)+' '+jFmt(NX)+' '+jFmt(Y)+' Tm\n('+jEsc(nm)+')Tj\nET');
  const dlines=addedDescWrap(it.desc, it.grams, sec).lines.filter(Boolean);   // chucky-2: leaves the weight tag room
  if(dlines.length){
    let d='BT\n'+NC+'\n'+F.desc+' 1 Tf\n0 Tc 0 Tw '+jFmt(C.desc_size)+' 0 0 '+jFmt(C.desc_size)+' '+jFmt(NX)+' '+jFmt(Y+DDY)+' Tm\n('+jEsc(dlines[0])+')Tj';
    for(let i=1;i<dlines.length;i++) d+='\n0 '+jFmt(LEAD)+' Td\n('+jEsc(dlines[i])+')Tj';
    d+='\nET'; p.push(d);
    // grams: small size-5 tag trailing the last desc line
    if(it.grams){ const gx=NX+(dlines[dlines.length-1].length)*C.adv_name*C.desc_size+4;
      const gy=Y+DDY+(dlines.length-1)*LEAD*C.desc_size;
      p.push('BT\n'+NC+'\n'+F.grams+' 1 Tf\n0 Tc 0 Tw '+jFmt(C.grams_size)+' 0 0 '+jFmt(C.grams_size)+' '+jFmt(gx)+' '+jFmt(gy)+' Tm\n('+jEsc('['+it.grams+'gms]')+')Tj\nET'); }
  }
  const drawPrice=(val,rightX)=>{ val=String(val||''); if(!val) return; const pw=val.length*C.adv_price*C.price_size, px=rightX-pw;
    p.push('BT\n'+NC+'\n'+F.price+' 1 Tf\n'+jFmt(NTC)+' Tc 0 Tw '+jFmt(C.price_size)+' 0 0 '+jFmt(C.price_size)+' '+jFmt(px)+' '+jFmt(Y)+' Tm\n('+jEsc(val)+')Tj\nET'); };
  drawPrice(it.price, sec.price_right);
  if(sec.price_right_2!=null) drawPrice(it.price2, sec.price_right_2);
  // allergen markers — packed via shared geometry
  { const bx=NX+nm.length*adv+(C.marker_gap||7); const mb=markerBody(it.allergens||[], bx, Y); if(mb) p.push(mb.trim()); }
  if(sec.divider_w>0){
    p.push('0 G\n0.464 w\nq 1 0 0 1 '+jFmt(NX)+' '+jFmt(Y+19.5)+' cm\n0 0 m\n'+jFmt(sec.divider_w)+' 0 l\nS\nQ');
  }
  const sz=PAGES[sec.page]||[595.276,841.89], W=sz[0], H=sz[1];
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
    const LH=Math.abs(AC.desc_leading*AC.desc_size);   // desc line height (~8.4pt Aiko)
    let cy=sec.last_y+shift;
    let prevName=sec.last_name_lines||1, prevDesc=sec.last_desc_lines||1;
    for(const it of bySec[si]){
      const dist = sec.slot + (prevDesc-2)*LH + (prevName-1)*AC.desc_size*1.93;   // gap depends on the PREVIOUS item's height
      cy -= dist;
      const _dl=addedDescWrap(it.desc,it.grams,sec).lines.filter(Boolean).length;
      const _bottom=cy-LH*_dl-2;   // this item's own lowest ink, not just its name baseline
      // backstop: never run an appended dish off the bottom of its column onto the page legend.
      // growPlan charges added items against the budget first, so this should be unreachable —
      // which is exactly why it must be loud rather than a silent truncation.
      // Report, but still place it: silently dropping a dish the user deliberately added is
      // worse than printing it tight, and ADD behaviour must not change just because growth exists.
      if(_floor!=null && _bottom<_floor+DESC_CLEAR){ try{console.warn('appendedForPage: no room for "'+(it.name||'')+'" below '+(sec.label||sec.col_x)+' — skipped');}catch(_){ } }
      out += buildItemJS(it,sec,cy);
      prevName = 1; prevDesc = addedDescWrap(it.desc,it.grams,sec).lines.filter(Boolean).length;
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
function dividerOps(divs, removedSlots, growSlots){
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
  const killed=new Set();
  const slots=[...removedSlots].sort((a,b)=>b.y-a.y);
  for(const rs of slots){
    const inCol=o=> o.d.x>=rs.cmin && o.d.x<rs.cmax;
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
      for(const it of grp.items){ if(removed.has(it.name.id)){ skip.add(it.name.id); if(it.desc)skip.add(it.desc.id); if(it.grams)skip.add(it.grams.id); for(const pr of it.prices)skip.add(pr.id);} }
    }
    const divs = _dividerLines(ps.pristine);
    const inDiv = (s,e)=> divs.some(d=> d.full[0]<=s && e<=d.full[1]);
    const shiftOps = st.shiftOps.filter(o=> !inDiv(o.s,o.e));   // divider cms handled by own-Y, not block-shift
    let ops = opsForPage(FM.fields.filter(f=>f.page===p), st.priceShift, skip, st.fieldShift).concat(shiftOps);
    // carve divider spans out of block-deletes so bundled dividers are never collaterally deleted
    let dels=[];
    for(const d of st.deletes){
      const inside = divs.filter(v=> d[0]<=v.full[0] && v.full[1]<=d[1]).sort((a,b)=>a.full[0]-b.full[0]);
      if(!inside.length){ dels.push(d); continue; }
      let cur=d[0];
      for(const v of inside){ if(v.full[0]>cur) dels.push([cur,v.full[0]]); cur=v.full[1]; }
      if(cur<d[1]) dels.push([cur,d[1]]);
    }
    for(const d of dels) ops.push({s:d[0],e:d[1],rep:enc(keepFont(d,p))});
    if(dels.length){
      ops = ops.filter(o=> !dels.some(d=> d[0]<=o.s && o.e<=d[1] && !(o.s===d[0]&&o.e===d[1])) );
    }
    for(const o of dividerOps(divs, st.removedSlots, st.growSlots)) ops.push(o);   // reposition/delete each divider by its own Y
    // ---- allergen markers: re-stamp any item whose DESIRED set differs from what's baked in
    // the PDF. Covers both menu-truth corrections (allergens≠baked) and live user toggles. ----
    let markerAddStr='';
    const allerDelSpans=[];
    for(const f of FM.fields){
      if(f.page!==p || f.role!=='name' || removed.has(f.id) || skip.has(f.id)) continue;
      const desired=(f.id in allerEdits)? allerEdits[f.id] : (f.allergens||[]);
      const baked=f.baked||[];
      const sameSet=[...desired].sort().join(',')===[...baked].sort().join(',');
      /* The cluster is anchored to the name's RIGHT EDGE, so renaming a dish has to carry it along.
         TOM YUM SOUP's icons are baked at x=113.45 — immediately after a 12-character name — so a
         26-character name printed straight through them. Measure the delta on the LAST rendered
         line, the one the markers follow, exactly as the grams tag does. */
      const _lastLine=s=>{ const L=wrapName(String(s||''),nameBudgetChars(f),f.lines.length).lines.filter(Boolean);
                           return L.length? L[L.length-1] : ''; };
      // Tc-aware: ADV.name alone over-measures every name by 4.1% (see nameAdv)
      const _ndx=(f.id in edits)? (nameWidth(f,_lastLine(edits[f.id]))-nameWidth(f,_lastLine(f.display))) : 0;
      if(sameSet && Math.abs(_ndx)<0.005) continue;                    // pristine already correct
      if(sameSet){
        /* MOVE ONLY — slide the designer's own icon artwork rather than re-drawing it. Each baked
           stamp is a `q 1 0 0 1 x y cm ... Q` group with an absolute origin, so translating the
           origins moves the cluster rigidly and the export stays byte-faithful to the artwork.
           (structuralForPage routed this field's vertical reflow into fieldShift for us, because
           these spans CONTAIN the cm operands it would otherwise have patched — see TM OWNERSHIP.) */
        const _mdy=st.fieldShift[f.id]||0;
        for(const sp of (f.marker_stamps||[]))
          ops.push({s:sp[0],e:sp[1],rep:enc(shiftArtOrigins(pageText(p).slice(sp[0],sp[1]), _ndx, _mdy))});
        continue;
      }
      for(const sp of (f.marker_stamps||[])) allerDelSpans.push(sp);   // remove this item's baked stamps
      const d=itemShift(f, st.removedSlots, st.growSlots);
      markerAddStr += markerGroup(desired, markerAnchor(f)+_ndx, f.y + d, p);
    }
    for(const sp of allerDelSpans) ops.push({s:sp[0],e:sp[1],rep:enc(keepFont(sp,p))});
    if(allerDelSpans.length){
      ops = ops.filter(o=> !allerDelSpans.some(sp=> sp[0]<=o.s && o.e<=sp[1] && !(o.s===sp[0]&&o.e===sp[1])) );
    }
    const pc=personaCover(p);
    for(const sp of pc.del){ ops.push({s:sp[0],e:sp[1],rep:enc(keepFont(sp,p))}); }
    let edited = ops.length ? spliceBytes(ps.pristine, ops) : ps.pristine;
    const addStr = appendedForPage(p, st.removedSlots, st.growSlots) + markerAddStr + pc.add;
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
   structuralForPage (a removal above moves it up; a description above that grew moves it down) and
   the description's rendered line count, size and real line pitch. It used to count the BAKED
   description lines at a fixed 9pt and follow removals only, so a description that grew stuck out
   below its box, and the boxes of the dishes under it were left behind. */
function pvBoxes(p){
  const st=structuralForPage(p, pageStreams[p].pristine), rows=st.rowShift||[], G=growPlan(p);
  const shiftOf=f=>rows.find(r=>f.x>=r.cmin && f.x<r.cmax && Math.abs(r.y-f.y)<0.01)||{name:0,below:0};
  const out=[];
  for(const it of itemsForPage(p).items){
    if(removed.has(it.name.id)) continue;
    const n=it.name, sz=n.size||13, nL=(n.lines||[]).length||1, sh=shiftOf(n);
    const top = n.y + sh.name + sz*1.05;             // headroom: the raised '4PCS' labels sit above the cap height
    let bot = n.y + sh.name - (nL-1)*15.5 - 5;
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
  // Uppercase NAMES only. This runs on a 160ms debounce after every keystroke and rewrites
  // innerHTML, so uppercasing here re-shouted descriptions in the DOM and the next input event
  // then captured the shouted text — which defeated the sentence-case fix in the capture path.
  const text=(kind==='name')? normTypo(el.textContent).toUpperCase() : normTypo(el.textContent),
        off=document.activeElement===el?getCaret(el):null;
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
  const grams=FM.fields.filter(f=>f.role==='grams'&&f.page===p);
  const prices=FM.fields.filter(f=>f.role==='price'&&f.page===p);
  const used=new Set();
  // assign each price to the nearest NAME to its left on the same row — column-aware, so it
  // works whether columns are ~260pt (Aiko p0 / Capiche) or ~520pt (Aiko p1) and never lets
  // a left-column name grab a right-column price that shares its row.
  const owner={};
  for(const x of prices){
    let best=null;
    for(const n of names){ const span=15.5*(n.lines.length-1);
      if(n.x<=x.x+1 && x.y<=n.y+6 && x.y>=n.y-span-7){ if(!best||n.x>best.x) best=n; } }
    if(best) owner[x.id]=best.id;
  }
  const items=names.map(n=>{
    const pr=prices.filter(x=>owner[x.id]===n.id).sort((a,b)=>a.x-b.x);
    pr.forEach(x=>used.add(x.id));
    // column-aware, mirroring the grams rule below. The old |dx|<8 window silently dropped a
    // description whose recorded x was wrong and let the dish reach down to the NEXT dish's text
    // instead — editing it then spliced into the wrong dish's bytes.
    const d=descs.filter(x=>x.x>=n.x-2 && x.x<n.x+260 && n.y>x.y && n.y-x.y<62).sort((a,b)=>b.y-a.y)[0]||null;
    const g=grams.filter(x=>x.x>=n.x-2 && x.x<n.x+260 && n.y>x.y && n.y-x.y<62).sort((a,b)=>b.y-a.y)[0]||null;
    return {name:n, prices:pr, desc:d, grams:g, y:n.y, x:n.x};
  }).sort((a,b)=> (Math.abs(a.x-b.x)>40? a.x-b.x : b.y-a.y));
  const extras=prices.filter(x=>!used.has(x.id));
  return {items,extras};
}
// text width from the header font's own /Widths (1000-unit em), stored on the field
function headerAdv(f, str){ let w=0; const W=f.widths||{};
  for(const ch of String(str||'')) w+=(W[ch]||0); return w/1000*f.size; }
/* Byte range of the stroked vector letterforms that sit ON TOP of a decorative label's text run.
   Derived at runtime rather than baked into the fieldmap so no rebuild is needed: walk from the end
   of the label's text run to the next BT (the following text block) and take the first `q .. cm`
   through the last `Q`. Measured per label: 3.0-15.6KB, 2-8 glyph groups. */
function labelVectorSpan(f){
  if(f._vec!==undefined) return f._vec;
  if(f.kind!=='script'||!f.run_span) return f._vec=null;
  const t=pageText(f.page), start=f.run_span[1];
  /* The overlay runs from the label's text to the NEXT text block. DESSERTS is the last text block
     on page 1, so `indexOf('BT')` returned -1 and this bailed — leaving that label with no vector
     span at all. The consequences were both silent: the delete-on-edit was skipped, so renaming
     "sweet" left its old stroked outline painted underneath; and the `_flourishGone` guard read
     false, so the flourish_cm rewrite fired and nudged ONE of the label's five outline groups.
     Neither is visible to a text-based assertion — the overlay is stroked paths, not text.
     With no following block, the span simply ends where the stream's content does. */
  const nextBT=t.indexOf('BT',start);
  const seg=t.slice(start, nextBT<0 ? t.length : nextBT);
  const first=seg.search(/q 1 0 0 1 -?[\d.]+ -?[\d.]+ cm/), lastQ=seg.lastIndexOf('\nQ\n');
  if(first<0||lastQ<0||lastQ<first) return f._vec=null;
  return f._vec=[start+first, start+lastQ+1];
}
/* Byte span of the `x y` operands of the Tm inside a header's run. Lets a header be MOVED without
   being retyped: the edit path rewrites the whole run as one Tm+Tj, which re-lays-out the word with
   a uniform advance and throws away the designer's per-glyph kerning — fine when the word changed,
   wrong when it only slid sideways, because the stroked overlay still follows the ORIGINAL kerning
   and the two would misregister. */
function headerTmSpan(f){
  if(f._htm!==undefined) return f._htm;
  if(!f.run_span) return f._htm=null;
  const seg=pageText(f.page).slice(f.run_span[0], f.run_span[1]);
  const m=/(-?[\d.]+) (-?[\d.]+) Tm/.exec(seg);
  if(!m) return f._htm=null;
  const s=f.run_span[0]+m.index;
  return f._htm={s:s, e:s+m[0].length-3};      // "x y", without the trailing " Tm"
}
/* Translate baked artwork rigidly by rewriting the absolute origin of everything inside a span.
   Used for two things the designer drew and we must NOT redraw: a decorative label's stroked
   letterforms (sibling `q 1 0 0 1 x y cm ... Q` groups, 8 of them for "Starters", never nested) and
   a dish's allergen icon stamps. Both forms appear, so both are handled — path groups via their cm
   origin, glyph markers (the Jain "J") via their text matrix. */
function shiftArtOrigins(txt, dx, dy){
  return txt
    .replace(/q 1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/g,
      (m,x,y)=>'q 1 0 0 1 '+fmtNum(parseFloat(x)+dx)+' '+fmtNum(parseFloat(y)+dy)+' cm')
    .replace(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g,
      (m,a,b,c,d,x,y)=>[a,b,c,d,fmtNum(parseFloat(x)+dx),fmtNum(parseFloat(y)+dy)].join(' ')+' Tm');
}
/* How many characters of `val` this header font cannot print. The category fonts are SUBSETS
   holding only the glyphs the artwork already uses — /TT1 (names) has no lowercase b/f/g/p/… and
   only D M N R S in caps; /TT2 (labels) has no space at all — so most realistic renames are simply
   not representable. Surfaced in the UI rather than silently dropped. */
function headerBadChars(f, val){
  const cs=f.charset||''; const out=[];
  for(const ch of new Set(String(val||''))) if(cs.indexOf(ch)<0) out.push(ch);
  return out;
}
function descText(d){ return (d.id in edits)? edits[d.id] : d.display; }

/* ---- SECTION MODEL ---------------------------------------------------------------------------
   Sections are DERIVED, not stored: a dish belongs to the section whose col_x is within 140pt and
   whose last_y is at or below it. Reorder has to be gated on this and NOT on pageColumns() — page 1
   is a single column holding RICE + NOODLES + DESSERTS, so a column-scoped move would silently let
   a dish cross into another section.
   Each dish's height is its own pitch to the next dish IN THE SAME SECTION (dishes differ: a 1-line
   description is ~33pt, a 2-line ~41, DIMSUM PLATTER's 3-line more), with the last dish taking the
   section's gap_below. Do NOT use structuralForPage's slotH() for this — it is unreliable for the
   last dish of a section (it reports 94.23 for 1:8, where the real slot is ~33). */
function sectionOf(it, secs){
  const ix=it.x, iy=it.y; let best=null, bs=Infinity;
  for(const s of secs){ const dx=Math.abs(s.col_x-ix); if(dx>140) continue; if(iy<(s.last_y-2)) continue;
    const sc=(iy-s.last_y)+dx*0.01; if(sc<bs){bs=sc;best=s;} }
  return best;
}
const _secModel={};
function sectionModel(p){
  if(_secModel[p]) return _secModel[p];
  const secs=sectionsForPage(p), {items}=itemsForPage(p), out={};
  for(const s of secs) out[s.label]={sec:s, ids:[], y:{}, h:{}};
  for(const it of items){ const s=sectionOf(it,secs); if(!s) continue; out[s.label].ids.push(it.name.id); out[s.label].y[it.name.id]=it.y; }
  for(const L in out){ const m=out[L]; m.ids.sort((a,b)=>m.y[b]-m.y[a]);      // top -> bottom
    m.ids.forEach((id,i)=>{ m.h[id]= i<m.ids.length-1? +(m.y[id]-m.y[m.ids[i+1]]).toFixed(2) : (m.sec.gap_below||m.sec.slot||33); });
  }
  return _secModel[p]=out;
}
// current order of a section (user override, else pristine top-to-bottom)
function secOrder(p, label){ const m=sectionModel(p)[label]; if(!m) return [];
  const k=p+'|'+label; return (k in order)? order[k].filter(id=>m.ids.indexOf(id)>=0) : m.ids.slice(); }
// y each dish should sit at under the CURRENT order: re-stack from the section top using the
// heights of whatever dish now occupies each position.
function secLayout(p, label){
  const m=sectionModel(p)[label]; if(!m) return {};
  const ord=secOrder(p,label), top=m.y[m.ids[0]], out={};
  let y=top;
  for(const id of ord){ out[id]=y; y-=m.h[id]; }
  return out;
}

// ----- ADD-ITEM UI -----
function sectionsForPage(p){ let r=[]; (SECTIONS||[]).forEach((s,i)=>{ if(s.page===p) r.push(Object.assign({_i:i},s)); }); return r; }
function addedCountInSec(i){ return added.filter(a=>a.sec===i).length; }
function secCapacity(s){ return Math.max(1, Math.floor(s.gap_below/s.slot)); }
function colWord(x){ return x<200?'left':x<450?'middle':'right'; }
function renderAddZone(ed){
  const secs=sectionsForPage(activePage);
  if(!secs.length) return;
  added.forEach((a,idx)=>{
    if(SECTIONS[a.sec].page!==activePage) return;
    const c=document.createElement('div'); c.className='addcard';
    const n=document.createElement('span'); n.className='ac-n'; n.textContent=a.name||'(unnamed)';
    const t=document.createElement('span'); t.className='ac-tag'; t.textContent='NEW IN '+SECTIONS[a.sec].label;
    const pr=document.createElement('span'); pr.className='ac-price'; pr.textContent=(a.price?('\u20b9'+a.price):'')+(a.price2?('  \u20b9'+a.price2):'');
    const x=document.createElement('button'); x.className='ac-x'; x.textContent='\u2715'; x.title='Remove this new item';
    x.onclick=()=>{ const k=added.indexOf(a); if(k>=0)added.splice(k,1); buildEditor(); schedulePreview(); };
    c.append(n,t,pr,x); ed.appendChild(c);
  });
  const zone=document.createElement('div'); zone.className='addzone';
  const btn=document.createElement('button'); btn.className='addbtn'; btn.textContent='+  Add a new item';
  const form=document.createElement('div'); form.className='addform';
  const opts=secs.map(s=>{ const cat=s.category||colWord(s.col_x).toUpperCase(); const sub=(s.label&&s.label!==cat)?(' \u00b7 '+s.label.charAt(0)+s.label.slice(1).toLowerCase()):(' \u00b7 '+colWord(s.col_x)+' column'); return '<option value="'+s._i+'">'+cat+sub+' \u00b7 room for '+(secCapacity(s)-addedCountInSec(s._i))+' more</option>'; }).join('');
  form.innerHTML='<label>Section</label><select class="af-sec">'+opts+'</select>'
    +'<label>Name</label><input type="text" class="af-name" maxlength="34" placeholder="MISO GLAZED EGGPLANT">'
    +'<div class="afmeta af-nmeta"></div>'
    +'<label>Description</label><textarea class="af-desc" maxlength="120" placeholder="MEDJOOL DATES, ACACIA HONEY, MASCARPONE CREAM"></textarea>'
    +'<div class="afmeta af-dmeta"></div>'
    +'<div class="af2"><div><label>Grams</label><input type="text" class="af-grams" maxlength="4" placeholder="130"></div>'
    +'<div><label class="af-plabel">Price \u20b9</label><input type="text" class="af-price" maxlength="4" placeholder="560"></div>'
    +'<div class="af-p2wrap" style="display:none"><label>Large \u20b9</label><input type="text" class="af-price2" maxlength="4" placeholder="760"></div></div>'
    +'<label>Markers</label><div class="afchk">'
    +'<label><input type="checkbox" class="af-a" value="dairy"> Dairy</label>'
    +'<label><input type="checkbox" class="af-a" value="gluten"> Gluten</label>'
    +'<label><input type="checkbox" class="af-a" value="sesame"> Sesame</label>'
    +'<label><input type="checkbox" class="af-a" value="jain"> Jain</label>'
    +'<label><input type="checkbox" class="af-a" value="korea"> Korea</label>'
    +'<label><input type="checkbox" class="af-a" value="new"> NEW badge</label></div>'
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
    const gr=gramsEl.value.trim();
    const si=+secEl.value, sec=SECTIONS[si], full=addedCountInSec(si)>=secCapacity(sec);
    const dwid=descWidthFor(sec), nwid=Math.floor(((sec.price_right||sec.col_x+233)-sec.col_x-6)/(AC.adv_name*(sec.name_size||11)));
    const nb=bad(nm,ALLOWED.name), db=bad(de,ALLOWED.desc), gb=bad(gr,ALLOWED.price);
    const nov=nm.length>nwid;
    const typos=s=>{const bad=[],warn=[];for(const w of (deacc(s).match(/[A-Za-z']+/g)||[])){ if(w.length>2 && !wordAllowed(w)){ const sg=suggest(w); if(sg.length) bad.push(w+' \u2192 '+sg[0].toUpperCase()+'?'); else warn.push(w.toUpperCase()); } } return {bad,warn};};
    const spN=typos(nm), spD=typos(de);   // bad = likely misspelling (blocks); warn = unrecognised word (soft)
    nmeta.textContent = nb.length?('can\u2019t print:  '+nb.map(c=>c===' '?'space':c).join('  ')):(nov?('too long \u2014 max '+nwid):(spN.bad.length?('spelling: '+spN.bad.join('  ')):(spN.warn.length?('check: '+spN.warn.join(' ')):(nm.length+'/'+nwid)))); nmeta.className='afmeta'+((nb.length||nov||spN.bad.length)?' bad':'');
    const ov=addedDescWrap(de,gr,sec).overflow;   // chucky-2: counts the weight tag, as the PDF will
    dmeta.textContent = db.length?('can\u2019t print:  '+db.map(c=>c===' '?'space':c).join('  ')):(ov?'too long \u2014 trim to fit 2 lines':(spD.bad.length?('spelling: '+spD.bad.join('  ')):(spD.warn.length?('check: '+spD.warn.join(' ')):(de.length+' chars')))); dmeta.className='afmeta'+((db.length||ov||spD.bad.length)?' bad':'');
    const two=sec.price_right_2!=null; p2wrap.style.display=two?'':'none'; plabel.textContent=two?'Regular \u20b9':'Price \u20b9';
    const p2b=two?bad(price2El.value.trim(),ALLOWED.price):[];
    if(full){ nmeta.textContent='this section is full \u2014 remove one or pick another'; nmeta.className='afmeta bad'; }
    /* Spelling is ADVISORY, not a blocker. The suggestion line above still shows it, but a menu is
       full of words no dictionary has — NDUJA, GHASLET, BURRATA, TTEOKBOKKI — so refusing to save on
       a dictionary miss stops legitimate dishes from being added. What still blocks is only what
       genuinely cannot be printed or placed: an empty field, a character with no glyph in the font,
       text too long for its space, or a section with no room left. */
    addBtn.disabled = !nm||!de||nb.length||db.length||gb.length||p2b.length||ov||nov||full;
  }
  nameEl.oninput=descEl.oninput=gramsEl.oninput=priceEl.oninput=price2El.oninput=secEl.onchange=validate; validate();
  form.querySelector('.afcancel').onclick=()=>{ form.classList.remove('open'); };
  addBtn.onclick=()=>{
    if(addBtn.disabled) return;
    const gr=gramsEl.value.trim(); let de=normTypo(descEl.value).toUpperCase().trim();
    de=de.replace(/\s*\[\d+\s*GMS\]\s*$/i,'');   // Aiko: grams render as their own size-5 tag, not inside the desc
    const al=[]; form.querySelectorAll('.af-a:checked').forEach(c=>al.push(c.value));
    added.push({sec:+secEl.value, name:normTypo(nameEl.value).toUpperCase().trim(), desc:de, grams:gr, price:priceEl.value.trim(), price2:price2El.value.trim(), allergens:al, _id:++addSeq});
    buildEditor(); schedulePreview();
  };
}

/* ---- MENU SECTIONS panel --------------------------------------------------------------------
   Each category heading in the artwork is a PAIR of text runs: a serif category name ("Sides") and
   a gold handwritten label beside it ("Starters"). Both are real text with their own byte spans, so
   both are edited the same byte-level way as a dish name — no overlay, no re-typesetting.
   The hard limit is the font: these are SUBSET fonts carrying only the glyphs the artwork already
   uses, so most renames are impossible and the UI has to say so plainly rather than silently drop
   characters. Everything writes into the same `edits` object dish edits use, so Save / Preview /
   Export / working-copy memory all pick it up with no extra plumbing. */
function buildSectionPanel(ed){
  const heads=FM.fields.filter(f=>f.role==='header'&&f.kind==='serif'&&f.page===activePage);
  if(!heads.length) return;
  const wrap=document.createElement('div'); wrap.className='secpanel';
  const hd=document.createElement('div'); hd.className='grouphd sechd';
  hd.innerHTML='<span>MENU SECTIONS</span><span class="n">'+heads.length+' on this page</span>';
  wrap.appendChild(hd);

  for(const sf of heads){
    const lf=FM.fields.find(q=>q.id===sf.pair);
    const card=document.createElement('div'); card.className='card seccard';
    const ttl=document.createElement('div'); ttl.className='sectitle';
    ttl.textContent=sf.label||sf.display; card.appendChild(ttl);

    const row=(labelText, f, placeholder)=>{
      if(!f) return;
      const w=document.createElement('div'); w.className='secrow';
      const lb=document.createElement('label'); lb.className='seclbl'; lb.textContent=labelText;
      const inp=document.createElement('input'); inp.className='secinp'; inp.spellcheck=false;
      inp.value=(f.id in edits)?edits[f.id]:f.display; inp.placeholder=placeholder;
      if(f.kind==='script') inp.classList.add('script');
      const meta=document.createElement('div'); meta.className='afmeta';
      const check=()=>{
        const v=inp.value;
        const bad=headerBadChars(f,v);
        // the label font has no space glyph at all, so flag it by name rather than as a blank
        const shown=bad.map(c=>c===' '?'space':c);
        if(bad.length){ meta.textContent='can’t print:  '+shown.join('  '); meta.className='afmeta bad'; }
        else if(!v.trim()){ meta.textContent='empty — this heading will disappear'; meta.className='afmeta bad'; }
        else { meta.textContent='✓ fits · '+headerAdv(f,v).toFixed(1)+'pt wide'; meta.className='afmeta'; }
        return !bad.length && !!v.trim();
      };
      inp.oninput=()=>{
        const okNow=check();
        if(inp.value===f.display) delete edits[f.id]; else edits[f.id]=inp.value;
        /* Mark the field itself, so the export gate can see it. `updateGate` counts unprintable
           glyphs from `.gl` spans inside `.name`/`.desc` only — a section input is `.secinp` and
           renders no such span, so a category name containing a letter the 20-glyph serif subset
           lacks (there is no `P`, so "Plates" is impossible) used to be written straight into
           `edits`, emitted verbatim by `escPdf`, and shipped behind a green "All clear". */
        inp.classList.toggle('badglyph', !okNow);
        try{ MEM.tick(); }catch(_){}
        if(okNow) schedulePreview();
        updateGate();
      };
      check();
      w.appendChild(lb); w.appendChild(inp); w.appendChild(meta); card.appendChild(w);
    };
    row('Category name', sf, 'Sides');
    row('Decorative label', lf, 'Starters');
    wrap.appendChild(card);
  }
  ed.appendChild(wrap);
}
function buildEditor(){
  const ed=document.getElementById('editor'); ed.innerHTML="";
  const {items,extras}=itemsForPage(activePage);
  const rmCount=items.filter(it=>removed.has(it.name.id)).length;
  const _secs=(typeof sectionsForPage==='function')?sectionsForPage(activePage):[];
  const _secOf={}; (function(){ const so=(it)=>{ const ix=it.name.x, iy=it.name.y; let best='',bs=Infinity; for(const s of _secs){ const dx=Math.abs(s.col_x-ix); if(dx>140) continue; if(iy<(s.last_y-2)) continue; const sc=(iy-s.last_y)+dx*0.01; if(sc<bs){bs=sc;best=s.label;} } return best; }; for(const it of items) _secOf[it.name.id]=so(it); })();
  // Re-sequence cards within each section to match the user's current order (secOrder). Without
  // this, itemsForPage() always hands back pristine top-to-bottom order, so the move up/down
  // buttons below correctly rewrote `order` and the exported PDF but the on-screen list snapped
  // right back -- a click looked like it did nothing.
  (function(){
    const byId={}; for(const it of items) byId[it.name.id]=it;
    const seen=new Set(), secSeq=[];
    for(const it of items){ const L=_secOf[it.name.id]||''; if(!seen.has(L)){ seen.add(L); secSeq.push(L); } }
    const reseq=[];
    for(const L of secSeq){
      if(!L){ for(const it of items) if((_secOf[it.name.id]||'')===L) reseq.push(it); continue; }
      for(const id of secOrder(activePage,L)) if(byId[id]) reseq.push(byId[id]);
    }
    if(reseq.length===items.length){ items.length=0; items.push(...reseq); }   // safety net: counts must match exactly
  })();
  window.__secCounts={};
  for(const it of items){ const L=_secOf[it.name.id]||'—'; if(!(L in window.__secCounts)) window.__secCounts[L]={live:0}; if(!removed.has(it.name.id)) window.__secCounts[L].live++; }
  buildSectionPanel(ed);
  let _lastSec=null, _secIdx=-1;
  for(const it of items){
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
    // Move up/down WITHIN the section. Buttons rather than drag-and-drop: a dish can never land in
    // another section by accident, and the ends are simply disabled. (The drinks editors' drag
    // handler is the cautionary tale — it rewrites text into a foreign slot.)
    { const _ord=secOrder(activePage,_L), _pos=_ord.indexOf(it.name.id);
      if(_pos>=0&&_ord.length>1){
        const mv=document.createElement('div'); mv.className='movebtns';
        const mk=(lbl,to,dis)=>{ const b=document.createElement('button'); b.type='button'; b.className='mvb';
          b.textContent=lbl; b.title=lbl==='\u2191'?'Move up':'Move down'; b.disabled=dis;
          b.addEventListener('click',()=>{ const o=secOrder(activePage,_L);
            const i=o.indexOf(it.name.id); if(i<0||to<0||to>=o.length) return;
            o.splice(to,0,o.splice(i,1)[0]); order[activePage+'|'+_L]=o;
            try{MEM.tick();}catch(_){} buildEditor(); regenerate().then(renderPreview); });
          return b; };
        mv.appendChild(mk('\u2191',_pos-1,_pos===0));
        mv.appendChild(mk('\u2193',_pos+1,_pos===_ord.length-1));
        nrow.appendChild(mv);
      } }
    const name=document.createElement('div'); name.className='name'; name.dataset.id=it.name.id; name.dataset.kind='name'; name.dataset.orig=it.name.display; name.contentEditable='true';
    name.textContent = (it.name.id in edits)? edits[it.name.id] : it.name.display;
    nrow.appendChild(name);
    const pr=document.createElement('div'); pr.className='prices';
    for(const p of it.prices){ const w=document.createElement('div'); w.className='pwrap'; const inp=document.createElement('input'); inp.className='price'; inp.dataset.id=p.id; inp.dataset.orig=p.text; inp.value=(p.id in edits)?edits[p.id]:p.text; inp.inputMode='numeric'; w.appendChild(inp); pr.appendChild(w); }
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
    if(it.grams){
      const grow=document.createElement('div'); grow.className='metarow';
      const glbl=document.createElement('span'); glbl.className='lbl'; glbl.textContent='Grams';
      const gwrap=document.createElement('span'); gwrap.style.cssText='display:flex;align-items:center;background:var(--well);border:1px solid var(--line2);border-radius:7px;padding:1px 8px';   // chucky-2: was a white #fff strip on the dark card
      const gcur=(it.grams.id in edits)?edits[it.grams.id]:(it.grams.display||'');
      const gnum=(gcur.match(/\d+/)||[''])[0];
      const ginp=document.createElement('input'); ginp.className='price'; ginp.style.width='52px'; ginp.style.textAlign='left';
      ginp.dataset.gid=it.grams.id; ginp.value=gnum; ginp.inputMode='numeric'; ginp.maxLength=4;
      ginp.oninput=()=>{ const v=ginp.value.replace(/[^0-9]/g,''); const full='['+v+'gms]';
        if(full===it.grams.display) delete edits[it.grams.id]; else edits[it.grams.id]=full; schedulePreview(); };
      const gsuf=document.createElement('span'); gsuf.className='lbl'; gsuf.textContent='gms'; gsuf.style.marginLeft='2px';
      gwrap.appendChild(ginp); gwrap.appendChild(gsuf); grow.appendChild(glbl); grow.appendChild(gwrap); card.appendChild(grow);
    }
    { // allergen marker toggles
      const mrow=document.createElement('div'); mrow.className='metarow'; mrow.style.alignItems='center';
      const mlbl=document.createElement('span'); mlbl.className='lbl'; mlbl.textContent='Markers';
      const mwrap=document.createElement('span'); mwrap.className='afchk'; mwrap.style.cssText='gap:13px;margin-top:0';
      const orig=it.name.allergens||[];
      for(const m of (BRAND.markers||['dairy','gluten','sesame','jain'])){
        const lab=document.createElement('label');
        const cb=document.createElement('input'); cb.type='checkbox'; cb.value=m;
        const curAl=new Set((it.name.id in allerEdits)?allerEdits[it.name.id]:orig);
        cb.checked=curAl.has(m);
        cb.onchange=()=>{
          const s=new Set((it.name.id in allerEdits)?allerEdits[it.name.id]:orig);
          if(cb.checked) s.add(m); else s.delete(m);
          const arr=[...s];
          if([...arr].sort().join(',')===[...orig].sort().join(',')) delete allerEdits[it.name.id];
          else allerEdits[it.name.id]=arr;
          updateGate();   // chucky-2: a marker changes the name's room, so re-check the warnings now
          schedulePreview();
        };
        lab.appendChild(cb); lab.insertAdjacentHTML('beforeend', (window.ALLERGEN_ICONS&&window.ALLERGEN_ICONS[m])||''); lab.appendChild(document.createTextNode(' '+(m==='new'?'NEW':m[0].toUpperCase()+m.slice(1))));
        mwrap.appendChild(lab);
      }
      mrow.appendChild(mlbl); mrow.appendChild(mwrap); card.appendChild(mrow);
    }
    const hint=document.createElement('div'); hint.className='hint'; card.appendChild(hint);
    ed.appendChild(card);
    highlightField(name); if(it.desc){ highlightField(card.querySelector('.desc')); updateCtr(card.querySelector('.desc')); }
  }
  if(extras.length){ const eh=document.createElement('div'); eh.className='grouphd'; eh.textContent='Other prices'; ed.appendChild(eh);
    const card=document.createElement('div'); card.className='card'; const pr=document.createElement('div'); pr.className='prices';
    for(const p of extras){ const w=document.createElement('div'); w.className='pwrap'; const inp=document.createElement('input'); inp.className='price'; inp.dataset.id=p.id; inp.dataset.orig=p.text; inp.value=(p.id in edits)?edits[p.id]:p.text; inp.inputMode='numeric'; w.appendChild(inp); pr.appendChild(w); }
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
  // read the column's own plan, so the count shown is the count that will be printed
  const G=growPlan(f.page), ex=G.extra[f.id]||0;
  const fit=((f.id in edits)&&G.fit[f.id])||fitDesc(f, val, ex); const w={lines:fit.lines, overflow:fit.overflow};
  const _used=fit.lines.filter(Boolean).length, _cap=maxLinesAt(f, fit.size, ex), _fitted=fit.size<f.size-0.005;
  const _pushed=ex>0;
  ctr.textContent = w.overflow ? 'no room left in this column — shorten this, or a description above it'
                  : (_used+'/'+_cap+' lines'+(_fitted?' · auto-fitted':'')+(_pushed?' · pushes the dishes below down':''));
  ctr.classList.toggle('over', w.overflow);
}

// ---------- events ----------
let etimer=null, ptimer=null;
function schedulePreview(){ clearTimeout(ptimer); ptimer=setTimeout(async()=>{ await regenerate(); renderPreview(); }, 380); }
document.getElementById('editor').addEventListener('input', e=>{
  const el=e.target;
  if(el.classList.contains('name')||el.classList.contains('desc')){
    // Names are set in caps by the artwork; DESCRIPTIONS are sentence case. Force-uppercasing a
    // description SHOUTED it in the export and, because dataset.orig holds the sentence-case
    // original, the revert check below could never match — so a description edit could never be
    // un-recorded once touched.
    const t=el.classList.contains('name')? normTypo(el.textContent).toUpperCase().trim()
                                         : normTypo(el.textContent).trim();
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
    const parts=fieldEl.textContent.match(/(\s+|[^\s]+)/g)||[]; let done=false;
    fieldEl.textContent=parts.map(t=>{ if(!done&&/[^\s]/.test(t)&&deacc(t).replace(/[^A-Za-z']/g,'')===sp.dataset.w){done=true;return b.dataset.fix;} return t; }).join('');
    const t=normTypo(fieldEl.textContent).trim(); if(t===fieldEl.dataset.orig && !REWRAP.has(fieldEl.dataset.id)) delete edits[fieldEl.dataset.id]; else edits[fieldEl.dataset.id]=t;   // chucky-2: see REWRAP
    if(fieldEl.classList.contains('desc')) updateCtr(fieldEl);
    schedulePreview();
  } else if(b.dataset.ignore!=null){ IGNORED.add(b.dataset.ignore); try{ localStorage.setItem(BRAND.dictKey, JSON.stringify([...IGNORED])); }catch(_){} }
  pop.style.display='none';
  document.querySelectorAll(".name,.desc").forEach(highlightField); updateGate();
});
document.addEventListener('click', e=>{ if(!e.target.closest('#popover')&&!e.target.closest('.sp')) pop.style.display='none'; });
document.querySelectorAll('.tabs button').forEach(b=> b.addEventListener('click', ()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
  activePage=+b.dataset.pg; document.getElementById('ptag').textContent='— '+(activePage===0?'Page 1':'Page 2');
  buildEditor(); renderPreview();
}));
/* chucky-2: a name that doesn't fit is printed cut down to what does, so the preview can look as if
   the edit never happened. The warning says what is actually printed, and why. Markers share the
   name's line, so each one turned on leaves the name less room. */
function nameTooLong(f){
  const per=nameBudgetChars(f), mk=((f.id in allerEdits)?allerEdits[f.id]:(f.allergens||[])).length;
  const shown=wrapName(edits[f.id], per, f.lines.length).lines.filter(Boolean).join(' ');
  const printed = shown ? 'only \u201c'+shown+'\u201d fits, so that\u2019s all the menu shows. ' : 'none of it fits, so the menu shows no name. ';
  return 'Too long to print: '+printed+(mk ? 'With '+mk+' marker'+(mk>1?'s':'')+' on, this' : 'This')+' name has room for '+per+' characters'+(f.lines.length>1?' a line':'')
    +' \u2014 shorten it'+(mk?' or turn a marker off':'')+'. Export is paused until it fits.';
}
function updateGate(){
  let sp=0,spBase=0,gl=0,pe=0,ov=0;
  // spelling flags on untouched baseline text stay soft — the PDF already
  // prints it; only flags on text the user edited (or added) block export
  document.querySelectorAll('.name,.desc').forEach(el=>{ const n=el.querySelectorAll('.sp').length; if(!n) return; if(el.dataset.id in edits) sp+=n; else spBase+=n; });
  document.querySelectorAll('.name .gl,.desc .gl').forEach(()=>gl++);
  // category names and decorative labels count too — they print the same PDF
  document.querySelectorAll('.secinp.badglyph').forEach(()=>gl++);
  document.querySelectorAll('.price.err').forEach(()=>pe++);
  document.querySelectorAll('.card').forEach(c=>{
    const g=c.querySelector('.gl'),s=c.querySelector('.sp'),h=c.querySelector('.hint'); if(!h) return;
    let over=false, longName=null;
    // a description is only "too long" once the COLUMN has run out of room to push for it, which is
    // growPlan's verdict — asking isOverflow() directly would still measure the pristine gap
    c.querySelectorAll('.name,.desc').forEach(el=>{ const f=FIELD[el.dataset.id]; if(!f||!(el.dataset.id in edits)) return;
      if(f.role==='desc' ? !!growPlan(f.page).over[f.id] : isOverflow(f,edits[el.dataset.id])){ over=true; if(f.role==='name') longName=f; } });
    if(over) ov++;
    if(over){c.classList.add('haswarn');h.textContent=longName?nameTooLong(longName):'Text is too long for the space — shorten it so it fits the line limit.';}
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
const PV_FILE=(typeof BRAND!=='undefined'&&BRAND&&BRAND.download)?BRAND.download:'Aiko_Menu.pdf';
const PV_TITLE="Aiko — Food";
function pvDB(){ return new Promise((res,rej)=>{ const r=indexedDB.open(PV_DB,1);
  r.onupgradeneeded=()=>{ if(!r.result.objectStoreNames.contains(PV_STORE)) r.result.createObjectStore(PV_STORE); };
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
function pvPut(id,rec){ return pvDB().then(d=>new Promise((res,rej)=>{
  const tx=d.transaction(PV_STORE,'readwrite'); tx.objectStore(PV_STORE).put(rec,id);
  tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); })); }
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
    if(!win) alert('Your browser blocked the preview tab.\nAllow pop-ups for this site, then press \u201cFull Preview\u201d again.');
  }catch(e){
    try{ await pvPut(id,{error:String((e&&e.message)||e), t:Date.now()}); }catch(_){}
    if(!win) alert('Could not build the preview: '+((e&&e.message)||e));
  }finally{ if(btn){ btn.disabled=false; btn.textContent=label||'Full Preview \u2197'; } }
}
(function(){ const b=document.getElementById('fullprev'); if(b) b.addEventListener('click', openFullPreview); })();   // guarded: a missing button must never kill the engine
document.getElementById('export').addEventListener('click', async ()=>{
  const bytes=await regenerate();
  const blob=new Blob([bytes],{type:'application/pdf'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=BRAND.download; a.click(); URL.revokeObjectURL(url);
  try{MEM.snapshot('export');}catch(_){}
  showChucky(BRAND.download);
});
// ---- Publish: chucky-2 — the shared MenuState (assets/js/menustate.js) owns the Publish button:
// the version check, the conflict handling and the live status. Wired up at the end of boot().
// ---------- PERSONALISE COVER: occasion + guest name (replaces the intro), then Export/Share ----------
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
    if(b.dataset.a==='clear'){ sel.value=''; occ.value=''; occ.style.display='none'; guest.value=''; apply(); } else ov.remove();
  });
}
document.getElementById('persona').addEventListener('click', openPersona);

// ---------- Chucky: mascot + export celebration ----------
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

// Cheeky export lines. The pool rotates: the day's starting line changes at LOCAL MIDNIGHT
// (so it's fresh every day, never stagnant), and advances on each export within the session.
const CHUCKY_LINES=[
 "KILLED IT 😎","NAILED IT.","CHEF’S KISS 🤌","MENU SLAPS.","COOKED. LITERALLY.","SERVED 🍽️",
 "TOO COOL FOR THE KITCHEN.","CRISPY.","MIC DROP 🎤","FLAWLESS VICTORY.","BOOM. PLATED.","CERTIFIED BANGER.",
 "SHARPER THAN MY SHADES.","PURR-FECTION 🐾","ATE. NO CRUMBS.","HOT OUT THE OVEN.","CLEAN LIKE MY WHISKERS.",
 "BIG CHEF ENERGY.","WHISKED IT, RISKED IT, KILLED IT.","ANOTHER ONE. 🐾","DEVOURED.","SMOOTH OPERATOR.",
 "ICE COLD 🧊","THAT’S A WRAP.","SEASONED TO PERFECTION.","SLAYED THE PLATE.","FRESH OUTTA THE LAB.",
 "CRUSHED IT.","GORDON WHO?","WORLD-CLASS, BABY.","SIZZLIN’.","DROPPED A BANGER.","NO NOTES.",
 "ABSOLUTELY COOKED.","TOP TIER.","MASTERPIECE.","EXPORTED & FLEXED.","LOCKED IN 🔒","UNDEFEATED.",
 "SAUCY.","GO OFF, CHEF.","LEGENDARY.","SHADES ON, MENU DONE.","EASY. 😼"
];
let _chuckyN=0;
function chuckyLine(){
  const n=new Date();
  const day=Math.floor(new Date(n.getFullYear(),n.getMonth(),n.getDate()).getTime()/86400000);  // local-midnight day index
  const i=((day*7 + _chuckyN++)%CHUCKY_LINES.length + CHUCKY_LINES.length)%CHUCKY_LINES.length;
  return CHUCKY_LINES[i];
}
function showChucky(fn){
  const el=document.getElementById('celebrate'); if(!el) return;
  el.querySelector('.cbline').textContent=chuckyLine();
  el.querySelector('.cbsub').textContent=(fn||'menu')+' — exported';
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  clearTimeout(showChucky._t); showChucky._t=setTimeout(()=>el.classList.remove('on'),2700);
}
// Chucky's sassy greeting — new on every load AND shifts at local midnight
const CHUCKY_GREET=[
 "How can I help you today, you non-skilled human?","Oh. It's you again. Let's fix this menu.",
 "I brought the shades. You bring the typos.","Point. Click. Let me carry you.",
 "90% attitude, 10% PDF surgeon. Let's go.","Try not to break anything. I'm watching. 😎",
 "Cleaner. Shorter. Better. Sound familiar?","Cool cats edit fast. Keep up.",
 "I do the hard part. You take the credit.","Ready when you are, slowpoke.",
 "I've seen worse menus. Barely.","Sit. Stay. Watch a professional work.",
 "Another menu you couldn't handle alone? Adorable.","Relax, human. The cat's got it."
];
function chuckyGreet(){
  const n=new Date(); const day=Math.floor(new Date(n.getFullYear(),n.getMonth(),n.getDate()).getTime()/86400000);
  let c=+(sessionStorage.getItem('chucky_g')||0); sessionStorage.setItem('chucky_g',c+1);
  return CHUCKY_GREET[((day*5+c)%CHUCKY_GREET.length+CHUCKY_GREET.length)%CHUCKY_GREET.length];
}
function sayChucky(msg, ms){
  const s=document.getElementById('chuckysay'); if(!s) return;
  s.textContent=msg||chuckyGreet();
  s.classList.remove('on'); void s.offsetWidth; s.classList.add('on');
  clearTimeout(sayChucky._t); if(ms!==0) sayChucky._t=setTimeout(()=>s.classList.remove('on'), ms||6000);
}
(function(){
  const o=document.createElement('div'); o.id='celebrate';
  o.innerHTML='<div class="cbcard"><div class="cbcat">'+CHUCKY_SVG+'</div><div class="cbline"></div><div class="cbsub"></div></div>';
  o.addEventListener('click',()=>o.classList.remove('on'));
  document.body.appendChild(o);
  /* chucky-2: the home link, the #chuckysay bubble and the greeting come from the shell
     (assets/js/editor.js); only the export celebration is made here. */
})();

// ---------- boot ----------
// ---- edit-memory glue (aiko) ----
const MEM_BRAND='aiko';
let memBaseVer='';
/* `allerEdits` belongs in the snapshot. Without it a marker toggle was invisible to `dirty()`, so
   the autosave never fired, the "Saved" indicator never lit, an explicit version-history entry was
   a no-op, and the toggle was silently dropped on resume — while an ADDED item's markers survived,
   because those live inside `added`. That asymmetry read as a bug rather than a limitation. */
function memSnapshot(){ return { qr:QRK.snap(), edits:{...edits}, removed:[...removed], added, order:JSON.parse(JSON.stringify(order)), persona:{...persona}, allerEdits:JSON.parse(JSON.stringify(allerEdits)) }; }
function memApply(st){ QRK.load(st&&st.qr); for(const k in edits) delete edits[k]; Object.assign(edits, st.edits||{}); rewrapBaked(); /* chucky-2 */ removed=new Set(st.removed||[]); added=st.added||[]; order=st.order?JSON.parse(JSON.stringify(st.order)):{}; persona=Object.assign({occasion:'',guest:''}, st.persona||{});
  for(const k in allerEdits) delete allerEdits[k]; Object.assign(allerEdits, st.allerEdits||{}); }
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
    timer=setTimeout(()=>{ try{ localStorage.setItem(AUTO, J({t:Date.now(), base:memBaseVer, pub:(window.MenuState?MenuState.version():null), s:memSnapshot()})); setStatus('Saved on this device','ok');   /* chucky-2: pub = the published version these edits started from */ }catch(_){ setStatus('',''); } }, 500);
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
    if(stale) bar.innerHTML='<span>You have unsaved edits from '+ago(a.t)+' made for a <b>previous version</b> of this menu file. They can\u2019t be applied to this one.</span><button class="pri" id="memfresh">OK</button>';
    else if(older) bar.innerHTML='<span>You have unsaved edits from '+ago(a.t)+', made <b>before the menu was last published</b>. Resuming them would bring back older details.</span>'
      +'<button class="pri" id="memfresh">Keep the published menu</button><button id="memres">Resume mine anyway</button>';
    else bar.innerHTML='<span>You left <b>unsaved edits</b> here '+ago(a.t)+'.</span><button class="pri" id="memres">Resume them</button><button id="memfresh">Start fresh</button>';
    bar.classList.add('on');
    const res=bar.querySelector('#memres'); if(res) res.addEventListener('click',()=>{ restore(a.s); bar.classList.remove('on'); });
    bar.querySelector('#memfresh').addEventListener('click',()=>dismiss(!stale));
  }
  // chucky-2: after a publish, or after loading the latest published menu, what's on screen IS the
  // published menu — nothing left to resume
  function rebase(){ try{ initial=J(memSnapshot()); localStorage.removeItem(AUTO); }catch(_){ } setStatus('',''); }
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
    FM.fields.forEach(f=>FIELD[f.id]=f);
    // decode PDF escapes (e.g. \\222) then normalize smart-punctuation baked into the SOURCE menu so the editor shows clean, printable text
    const _pdfEsc=s=>(s||'').replace(/\\([0-7]{1,3})/g,(m,o)=>String.fromCharCode(parseInt(o,8)&0xff)).replace(/\\([()\\])/g,'$1');
    FM.fields.forEach(f=>{ if(f.display) f.display=normTypo(_pdfEsc(f.display)); if(f.text) f.text=normTypo(_pdfEsc(f.text)); });
    for(const f of FM.fields){ if(f.role==='name'||f.role==='desc'){ for(const w of deacc((f.display||'').toLowerCase()).split(/[^a-z']+/)) if(w) MENU.add(w); } }
    try{ const saved=JSON.parse(localStorage.getItem(BRAND.dictKey)||'[]'); saved.forEach(w=>IGNORED.add(w)); }catch(_){}
    document.getElementById('bootmsg').textContent='Loading your menu file…';
    pdfBytesOrig = new Uint8Array(await (await fetch(BRAND.pdf+'?v='+Date.now())).arrayBuffer()); memBaseVer='v'+pdfBytesOrig.length;
    doc = await PDFDocument.load(pdfBytesOrig);
    for(let p=0;p<doc.getPageCount();p++){
      const page=doc.getPage(p); const ref=page.node.get(PDFName.of('Contents'));
      const stream=doc.context.lookup(ref);
      pageStreams.push({ref, dict:stream.dict, pristine:stream.contents.slice()});
    }
    /* chucky-2: MenuState.boot retries the load, applies a published state only if it was made for
       THIS base PDF (its edits address byte spans in one file), falls back to the menu's starting
       state (start-state.json — the current menu, as edits over aiko.pdf), and — unlike the old
       silent 4s fallback — puts up a bar and locks Publish when the published menu can't be loaded. */
    const _st=await MenuState.boot({ editor:MEM_BRAND, base:memBaseVer, start:'start-state.json' });
    if(_st) memApply(_st);
    readRunTracking();           // per-field Tc/Tw, needed by every name width calculation
    capDescsAtPrices();          // chucky-2: descriptions fill the line up to the price column (needs Tc)
    adoptBakedBadges();          // before buildEditor(): it changes what the marker chips show
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
// ===================== redesign shell (engine untouched) =====================
window.ALLERGEN_ICONS={
 dairy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 3h6M9.5 3v2.2L8 8.2V20a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8.2l-1.5-3V3"/><path d="M8 11h8"/></svg>',
 gluten:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21V8M12 8c0-2 1.5-4 4-4 0 2.2-1.8 4-4 4Zm0 0c0-2-1.5-4-4-4 0 2.2 1.8 4 4 4Zm0 4c0-1.6 1.4-3 3.2-3 0 1.8-1.5 3-3.2 3Zm0 0c0-1.6-1.4-3-3.2-3 0 1.8 1.5 3 3.2 3Zm0 4c0-1.6 1.4-3 3.2-3 0 1.8-1.5 3-3.2 3Zm0 0c0-1.6-1.4-3-3.2-3 0 1.8 1.5 3 3.2 3Z"/></svg>',
 sesame:'<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><ellipse cx="8" cy="9" rx="1.5" ry="2.4" transform="rotate(-20 8 9)"/><ellipse cx="14" cy="8" rx="1.5" ry="2.4" transform="rotate(18 14 8)"/><ellipse cx="11" cy="13" rx="1.5" ry="2.4" transform="rotate(-8 11 13)"/><ellipse cx="16" cy="14" rx="1.5" ry="2.4" transform="rotate(24 16 14)"/><ellipse cx="7" cy="15" rx="1.5" ry="2.4" transform="rotate(12 7 15)"/></svg>',
 jain:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 5v9a4 4 0 1 1-4-4"/></svg>',
 korea:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 3a9 9 0 0 1 0 18 4.5 4.5 0 0 1 0-9 4.5 4.5 0 0 0 0-9Z" fill="currentColor"/></svg>',
 new:'<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l2.4 6.6 7 .3-5.5 4.4 2 6.8-5.9-4-5.9 4 2-6.8-5.5-4.4 7-.3Z"/></svg>'};
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
