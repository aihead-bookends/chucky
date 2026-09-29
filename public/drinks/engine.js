/* Aiko drinks — the menu engine. Unlike the food menus it doesn't splice the artwork: the drinks
   page of drinks.pdf is redrawn from a list of bands (a gradient, a name, a description, a price;
   and the soft drinks at the bottom), read from fieldmap.json. Ported from the original Chucky editor
   (deploy/public/drinks/index.html); every change is marked "chucky-2". It runs inside the shell
   that assets/js/editor.js renders, loads and publishes through assets/js/menustate.js, and relies
   on pdf-lib (PDFLib) and pdf.js (pdfjsLib) loaded by index.html. */

const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const BRAND={ name:"Aiko Drinks", pdf:'drinks.pdf', download:'Aiko_Drinks_Menu.pdf', dictKey:'aikodrinks_dict' };
let FM, GEO, BANDS=[], doc, pageStreams=[], pdfBytesOrig, lastBytes=null, pdfjsDoc=null, renderToken=0, activePage=1, ptimer=null;
const enc=s=>new TextEncoder().encode(s);
const escPdf=s=>(s||'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
function esc(s){return (s+'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
const num=n=>{ let s=(+n).toFixed(3).replace(/0+$/,'').replace(/\.$/,''); return s||'0'; };
const deacc=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
let BASE=new Set(), CULINARY=new Set(), BASE_LIST=[], CULINARY_LIST=[];
const IGNORED=new Set(), MENU=new Set();
try{ JSON.parse(localStorage.getItem(BRAND.dictKey)||'[]').forEach(w=>IGNORED.add(w)); }catch(_){}
function lev(a,b,max){ const m=a.length,n=b.length; if(Math.abs(m-n)>max) return max+1; let p=Array.from({length:n+1},(_,i)=>i); for(let i=1;i<=m;i++){ let c=[i],best=i; for(let j=1;j<=n;j++){ const d=a[i-1]===b[j-1]?0:1; c[j]=Math.min(p[j]+1,c[j-1]+1,p[j-1]+d); best=Math.min(best,c[j]); } if(best>max) return max+1; p=c; } return p[n]; }
function suggest(word){ word=word.toLowerCase(); const f=word[0],res=[]; const scan=arr=>{ for(const c of arr){ if(c[0]!==f||Math.abs(c.length-word.length)>2) continue; const d=lev(word,c,2); if(d<=2) res.push([d,c]); } }; scan(CULINARY_LIST); scan(BASE_LIST); res.sort((a,b)=>a[0]-b[0]||a[1].length-b[1].length); const seen=new Set(),out=[]; for(const[,c]of res){ if(!seen.has(c)){seen.add(c);out.push(c);} if(out.length>=3) break; } return out; }
function wordAllowed(raw){
  const w = deacc(raw).replace(/[^A-Za-z']/g,'').toLowerCase().replace(/^'+|'+$/g,'');
  if(!w || w.length<2) return true;
  if(IGNORED.has(w)||CULINARY.has(w)||MENU.has(w)||BASE.has(w)) return true;
  if(w.endsWith('s') && (BASE.has(w.slice(0,-1))||CULINARY.has(w.slice(0,-1))||MENU.has(w.slice(0,-1)))) return true;
  if(w.includes("'") && BASE.has(w.replace(/'/g,''))) return true;
  if(/[-\/]/.test(raw)){ const parts=raw.split(/[-\/]+/).filter(p=>/[A-Za-z]/.test(p)); if(parts.length>1 && parts.every(p=>wordAllowed(p))) return true; }
  return false;
}
function nameIssues(v){ const bad=[],warn=[];
  for(const raw of v.split(/\s+/)){ const w=raw.replace(/[^A-Za-z'\-/]/g,''); if(w.replace(/[^A-Za-z]/g,'').length<3) continue;
    if(wordAllowed(w)) continue; const sg=suggest(deacc(w).replace(/[^A-Za-z']/g,''));
    if(sg.length) bad.push(w.toUpperCase()+' \u2192 '+sg[0].toUpperCase()+'?'); else warn.push(w.toUpperCase()); }
  return {bad,warn}; }
function updateGate(){ const pill=document.getElementById('flagpill'), ex=document.getElementById('export');
  let bad=0, soft=0;
  document.querySelectorAll('#editor .warnline').forEach(w=>{ if(w.dataset.level==='bad') bad++; else soft++; });
  if(bad){ pill.className='pill bad'; pill.textContent=bad+' spelling to fix'; ex.disabled=true; }
  else{ pill.className='pill ok'; pill.textContent='All clear'+(soft?' \u00b7 '+soft+' to review':''); ex.disabled=false; } }
function validateNames(){
  document.querySelectorAll('#editor .card').forEach(card=>{
    const inp=card.querySelector('input.name'); if(!inp) return;
    const touched = inp.dataset.added==='1' || (inp.dataset.orig!=null && inp.value.trim()!==inp.dataset.orig);
    let line=card.querySelector('.warnline');
    const clear=()=>{ if(line) line.remove(); inp.classList.remove('err'); };
    if(!touched || !inp.value.trim()){ clear(); return; }
    const {bad,warn}=nameIssues(inp.value);
    if(!bad.length && !warn.length){ clear(); return; }
    if(!line){ line=document.createElement('div'); line.className='warnline'; card.appendChild(line); }
    line.dataset.level=bad.length?'bad':'soft'; line.classList.toggle('soft',!bad.length);
    line.textContent = bad.length ? ('spelling: '+bad.join('  ')) : ('check: '+warn.join(' '));
    const ig=document.createElement('button'); ig.type='button'; ig.className='iglink'; ig.textContent='ignore \u2014 add to dictionary';
    ig.onclick=()=>{ for(const w of (deacc(inp.value).toLowerCase().match(/[a-z']+/g)||[])) IGNORED.add(w); try{ localStorage.setItem(BRAND.dictKey, JSON.stringify([...IGNORED])); }catch(_){} validateNames(); };
    line.appendChild(ig);
    inp.classList.toggle('err',!!bad.length);
  });
  updateGate();
}
function fontNote(chars){ let n=document.getElementById('fontnote'); if(!n)return; n.textContent='“'+chars+'” isn’t in this menu’s font — can’t print'; n.classList.add('on'); clearTimeout(n._t); n._t=setTimeout(()=>n.classList.remove('on'),2400); }
function cleanField(v, role){ const al=(FM.allowed&&FM.allowed[role])||''; let out='',drop=''; for(const ch of v){ if(al.indexOf(ch)>=0) out+=ch; else drop+=ch; } if(drop.replace(/\s/g,'')) fontNote(drop.replace(/\s+/g,' ').trim().split('').join(' ')); return out; }

// ---------- flavor -> gradient ----------
const FLAVOR={mango:'#F5A623',passionfruit:'#F2B705',passion:'#F2B705',orange:'#FF8C1A',apricot:'#F6A623',
 lemon:'#F4D03F',lime:'#A3D93A',citrus:'#EBD534',yuzu:'#EBD534',grapefruit:'#F0616B',
 mint:'#3ECF8E',basil:'#4FAE5A',cucumber:'#8FD14F',matcha:'#7FB135',green:'#5BC236',apple:'#8FCB3A',
 berry:'#C0392B',raspberry:'#D6336C',strawberry:'#E8384F',cherry:'#C81D4E',pomegranate:'#B31438',
 blueberry:'#4A69BD',blackberry:'#5B2C8C',grape:'#6A2C91',plum:'#7A2E6B',kala:'#4B2367',khatta:'#4B2367',
 hibiscus:'#C71F5A',rose:'#E56B9F',scarlett:'#E8384F',watermelon:'#F76B7A',peach:'#FFB07C',
 pineapple:'#F6D33C',banana:'#F2E14C',honey:'#E8A93A',ginger:'#E0A44A',
 chamoy:'#C0392B',tamarind:'#8A4B2E',chilli:'#E23B2E',spice:'#D2542E',
 chocolate:'#5A3A2E',coffee:'#4A2E22',cola:'#3A241A',vanilla:'#EFE3C2',coconut:'#F0EBDD',cream:'#F2E7CE',
 thai:'#E08A2E',tea:'#B5651D',boba:'#7A4A2E',soda:'#8FA9BC',fizz:'#7FC4D8',tonic:'#CFE8F0',
 tropical:'#F6A11F',pop:'#F25C54',breeze:'#5AC8E0',kafir:'#9FD24A',kaffir:'#9FD24A',blue:'#3B6FD6',red:'#D8352A'};
const STOP=new Set('and with a of the served no nasty in house from scratch syrup sauce jam ice club soda salt'.split(' '));
function hx2rgb(h){h=h.replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
function rgb01(c){return c.map(x=>Math.max(0,Math.min(1,x/255)));}
function shade(c,f){return c.map(x=> f<=1? x*f : x+(255-x)*(f-1));}
function gradientFor(text){
  const words=(text.toLowerCase().match(/[a-z]+/g)||[]); const hits=[];
  for(const w of words){ if(STOP.has(w))continue; if(FLAVOR[w])hits.push(FLAVOR[w]); else if(w.endsWith('s')&&FLAVOR[w.slice(0,-1)])hits.push(FLAVOR[w.slice(0,-1)]); }
  const uniq=[...new Set(hits)].map(hx2rgb);
  if(!uniq.length) return [rgb01([138,143,163]), rgb01([60,58,72])];
  if(uniq.length===1){ const b=uniq[0]; return [rgb01(shade(b,1.18)), rgb01(shade(b,0.55))]; }
  return [rgb01(uniq[0]), rgb01(shade(uniq[uniq.length-1],0.7))];
}
function rgb2hex(c){return '#'+c.map(x=>Math.round(Math.max(0,Math.min(1,x))*255).toString(16).padStart(2,'0')).join('');}

// ---------- rebuild page from band model ----------
function strips(bottom,h,C0,C1){ const N=90,W=GEO.W; let s='q\n';
  for(let i=0;i<N;i++){ const t=i/(N-1); const r=C0[0]+(C1[0]-C0[0])*t,g=C0[1]+(C1[1]-C0[1])*t,b=C0[2]+(C1[2]-C0[2])*t;
    s+=num(r)+' '+num(g)+' '+num(b)+' rg '+num(i*W/N)+' '+num(bottom)+' '+num(W/N+0.7)+' '+num(h)+' re f\n'; }
  return s+'Q\n'; }
function txt(x,y,size,t,col){ if(!t) return ''; return 'BT\n'+(col||'1 1 1')+' rg /GS0 gs /TT0 1 Tf\n-0.02 Tc '+num(size)+' 0 0 '+num(size)+' '+num(x)+' '+num(y)+' Tm\n('+escPdf(t)+')Tj\nET\n'; }
// width of a string in this page's font. TT0 (MonospaceTypewriter) is effectively monospace, and
// txt() always sets -0.02 Tc, so every glyph advances the same amount.
function aikoAdv(s,size){ return (s||'').length*(((GEO&&GEO.volAdv)||0.586)-0.02)*size; }
function buildPage(){
  const sig=BANDS.filter(b=>b.type==='signature'); const soft=BANDS.find(b=>b.type==='soft');
  const W=GEO.W,H=GEO.H,softH=GEO.softH; const bh=(H-softH)/Math.max(1,sig.length); let out='';
  sig.forEach((b,i)=>{ const top=H-i*bh, bottom=top-bh;
    out+=strips(bottom,bh,b.C0,b.C1);
    out+=txt(GEO.nameX, bottom+bh*0.52, GEO.nameSize, b.name);
    out+=txt(GEO.descX, bottom+bh*0.52-9.5, GEO.descSize, b.desc);
    // volume trails the description, one space clear of it — same relationship the Capiche
    // drinks menus use. No brackets here: this font's subset has no [ or ].
    if(b.vol) out+=txt(GEO.descX+aikoAdv((b.desc||'')+' ',GEO.descSize), bottom+bh*0.52-9.5,
                       GEO.volSize||5, b.vol+'ML', '0.78 0.78 0.78');
    out+=txt(GEO.priceX, bottom+bh*0.46, GEO.priceSize, b.price);
  });
  if(soft){ out+=strips(0,softH,soft.C0,soft.C1);
    const n=soft.lines.length, gap=Math.min(11,(softH-30)/Math.max(1,n-1));
    soft.lines.forEach((l,i)=>{ const y=17+i*gap; out+=txt(GEO.nameX,y,GEO.priceSize,l.name); out+=txt(GEO.priceX,y,GEO.priceSize,l.price); }); }
  return out;
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
  const bytes=enc(buildPage()); const ps=pageStreams[FM.menu_page];
  ps.dict.set(PDFName.of('Length'), PDFNumber.of(bytes.length));
  doc.context.assign(ps.ref, PDFRawStream.of(ps.dict, bytes));
  if(typeof QRK!=='undefined') QRK.apply(doc);   // QR codes: resize/move/remove/add (src/shared/qrtool)
  lastBytes=await doc.save({useObjectStreams:false}); try{MEM.tick();}catch(_){} try{MenuState.touch();}catch(_){}   // chucky-2
  return lastBytes;
}
function schedulePreview(){ clearTimeout(ptimer); ptimer=setTimeout(async()=>{ await regenerate(); renderPreview(); },320); try{MEM.tick();}catch(_){} }
/* ---------- click the preview to edit ----------
   Invisible boxes over the rendered page (positioned in PERCENT so they hold at any preview
   scale). Clicking a drink scrolls to + highlights its card. Boxes follow the removal reflow. */
let _pvSel=null;
function pvHitLayer(){
  const cv=document.getElementById('preview'); if(!cv) return null;
  let st=document.getElementById('pstage');
  if(!st){ st=document.createElement('div'); st.id='pstage';
    cv.parentNode.insertBefore(st,cv); st.appendChild(cv);
    const hl=document.createElement('div'); hl.id='hitlayer'; st.appendChild(hl); }
  return st.querySelector('#hitlayer');
}
// one box per band on the menu page, in PDF space (y up). Mirrors buildPage()'s layout:
// signature bands stack from the top in equal slices, the soft-drinks band owns the bottom.
function pvBoxes(p){
  if(p!==FM.menu_page) return [];
  const sig=BANDS.filter(b=>b.type==='signature'), soft=BANDS.find(b=>b.type==='soft');
  const H=GEO.H, W=GEO.W, softH=GEO.softH, bh=(H-softH)/Math.max(1,sig.length);
  const out=[];
  sig.forEach((b,i)=>{ const top=H-i*bh; out.push({id:'sig:'+i, x0:4, x1:W-4, top, bot:top-bh}); });
  if(soft){ const n=soft.lines.length, gap=Math.min(11,(softH-30)/Math.max(1,n-1));
    soft.lines.forEach((l,i)=>{ const y=17+i*gap;      // height tied to the gap so rows never overlap
      out.push({id:'soft:'+i, x0:4, x1:W-4, top:y+gap*0.70, bot:y-gap*0.28}); }); }
  return out;
}
function pvSync(){
  const hl=pvHitLayer(); if(!hl) return;
  let boxes; try{ boxes=pvBoxes(activePage); }catch(e){ hl.innerHTML=''; return; }
  const sz=(FM.page_sizes&&FM.page_sizes[activePage])||[280.63,595.28], W=sz[0], H=sz[1];
  hl.innerHTML='';
  for(const b of boxes){
    const d=document.createElement('div');
    d.className='hitbox'+(_pvSel===b.id?' sel':'');
    d.style.left=(b.x0/W*100)+'%'; d.style.width=(Math.max(10,b.x1-b.x0)/W*100)+'%';
    d.style.top=((H-b.top)/H*100)+'%'; d.style.height=(Math.max(8,b.top-b.bot)/H*100)+'%';
    d.title='Click to edit this drink';
    d.addEventListener('click',()=>pvJump(b.id));
    hl.appendChild(d);
  }
  try{ if(typeof QRK!=='undefined') QRK.hits(hl, activePage, W, H); }catch(e){ console.error(e); }
}
function pvJump(key){
  _pvSel=key; pvSync();
  const card=document.querySelector('#editor .card[data-key="'+key+'"]');
  if(!card) return;
  card.scrollIntoView({behavior:'smooth', block:'center'});
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  const f=card.querySelector('textarea.name,input.name'); if(f) setTimeout(()=>f.focus(),260);
}
async function renderPreview(){
  const my=++renderToken; document.getElementById('busy').classList.add('on');
  const bytes=lastBytes||await regenerate();
  try{ if(pdfjsDoc){pdfjsDoc.destroy();pdfjsDoc=null;}
    const pdf=await pdfjsLib.getDocument({data:bytes.slice(0)}).promise; if(my!==renderToken){pdf.destroy();return;} pdfjsDoc=pdf;
    const page=await pdf.getPage(activePage+1);
    const pane=document.getElementById('previewPane'); const avail=pane.clientWidth-28;
    const base=page.getViewport({scale:1}); const scale=Math.min(avail/base.width,2.6);
    const vp=page.getViewport({scale:scale*window.devicePixelRatio});
    const cv=document.getElementById('preview'),cx=cv.getContext('2d');
    cv.width=vp.width;cv.height=vp.height;cv.style.width=(vp.width/window.devicePixelRatio)+'px';
    await page.render({canvasContext:cx,viewport:vp}).promise;
  }catch(e){ if(!(e&&(e.name==='RenderingCancelledException'||String(e.message||e).includes('Rendering cancelled')))) console.error(e); }
  if(my===renderToken){ document.getElementById('busy').classList.remove('on'); try{ pvSync(); }catch(_){} }
}
function updateGate(){ let bad=0; document.querySelectorAll('#editor .warnline').forEach(w=>{ if(w.dataset.level==='bad') bad++; });
  document.querySelectorAll('#editor input.name').forEach(inp=>{ if(!inp.value.trim()) bad++; });
  const pill=document.getElementById('flagpill'),ex=document.getElementById('export');
  if(bad){ pill.className='pill bad'; pill.textContent=bad+' to fix'; ex.disabled=true; }
  else{ pill.className='pill ok'; pill.textContent='All clear'; ex.disabled=false; } }
function validateFields(){
  document.querySelectorAll('#editor .card').forEach(card=>{ let line=card.querySelector('.warnline');
    const bads=[],warns=[];
    card.querySelectorAll('input.name,input.desc').forEach(inp=>{ const iss=nameIssues(inp.value); inp.classList.toggle('err',!!iss.bad.length); bads.push(...iss.bad); warns.push(...iss.warn); });
    if(!bads.length&&!warns.length){ if(line)line.remove(); return; }
    if(!line){ line=document.createElement('div'); line.className='warnline'; card.appendChild(line); }
    line.dataset.level=bads.length?'bad':'soft'; line.classList.toggle('soft',!bads.length);
    line.textContent=bads.length?('spelling: '+bads.join('  ')):('check: '+warns.join(' '));
    const ig=document.createElement('button'); ig.type='button'; ig.className='iglink'; ig.textContent='ignore';
    ig.onclick=()=>{ card.querySelectorAll('input.name,input.desc').forEach(inp=>{ for(const w of (deacc(inp.value).toLowerCase().match(/[a-z']+/g)||[])) IGNORED.add(w); }); try{localStorage.setItem(BRAND.dictKey,JSON.stringify([...IGNORED]));}catch(_){}; validateFields(); updateGate(); };
    line.appendChild(ig); });
  updateGate();
}
function swatchCss(b){ return 'linear-gradient(90deg,'+rgb2hex(b.C0)+','+rgb2hex(b.C1)+')'; }
function buildEditor(){
  const ed=document.getElementById('editor'); ed.innerHTML='';
  if(activePage!==FM.menu_page){ const m=document.createElement('div'); m.style.cssText='padding:30px 6px;color:var(--muted);font-size:14px'; m.innerHTML='The cover page isn’t editable — switch to <b>Menu</b> to edit drinks.'; ed.appendChild(m); if(typeof syncRail==='function')syncRail(); return; }
  const sig=BANDS.filter(b=>b.type==='signature');
  // SIGNATURE section
  const hd=document.createElement('div'); hd.className='grouphd sechd'; hd.id='sec-0'; hd.dataset.sec='SIGNATURE';
  hd.innerHTML='<span>SIGNATURE</span><span class="n">'+sig.length+' item'+(sig.length===1?'':'s')+'</span>'; ed.appendChild(hd);
  let dragFrom=null; // index into sig[] being dragged
  sig.forEach((b,si)=>{
    const card=document.createElement('div'); card.className='card';
    card.dataset.slot=si;
    card.dataset.key='sig:'+si;   // what pvJump() looks the card up by — keep in step with pvBoxes()
    // Drag events — only fire when initiated from the handle
    card.addEventListener('dragstart',e=>{
      dragFrom=si; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',String(si));
      setTimeout(()=>card.classList.add('dragging'),0);
    });
    card.addEventListener('dragend',()=>{ card.classList.remove('dragging'); card.draggable=false; dragFrom=null; ed.querySelectorAll('.card.drag-over').forEach(c=>c.classList.remove('drag-over')); });
    card.addEventListener('dragover',e=>{ e.preventDefault(); e.dataTransfer.dropEffect='move'; if(dragFrom!=null&&dragFrom!==si) card.classList.add('drag-over'); });
    card.addEventListener('dragleave',e=>{ if(!card.contains(e.relatedTarget)) card.classList.remove('drag-over'); });
    card.addEventListener('drop',e=>{
      e.preventDefault(); card.classList.remove('drag-over');
      const from=dragFrom; if(from==null||from===si) return;
      // Find the actual BANDS indices for from and si within the signature sub-array
      const sigBands=BANDS.filter(x=>x.type==='signature');
      const bFrom=BANDS.indexOf(sigBands[from]), bTo=BANDS.indexOf(sigBands[si]);
      if(bFrom>=0&&bTo>=0){ const tmp=BANDS[bFrom]; BANDS[bFrom]=BANDS[bTo]; BANDS[bTo]=tmp; }
      try{MEM.tick();}catch(_){} buildEditor(); regenerate().then(renderPreview);
    });
    const nrow=document.createElement('div'); nrow.className='nrow';
    // Drag handle
    const handle=document.createElement('div'); handle.className='drag-handle'; handle.title='Drag to reorder'; handle.textContent='⠿';
    handle.addEventListener('mouseenter', () => { if (dragFrom == null) card.draggable = true; });
    handle.addEventListener('mouseleave', () => { if (dragFrom == null) card.draggable = false; });
    handle.addEventListener('touchstart', () => { card.draggable = true; }, {passive:true});
    nrow.appendChild(handle);
    const name=document.createElement('input'); name.className='name'; name.spellcheck=false; name.value=b.name; name.placeholder='DRINK NAME';
    name.oninput=()=>{ let v=cleanField(name.value.toUpperCase(),'name'); if(name.value!==v){const p=name.selectionStart;name.value=v;name.setSelectionRange(p,p);} b.name=v; validateFields(); schedulePreview(); };
    nrow.appendChild(name);
    const pw=document.createElement('div'); pw.className='price-wrap'; pw.innerHTML='<span class="cur">₹</span>';
    const price=document.createElement('input'); price.className='price'; price.value=b.price; price.inputMode='numeric';
    price.oninput=()=>{ const c=cleanField(price.value.replace(/[^0-9]/g,''),'price'); if(price.value!==c)price.value=c; b.price=c; schedulePreview(); };
    pw.appendChild(price); nrow.appendChild(pw);
    // volume — the number only; buildPage appends the "ML". cleanField applies the desc charset
    // because that is the font it renders in: this subset has no 1, 4, 7, 8 or 9, and the toast
    // is how the editor already tells you a character can't be printed.
    const vw=document.createElement('div'); vw.className='vol-wrap';
    const vol=document.createElement('input'); vol.className='volu'; vol.inputMode='numeric';
    vol.placeholder='300'; vol.value=b.vol||''; vol.title='Serving volume';
    vol.oninput=()=>{ const c=cleanField(vol.value.replace(/[^0-9]/g,''),'desc'); if(vol.value!==c)vol.value=c; b.vol=c; schedulePreview(); };
    const vu=document.createElement('span'); vu.className='unit'; vu.textContent='ML';
    vw.appendChild(vol); vw.appendChild(vu); nrow.appendChild(vw);
    const rm=document.createElement('button'); rm.className='rm'; rm.title='Remove drink'; rm.textContent='✕';
    rm.onclick=()=>{ const k=BANDS.indexOf(b); if(k>=0)BANDS.splice(k,1); buildEditor(); regenerate().then(renderPreview); };
    nrow.appendChild(rm); card.appendChild(nrow);
    const desc=document.createElement('input'); desc.className='desc'; desc.spellcheck=false; desc.value=b.desc; desc.placeholder='ingredients, comma separated';
    desc.oninput=()=>{ const c=cleanField(desc.value,'desc'); if(desc.value!==c){const p=desc.selectionStart;desc.value=c;desc.setSelectionRange(p,p);} b.desc=c; validateFields(); schedulePreview(); };
    card.appendChild(desc);
    // gradient row
    const gr=document.createElement('div'); gr.className='gradrow';
    gr.innerHTML='<span class="gradlbl">Gradient</span>';
    const sw=document.createElement('div'); sw.className='gradsw'; sw.style.background=swatchCss(b); gr.appendChild(sw);
    const c0=document.createElement('input'); c0.type='color'; c0.value=rgb2hex(b.C0); c0.title='Start colour';
    const c1=document.createElement('input'); c1.type='color'; c1.value=rgb2hex(b.C1); c1.title='End colour';
    c0.oninput=()=>{ b.C0=rgb01(hx2rgb(c0.value)); sw.style.background=swatchCss(b); schedulePreview(); };
    c1.oninput=()=>{ b.C1=rgb01(hx2rgb(c1.value)); sw.style.background=swatchCss(b); schedulePreview(); };
    gr.appendChild(c0); gr.appendChild(c1);
    const auto=document.createElement('button'); auto.className='autogr'; auto.innerHTML='✨ Auto from flavour';
    auto.onclick=()=>{ const g=gradientFor(b.name+' '+b.desc); b.C0=g[0]; b.C1=g[1]; c0.value=rgb2hex(b.C0); c1.value=rgb2hex(b.C1); sw.style.background=swatchCss(b); schedulePreview(); };
    gr.appendChild(auto); card.appendChild(gr);
    ed.appendChild(card);
  });
  const add=document.createElement('button'); add.className='addbtn'; add.textContent='+  Add drink';
  add.onclick=()=>{ const nb={type:'signature',C0:[0.55,0.55,0.6],C1:[0.28,0.28,0.34],name:'',desc:'',price:'360',vol:''};
    const si=BANDS.filter(b=>b.type==='signature').length; BANDS.splice(si,0,nb); buildEditor();
    const cards=document.querySelectorAll('#editor .card'); const last=cards[si]; if(last){const n=last.querySelector('input.name'); if(n)n.focus();}
    regenerate().then(renderPreview); };
  ed.appendChild(add);
  // SOFT DRINKS section
  const soft=BANDS.find(b=>b.type==='soft');
  if(soft){ const sh=document.createElement('div'); sh.className='grouphd sechd'; sh.id='sec-1'; sh.dataset.sec='SOFT DRINKS';
    sh.innerHTML='<span>SOFT DRINKS</span><span class="n">'+soft.lines.length+' items</span>'; ed.appendChild(sh);
    let dragSoftFrom=null;
    soft.lines.forEach((l,si)=>{ const card=document.createElement('div'); card.className='card';
      card.dataset.slot=si;
      card.dataset.key='soft:'+si;   // what pvJump() looks the card up by — keep in step with pvBoxes()
      card.addEventListener('dragstart',e=>{
        dragSoftFrom=si; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',String(si));
        setTimeout(()=>card.classList.add('dragging'),0);
      });
      card.addEventListener('dragend',()=>{ card.classList.remove('dragging'); card.draggable=false; dragSoftFrom=null; ed.querySelectorAll('.card.drag-over').forEach(c=>c.classList.remove('drag-over')); });
      card.addEventListener('dragover',e=>{ e.preventDefault(); e.dataTransfer.dropEffect='move'; if(dragSoftFrom!=null&&dragSoftFrom!==si) card.classList.add('drag-over'); });
      card.addEventListener('dragleave',e=>{ if(!card.contains(e.relatedTarget)) card.classList.remove('drag-over'); });
      card.addEventListener('drop',e=>{
        e.preventDefault(); card.classList.remove('drag-over');
        const from=dragSoftFrom; if(from==null||from===si) return;
        const tmp=soft.lines[from]; soft.lines[from]=soft.lines[si]; soft.lines[si]=tmp;
        try{MEM.tick();}catch(_){} buildEditor(); regenerate().then(renderPreview);
      });
      const nrow=document.createElement('div'); nrow.className='nrow';
      // Drag handle
      const handle=document.createElement('div'); handle.className='drag-handle'; handle.title='Drag to reorder'; handle.textContent='⠿';
      handle.addEventListener('mouseenter', () => { if (dragSoftFrom == null) card.draggable = true; });
      handle.addEventListener('mouseleave', () => { if (dragSoftFrom == null) card.draggable = false; });
      handle.addEventListener('touchstart', () => { card.draggable = true; }, {passive:true});
      nrow.appendChild(handle);
      const name=document.createElement('input'); name.className='name'; name.spellcheck=false; name.value=l.name;
      name.oninput=()=>{ let v=cleanField(name.value.toUpperCase(),'name'); if(name.value!==v){const p=name.selectionStart;name.value=v;name.setSelectionRange(p,p);} l.name=v; validateFields(); schedulePreview(); };
      nrow.appendChild(name);
      const pw=document.createElement('div'); pw.className='price-wrap'; pw.innerHTML='<span class="cur">₹</span>';
      const price=document.createElement('input'); price.className='price'; price.value=l.price; price.inputMode='numeric';
      price.oninput=()=>{ const c=cleanField(price.value.replace(/[^0-9]/g,''),'price'); if(price.value!==c)price.value=c; l.price=c; schedulePreview(); };
      pw.appendChild(price); nrow.appendChild(pw);
      const rm=document.createElement('button'); rm.className='rm'; rm.title='Remove'; rm.textContent='✕';
      rm.onclick=()=>{ const k=soft.lines.indexOf(l); if(k>=0)soft.lines.splice(k,1); buildEditor(); regenerate().then(renderPreview); };
      nrow.appendChild(rm); card.appendChild(nrow); ed.appendChild(card); });
    const addS=document.createElement('button'); addS.className='addbtn'; addS.textContent='+  Add soft drink';
    addS.onclick=()=>{ soft.lines.push({name:'',price:'200'}); buildEditor(); const cards=document.querySelectorAll('#editor .sechd#sec-1 ~ .card'); const last=cards[cards.length-1]; if(last){const n=last.querySelector('input.name'); if(n)n.focus();} regenerate().then(renderPreview); };
    ed.appendChild(addS);
  }
  validateFields();
  if(typeof syncRail==='function') syncRail();
}
document.querySelectorAll('.tabs button').forEach(b=>b.addEventListener('click',()=>{ document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); activePage=+b.dataset.pg; document.getElementById('ptag').textContent='— '+(activePage===FM.menu_page?'Menu':'Cover'); buildEditor(); renderPreview(); }));
/* ---- FULL-PAGE PREVIEW HANDOFF --------------------------------------------------------------
   Opens /preview/ in a new tab showing the ACTUAL current PDF. There is NO second generator here:
   this calls the same regenerate() that Export calls, so the preview and the exported file are the
   same bytes. The PDF reaches the viewer through IndexedDB (same-origin, client-only) — it never
   enters the URL, never hits the network and is never uploaded. The record is one-shot: the viewer
   deletes it the moment it loads, and sweeps anything stale.
   The tab is opened SYNCHRONOUSLY, before the await — opening it afterwards makes the browser treat
   it as a pop-up and block it. */
const PV_DB='chucky_preview', PV_STORE='jobs';
const PV_FILE=(typeof BRAND!=='undefined'&&BRAND&&BRAND.download)?BRAND.download:'Aiko_Drinks_Menu.pdf';
const PV_TITLE="Aiko — Drinks";
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
document.getElementById('export').addEventListener('click', async()=>{ const bytes=await regenerate(); const blob=new Blob([bytes],{type:'application/pdf'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=BRAND.download; a.click(); URL.revokeObjectURL(url); try{MEM.snapshot('export');}catch(_){} showChucky(BRAND.download); });
// ---- Publish: chucky-2 — the shared MenuState (assets/js/menustate.js) owns the Publish button:
// the version check, the conflict handling and the live status. Wired up at the end of boot().
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
     (assets/js/editor.js); made here: the export celebration and the font note (#fontnote). */
  const note=document.createElement('div'); note.id='fontnote'; note.setAttribute('role','status');
  document.body.appendChild(note);
})();

// ---------- boot ----------
// ---- edit-memory glue (drinks) ----
const MEM_BRAND='aiko-drinks';
let memBaseVer='';
/* chucky-2: the state is a COPY of the bands. The snapshot used to hand out BANDS itself and a loaded
   state became BANDS, so a later edit also changed the "saved" copy it came from (a History entry,
   the menu kept before loading the latest). A state without bands means the fieldmap's menu. */
let PRISTINE_BANDS=null;
const copyBands=b=>JSON.parse(JSON.stringify(b));
function memSnapshot(){ return { qr:QRK.snap(), bands:copyBands(BANDS) }; }
function memApply(st){ QRK.load(st&&st.qr); BANDS=copyBands((st&&st.bands)||PRISTINE_BANDS); FM.bands=BANDS; }
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
  // published menu — nothing left to resume. Cancel a pending autosave too: publishing regenerates,
  // which queues one, and if the server answers first it would put the old edits back afterwards.
  function rebase(){ clearTimeout(timer); try{ initial=J(memSnapshot()); localStorage.removeItem(AUTO); }catch(_){ } setStatus('',''); }
  function init(){ try{ initial=J(memSnapshot()); }catch(_){ initial=''; } ready=true; build(); checkResume(); }
  return { init, tick, snapshot, restore, ago, rebase };
})();
async function boot(){
  try{
    FM=await (await fetch('fieldmap.json?v='+Date.now())).json(); activePage=FM.menu_page; GEO=FM.geo; BANDS=FM.bands; PRISTINE_BANDS=copyBands(FM.bands);   // chucky-2: the fieldmap's menu, for memApply
    try{ const [bw,cw]=await Promise.all([fetch('base_words.json?v='+Date.now()).then(r=>r.json()),fetch('culinary.json?v='+Date.now()).then(r=>r.json())]); BASE=new Set(bw);CULINARY=new Set(cw);BASE_LIST=bw;CULINARY_LIST=cw; }catch(_){}
    BANDS.forEach(b=>{ [b.name,b.desc].forEach(t=>{ if(t) for(const w of deacc(t.toLowerCase()).split(/[^a-z']+/)) if(w) MENU.add(w); }); if(b.lines) b.lines.forEach(l=>{ for(const w of deacc((l.name||'').toLowerCase()).split(/[^a-z']+/)) if(w) MENU.add(w); }); });
    document.getElementById('bootmsg').textContent='Loading your menu…';
    pdfBytesOrig=new Uint8Array(await (await fetch(BRAND.pdf+'?v='+Date.now())).arrayBuffer()); memBaseVer='v'+pdfBytesOrig.length;
    doc=await PDFDocument.load(pdfBytesOrig);
    for(let p=0;p<doc.getPageCount();p++){ const page=doc.getPage(p); const ref=page.node.get(PDFName.of('Contents')); const stream=doc.context.lookup(ref); pageStreams.push({ref,dict:stream.dict,pristine:stream.contents.slice()}); }
    /* chucky-2: MenuState.boot retries the load, applies a published state only if it was made for
       THIS base PDF, falls back to the menu's starting state (start-state.json — the current menu),
       and puts up a bar and locks Publish when the published menu can't be loaded. */
    const _st=await MenuState.boot({ editor:MEM_BRAND, base:memBaseVer, start:'start-state.json' });
    if(_st) memApply(_st);
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
  }catch(e){ document.getElementById('bootmsg').innerHTML='Couldn’t load. It needs to be <b>served</b> (deploy it). <br>'+esc(String(e)); console.error(e); }
}
// ===================== shell =====================
function syncRail(){ const rail=document.getElementById('rail'); if(!rail)return; rail.querySelectorAll('.sec').forEach(e=>e.remove());
  [...document.querySelectorAll('#editor .sechd')].forEach(h=>{ const b=document.createElement('button'); b.className='sec'; b.dataset.target=h.id;
    const cnt=h.querySelector('.n')?h.querySelector('.n').textContent.replace(/ items?$/,''):'';
    b.innerHTML='<span>'+(h.dataset.sec||'Items')+'</span><span class="ct">'+cnt+'</span>';
    b.onclick=()=>{ const t=document.getElementById(h.id); if(t)t.scrollIntoView({behavior:'smooth',block:'start'}); rail.querySelectorAll('.sec').forEach(x=>x.classList.remove('on')); b.classList.add('on'); if(matchMedia('(max-width:640px)').matches) closeDrawers(); };
    rail.appendChild(b); });
  rail.querySelectorAll('.tabs button').forEach(t=>t.classList.toggle('on',+t.dataset.pg===activePage));
  const q=document.getElementById('q'); if(q&&q.value) filterItems(q.value); }
(function(){ const ed=document.getElementById('editor'); if(!ed)return; ed.addEventListener('scroll',()=>{ const heads=[...ed.querySelectorAll('.sechd')]; if(!heads.length)return; const top=ed.getBoundingClientRect().top+70; let cur=heads[0]; for(const h of heads){ if(h.getBoundingClientRect().top<=top) cur=h; } document.querySelectorAll('#rail .sec').forEach(s=>s.classList.toggle('on',s.dataset.target===cur.id)); },{passive:true}); })();
function filterItems(q){ q=(q||'').trim().toLowerCase(); const nt=nm=>nm?(nm.value!=null?nm.value:nm.textContent):'';
  document.querySelectorAll('#editor .card').forEach(c=>{ const t=(nt(c.querySelector('.name'))+' '+nt(c.querySelector('.desc'))).toLowerCase(); c.style.display=(!q||t.includes(q))?'':'none'; });
  document.querySelectorAll('#editor .sechd').forEach(h=>{ let n=h.nextElementSibling,any=false; while(n&&!n.classList.contains('sechd')){ if(n.classList.contains('card')&&n.style.display!=='none') any=true; n=n.nextElementSibling; } h.style.display=(!q||any)?'':'none'; });
  document.querySelectorAll('#editor .addbtn').forEach(b=>b.style.display=q?'none':''); }
function togglePrev(force){ const p=document.getElementById('previewPane'),s=document.getElementById('scrim'); const open=force!==undefined?force:!p.classList.contains('open'); p.classList.toggle('open',open); document.getElementById('rail').classList.remove('open'); s.classList.toggle('on',open&&matchMedia('(max-width:1080px)').matches); }
function closeDrawers(){ document.getElementById('previewPane').classList.remove('open'); document.getElementById('rail').classList.remove('open'); document.getElementById('scrim').classList.remove('on'); }
document.addEventListener('keydown',e=>{ if(e.key==='/'&&document.activeElement.tagName!=='INPUT'&&!document.activeElement.isContentEditable){e.preventDefault();const q=document.getElementById('q');if(q)q.focus();} });
boot();
