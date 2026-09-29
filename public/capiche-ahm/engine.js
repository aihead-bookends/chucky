/* Capiche Ahmedabad drinks — the menu engine: byte-level edits to capiche-ahm.pdf, driven by
   fieldmap.json. Ported from the original Chucky editor (deploy/public/capiche-ahm/index.html);
   every change is marked "chucky-2". It runs inside the shell that assets/js/editor.js renders,
   loads and publishes through assets/js/menustate.js, keeps its photos on the server
   (api/photo.mjs), and relies on pdf-lib (PDFLib) and pdf.js (pdfjsLib) loaded by index.html. */
const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const BRAND={ name:"Capiche", sub:"Ahmedabad · Drinks", pdf:'capiche-ahm.pdf', download:'Capiche_Ahmedabad_Drinks.pdf', dictKey:'capahm_dict' };
let FM, doc, pageStreams=[], pdfBytesOrig, lastBytes=null, pdfjsDoc=null, renderToken=0, activePage, ptimer=null;
let edits={};
let removed=new Set();   // `${page}:${idx}` of removed drinks
let added={};            // page -> [{name,desc,price}] new drinks (fill freed slots)
let photoUploads={};     // drink key -> { name:'/UpN', iw, ih } uploaded photo XObject
let _upN=0;
let markerEdits={};      // K0(page,idx) -> [marker types] override (jain/dairy/gluten) for existing drinks
let badgeEdits={};       // K0(page,idx) -> bool override for the red NEW starburst
let specialsEdits={};    // K0(page,idx) -> bool override for the red SPECIALS bar on the photo
let reorder={};          // page -> [origIdx,...]: reorder[page][slotIdx]=origIdx to display in that slot
// Grade an uploaded image to match the dark/warm menu theme (canvas). Returns a themed JPEG.
async function gradeImage(file){
  const url=URL.createObjectURL(file);
  try{
    const im=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('img')); i.src=url; });
    const MAX=900, sc=Math.min(1, MAX/Math.max(im.width,im.height));
    const cv=document.createElement('canvas'); cv.width=Math.max(1,Math.round(im.width*sc)); cv.height=Math.max(1,Math.round(im.height*sc));
    const cx=cv.getContext('2d'); if(!cx) throw new Error('nocanvas');
    cx.filter='brightness(0.86) contrast(1.10) saturate(1.06)'; cx.drawImage(im,0,0,cv.width,cv.height);
    cx.filter='none'; cx.globalCompositeOperation='overlay'; cx.fillStyle='rgba(120,60,20,0.10)'; cx.fillRect(0,0,cv.width,cv.height);
    cx.globalCompositeOperation='source-over';
    const blob=await new Promise(res=>cv.toBlob(res,'image/jpeg',0.85));
    return { bytes:new Uint8Array(await blob.arrayBuffer()), png:false };
  } finally { URL.revokeObjectURL(url); }
}
/* chucky-2: PHOTOS ARE PART OF THE PUBLISHED MENU. The old editor kept uploaded photos in this
   browser's IndexedDB only: a photo uploaded on one device never showed on any other, and a device
   that published without it put the drink's printed photo back for everyone.
   Now the menu's state names each drink's photo by id, with its crop:
     - a new upload gets a local id ("local-…"), and its bytes are kept on this device (IndexedDB)
       so unpublished edits survive a reload;
     - Publish uploads it first (MenuState's prepare hook, POST /api/photo), and the server's id —
       the SHA-256 of the bytes — replaces the local one in the published state;
     - any device loading a state fetches the photos it names (GET /api/photo/<id>) and keeps a copy.
   A photo a device can't load stays in the state (photoPending), so the next publish never drops
   it silently, and the bar says which drinks are missing theirs. */
const PHOTO_MAX=600*1024;                     // the server's cap (api/_lib/photos.mjs)
const isServerPhoto=id=>/^[0-9a-f]{64}$/.test(id||'');
const newLocalPhotoId=()=>'local-'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
let photoPending={};   // drink key -> {id,zoom,dx,dy,rot}: named by the loaded state, bytes not loaded (yet)
const _xo={};          // photo id -> {name,ref,iw,ih}: each photo goes into the PDF once, however often it's loaded
// Embed raw image bytes into the PDF + register the XObject + set photoUploads[key].
// `fr` (optional) restores a saved crop {zoom,dx,dy,rot}. Keeps the bytes so they can be uploaded.
async function embedBytes(key, buf, isPng, fr, id){
  id=id||newLocalPhotoId();
  let x=_xo[id];
  if(!x){ const img=isPng? await doc.embedPng(buf) : await doc.embedJpg(buf);
    x=_xo[id]={ name:'/Up'+(_upN++), ref:img.ref, iw:img.width, ih:img.height }; }
  const mp=+String(key).split(':')[0]; const page=doc.getPage(mp);
  let res=doc.context.lookup(page.node.get(PDFName.of('Resources')));
  let xo=res.get(PDFName.of('XObject')); xo = xo? doc.context.lookup(xo) : doc.context.obj({});
  if(!res.get(PDFName.of('XObject'))) res.set(PDFName.of('XObject'), xo);
  xo.set(PDFName.of(x.name.slice(1)), x.ref);
  const prev=photoUploads[key]; if(prev&&prev.src){ try{URL.revokeObjectURL(prev.src);}catch(_){} }
  const src=URL.createObjectURL(new Blob([buf],{type:isPng?'image/png':'image/jpeg'}));
  photoUploads[key]={ id, name:x.name, iw:x.iw, ih:x.ih, src, bytes:buf, isPng:!!isPng,
    zoom:(fr&&fr.zoom)||1, dx:(fr&&fr.dx)||0, dy:(fr&&fr.dy)||0, rot:(fr&&fr.rot)||0 };
  delete photoPending[key];
  return photoUploads[key];
}
function photoNote(msg){ const n=document.getElementById('fontnote'); if(!n) return; n.textContent=msg; n.classList.add('on'); clearTimeout(n._t); n._t=setTimeout(()=>n.classList.remove('on'),4500); }
async function embedPhoto(key, file){
  try{
    let buf, isPng=false;
    try{ const g=await gradeImage(file); buf=g.bytes; isPng=g.png; }
    catch(_){ const raw=new Uint8Array(await file.arrayBuffer()); buf=raw; isPng=(file.type||'').includes('png')||(raw[0]===0x89&&raw[1]===0x50); }
    if(buf.length>PHOTO_MAX){ photoNote('That photo is too large to publish — try a smaller image.'); return; }
    const prev=photoUploads[key]||photoPending[key];
    const up=await embedBytes(key, buf, isPng, null);
    cachePhoto(up.id, buf, isPng);   // on this device until Publish puts it on the server
    try{MEM.tick();}catch(_){}
    buildEditor(); await regenerate(); renderPreview();
    if(!prev) openCropModal(key);   // first upload -> open the crop editor automatically
  }catch(e){ console.error('photo embed failed',e); photoNote('Couldn\u2019t read that image.'); }
}
// ---- this device's copy of photo bytes (IndexedDB), by photo id ----
let _idb=null;
function idb(){ if(_idb) return _idb; _idb=new Promise((res,rej)=>{ const r=indexedDB.open('chucky_photos',1);
  r.onupgradeneeded=()=>{ if(!r.result.objectStoreNames.contains('p')) r.result.createObjectStore('p'); };
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); return _idb; }
async function idbSet(k,v){ try{ const db=await idb(); await new Promise((res,rej)=>{ const t=db.transaction('p','readwrite'); t.objectStore('p').put(v,k); t.oncomplete=res; t.onerror=()=>rej(t.error); }); }catch(_){}}
async function idbGet(k){ try{ const db=await idb(); return await new Promise((res)=>{ const t=db.transaction('p','readonly'); const rq=t.objectStore('p').get(k); rq.onsuccess=()=>res(rq.result); rq.onerror=()=>res(null); }); }catch(_){ return null; }}
async function idbDel(k){ try{ const db=await idb(); await new Promise((res)=>{ const t=db.transaction('p','readwrite'); t.objectStore('p').delete(k); t.oncomplete=res; t.onerror=res; }); }catch(_){}}
const cachePhoto=(id,bytes,isPng)=>idbSet('photo:'+id,{bytes,isPng:!!isPng,t:Date.now()});
async function photoBytes(id){      // -> {bytes,isPng} | null: this device's copy, else the server's
  const c=await idbGet('photo:'+id);
  if(c&&c.bytes) return { bytes:c.bytes instanceof Uint8Array? c.bytes : new Uint8Array(c.bytes), isPng:!!c.isPng };
  if(!isServerPhoto(id)) return null;           // a local photo whose bytes aren't on this device
  const r=await fetch('/api/photo/'+id,{signal:AbortSignal.timeout(20000)}).catch(()=>null);
  if(!r||!r.ok) return null;
  const bytes=new Uint8Array(await r.arrayBuffer()), isPng=bytes[0]===0x89&&bytes[1]===0x50;
  cachePhoto(id,bytes,isPng); return {bytes,isPng};
}
// load the photos memApply() left in photoPending; returns how many are still missing
async function loadPendingPhotos(){
  const want=Object.entries(photoPending);
  const got=await Promise.all(want.map(([,m])=>photoBytes(m.id).catch(()=>null)));
  for(let i=0;i<want.length;i++){ const [k,m]=want[i], b=got[i];
    if(!b || photoPending[k]!==m) continue;      // not found, or replaced while it loaded
    try{ await embedBytes(k, b.bytes, b.isPng, m, m.id); }catch(e){ console.error('photo embed failed',e); } }
  return Object.keys(photoPending).length;
}
function drinkLabel(key){
  const p=String(key).split(':'), mp=+p[0];
  let n='';
  if(p[1]==='add') n=((added[mp]||[])[+p[2]]||{}).name||'';
  else { const it=((FM.pages.find(x=>x.page===mp)||{}).items||[])[+p[1]]; if(it) n=val(mp,+p[1],'name',it.name); }
  n=String(n||'').replace(/\s+/g,' ').trim();
  return n? n : 'a new drink';
}
// say which drinks' photos couldn't be loaded — never quietly show a menu without them
function reportMissingPhotos(why){
  const ks=Object.keys(photoPending); if(!window.MenuState) return ks.length;
  if(!ks.length){ if(why==='retry') MenuState.notice('ok','All the drink photos are loaded.',[],4000); return 0; }
  const names=ks.map(drinkLabel).map(esc).join(', '), one=ks.length===1;
  const what=one? 'The photo for <b>'+names+'</b> couldn\u2019t be loaded' : ks.length+' drink photos couldn\u2019t be loaded (<b>'+names+'</b>)';
  MenuState.notice('warn', why==='export'
      ? '<b>Export paused:</b> '+what+', and the PDF would print without '+(one?'it':'them')+'.'
      : what+'. '+(one?'It stays on the menu, but the preview leaves it out until it loads.':'They stay on the menu, but the preview leaves them out until they load.'),
    [['Try again', retryPhotos]]);
  return ks.length;
}
async function retryPhotos(){ await loadPendingPhotos(); buildEditor(); await regenerate(); renderPreview(); reportMissingPhotos('retry'); }
// Publish (MenuState's prepare hook): put every photo the menu names on the server first
async function uploadPhotos(key){
  for(const k in photoPending) if(!isServerPhoto(photoPending[k].id))
    throw new Error('the photo for '+drinkLabel(k)+' isn\u2019t on this device any more \u2014 upload it again');
  for(const k in photoUploads){ const u=photoUploads[k]; if(!u||isServerPhoto(u.id)) continue;
    const fail=why=>new Error('the photo for '+drinkLabel(k)+' couldn\u2019t be uploaded ('+why+')');
    let r; try{ r=await fetch('/api/photo',{ method:'POST', body:u.bytes, signal:AbortSignal.timeout(30000),
      headers:{ 'content-type':u.isPng?'image/png':'image/jpeg', authorization:'Bearer '+key } }); }
    catch(e){ throw fail(e&&e.name==='TimeoutError'?'the server took too long':'network error'); }
    if(r.status===403) return 'forbidden';
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok||!isServerPhoto(j.id)) throw fail(j.error||'the server answered '+r.status);
    if(!_xo[j.id]) _xo[j.id]=_xo[u.id];
    u.id=j.id; cachePhoto(j.id,u.bytes,u.isPng);
  }
}
// an added drink's photo is keyed by its position: discarding one moves the later ones up with it
function shiftAddedPhotos(mp, ai){
  const pre=mp+':add:';
  for(const M of [photoUploads, photoPending]){
    const idx=Object.keys(M).filter(k=>k.startsWith(pre)).map(k=>+k.slice(pre.length)).sort((a,b)=>a-b);
    delete M[pre+ai];
    for(const i of idx) if(i>ai){ M[pre+(i-1)]=M[pre+i]; delete M[pre+i]; }
  }
}
// Drop this device's copies of photos nothing here names any more (the menu on screen, the
// autosave, History), once they're a day old. Published ones are on the server if needed again.
async function gcPhotoCache(){
  try{
    const keep=new Set(), P=x=>{ try{return JSON.parse(x);}catch(_){return null;} };
    const add=st=>{ const ph=(st&&st.photos)||{}; for(const k in ph) if(ph[k]&&ph[k].id) keep.add(ph[k].id); };
    add(memSnapshot());
    const K='chucky_mem_'+MEM_BRAND, a=P(localStorage.getItem(K+':auto'));
    if(a) add(a.s);
    for(const v of (P(localStorage.getItem(K+':snaps'))||[])) add(v.s);
    const db=await idb();
    const keys=await new Promise(res=>{ const rq=db.transaction('p','readonly').objectStore('p').getAllKeys(); rq.onsuccess=()=>res(rq.result||[]); rq.onerror=()=>res([]); });
    for(const k of keys){ if(typeof k!=='string' || !k.startsWith('photo:') || keep.has(k.slice(6))) continue;
      const rec=await idbGet(k); if(!rec || !rec.t || Date.now()-rec.t>864e5) idbDel(k); }
  }catch(_){}
}
// Frame an uploaded image into a tile [x,y,w,h]: cover-fit, then the drink's own zoom / pan / rotate.
// Defaults (zoom 1, dx/dy 0, rot 0) reproduce the plain centred cover-fit exactly.
function photoFit(up, tile){
  const tw=tile[2], th=tile[3];
  const rot=(((up.rot||0)%360)+360)%360, swap=(rot===90||rot===270);
  const effW = swap? up.ih : up.iw, effH = swap? up.iw : up.ih;   // rotated footprint drives the cover-fit
  const sc = Math.max(tw/effW, th/effH) * (up.zoom||1);
  return { rot, rad:rot*Math.PI/180, w:up.iw*sc, h:up.ih*sc };
}
// Never let a pan drag the image off its tile (that would expose the background). Max pan is
// however much the ROTATED footprint overhangs the tile — so at zoom 1 there's little/no slack.
function photoClamp(up, tile){
  const tw=tile[2], th=tile[3], f=photoFit(up,tile), swap=(f.rot===90||f.rot===270);
  const fw = swap? f.h : f.w, fh = swap? f.w : f.h;
  const mx = Math.max(0,(fw-tw)/2), my = Math.max(0,(fh-th)/2);
  up.dx = Math.min(mx, Math.max(-mx, up.dx||0));
  up.dy = Math.min(my, Math.max(-my, up.dy||0));
  return up;
}
function photoDrawOp(up, tile){
  const tx=tile[0],ty=tile[1],tw=tile[2],th=tile[3];
  photoClamp(up, tile);
  const f=photoFit(up,tile);
  const cx = tx + tw/2 + (up.dx||0), cy = ty + th/2 + (up.dy||0);   // image centre (pan moves it)
  const co=Math.cos(f.rad), si=Math.sin(f.rad);
  const a=f.w*co, b=f.w*si, c=-f.h*si, d=f.h*co;                    // unit square -> placed image
  const e=cx-(a+c)/2, ff=cy-(b+d)/2;
  return '\nq '+num(tx)+' '+num(ty)+' '+num(tw)+' '+num(th)+' re W n '
       + num(a)+' '+num(b)+' '+num(c)+' '+num(d)+' '+num(e)+' '+num(ff)+' cm '+up.name+' Do Q\n';
}
// the tile a drink's photo occupies (w/h is all the framing UI needs)
function photoTileWH(key){
  const p=String(key).split(':');
  if(p[1]==='add') return [99.6,66];
  const pd=FM.pages.find(x=>x.page===+p[0]); const it=pd&&pd.items[+p[1]];
  return (it&&it.photo_tile)? [it.photo_tile[2], it.photo_tile[3]] : [99.6,66];
}
// Stamp a brand-new drink (name/desc/price + placeholder photo tile) at a freed slot baseline y.
function stampNewDrink(pd, slotY, dr){
  const regF='/'+(pd.reg_font||'T1_0'), boldF='/'+(pd.bold_font||'T1_1');
  const nx=9.5, nsz=13, dsz=7; let out='\n';
  out+='q 0.16 0.15 0.13 rg 181.03 '+num(slotY-46)+' 99.6 66 re f Q\n';   // placeholder photo tile
  const nl=nameLines(dr.name); const _nlv=nl.filter(Boolean).length||1;
  out+='BT 0.09 0.09 0.09 rg '+regF+' 1 Tf '+nsz+' 0 0 '+nsz+' '+num(nx)+' '+num(slotY)+' Tm';
  nl.forEach((ln,i)=> out+= (i? ' 0 -1.2 Td':' ')+'('+escPdf(ln)+')Tj');
  out+=' ET\n';
  const DLEAD=-1.4, DCOL='0.42 0.4 0.38 rg';
  const dy=slotY - _nlv*15 - 3;
  let vx=nx, vy=dy;
  if(dr.desc){ const dl=descLines(dr.desc, DESC_MC).slice(0,3);   // honour Enter here too
    out+='BT '+DCOL+' '+boldF+' 1 Tf '+dsz+' 0 0 '+dsz+' '+num(nx)+' '+num(dy)+' Tm ('+escPdf(dl[0]||'')+')Tj';
    for(let i=1;i<dl.length;i++) out+=' 0 '+num(DLEAD)+' Td ('+escPdf(dl[i])+')Tj';
    out+=' ET\n';
    vy=dy+DLEAD*dsz*(dl.length-1);
    vx=nx+(dl[dl.length-1]||'').length*DESC_ADV*dsz+DESC_ADV*dsz;   // one space of separation
  }
  // volume for a brand-new drink is stamped in RMSB (like the price) rather than the subset
  // menu font, so every digit is available — no 1/7/9 gap to work around.
  if(dr.vol) out+=volStamp({x:vx,y:vy,size:5}, DCOL, '['+dr.vol+'ML]');
  out+=priceStamp({x:157,y:slotY-24,size:7}, dr.price||'');
  return out;
}
// Reflow: shift every Tm and photo-block y that sits BELOW a removed drink up by row_h per removed-above.
function reflowOps(bytes, removedTops, delSpans, rowH){
  const s=new TextDecoder('latin1').decode(bytes); const ops=[];
  const inDel=i=> delSpans.some(d=> d[0]<=i && i<d[1]);
  // shift = sum of the ACTUAL heights (pitch) of removed drinks sitting above this y
  const shiftFor=y=> removedTops.filter(t=> t.y>y+0.5).reduce((a,t)=>a+t.pitch,0);
  let m;
  // text Tm ops: shift the y
  let re1=/([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g;
  while((m=re1.exec(s))){ if(inDel(m.index)) continue; const y=parseFloat(m[4]); const sh=shiftFor(y); if(!sh) continue;
    ops.push({s:m.index,e:m.index+m[0].length,rep:enc(m[1]+' 0 0 '+m[2]+' '+m[3]+' '+num(y+sh)+' Tm')}); }
  // affine cm transforms (photos incl rotated, badges): shift the ty (group 6). skip delSpans
  let re2=/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g;
  while((m=re2.exec(s))){ if(inDel(m.index)) continue; const y=parseFloat(m[6]); const sh=shiftFor(y); if(!sh) continue;
    ops.push({s:m.index,e:m.index+m[0].length,rep:enc(m[1]+' '+m[2]+' '+m[3]+' '+m[4]+' '+m[5]+' '+num(y+sh)+' cm')}); }
  // rectangles (clip tiles, SPECIALS bars, dividers): shift y. skip full-page (|h|>400) & delSpans
  let re3=/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g;
  while((m=re3.exec(s))){ if(inDel(m.index)) continue; const y=parseFloat(m[2]), h=parseFloat(m[4]); if(Math.abs(h)>400) continue; const sh=shiftFor(y+h/2); if(!sh) continue;
    ops.push({s:m.index,e:m.index+m[0].length,rep:enc(m[1]+' '+num(y+sh)+' '+m[3]+' '+m[4]+' re')}); }
  return ops;
}
const enc=s=>new TextEncoder().encode(s);
const escPdf=s=>(s||'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
function esc(s){return (s+'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
const num=n=>{ let s=(+n).toFixed(2).replace(/0+$/,'').replace(/\.$/,''); return s||'0'; };
function fontNote(chars){ let n=document.getElementById('fontnote'); if(!n)return; n.textContent='“'+chars+'” isn’t in this menu’s font — can’t print'; n.classList.add('on'); clearTimeout(n._t); n._t=setTimeout(()=>n.classList.remove('on'),2400); }
function cleanField(v, role){ const al=(FM.allowed&&FM.allowed[role])||''; let out='',drop=''; for(const ch of v){ if(al.indexOf(ch)>=0) out+=ch; else drop+=ch; } if(drop.replace(/\s/g,'')) fontNote(drop.replace(/\s+/g,' ').trim().split('').join(' ')); return out; }


function fontNote(chars){ let n=document.getElementById('fontnote'); if(!n)return; n.textContent='“'+chars+'” isn’t in this menu’s font'; n.classList.add('on'); clearTimeout(n._t); n._t=setTimeout(()=>n.classList.remove('on'),2400); }
function cleanField(v, role){ const al=(FM.allowed&&FM.allowed[role]); if(al==null) return v; let out='',drop=''; for(const ch of v){ if(al.indexOf(ch)>=0||ch===' ') out+=ch; else drop+=ch; } if(drop.replace(/\s/g,'')) fontNote(drop.replace(/\s+/g,' ').trim().split('').join(' ')); return out; }
function greedyWrap(words,mc){ const L=[];let c='';const m=Math.max(1,mc|0);for(let w of words){while(w.length>m){if(c){L.push(c);c='';}L.push(w.slice(0,m));w=w.slice(m);}if(!w)continue;if(!c)c=w;else if((c+' '+w).length<=m)c+=' '+w;else{L.push(c);c=w;}}if(c)L.push(c);return L; }
const K=(p,i,f)=>p+':'+i+':'+f;
const K0=(p,i)=>p+':'+i;
function val(p,i,f,orig){ const k=K(p,i,f); return (k in edits)?edits[k]:orig; }

function priceStamp(pos, v){ return '\nq BT '+FM.price_font+' '+num(FM.price_size)+' Tf 0 0 0 rg '+num(pos.x)+' '+num(pos.y)+' Td ('+escPdf(v)+')Tj ET Q\n'; }

// ---- MARKERS: stamp J / dairy / gluten like the food menu ----
// reposition+scale a vector icon: replace its own cm origin with (tx,ty), scale by s
// dx/dy are offsets in the icon's OWN coordinate space, so they scale with the art. This is a
// no-op for micons (every dairy/gluten part is dx:0,dy:0) but load-bearing for any multi-part
// program — newbadge has three lettered parts hanging off the starburst.
function iconStamp(parts, tx, ty, s){ let out=''; for(const p of parts){
  const b=p.bytes.replace(/1 0 0 1 -?[\d.]+ -?[\d.]+ cm/, num(s)+' 0 0 '+num(s)+' '+num(tx+(p.dx||0)*s)+' '+num(ty+(p.dy||0)*s)+' cm');
  out+=(p.color||((FM.jmark&&FM.jmark.color||'0 0 0 1')+' k'))+' '+b+'\n'; } return out; }
function iconW(parts){ const body=(parts[0].bytes.split('cm')[1]||''); const ns=(body.match(/-?[\d.]+/g)||[]).map(Number); const xs=ns.filter((_,i)=>i%2===0); return xs.length? Math.max(...xs)-Math.min(...xs):5; }
// the current marker set for an existing drink (override if edited, else the baked defaults)
function drinkMarkerSet(mp, idx, it){ const k=K0(mp,idx); if(k in markerEdits) return new Set(markerEdits[k]);
  const s=new Set(); if(it.marker) s.add('jain'); if(it.dairy_span) s.add('dairy'); return s; }
// promo art: red NEW starburst beside the name, red SPECIALS bar across the photo's bottom edge.
// Override if toggled, else whatever the designer baked in.
function drinkBadge(mp, idx, it){ const k=K0(mp,idx); return (k in badgeEdits)? !!badgeEdits[k] : !!it.badge; }
function drinkSpecials(mp, idx, it){ const k=K0(mp,idx); return (k in specialsEdits)? !!specialsEdits[k] : !!it.specials; }
// stamp a marker cluster (dairy, gluten, then J) packed left-to-right from anchor [ax,ay]
// ---- MULTI-LINE NAMES: honour manual line breaks; keep markers below the whole title ----
function nameLines(str){
  let L=String(str==null?'':str).toUpperCase().split(/\r?\n/).map(x=>x.replace(/\s+$/,''));
  while(L.length>1 && !L[L.length-1]) L.pop();      // drop trailing blank lines
  return L.length?L:[''];
}
const _ngCache={};
function nameGeomOf(it, PT){                          // parse the baked name block: size, x, first-line y, Td leading
  if(it._ng) return it._ng;
  const s0=it.name_spans[0][0], bt=PT.lastIndexOf('BT',s0), seg=PT.slice(bt,s0);
  const re=/([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g; let m=null,last=null;
  while((last=re.exec(seg))) m=last;                  // the LAST Tm before the first span is ours
  const size=m?parseFloat(m[2]):12.9512, x0=m?parseFloat(m[3]):9.15;
  let lead=-1.2;
  if(it.name_spans.length>=2){ const t=/0 (-?[\d.]+) Td/.exec(PT.slice(it.name_spans[0][1], it.name_spans[1][0])); if(t) lead=parseFloat(t[1]); }
  // byte range of that Tm operator, so a grown name can be re-anchored higher up the row
  const tm = m? {s:bt+m.index, e:bt+m.index+m[0].length, txt:m[0], y:parseFloat(m[4])} : null;
  return it._ng={size, x0, topY:it.top_y, lead, tm};
}
/* The row budget below replaces an earlier local attempt that measured `pitch - content_h`.
   That was wrong: content_h is a SYNTHETIC estimate the builder derives for add-slot maths
   (reflow_data.py:109) -- a flat +10pt per row, +6 more for a description, both line heights
   rounded up -- so on AHM MANGO PICANTE it claimed 49.6pt of content in a 66.1pt row while the
   artwork really leaves 30.5pt clear above the name. `photo_tile` is the row TRUE box, which is
   also where reflow_data.py:138-144 derives `pitch` from and where the divider rules are drawn. */
/* ---- NAME FITTING (ported from production) ---------------------------------------------------
   This subsystem shipped live on 2026-07-15 (ee8c6ef1) and never reached the repository, while the
   repository grew its own answer to the same problem. Live's is adopted because it is production-
   proven AND strictly richer: it wraps long names automatically instead of requiring the user to
   type line breaks, reserves the marker cluster's width so a wrap cannot run under the icons, and
   handles baked icons the fieldmap never captured. It already measured the row from `photo_tile`,
   which is the same source of truth the local fix independently arrived at, so the two agree on
   geometry and only differ in reach. The local `rowHeadroom`/`rowTopInk` pair is retired here.   */
const NAME_ADV=0.6383;   // measured AO-Mono advance. 0.63 under-measures by ~1pt over 6 glyphs,
                         // which pulled the marker cluster back INTO the last letter.
const MIN_MARK_GAP=2.2;  // minimum visual clearance between a title and its first marker
const ICON_LEFT_PAD=2.8; // dairy/gluten vectors paint ~2.8pt LEFT of their cm origin; without
                         // this the leading icon lands back on the last letter of the title
function bakedLastLine(it, PT){         // text of the baked final name line, for gap calibration
  const sp=it.name_spans[it.name_spans.length-1];
  const m=/^\((.*)\)Tj$/.exec(PT.slice(sp[0],sp[1]));
  return m? m[1].replace(/\\([()\\])/g,'$1') : '';
}
/* Some drinks carry baked icons the fieldmap never captured (MANGO PICANTE's chillies, etc.): they
   sit AFTER the J and are covered by no span, so a rename left them stranded on top of the new
   name. Find them so they can ride along with the marker cluster. */
function strayRowIcons(it, PT){
  if(it._sri) return it._sri;
  const band = it.photo_tile ? [it.photo_tile[1], it.photo_tile[1]+it.photo_tile[3]]
                             : [it.top_y-50, it.top_y+20];
  /* MERGE NOTE: live excluded only marker_span/dairy_span here, because live has no NEW-badge or
     SPECIALS subsystem — that is unshipped local work. Locally those spans ARE deleted and
     restamped, and the badge's own `cm` sits at x≈126 inside this scan window, so without excluding
     them a badge is mistaken for a stray icon and gets an op inside a range that is also being
     deleted. spliceBytes assumes non-overlapping ops, so that corrupted the stream from that point
     on ("syntax error: unknown keyword" and every dish below vanishing). */
  const covered=[it.marker_span, it.dairy_span, it.badge_span,
                 it.specials_span, it.specials_text_span, it.photo_span].filter(Boolean);
  const re=/q\s+1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/g; let m; const out=[];
  while(m=re.exec(PT)){
    const x=+m[1], y=+m[2];
    if(y<band[0]||y>band[1]||x<12||x>180) continue;
    if(covered.some(sp=>sp[0]<=m.index&&m.index<sp[1])) continue;   // dairy/J are restamped already
    out.push({x, y, numStart:m.index+m[0].indexOf(m[1]), numEnd:m.index+m[0].indexOf(m[1])+m[1].length});
  }
  return it._sri=out;
}
// widest x the marker cluster reaches, relative to the baked name end — reserved when wrapping
function markerReserve(it, PT, g){
  const icons=strayRowIcons(it,PT);
  const bakedRight=g.x0+bakedLastLine(it,PT).replace(/\s+$/,'').length*NAME_ADV*g.size;
  let far=(it.mk_anchor? it.mk_anchor[0] : bakedRight)+4;
  for(const ic of icons) far=Math.max(far, ic.x+5);
  return Math.max(0, far-bakedRight);
}
// Locate the x-number inside a baked span so it can be nudged in place.
function numSpanIn(PT, span, re){
  const seg=PT.slice(span[0],span[1]); const m=re.exec(seg);
  if(!m) return null;
  const i=span[0]+m.index+m[0].indexOf(m[1]);
  return {s:i, e:i+m[1].length, v:parseFloat(m[1])};
}
/* The artwork packs a few markers hard against the title (Surat's COLADA clears the "A" by 0.65pt,
   so it reads as overlapping). Where the baked gap is under MIN_MARK_GAP, slide the whole baked
   cluster right — icons AND the J AND any stray badge — leaving everything else as-is. */
function tidyMarkerOps(it, PT, sh){
  if(!it.name_spans || !it.name_spans.length) return [];
  const g=nameGeomOf(it,PT);
  const nameEnd=g.x0+bakedLastLine(it,PT).replace(/\s+$/,'').length*NAME_ADV*g.size;
  const parts=[];
  if(it.dairy_span){ const n=numSpanIn(PT,it.dairy_span,/q 1 0 0 1 (-?[\d.]+) /); if(n) parts.push({n, vis:n.v-ICON_LEFT_PAD}); }
  if(it.marker_span){ const n=numSpanIn(PT,it.marker_span,/[\d.]+ 0 0 [\d.]+ (-?[\d.]+) -?[\d.]+ Tm/); if(n) parts.push({n, vis:n.v}); }
  for(const ic of strayRowIcons(it,PT)) parts.push({n:{s:ic.numStart,e:ic.numEnd,v:ic.x}, vis:ic.x-ICON_LEFT_PAD});
  if(!parts.length) return [];
  const gap=Math.min.apply(null,parts.map(p=>p.vis))-nameEnd;
  if(!(gap<MIN_MARK_GAP)) return [];
  const d=MIN_MARK_GAP-gap;
  return parts.map(p=>({s:p.n.s, e:p.n.e, rep:enc(num(p.n.v+d))}));
}
/* How many lines this drink's NAME can show: extra lines grow UPWARD from the baked last line,
   bounded by the row's own top (the photo band), so they never touch the row above. */
function nameRoom(it, g){
  const B=it.name_spans.length, lh=Math.abs(g.lead)*g.size;
  const rowTop = it.photo_tile ? it.photo_tile[1]+it.photo_tile[3]
                               : (it.top_y!=null ? it.top_y+(it.pitch||FM.row_h||60)-14 : null);
  if(rowTop==null) return Math.max(B,1);
  const bakedBaseY = g.topY-(B-1)*lh;
  const extra = Math.floor((rowTop - bakedBaseY - g.size*0.78)/lh);
  return Math.max(B, Math.min(3, B+Math.max(0,extra)));
}
// Wrap a name to the text column (the photo rail starts at x=181) without breaking words.
function nameWrap(lines, g, maxLines, reserve){
  const perLine=Math.max(4, Math.floor((176-g.x0-(reserve||0))/(NAME_ADV*g.size)));
  const out=[];
  for(const ln of lines){
    if(ln.length<=perLine){ out.push(ln); continue; }
    let cur='';
    for(const w of ln.split(/\s+/).filter(Boolean)){
      if(!cur) cur=w;
      else if((cur+' '+w).length<=perLine) cur+=' '+w;
      else { out.push(cur); cur=w; }
    }
    if(cur) out.push(cur);
  }
  // Never DROP text: if it needs more lines than the row can hold, fold the remainder into the
  // last allowed line (it may run wide, and the card warns) rather than silently losing words.
  const cap=Math.max(1,maxLines);
  if(out.length>cap){ const tail=out.slice(cap-1).join(' '); return out.slice(0,cap-1).concat([tail]); }
  return out;
}
// The name lines a drink will actually RENDER (explicit breaks + wrap, capped by room).
function renderedNameLines(it, PT, raw){
  const g=nameGeomOf(it,PT);
  return nameWrap(nameLines(raw), g, nameRoom(it,g), markerReserve(it,PT,g));
}
// kept as the public name for "how many lines fit", now answered by nameRoom()
function nameCapacity(it, PT){
  const B=(it.name_spans||[]).length; if(!B) return 0;
  return nameRoom(it, nameGeomOf(it,PT));
}
/* The clamp in regenerate() and the warning in validate() need the same ceiling as nameRoom(), but
   expressed in POINTS of upward rise rather than a line count — the block also rises when the
   DESCRIPTION grows, which a line count cannot express.
   One deliberate difference from live's nameRoom(): it reserves only cap height (`size*0.78`), but
   the topmost ink on a row is usually not the name — the marker cluster and NEW badge ride the
   first line `raise` above its baseline, and across these two menus `raise` runs 5.85-8.61pt, so a
   J sits ~4pt higher than the letters it labels. Reserve whichever is taller, or a row that
   saturates its budget pushes the J through the divider rule drawn at the tile top. Verified by
   render; pinned by the MANGO PICANTE row-box regression case. */
function nameRoomFree(it, PT){
  const g=nameGeomOf(it,PT);
  const rowTop = it.photo_tile ? it.photo_tile[1]+it.photo_tile[3]
                               : (it.top_y!=null ? it.top_y+(it.pitch||FM.row_h||60)-14 : null);
  if(rowTop==null || it.top_y==null)
    return (it.pitch!=null&&it.content_h!=null)? it.pitch-it.content_h : 0;   // no tile -> old estimate
  let asc=g.size*0.78;                                    // live's cap-height reserve
  if(it.mk_anchor){
    const B=(it.name_spans||[]).length, lh=Math.abs(g.lead)*g.size;
    const raise=it.mk_anchor[1]-(it.top_y-(B-1)*lh);
    asc=Math.max(asc, raise + 0.67*((FM.jmark&&FM.jmark.size)||g.size));
  }
  return (rowTop - asc) - g.topY;
}
/* Where the marker cluster starts for an EDITED name (after its true last line).
   Local keeps the `y0` parameter — rowLayout() moves the whole block when the description changes
   length, and the markers have to follow it — while adopting live's self-calibrated horizontal pad:
   the distance between this drink's baked last line and its baked anchor IS the designer's intended
   spacing, so reuse it at the new length instead of a fixed 2.4pt. */
function editedNameAnchor(it, nl2, PT, y0){
  const g=nameGeomOf(it,PT), B=it.name_spans.length;
  const M=Math.min(nl2.length, Math.max(B, nameCapacity(it,PT)));   // grown names count too
  const lh=Math.abs(g.lead)*g.size, lastLen=(nl2[M-1]||'').length;
  // a grown name is raised by (M-B)*lh and drawn downward, so its LAST line lands back on the baked
  // baseline — markers and the badge therefore keep their original y.
  const _top=(y0!=null?y0:g.topY);
  const baseY=_top-(Math.min(M,B)-1)*lh, bakedBaseY=g.topY-(B-1)*lh;
  const raise=(it.mk_anchor?it.mk_anchor[1]:bakedBaseY+5.9)-bakedBaseY;
  const bakedRight=g.x0+bakedLastLine(it,PT).replace(/\s+$/,'').length*NAME_ADV*g.size;
  const pad=Math.max(1.0, it.mk_anchor? (it.mk_anchor[0]-bakedRight) : 4.9);
  return [ g.x0 + lastLen*NAME_ADV*g.size + pad, baseY+raise ];
}
/* ---- NEW BADGE placement -------------------------------------------------------------------
   The badge sits to the RIGHT of the whole marker cluster, so a marker edit moves it exactly like
   a rename does: adding dairy+gluten to MANGO PICANTE pushes the cluster to x=132.2 while the
   baked badge's left edge is 126.5 — a 5.7pt overlap if we didn't restamp. Hence regenerate()
   deletes+restamps on EITHER a name edit or a marker edit.
   x/y are measured off the name (via editedNameAnchor / mk_anchor), not off mk_anchor's y alone:
   marker_data.py synthesises `last_y+5.9` for markerless drinks, which is a guess.            */
function badgePlace(it, mp, idx, set, PT, y0){
  const C=FM.mk_const, P=FM.micons&&FM.micons.newbadge; if(!P) return null;
  const W=iconW(P);
  const nameEd=(K(mp,idx,'name') in edits);
  const nl2=nameEd? renderedNameLines(it,PT,edits[K(mp,idx,'name')]) : null;
  const a=nameEd? editedNameAnchor(it,nl2,PT,y0) : (it.mk_anchor||[9.15, it.top_y]);
  let x=a[0] + markerRunW(set) + (C.gap_badge!=null?C.gap_badge:3.23);
  // never let a long name push the badge under the photo column
  const rail=((it.photo_tile? it.photo_tile[0] : 181) - W - 1);
  const clamped=(x>rail); if(clamped) x=rail;
  const g=nameGeomOf(it,PT), B=it.name_spans.length;
  const M=nl2? Math.min(nl2.length,B) : B;
  const baseY=(y0!=null?y0:g.topY)-(M-1)*Math.abs(g.lead)*g.size;
  return {x:x, y:baseY+(C.dy_badge!=null?C.dy_badge:8.54), clamped:clamped};
}
// iconStamp places part 0's ORIGIN; the art extends leftwards, so add iconW to land its LEFT edge at bx.
function badgeStamp(bx, by){ const P=FM.micons&&FM.micons.newbadge; if(!P) return '';
  return '\nq\n'+iconStamp(P, bx+iconW(P), by, 1)+'Q\n'; }
/* ---- SPECIALS bar --------------------------------------------------------------------------
   Geometry is derived from photo_tile, never from page-1 constants: ahm pages 2/3 use 112.2-wide
   tiles, not 99.6. Returns null for a drink with no photo (ahm LEMON ICED TEA) — nowhere to put it. */
function specialsPlace(it){
  if(it.specials_geom && it.specials_text_pos) return {g:it.specials_geom.slice(), t:it.specials_text_pos.slice()};
  const t=it.photo_tile; if(!t) return null;
  const S=(FM.mk_const&&FM.mk_const.spec)||{};
  const h=S.h!=null?S.h:8.177, size=S.text_size!=null?S.text_size:5;
  const g=[t[0], t[1], t[2], h];
  const adv=8*((S.text_adv!=null?S.text_adv:0.63)*size + (S.text_tc!=null?S.text_tc:0.025));
  return {g:g, t:[g[0]+g[2]-(S.text_right_pad!=null?S.text_right_pad:3.149)-adv,
                  g[1]+(S.text_dy!=null?S.text_dy:2.13)]};
}
function specialsStamp(p, sh, boldFont){
  const S=(FM.mk_const&&FM.mk_const.spec)||{}, C=(FM.jmark&&FM.jmark.color)||'0 0 0 1';
  const size=S.text_size!=null?S.text_size:5;
  return '\nq\n'+C+' k\n'+num(p.g[0])+' '+num(p.g[1]+sh)+' '+num(p.g[2])+' '+num(p.g[3])+' re\nf\nQ\n'
       + '\nq\nBT\n0 0 0 0 k\n/'+boldFont+' 1 Tf\n'+num(S.text_tc!=null?S.text_tc:0.025)+' Tc '
       + num(S.text_tw!=null?S.text_tw:-0.025)+' Tw '+num(size)+' 0 0 '+num(size)+' '
       + num(p.t[0])+' '+num(p.t[1]+sh)+' Tm\n(SPECIALS)Tj\nET\nQ\n';
}
// fit N typed lines into B baked spans: keep the first B-1, merge any overflow words into the last
function nameToSpans(nl, B){
  if(nl.length<=B){ const o=nl.slice(); while(o.length<B) o.push(''); return o; }
  const head=nl.slice(0,B-1), tail=nl.slice(B-1).join(' ');
  return head.concat([tail]);
}
// ---- DESCRIPTIONS: honour manual line breaks; keep the inline volume glued to the last line ----
// The volume ([300ML]) is not its own column — it renders at the END of the description's last
// line, inside the same BT..ET block. So it must be re-placed whenever the description re-wraps,
// not only when the volume itself is edited. desc_geom / vol_* are baked into the fieldmap by
// src/capdrinks/vol_data.py.
const DESC_MC=32;                                   // chars per description line
const DESC_ADV=0.63;                                // AOMono advance (em) — /Widths is [0,630]
function descAdvance(g, s){ s=s||'';
  const spaces=s.length-s.replace(/ /g,'').length;
  return s.length*(DESC_ADV*g.th + g.tc*g.th) + spaces*g.tw*g.th; }
// manual breaks first, then greedy-wrap each resulting paragraph
function descLines(str, mc){
  const out=[];
  String(str==null?'':str).split(/\r?\n/).forEach(p=>{
    const w=greedyWrap(p.split(/\s+/).filter(Boolean), mc);
    if(w.length) out.push.apply(out,w); else out.push('');
  });
  while(out.length>1 && !out[out.length-1]) out.pop();
  return out.length?out:[''];
}
// lines a drink can show: the baked span count plus whatever fits in the gap below its content
function descCapacity(it){
  const B=(it.desc_spans||[]).length, g=it.desc_geom;
  if(!B||!g) return B;
  const lineH=Math.abs(g.lead)*g.size;
  const free=(it.pitch!=null&&it.content_h!=null)? it.pitch-it.content_h : 0;
  return B + Math.max(0, Math.floor((free-2)/lineH));      // 2pt safety margin
}
/* ---- ROW LAYOUT: the single owner of vertical placement -------------------------------------
   Measured from the artwork: every row holds exactly THREE text lines (name lines + description
   lines) and is BOTTOM-ANCHORED, with the price sitting level with the last line —
     LEMON ICED TEA  2 name + 1 desc,  RED BULL  3 name + 0 desc,  everything else  1 name + 2 desc.
   So the row is laid out from the bottom UP, starting from the baked last description line, which
   is the one thing that never moves (it is where the price already is). A shorter description
   therefore pulls the heading DOWN to meet the price rather than stranding it; a longer one, or a
   wrapped name, pushes the heading UP into the row's free space.
   Everything vertical goes through here — do not re-add per-feature y offsets alongside it. */
function descTmOf(it, PT){
  if(it._dtm!==undefined) return it._dtm;
  if(!it.desc_spans||!it.desc_spans.length) return it._dtm=null;
  const s0=it.desc_spans[0][0], bt=PT.lastIndexOf('BT',s0), seg=PT.slice(bt,s0);
  const re=/([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g; let m=null,last=null;
  while((last=re.exec(seg))) m=last;
  return it._dtm = m? {s:bt+m.index, e:bt+m.index+m[0].length, txt:m[0], y:parseFloat(m[4])} : null;
}
// nN / nD = the line counts we are about to RENDER. Returns the baselines to draw at.
function rowLayout(it, PT, nN, nD){
  const B=(it.name_spans||[]).length, D=(it.desc_spans||[]).length;
  const ng=nameGeomOf(it,PT), dg=it.desc_geom;
  const nlh=Math.abs(ng.lead)*ng.size;
  // No description: the name itself owns the row's last line (the price rides it), so anchor on the
  // baked name's LAST baseline exactly as the branch below does. `ng.topY` is its FIRST baseline —
  // anchoring there made a baked 3-line name (RED BULL/GINGER ALE/PERRIER) report a 31pt rise for
  // its own unchanged line count, which tripped the clamp on every rename of those rows.
  if(!D||!dg) return {nameY0:(ng.topY-(B-1)*nlh)+(Math.max(1,nN)-1)*nlh, descY0:null, nlh:nlh, dlh:0};
  const dlh=Math.abs(dg.lead)*dg.size;
  const descLastY=dg.y0-(D-1)*dlh;                 // pinned: the price's own baseline
  const gap=(ng.topY-(B-1)*nlh)-dg.y0;             // baked name-to-description gap, per row
  const descY0 = nD? descLastY+(nD-1)*dlh : null;
  const nameLastY = nD? descY0+gap : descLastY;    // no description -> the name takes the last line
  return {nameY0:nameLastY+(Math.max(1,nN)-1)*nlh, descY0:descY0, nlh:nlh, dlh:dlh};
}
// rendered lines for an EDITED drink (null if untouched — untouched bytes are never respliced)
function descRender(mp, idx, it){
  const B=(it.desc_spans||[]).length;
  if(!B || !(K(mp,idx,'desc') in edits)) return null;
  const cap=Math.max(1,descCapacity(it));
  let L=descLines(edits[K(mp,idx,'desc')], DESC_MC);
  const joined=L.length>cap;      // more lines typed than this drink has room for
  // merge rather than drop: an over-long line is visibly wrong in the preview, a silently
  // truncated one is not. validate() reports both cases.
  if(joined) L=L.slice(0,cap-1).concat([L.slice(cap-1).join(' ')]);
  return {lines:L, joined:joined, wide:L.some(l=>l.length>DESC_MC), cap:cap, baked:B};
}
// where the volume sits given the rendered description lines
// y0 overrides the baked description origin — rowLayout moves the whole block, and the volume
// rides its LAST line, so it has to be measured from where the block actually lands.
function volPlace(it, lines, y0){
  const g=it.desc_geom;
  if(!g||!lines||!lines.length) return {x:it.vol_pos.x, y:it.vol_pos.y};
  const li=lines.length-1;
  // Never let the volume touch the text. Some drinks bake their separation as a trailing space
  // INSIDE the description ("ginger "), which retyping strips — vol_gap is then ~0 and the
  // volume would butt straight up against the last word. Others use a real gap, which already
  // measures one space wide, so taking the larger of the two is right in both cases.
  const gap=Math.max(it.vol_gap||0, descAdvance(g,' '));
  return { x: g.x0+(g.dx||0)+descAdvance(g,lines[li])+gap,
           y: (y0!=null?y0:g.y0)+g.lead*g.size*li };
}
// fallback for volumes whose digits are missing from the subset font (1, 7 and 9 are absent),
// mirroring priceStamp. Re-states the fill colour: the stamp lands at the end of the stream,
// far from the BT..ET block the baked volume inherited its colour from.
function volStamp(pos, col, v){ return '\nq '+(col||'0 0 0 rg')+' BT '+FM.price_font+' '+num(pos.size||5)+' Tf '+num(pos.x)+' '+num(pos.y)+' Td ('+escPdf(v)+')Tj ET Q\n'; }
// Width of ONE marker slot including its trailing gap. Single source of truth: stampMarkers packs
// the cluster with it and badgePlace measures past the cluster with it, so the two can never drift.
function mkSlotW(t){ const MIC=FM.micons, C=FM.mk_const, J=FM.jmark; if(!MIC||!C) return 0;
  if(t==='dairy')  return iconW(MIC.dairy)*C.scale + C.gap;
  if(t==='gluten') return iconW(MIC.gluten)*C.scale + C.gap;
  if(t==='jain')   return (C.w_j!=null?C.w_j:0.63)*J.size + C.gap;   // AOMonoBlack /Widths = [630]
  return 0; }
function markerRunW(set){ let w=0; for(const t of ['dairy','gluten','jain']) if(set&&set.has(t)) w+=mkSlotW(t); return w; }
function stampMarkers(ax, ay, set){ const J=FM.jmark, MIC=FM.micons, C=FM.mk_const; if(!J||!MIC||!C||!set.size) return '';
  const s=C.scale; let out='\nq\n', ix=ax;
  if(set.has('dairy')){ out+=iconStamp(MIC.dairy, ix, ay+(C.dy_dairy||0), s); ix+=mkSlotW('dairy'); }
  if(set.has('gluten')){ out+=iconStamp(MIC.gluten, ix, ay+(C.dy_gluten||0), s); ix+=mkSlotW('gluten'); }
  if(set.has('jain')){ out+='BT '+J.color+' k '+J.font+' 1 Tf 0 Tc 0 Tw '+num(J.size)+' 0 0 '+num(J.size)+' '+num(ix)+' '+num(ay+(C.dy_j||0))+' Tm (J)Tj ET\n'; }
  out+='Q\n'; return out; }
// collapse duplicate / overlapping byte ranges into a minimal disjoint set
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
function spliceBytes(src, ops){ ops=ops.slice().sort((a,b)=>a.s-b.s); let L=src.length+ops.reduce((d,o)=>d+(o.rep.length-(o.e-o.s)),0); const out=new Uint8Array(L); let si=0,oi=0; for(const o of ops){ out.set(src.subarray(si,o.s),oi);oi+=o.s-si; out.set(o.rep,oi);oi+=o.rep.length; si=o.e; } out.set(src.subarray(si),oi); return out; }

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
  const rowH=FM.row_h||60;
  /* Has the user changed ANYTHING? Gates the baked-artwork tidy pass below, so a pristine export
     stays byte-for-byte identical to the source PDF.
     Test VALUES, not key presence: buildEditor() seeds reorder[page] with an identity permutation
     for every page it draws, and added[page] can be an empty array — treating either as "edited"
     made a no-op export nudge markers and lose byte identity. */
  const _some = o => Object.values(o||{}).some(v => Array.isArray(v) ? v.length>0 : v!=null);
  const _anyEdit = _some(edits) || _some(markerEdits) || _some(badgeEdits) ||
                   _some(specialsEdits) || _some(photoUploads) || removed.size>0 ||
                   Object.values(added||{}).some(a=>a&&a.length>0) ||
                   Object.values(reorder||{}).some(r=>(r||[]).some((v,i)=>v!==i));
  for(const mp of FM.menu_pages){
    const ps=pageStreams[mp]; const pageData=FM.pages.find(p=>p.page===mp);
    const PT=new TextDecoder('latin1').decode(ps.pristine);
    let ops=[]; let append='';
    const getOrigIdx=slotIdx=>(reorder[mp]&&reorder[mp][slotIdx]!=null)?reorder[mp][slotIdx]:slotIdx;
    // 1) removed drinks: collect delete spans + tops
    const delSpans=[]; const removedTops=[];
    pageData.items.forEach((it,idx)=>{ const origIdx=getOrigIdx(idx); if(!removed.has(K0(mp,origIdx))) return;
      (it.name_spans||[]).forEach(sp=>delSpans.push(sp)); (it.desc_spans||[]).forEach(sp=>delSpans.push(sp));
      if(it.price_span)delSpans.push(it.price_span); if(it.vol_span)delSpans.push(it.vol_span);
      // dairy_span too: on ahm pages 2-3 nine milk icons are in NO extra_spans, so removal used to
      // leave them floating. mergeSpans absorbs the overlap when it IS also in extra_spans.
      if(it.marker_span)delSpans.push(it.marker_span); if(it.photo_span)delSpans.push(it.photo_span);
      if(it.dairy_span)delSpans.push(it.dairy_span);
      (it.extra_spans||[]).forEach(sp=>delSpans.push(sp));
      if(it.top_y!=null) removedTops.push({y:it.top_y, pitch:(it.pitch||rowH)});
    });
    const volSkip=[];
    // Vertical layout for every touched row, decided BEFORE reflowOps runs so the Tm ranges we are
    // about to rewrite can be excluded from it (two ops over one range corrupt spliceBytes). The
    // row shift `sh` is applied by hand below, the same pattern volumes use.
    const layout=new Map();
    pageData.items.forEach((it,idx)=>{
      const origIdx=getOrigIdx(idx); const isReordered=origIdx!==idx;
      if(removed.has(K0(mp,origIdx))||!it.name_spans||!it.name_spans.length) return;
      const origIt=pageData.items[origIdx];
      const nameEd=isReordered||(K(mp,origIdx,'name') in edits);
      const dr=descRender(mp,origIdx,origIt);
      if(!nameEd && !dr) return;                       // untouched rows are never respliced
      const B=it.name_spans.length, ng=nameGeomOf(it,PT);
      const typed=nameEd? renderedNameLines(it,PT,val(mp,origIdx,'name',origIt.name)) : null;
      let nN=typed? Math.min(typed.length, Math.max(B, nameCapacity(it,PT))) : B;   // `let`: the clamp below decrements it
      const nD=dr? dr.lines.filter(l=>l&&l.trim()).length : (it.desc_spans||[]).length;
      let L=rowLayout(it,PT,nN,nD);
      // nameCapacity and descCapacity each measure the row's headroom independently, so a grown
      // name AND a grown description can together rise past the row above. Merge name lines back
      // until the block fits rather than letting it collide.
      const free=nameRoomFree(it,PT);
      let clamped=false;
      while(nN>1 && (L.nameY0-ng.topY)>free+0.5){ nN--; clamped=true; L=rowLayout(it,PT,nN,nD); }
      const dtm=descTmOf(it,PT);
      // only rewrite a Tm that actually moves — the baked price-to-text relationship carries up to
      // 0.4pt of hand jitter, and an unedited row must stay byte-identical
      const moveN = ng.tm && Math.abs(L.nameY0-ng.tm.y)>0.5;
      const moveD = dtm && L.descY0!=null && Math.abs(L.descY0-dtm.y)>0.5;
      if(!moveN && !moveD && nN<=B) return;
      layout.set(idx,{L:L,nN:nN,nD:nD,B:B,typed:typed,ng:ng,dtm:dtm,moveN:moveN,moveD:moveD,clamped:clamped});
      if(moveN) volSkip.push([ng.tm.s,ng.tm.e]);
      if(moveD) volSkip.push([dtm.s,dtm.e]);
    });
    // marker-edited survivors: delete their baked J + baked dairy so we can restamp the chosen set.
    // Added to delSpans BEFORE reflow so reflowOps won't try to shift the (deleted) baked marks.
    pageData.items.forEach((it,idx)=>{
      const origIdx=getOrigIdx(idx); const isReordered=origIdx!==idx;
      if(removed.has(K0(mp,origIdx))) return;
      // ...and whenever rowLayout moves the name block: a desc-only edit can pull the heading
      // down, and a baked marker left at the old baseline would float above it
      const _lm=layout.get(idx);
      const touched=(K0(mp,origIdx) in markerEdits)||(K(mp,origIdx,'name') in edits)||isReordered||!!(_lm&&_lm.moveN);
      if(!touched) return;
      if(it.marker_span) delSpans.push(it.marker_span);
      if(it.dairy_span) delSpans.push(it.dairy_span);
    });
    // NEW badge / SPECIALS bar toggles on survivors. Everything here is DELETE + APPEND, never a
    // resplice in place, so reflowOps can't collide with us (append lands after spliceBytes).
    // NOTE the spans used: badge_span is the INNER art-only range, NOT the extra_spans group entry
    // — that group also holds the row dividers and the SPECIALS bar, which must survive a badge
    // toggle. keepState re-emits the white `0 0 0 0 scn` the dividers rely on. Removal still
    // deletes the whole group via extra_spans, which is why this loop skips removed drinks.
    pageData.items.forEach((it,idx)=>{
      const origIdx=getOrigIdx(idx); const origIt=pageData.items[origIdx]; const isReordered=origIdx!==idx;
      if(removed.has(K0(mp,origIdx))) return;
      const _nm=(K(mp,origIdx,'name') in edits)||isReordered, _mk=(K0(mp,origIdx) in markerEdits)||isReordered;
      const _bmv=!!(layout.get(idx)&&layout.get(idx).moveN);   // heading moved -> badge must follow
      if(it.badge_span&&(!drinkBadge(mp,origIdx,origIt)||_nm||_mk||_bmv)) delSpans.push(it.badge_span);
      // an uploaded photo is appended over photo_tile and would BURY a baked bar, so restamp it
      if(it.specials_span&&(!drinkSpecials(mp,origIdx,origIt)||photoUploads[K0(mp,origIdx)])){
        delSpans.push(it.specials_span);
        if(it.specials_text_span) delSpans.push(it.specials_text_span);
      }
    });
    // A drink's volume (and its dairy icon) is ALSO listed in extra_spans, so the raw delete list
    // can name the same bytes twice. spliceBytes assumes non-overlapping ops and runs its cursor
    // backwards if it ever meets an overlap, corrupting the stream — so merge before emitting.
    // keepState is computed over the MERGED range, never per original span: merged spans can nest
    // (removing MANGO PICANTE + MELON FRESCA nests [8859,8909] inside [7602,8911]), and per-span
    // replacement would emit overlapping ops -- exactly the corruption mergeSpans exists to prevent.
    for(const d of mergeSpans(delSpans)) ops.push({s:d[0],e:d[1],rep:enc(keepState(PT.slice(0,d[1])))});
    // Volumes we re-place ourselves must be hidden from reflowOps: it rewrites every Tm it sees,
    // and two ops covering one byte range would corrupt the stream in spliceBytes. We apply the
    // reflow shift to them by hand instead (see the volume block below).
    pageData.items.forEach((it,idx)=>{
      const origIdx=getOrigIdx(idx); const isReordered=origIdx!==idx;
      if(removed.has(K0(mp,origIdx))||!it.vol_span) return;
      if(isReordered||(K(mp,origIdx,'vol') in edits)||(K(mp,origIdx,'desc') in edits)) volSkip.push(it.vol_span);
    });
    // A name that needs more lines than the artwork baked is re-anchored by rewriting its block's
    // Tm (see the name splice below). That Tm must ALSO be hidden from reflowOps for the same
    // reason volumes are — decided here, before reflowOps runs, and the row shift is applied by hand.
    // 2) reflow survivors below removed drinks (shift by real heights)
    if(removedTops.length) ops=ops.concat(reflowOps(ps.pristine, removedTops, delSpans.concat(volSkip), rowH));
    const shiftOf=y=> removedTops.filter(t=>t.y>((y||0)+0.5)).reduce((a,t)=>a+t.pitch,0);
    // 3) text edits + prices for survivors
    pageData.items.forEach((it,idx)=>{
      const origIdx=getOrigIdx(idx); const origIt=pageData.items[origIdx]; const isReordered=origIdx!==idx;
      if(removed.has(K0(mp,origIdx))) return;
      const sh=shiftOf(it.top_y);
      // name: always splice when reordered; use origIt's content as baked fallback
      if((isReordered||K(mp,origIdx,'name') in edits)&&it.name_spans.length){
        const lay=layout.get(idx);
        if(lay && lay.typed && lay.nN>lay.B){
          // more typed lines than the artwork baked: draw them all, the surplus riding inside the
          // LAST baked span with the artwork's own leading (the technique the description uses)
          const {nN,B,typed,ng}=lay;
          const L=typed.slice(0,nN-1).concat([typed.slice(nN-1).join(' ')]);
          it.name_spans.forEach((sp,i)=>{
            let rep='('+escPdf(L[i]||'')+')Tj';
            if(i===B-1) for(let j=B;j<L.length;j++) rep+='\n0 '+num(ng.lead)+' Td\n('+escPdf(L[j])+')Tj';
            ops.push({s:sp[0],e:sp[1],rep:enc(rep)});
          });
        } else {
          const nl=nameToSpans(renderedNameLines(it,PT,val(mp,origIdx,'name',origIt.name)), it.name_spans.length);
          it.name_spans.forEach((sp,i)=>ops.push({s:sp[0],e:sp[1],rep:enc('('+escPdf(nl[i]||'')+')Tj')}));
        }
      }
      // re-anchor the row's blocks to the bottom-up layout (sh by hand: reflowOps skips these Tms)
      { const lay=layout.get(idx);
        if(lay&&lay.moveN) ops.push({s:lay.ng.tm.s,e:lay.ng.tm.e,
          rep:enc(lay.ng.tm.txt.replace(/(-?[\d.]+) Tm$/, num(lay.L.nameY0+sh)+' Tm'))});
        if(lay&&lay.moveD) ops.push({s:lay.dtm.s,e:lay.dtm.e,
          rep:enc(lay.dtm.txt.replace(/(-?[\d.]+) Tm$/, num(lay.L.descY0+sh)+' Tm'))});
      }
      // description: for a reordered slot with no edit, write origIt's baked desc into this slot's spans
      let _dr=K(mp,origIdx,'desc') in edits ? descRender(mp,origIdx,origIt) : null;
      if(_dr) _dr={..._dr, baked:it.desc_spans?it.desc_spans.length:_dr.baked};
      if(isReordered&&!_dr&&it.desc_spans&&it.desc_spans.length){
        const cap=Math.max(1,descCapacity(it));
        let L=descLines(origIt.desc||'',DESC_MC);
        if(L.length>cap) L=L.slice(0,cap-1).concat([L.slice(cap-1).join(' ')]);
        _dr={lines:L,joined:false,wide:L.some(l=>l.length>DESC_MC),cap:cap,baked:it.desc_spans.length};
      }
      if(_dr){
        const B=_dr.baked, L=_dr.lines, lead=it.desc_geom? it.desc_geom.lead : -1.2;
        for(let i=0;i<B;i++){
          let rep='('+escPdf(L[i]||'')+')Tj';
          // lines beyond the baked spans ride inside the LAST span, stepping down with the
          // artwork's own leading — the inter-span bytes that normally carry it aren't ours
          if(i===B-1) for(let j=B;j<L.length;j++) rep+='\n0 '+num(lead)+' Td\n('+escPdf(L[j])+')Tj';
          ops.push({s:it.desc_spans[i][0],e:it.desc_spans[i][1],rep:enc(rep)});
        }
      }
      // volume: re-placed when the description re-wraps, not just when the volume is edited
      if(it.vol_span&&it.vol_pos&&(isReordered||(K(mp,origIdx,'vol') in edits)||_dr)){
        const vv=val(mp,origIdx,'vol',origIt.vol)||'';
        const vtxt=vv?(origIt.vol_pre||'')+vv+(origIt.vol_suf||''):'';
        const _lay=layout.get(idx);
        let vp;
        if(_lay && _lay.nD===0){
          // description emptied: the volume has no line to ride, so it sits straight after the
          // NAME's last line — the way RED BULL/GINGER ALE/PERRIER[300ML] is drawn natively
          const _ng2=nameGeomOf(it,PT);
          const _nl=(_lay.typed||renderedNameLines(it,PT,origIt.name)).filter(Boolean);
          const _lastTxt=_nl[Math.min(_lay.nN,_nl.length)-1]||'';
          vp={ x:_ng2.x0 + _lastTxt.length*0.63*_ng2.size + 1.2,
               y:_lay.L.nameY0-(Math.max(1,_lay.nN)-1)*Math.abs(_ng2.lead)*_ng2.size };
        } else {
          vp=_dr?volPlace(it,_dr.lines,_lay&&_lay.L.descY0!=null?_lay.L.descY0:null):{x:it.vol_pos.x,y:it.vol_pos.y};
        }
        const va=(FM.allowed&&FM.allowed.desc)||'';
        const vfits=!!vtxt&&[...vtxt].every(c=>va.indexOf(c)>=0);
        if(vfits) ops.push({s:it.vol_span[0],e:it.vol_span[1],rep:enc('5 0 0 5 '+num(vp.x)+' '+num(vp.y+sh)+' Tm\n('+escPdf(vtxt)+')Tj')});
        else { ops.push({s:it.vol_span[0],e:it.vol_span[1],rep:enc(keepState(PT.slice(0,it.vol_span[1])))});
               if(vtxt) append+=volStamp({x:vp.x,y:vp.y+sh,size:it.vol_pos.size},origIt.vol_color||it.vol_color,vtxt); }
      }
      if(it.price_span){ const pv=val(mp,origIdx,'price',origIt.price);
        const pa=(FM.allowed&&FM.allowed.price)||'0235';
        const fits=[...(pv||'')].every(c=>pa.indexOf(c)>=0);
        // The price NEVER moves: rowLayout pins the description's last line to the baked
        // baseline the price already sits on, so the text comes to the price instead.
        if(fits){ if(isReordered||K(mp,origIdx,'price') in edits) ops.push({s:it.price_span[0],e:it.price_span[1],rep:enc('('+escPdf(pv)+')Tj')}); }
        else { ops.push({s:it.price_span[0],e:it.price_span[1],rep:enc('()Tj')}); if(it.price_pos&&pv) append+=priceStamp({x:it.price_pos.x,y:it.price_pos.y+sh,size:it.price_pos.size},pv); }
      }
      // uploaded photo -> draw over the drink's (shifted) tile; keyed by origIdx (photo belongs to the drink)
      const up=photoUploads[K0(mp,origIdx)];
      if(up&&it.photo_tile){ const t=it.photo_tile; append+=photoDrawOp(up,[t[0],t[1]+sh,t[2],t[3]]); }
      // Baked markers packed too tight against the title get nudged clear (artwork fix). Only for
      // rows we are NOT restamping below — a restamp already places the cluster from scratch — and
      // only once the menu has been touched at all: an export with NO edits must stay byte-identical
      // to the source, which is the cheapest corruption alarm this project has.
      // MERGE NOTE: live could tidy any untouched row, but locally a row that REFLOWS has its
      // marker `cm`/`Tm` numbers rewritten by the shift pass — the very numbers tidyMarkerOps
      // rewrites. Two ops over one range corrupt the stream (spliceBytes assumes non-overlap), so
      // a moving row keeps its baked spacing; the nudge is cosmetic and reflow is not.
      if(_anyEdit && !sh && !(K(mp,origIdx,'name') in edits) && !(K0(mp,origIdx) in markerEdits) && !isReordered){
        const _tidy=tidyMarkerOps(it, PT, sh)
          .filter(t=>!ops.some(o=>o.s<t.e && o.e>t.s));   // belt-and-braces: never double-write a range
        ops=ops.concat(_tidy);
      }
      // markers ALWAYS sit under the whole title: restamp when name OR marker set changed, or reordered
      const _nameEd=(K(mp,origIdx,'name') in edits)||isReordered;
      const _mkEd=(K0(mp,origIdx) in markerEdits)||isReordered;
      const _mvN=!!(layout.get(idx)&&layout.get(idx).moveN);   // rowLayout pulled the heading
      if((_nameEd||_mkEd||_mvN)&&it.mk_anchor){
        const set=(K0(mp,origIdx) in markerEdits)?new Set(markerEdits[K0(mp,origIdx)]):drinkMarkerSet(mp,origIdx,origIt);
        const _lg=layout.get(idx), _ly=_lg?_lg.L.nameY0:null;
        const a=_nameEd?editedNameAnchor(it,renderedNameLines(it,PT,val(mp,origIdx,'name',origIt.name)),PT,_ly):(_ly!=null?[it.mk_anchor[0],it.mk_anchor[1]+(_ly-nameGeomOf(it,PT).topY)]:it.mk_anchor);
        append+=stampMarkers(a[0],a[1]+sh,set);
        // Baked icons the fieldmap never captured (MANGO PICANTE's chillies, stray badges) sit after
        // the J under no span, so a rename left them stranded on top of the new title. Ride them
        // along by the same delta the cluster moved.
        if(_nameEd){ const dx=a[0]-it.mk_anchor[0];
          if(Math.abs(dx)>0.05) for(const ic of strayRowIcons(it,PT))
            ops.push({s:ic.numStart, e:ic.numEnd, rep:enc(num(ic.x+dx))});
        }
      }
      // ---- SPECIALS bar. Emitted AFTER photoDrawOp above so an upload can't bury it. ----
      if(drinkSpecials(mp,origIdx,origIt)&&(!it.specials_span||up)){
        const _sp=specialsPlace(it);
        if(_sp) append+=specialsStamp(_sp,sh,pageData.bold_font||'T1_0');
      }
      // ---- NEW badge. Restamped whenever the name or markers moved (it packs after the cluster). ----
      if(drinkBadge(mp,origIdx,origIt)&&(!it.badge_span||_nameEd||_mkEd||_mvN)){
        const _bs=(K0(mp,origIdx) in markerEdits)?new Set(markerEdits[K0(mp,origIdx)]):drinkMarkerSet(mp,origIdx,origIt);
        // an untouched drink that merely had its badge switched back on lands on the baked position
        if(it.badge_pos&&!_nameEd&&!_mkEd&&!_mvN) append+=badgeStamp(it.badge_pos[0],it.badge_pos[1]+sh);
        else { const _bl=layout.get(idx); const _bp=badgePlace(it,mp,origIdx,_bs,PT,_bl?_bl.L.nameY0:null); if(_bp) append+=badgeStamp(_bp.x,_bp.y+sh); }
      }
    });
    // 4) added drinks -> stack into the space freed below the LAST survivor's real content.
    const addList=added[mp]||[];
    if(addList.length){
      const rmSet=new Set([...removed].filter(k=>k.startsWith(mp+':')).map(k=>+k.split(':')[1]));
      const survs=pageData.items.map((it,idx)=>({it,idx})).filter(o=>!rmSet.has(o.idx)&&o.it.top_y!=null);
      // Rows are a UNIFORM strip (the photo grid) — a removal frees exactly one row at the bottom,
      // so new drinks drop straight onto the next grid row. (Text pitch varies with 1- vs 2-line
      // names and is NOT the row height — using it here is what left holes / overlaps.)
      const _pp=pageData.items.map(it=>it.pitch).filter(Boolean).sort((a,b)=>a-b);
      const ROW = _pp.length? _pp[Math.floor(_pp.length/2)] : rowH;   // median row (1st row can be an outlier)
      let lastTileY;
      if(survs.length){ const last=survs.reduce((a,b)=> a.it.top_y<=b.it.top_y? a:b);
        lastTileY = (last.it.photo_tile? last.it.photo_tile[1] : last.it.top_y-46) + shiftOf(last.it.top_y); }
      else lastTileY = ((pageData.items[0]&&pageData.items[0].photo_tile)? pageData.items[0].photo_tile[1]+ROW : 529.2+ROW);
      addList.forEach((dr,i)=>{ const tileY = lastTileY - ROW*(i+1); const by = tileY + 46; if(tileY>-2){ append+=stampNewDrink(pageData, by, dr);
        const up=photoUploads[mp+':add:'+i]; if(up) append+=photoDrawOp(up, [181.03, tileY, 99.6, 66]);
        const _nl=nameLines(dr.name).filter(Boolean); const _M=_nl.length||1;
        const _lastLen=(_nl[_M-1]||'').length;
        const _mkSet=new Set(dr.markers||[]);
        const _anchorX=9.5 + _lastLen*0.63*13 + 3.0;
        if(dr.markers && dr.markers.length) append+=stampMarkers(_anchorX, by - (_M-1)*15.6 + 5.9, _mkSet);
        // HARD RULE 6 parity: added drinks get the same promo art. Both use stampNewDrink's own
        // placeholder tile (181.03 × 99.6) so they line up with the slot it draws.
        if(dr.specials){
          const C=(FM.mk_const&&FM.mk_const.spec)||{}; const _h=C.h!=null?C.h:8.177, _sz=C.text_size!=null?C.text_size:5;
          const _adv=8*((C.text_adv!=null?C.text_adv:0.63)*_sz + (C.text_tc!=null?C.text_tc:0.025));
          append+=specialsStamp({g:[181.03, tileY, 99.6, _h],
                                 t:[181.03+99.6-(C.text_right_pad!=null?C.text_right_pad:3.149)-_adv,
                                    tileY+(C.text_dy!=null?C.text_dy:2.13)]}, 0, pageData.bold_font||'T1_0');
        }
        if(dr.badge && FM.micons && FM.micons.newbadge){
          const _C=FM.mk_const||{}, _W=iconW(FM.micons.newbadge);
          const _bx=Math.min(_anchorX + markerRunW(_mkSet) + (_C.gap_badge!=null?_C.gap_badge:3.23), 181.03-_W-1);
          append+=badgeStamp(_bx, by - (_M-1)*15.6 + (_C.dy_badge!=null?_C.dy_badge:8.54));
        }
      } });
    }
    let edited = ops.length ? spliceBytes(ps.pristine, ops) : ps.pristine.slice();
    if(append){ const ab=enc(append); const m=new Uint8Array(edited.length+ab.length); m.set(edited,0); m.set(ab,edited.length); edited=m; }
    ps.dict.set(PDFName.of('Length'), PDFNumber.of(edited.length));
    doc.context.assign(ps.ref, PDFRawStream.of(ps.dict, edited));
  }
  if(typeof QRK!=='undefined') QRK.apply(doc);   // QR codes: resize/move/remove/add (src/shared/qrtool)
  lastBytes=await doc.save({useObjectStreams:false}); try{MEM.tick();}catch(_){} try{MenuState.touch();}catch(_){}   // chucky-2
  return lastBytes;
}
function schedulePreview(){ clearTimeout(ptimer); ptimer=setTimeout(async()=>{ await regenerate(); renderPreview(); },320); }
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
// one box per visible drink row on page p, in PDF space (y up). Rows TILE the page, so bands
// are derived bottom-up from the photo grid — an item without a photo_tile (AHM's first row)
// still gets a correct, non-overlapping band instead of an oversized guess.
function pvBoxes(p){
  const pd=FM.pages.find(x=>x.page===p); if(!pd) return [];
  const rowH=FM.row_h||60;
  const H=(FM.page_sizes&&FM.page_sizes[p])? FM.page_sizes[p][1] : 595.28;
  const rmTops=[]; pd.items.forEach((it,idx)=>{ if(removed.has(K0(p,idx))&&it.top_y!=null) rmTops.push({y:it.top_y,pitch:(it.pitch||rowH)}); });
  const rise=y=> rmTops.filter(t=> t.y>((y||0)+0.5)).reduce((a,t)=>a+t.pitch,0);
  const band={}; let prevTop=0;
  pd.items.map((it,idx)=>({it,idx})).filter(o=>o.it.top_y!=null)
    .sort((a,b)=>a.it.top_y-b.it.top_y)                       // bottom of page first
    .forEach(({it,idx})=>{
      const t=it.photo_tile;
      const bot = t? t[1] : prevTop;
      const top = t? t[1]+t[3] : Math.min(H, bot+(it.pitch||rowH));
      prevTop=Math.max(prevTop,top); band[idx]={bot,top,right:(t? t[0]+t[2] : 275)};
    });
  const out=[];
  pd.items.forEach((it,idx)=>{
    if(removed.has(K0(p,idx)) || !band[idx]) return;
    const sh=rise(it.top_y), b=band[idx];
    out.push({id:K0(p,idx), x0:5, x1:b.right, top:b.top+sh, bot:b.bot+sh});
  });
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
    const base=page.getViewport({scale:1}); const scale=Math.min(avail/base.width,2.8);
    const vp=page.getViewport({scale:scale*window.devicePixelRatio});
    const cv=document.getElementById('preview'),cx=cv.getContext('2d');
    cv.width=vp.width;cv.height=vp.height;cv.style.width=(vp.width/window.devicePixelRatio)+'px';
    await page.render({canvasContext:cx,viewport:vp}).promise;
  }catch(e){ if(!(e&&String(e.message||e).includes('ancelled'))) console.error(e); }
  if(my===renderToken){ document.getElementById('busy').classList.remove('on'); try{ pvSync(); }catch(_){} }
}
function buildTabs(){ const t=document.getElementById('tabs'); t.innerHTML=''; FM.menu_pages.forEach((mp,i)=>{ const b=document.createElement('button'); b.dataset.pg=mp; b.textContent='Page '+(i+1); if(mp===activePage)b.classList.add('on'); b.onclick=()=>{ activePage=mp; buildEditor(); renderPreview(); }; t.appendChild(b); });
  // chucky-2: the shell's "Live preview — <page>" label follows the tab (the old page left it blank)
  const pt=document.getElementById('ptag'); if(pt) pt.textContent='— Page '+(FM.menu_pages.indexOf(activePage)+1); }
function photoUploadBtn(key){
  const wrap=document.createElement('label'); const has=!!photoUploads[key];
  wrap.style.cssText='display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:11.5px;cursor:pointer;margin-top:9px;padding:5px 11px;border:1px solid var(--line2);border-radius:8px;width:max-content;color:'+(has?'var(--ac)':'var(--muted)');
  wrap.textContent = has? '✓ Photo set · replace' : '⬆ Upload photo';
  const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.style.display='none';
  inp.addEventListener('change',e=>{ const f=e.target.files&&e.target.files[0]; if(f) embedPhoto(key,f); });
  wrap.appendChild(inp); return wrap;
}
// ---- FRAMING: drag to reposition, zoom, rotate. The thumbnail mirrors photoDrawOp exactly,
// so what you frame here is what prints.
let _ptmr=null;
function schedulePhotoDraw(){ clearTimeout(_ptmr); _ptmr=setTimeout(async()=>{ await regenerate(); renderPreview(); try{MEM.tick();}catch(_){} }, 220); }
// mirror photoDrawOp into an <img> inside a tile-ratio box scaled by K (pts->px)
function paintFrame(up, wh, K, img){
  photoClamp(up,[0,0,wh[0],wh[1]]);
  const f=photoFit(up,[0,0,wh[0],wh[1]]);
  img.style.width=(f.w*K)+'px'; img.style.height=(f.h*K)+'px';
  img.style.left=((wh[0]/2+(up.dx||0))*K)+'px';
  img.style.top =((wh[1]/2-(up.dy||0))*K)+'px';            // PDF y is up, CSS y is down
  img.style.transform='translate(-50%,-50%) rotate('+(-f.rot)+'deg)';
}
// card: a small live preview of the crop + a button that opens the full crop editor
function photoAdjustUI(key){
  const up=photoUploads[key]; if(!up||!up.src) return null;
  const wh=photoTileWH(key), K=58/wh[0];
  const box=document.createElement('div'); box.className='pframe pmini'; box.title='Edit crop';
  box.style.width=(wh[0]*K)+'px'; box.style.height=(wh[1]*K)+'px';
  const img=document.createElement('img'); img.src=up.src; img.draggable=false; box.appendChild(img);
  paintFrame(up,wh,K,img);
  box.onclick=()=>openCropModal(key);
  const btn=document.createElement('button'); btn.type='button'; btn.className='pbtn'; btn.textContent='✎ Adjust crop'; btn.onclick=()=>openCropModal(key);
  const wrap=document.createElement('div'); wrap.className='padj'; wrap.append(box,btn);
  return wrap;
}
// full crop editor: ADJUSTABLE CROP BOX. The whole photo shows dimmed; a ratio-locked box
// (drag corners/edges to resize, drag body to move) picks the exact region that fills the
// drink's fixed photo slot. The box is converted to the same {zoom,dx,dy,rot} photoDrawOp
// model, so what the box selects is exactly what prints — no distortion, no background.
function openCropModal(key){
  const up=photoUploads[key]; if(!up||!up.src||!up.iw||!up.ih) return;
  if(document.querySelector('.cropov')) return;
  const wh=photoTileWH(key), tw=wh[0], th=wh[1], ratio=tw/th;
  const VW=(window.innerWidth||640);
  const STAGEW=Math.round(Math.min(430,VW*0.72)), STAGEH=Math.round(STAGEW*0.72);
  const KR=Math.min(120,STAGEW*0.34)/tw;                 // small live "result" preview scale
  const snap={zoom:up.zoom||1, dx:up.dx||0, dy:up.dy||0, rot:up.rot||0};   // Cancel target

  const ov=document.createElement('div'); ov.className='cropov';
  ov.innerHTML='<div class="cropcard"><div class="crophd">Crop photo<span>drag box &middot; corners/edges resize &middot; scroll or slider to zoom</span></div>'
    +'<div class="cropwrap"><div class="cropstage"><img class="cropimg" draggable="false"><div class="cropbox"><div class="cg"></div></div></div>'
    +'<div class="cropside"><span class="rl">Fills the slot</span><div class="cropresult"><img draggable="false"></div></div></div>'
    +'<div class="croprow"><span class="cz">−</span><input type="range" class="crzoom" min="1" max="3" step="0.01"><span class="cz">+</span>'
    +'<button class="cropbtn" data-a="rot" type="button" title="Rotate 90°">⟲</button><button class="cropbtn" data-a="reset" type="button">Reset</button></div>'
    +'<div class="cropfoot"><button class="cropbtn ghost" data-a="cancel" type="button">Cancel</button><button class="cropbtn save" data-a="save" type="button">Save</button></div></div>';
  document.body.appendChild(ov);
  const stage=ov.querySelector('.cropstage'), img=ov.querySelector('.cropimg'),
        cbox=ov.querySelector('.cropbox'), z=ov.querySelector('.crzoom'),
        rbox=ov.querySelector('.cropresult'), rimg=rbox.querySelector('img');
  stage.style.width=STAGEW+'px'; stage.style.height=STAGEH+'px'; img.src=up.src; rimg.src=up.src;
  rbox.style.width=(tw*KR)+'px'; rbox.style.height=(th*KR)+'px';

  // 8 resize handles (4 corners + 4 edges), positioned by fraction of the box
  const HANDLES=[[0,0],[1,0],[1,1],[0,1],[0.5,0],[1,0.5],[0.5,1],[0,0.5]];
  HANDLES.forEach(([hx,hy])=>{
    const h=document.createElement('div'); const edge=(hx===0.5||hy===0.5);
    h.className='crophandle'+(edge?' edge':''); h.dataset.hx=hx; h.dataset.hy=hy;
    h.style.left=(hx*100)+'%'; h.style.top=(hy*100)+'%';
    h.style.cursor = hx===0.5 ? 'ns-resize' : hy===0.5 ? 'ew-resize' : (hx===hy?'nwse-resize':'nesw-resize');
    cbox.appendChild(h);
  });

  // layout of the dimmed image inside the stage (recomputed on rotate)
  let effW,effH,D,dispW,dispH,imgL,imgT,maxBw,minBw;
  const box={x:0,y:0,w:0,h:0};
  function computeLayout(){
    const rot=(((up.rot||0)%360)+360)%360, swap=(rot===90||rot===270);
    effW=swap?up.ih:up.iw; effH=swap?up.iw:up.ih;
    D=Math.min(STAGEW/effW, STAGEH/effH); dispW=effW*D; dispH=effH*D;
    imgL=(STAGEW-dispW)/2; imgT=(STAGEH-dispH)/2;
    maxBw=Math.min(dispW, dispH*ratio); minBw=maxBw/3;    // box at zoom 1 .. zoom 3
    const rot0=rot;
    img.style.width=((rot0===90||rot0===270)?dispH:dispW)+'px';
    img.style.height=((rot0===90||rot0===270)?dispW:dispH)+'px';
    img.style.left=(imgL+dispW/2)+'px'; img.style.top=(imgT+dispH/2)+'px';
    img.style.transform='translate(-50%,-50%) rotate('+(-rot0)+'deg)';
  }
  function clampBox(){
    box.w=Math.max(minBw,Math.min(maxBw,box.w)); box.h=box.w/ratio;
    box.x=Math.max(imgL,Math.min(imgL+dispW-box.w,box.x));
    box.y=Math.max(imgT,Math.min(imgT+dispH-box.h,box.y));
  }
  function frameToBox(){                                  // up{zoom,dx,dy} -> box(px)
    const sc=Math.max(tw/effW,th/effH)*(up.zoom||1);
    const cropX=effW/2-((up.dx||0)+tw/2)/sc, cropY=effH/2-(th/2-(up.dy||0))/sc;
    box.w=(tw/sc)*D; box.h=box.w/ratio; box.x=imgL+cropX*D; box.y=imgT+cropY*D; clampBox();
  }
  function boxToFrame(){                                  // box(px) -> up{zoom,dx,dy}
    const cropX=(box.x-imgL)/D, cropY=(box.y-imgT)/D, cropW=box.w/D, sc=tw/cropW;
    up.zoom=sc/Math.max(tw/effW,th/effH);
    up.dx=(effW/2-cropX)*sc - tw/2;
    up.dy=th/2 - (effH/2-cropY)*sc;
  }
  function paintBox(){
    cbox.style.left=box.x+'px'; cbox.style.top=box.y+'px';
    cbox.style.width=box.w+'px'; cbox.style.height=box.h+'px';
    z.value=Math.max(1,Math.min(3,maxBw/box.w));
    boxToFrame(); paintFrame(up,wh,KR,rimg);             // live "result" mirrors what prints
  }
  function resizeCenter(newW){
    const cx=box.x+box.w/2, cy=box.y+box.h/2;
    box.w=Math.max(minBw,Math.min(maxBw,newW)); box.h=box.w/ratio;
    box.x=cx-box.w/2; box.y=cy-box.h/2; clampBox(); paintBox();
  }
  function relayout(resetFrame){ computeLayout(); if(resetFrame){up.zoom=1;up.dx=0;up.dy=0;} frameToBox(); paintBox(); }
  relayout(false);

  // ---- pointer interaction (resize handle / pan body / pinch) ----
  const pts=new Map(); let mode=null, hs=null, ps=null, pinch=null;
  const rectXY=e=>{ const r=stage.getBoundingClientRect(); return [e.clientX-r.left, e.clientY-r.top]; };
  stage.addEventListener('pointerdown',e=>{
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY}); stage.setPointerCapture(e.pointerId);
    if(pts.size===2){ const a=[...pts.values()]; pinch={d:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)||1, w:box.w}; mode='pinch'; return; }
    const [px,py]=rectXY(e); const h=e.target.closest('[data-h]')||(e.target.classList&&e.target.classList.contains('crophandle')?e.target:null);
    if(h && h.dataset.hx!==undefined){ const hx=+h.dataset.hx, hy=+h.dataset.hy;
      const axF=hx===0.5?0.5:1-hx, ayF=hy===0.5?0.5:1-hy;
      hs={hx,hy,axF,ayF, ax:box.x+axF*box.w, ay:box.y+ayF*box.h}; mode='resize'; }
    else if(px>=box.x&&px<=box.x+box.w&&py>=box.y&&py<=box.y+box.h){ ps={mx:px,my:py,bx:box.x,by:box.y}; mode='pan'; cbox.style.cursor='grabbing'; }
    else mode=null;
  });
  stage.addEventListener('pointermove',e=>{
    if(!pts.has(e.pointerId))return; pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(mode==='pinch'&&pts.size>=2){ const a=[...pts.values()]; resizeCenter(pinch.w*Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)/pinch.d); return; }
    const [px,py]=rectXY(e);
    if(mode==='resize'){
      let nw;
      if(hs.hx!==0.5){ nw = hs.hx===1 ? (px-hs.ax) : (hs.ax-px); }
      else { const nh = hs.hy===1 ? (py-hs.ay) : (hs.ay-py); nw = nh*ratio; }
      box.w=Math.max(minBw,Math.min(maxBw,nw)); box.h=box.w/ratio;
      box.x=hs.ax-hs.axF*box.w; box.y=hs.ay-hs.ayF*box.h; clampBox(); paintBox();
    } else if(mode==='pan'){ box.x=ps.bx+(px-ps.mx); box.y=ps.by+(py-ps.my); clampBox(); paintBox(); }
  });
  const rel=e=>{ pts.delete(e.pointerId); cbox.style.cursor='move'; if(pts.size<2&&mode==='pinch')mode=null; if(pts.size===0)mode=null; };
  stage.addEventListener('pointerup',rel); stage.addEventListener('pointercancel',rel);
  stage.addEventListener('wheel',e=>{ e.preventDefault(); const cur=maxBw/box.w; resizeCenter(maxBw/Math.max(1,Math.min(3,cur*(1-e.deltaY*0.0012)))); },{passive:false});
  z.oninput=()=>resizeCenter(maxBw/(+z.value||1));

  const close=revert=>{ if(revert) Object.assign(up,snap); else boxToFrame();
    ov.remove(); document.removeEventListener('keydown',esc);
    buildEditor(); regenerate().then(renderPreview); try{MEM.tick();}catch(_){}
  };
  ov.addEventListener('click',e=>{ if(e.target===ov){ close(true); return; } const b=e.target.closest('[data-a]'); if(!b)return; const a=b.dataset.a;
    if(a==='rot'){ up.rot=(((up.rot||0)+90)%360); relayout(true); }
    else if(a==='reset'){ up.rot=0; relayout(true); }
    else if(a==='cancel') close(true);
    else if(a==='save') close(false);
  });
  const esc=e=>{ if(e.key==='Escape') close(true); else if(e.key==='Enter') close(false); };
  document.addEventListener('keydown',esc);
}
const MK_DEFS=[['jain','Ⓙ','Jain'],['dairy','🥛','Dairy'],['gluten','🌾','Gluten']];
// interactive J/dairy/gluten chip row. getSet()->Set, setSet(Set) persists.
function markerChips(getSet, setSet){
  const row=document.createElement('div'); row.className='markrow';
  const lbl=document.createElement('span'); lbl.className='mlbl'; lbl.textContent='Markers'; row.appendChild(lbl);
  MK_DEFS.forEach(([t,emo,name])=>{
    const c=document.createElement('button'); c.type='button'; c.className='mchip'; c.innerHTML=emo+' '+name;
    if(getSet().has(t)) c.classList.add('on');
    c.onclick=()=>{ const s=getSet(); if(s.has(t)) s.delete(t); else s.add(t); setSet(s);
      c.classList.toggle('on', getSet().has(t)); regenerate().then(renderPreview); };
    row.appendChild(c);
  });
  return row;
}
const FLAG_DEFS=[['badge','✦','NEW badge'],['specials','▬','SPECIALS bar']];
// promo-art chips. Deliberately its OWN row rather than folded into markerChips: that helper's
// contract is "a Set that replaces the baked marker set", so a SPECIALS click would otherwise
// trip the marker delete/restamp path for no reason. avail(t) hides SPECIALS on photoless drinks.
function flagChips(get, set, avail){
  const row=document.createElement('div'); row.className='markrow'; row.style.marginTop='7px';
  const lbl=document.createElement('span'); lbl.className='mlbl'; lbl.textContent='Highlights'; row.appendChild(lbl);
  FLAG_DEFS.forEach(([t,emo,name])=>{
    if(avail && !avail(t)) return;
    const c=document.createElement('button'); c.type='button'; c.className='mchip'; c.innerHTML=emo+' '+name;
    if(get(t)) c.classList.add('on');
    c.onclick=()=>{ set(t, !get(t)); c.classList.toggle('on', get(t)); validate(); regenerate().then(renderPreview); };
    row.appendChild(c);
  });
  return row;
}
// auto-growing multi-line name field. Enter inserts a line break (never submits); cleanField
// runs per line so the PDF-font limit still applies; height tracks the number of lines.
function mkNameField(value, ph, onChange){
  const ta=document.createElement('textarea'); ta.className='name'; ta.rows=1; ta.spellcheck=false;
  ta.placeholder=ph; ta.value=value||'';
  const grow=()=>{ ta.style.height='auto'; ta.style.height=(ta.scrollHeight)+'px'; };
  ta.addEventListener('input',()=>{
    const lines=ta.value.split('\n').map(L=>cleanField(L.toUpperCase(),'name'));
    const v=lines.join('\n');
    if(ta.value!==v){ const p=ta.selectionStart; ta.value=v; try{ta.setSelectionRange(p,p);}catch(_){}}
    grow(); onChange(v);
  });
  ta.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.stopPropagation(); } });   // keep newlines
  requestAnimationFrame(grow); setTimeout(grow,0);
  return ta;
}
// auto-growing multi-line description field. Enter breaks the line exactly where the user puts
// it and the PDF splice honours that break. cleanField runs PER LINE because the font charset
// has no '\n' — cleaning the whole value in one pass would silently swallow every newline.
function mkDescField(value, ph, onChange){
  const ta=document.createElement('textarea'); ta.className='desc'; ta.rows=1; ta.spellcheck=false;
  ta.placeholder=ph; ta.value=value||'';
  const grow=()=>{ ta.style.height='auto'; ta.style.height=(ta.scrollHeight)+'px'; };
  ta.addEventListener('input',()=>{
    const v=ta.value.split('\n').map(L=>cleanField(L,'desc')).join('\n');
    if(ta.value!==v){ const p=ta.selectionStart; ta.value=v; try{ta.setSelectionRange(p,p);}catch(_){}}
    grow(); onChange(v);
  });
  ta.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.stopPropagation(); } });   // keep newlines
  requestAnimationFrame(grow); setTimeout(grow,0);
  return ta;
}
// volume field — the number only; the engine re-applies the drink's own "[..ML]" wrapper and case
function mkVolField(value, onChange){
  const w=document.createElement('div'); w.className='vol-wrap';
  const v=document.createElement('input'); v.className='volu'; v.inputMode='numeric';
  v.placeholder='300'; v.value=value||''; v.title='Serving volume';
  v.oninput=()=>{ const c=v.value.replace(/[^0-9]/g,''); if(v.value!==c)v.value=c; onChange(c); };
  const u=document.createElement('span'); u.className='unit'; u.textContent='ML';
  w.appendChild(v); w.appendChild(u);
  return w;
}
let descCtrs=[];        // per-card line counters, rebuilt by buildEditor() and read by validate()
function buildEditor(){
  buildTabs();
  descCtrs=[];
  const ed=document.getElementById('editor'); ed.innerHTML='';
  const pageData=FM.pages.find(p=>p.page===activePage); if(!pageData) return;
  const hd=document.createElement('div'); hd.className='grouphd sechd'; hd.dataset.sec='DRINKS';
  const _rmCount=[...removed].filter(k=>k.startsWith(activePage+':')).length, _addCount=(added[activePage]||[]).length;
  const _vis=pageData.items.length-_rmCount+_addCount;
  hd.innerHTML='<span>DRINKS</span><span class="n">'+_vis+' items</span>'; ed.appendChild(hd);
  // Ensure reorder is initialised for this page (identity permutation by default)
  if(!reorder[activePage]||reorder[activePage].length!==pageData.items.length)
    reorder[activePage]=pageData.items.map((_,i)=>i);
  const ord=reorder[activePage];  // ord[slotIdx] = origIdx to display in that slot
  let dragFrom=null;              // slot index currently being dragged
  pageData.items.forEach((_,slotIdx)=>{
    const origIdx=ord[slotIdx]??slotIdx; const it=pageData.items[origIdx];
    if(removed.has(K0(activePage,origIdx))){
      const strip=document.createElement('div'); strip.className='rmstrip';
      strip.innerHTML='<span class="rmname">'+esc(val(activePage,origIdx,'name',it.name)||'(drink)')+'</span><span class="rmtag">removed</span>';
      const rb=document.createElement('button'); rb.className='restore'; rb.type='button'; rb.textContent='Restore';
      rb.onclick=()=>{ removed.delete(K0(activePage,origIdx)); buildEditor(); regenerate().then(renderPreview); };
      strip.appendChild(rb); ed.appendChild(strip); return;
    }
    const card=document.createElement('div'); card.className='card';
    card.dataset.slot=slotIdx;
    card.dataset.key=K0(activePage,origIdx);   // what pvJump() looks the card up by — keep in step with pvBoxes()
    // Drag events — only fire when the drag-handle is the initiating target
    card.addEventListener('dragstart',e=>{
      dragFrom=slotIdx; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',String(slotIdx));
      setTimeout(()=>card.classList.add('dragging'),0);
    });
    card.addEventListener('dragend',()=>{ card.classList.remove('dragging'); card.draggable=false; dragFrom=null; ed.querySelectorAll('.card.drag-over').forEach(c=>c.classList.remove('drag-over')); });
    card.addEventListener('dragover',e=>{ e.preventDefault(); e.dataTransfer.dropEffect='move'; if(dragFrom!=null&&dragFrom!==slotIdx) card.classList.add('drag-over'); });
    card.addEventListener('dragleave',e=>{ if(!card.contains(e.relatedTarget)) card.classList.remove('drag-over'); });
    card.addEventListener('drop',e=>{ e.preventDefault(); card.classList.remove('drag-over'); const from=dragFrom; if(from==null||from===slotIdx) return; const r=reorder[activePage]; [r[from],r[slotIdx]]=[r[slotIdx],r[from]]; try{MEM.tick();}catch(_){} buildEditor(); regenerate().then(renderPreview); });
    const nrow=document.createElement('div'); nrow.className='nrow';
    // Drag handle — sits at the left edge of the name row
    const handle=document.createElement('div'); handle.className='drag-handle'; handle.title='Drag to reorder'; handle.textContent='⠿';
    handle.addEventListener('mouseenter', () => { if (dragFrom == null) card.draggable = true; });
    handle.addEventListener('mouseleave', () => { if (dragFrom == null) card.draggable = false; });
    handle.addEventListener('touchstart', () => { card.draggable = true; }, {passive:true});
    nrow.appendChild(handle);
    const name=mkNameField(val(activePage,origIdx,'name',it.name),'DRINK NAME',v=>{ edits[K(activePage,origIdx,'name')]=v; validate(); schedulePreview(); });
    nrow.appendChild(name);
    const pw=document.createElement('div'); pw.className='price-wrap'; pw.innerHTML='<span class="cur">₹</span>';
    const price=document.createElement('input'); price.className='price'; price.value=val(activePage,origIdx,'price',it.price); price.inputMode='numeric';
    price.oninput=()=>{ const c=price.value.replace(/[^0-9]/g,''); if(price.value!==c)price.value=c; edits[K(activePage,origIdx,'price')]=c; schedulePreview(); };
    pw.appendChild(price); nrow.appendChild(pw);
    if(it.vol_span) nrow.appendChild(mkVolField(val(activePage,origIdx,'vol',it.vol),
      c=>{ edits[K(activePage,origIdx,'vol')]=c; validate(); schedulePreview(); }));
    const rm=document.createElement('button'); rm.className='rm'; rm.type='button'; rm.title='Remove drink'; rm.textContent='✕';
    rm.onclick=()=>{ removed.add(K0(activePage,origIdx)); buildEditor(); regenerate().then(renderPreview); };
    nrow.appendChild(rm); card.appendChild(nrow);
    if(it.desc_spans&&it.desc_spans.length){
      card.appendChild(mkDescField(val(activePage,origIdx,'desc',it.desc),'description',
        v=>{ edits[K(activePage,origIdx,'desc')]=v; validate(); schedulePreview(); }));
      const ctr=document.createElement('div'); ctr.className='ctr'; ctr.style.marginTop='5px';
      card.appendChild(ctr); descCtrs.push({idx:origIdx, it:it, el:ctr});
    }
    card.appendChild(markerChips(
      ()=>drinkMarkerSet(activePage,origIdx,it),
      (s)=>{ markerEdits[K0(activePage,origIdx)]=[...s]; try{MEM.tick();}catch(_){} }
    ));
    card.appendChild(flagChips(
      (t)=> t==='badge'? drinkBadge(activePage,origIdx,it) : drinkSpecials(activePage,origIdx,it),
      (t,v)=>{ (t==='badge'?badgeEdits:specialsEdits)[K0(activePage,origIdx)]=v; try{MEM.tick();}catch(_){} },
      (t)=> t!=='specials'||!!it.photo_tile
    ));
    card.appendChild(photoUploadBtn(K0(activePage,origIdx)));
    { const _a=photoAdjustUI(K0(activePage,origIdx)); if(_a) card.appendChild(_a); }
    ed.appendChild(card);
  });
  // --- added (new) drinks + the Add button ---
  const addList=added[activePage]||(added[activePage]=[]);
  addList.forEach((dr,ai)=>{
    const card=document.createElement('div'); card.className='card'; card.style.borderColor='var(--ac-line)';
    const nrow=document.createElement('div'); nrow.className='nrow';
    const name=mkNameField(dr.name||'','NEW DRINK',v=>{ dr.name=v; schedulePreview(); });
    nrow.appendChild(name);
    const pw=document.createElement('div'); pw.className='price-wrap'; pw.innerHTML='<span class="cur">₹</span>';
    const price=document.createElement('input'); price.className='price'; price.value=dr.price||''; price.inputMode='numeric'; price.placeholder='300';
    price.oninput=()=>{ const c=price.value.replace(/[^0-9]/g,''); if(price.value!==c)price.value=c; dr.price=c; schedulePreview(); };
    pw.appendChild(price); nrow.appendChild(pw);
    nrow.appendChild(mkVolField(dr.vol||'', c=>{ dr.vol=c; schedulePreview(); }));
    const rm=document.createElement('button'); rm.className='rm'; rm.type='button'; rm.title='Discard'; rm.textContent='✕';
    rm.onclick=()=>{ addList.splice(ai,1); shiftAddedPhotos(activePage, ai); buildEditor(); regenerate().then(renderPreview); };   // chucky-2: photos move with their drinks
    nrow.appendChild(rm); card.appendChild(nrow);
    card.appendChild(mkDescField(dr.desc||'','description', v=>{ dr.desc=v; schedulePreview(); }));
    dr.markers=dr.markers||[];
    card.appendChild(markerChips(
      ()=>new Set(dr.markers),
      (s)=>{ dr.markers=[...s]; try{MEM.tick();}catch(_){} }
    ));
    card.appendChild(flagChips(
      (t)=> !!dr[t],
      (t,v)=>{ dr[t]=v; try{MEM.tick();}catch(_){} }      // added drinks always get a placeholder tile
    ));
    card.appendChild(photoUploadBtn(activePage+':add:'+ai));
    { const _a=photoAdjustUI(activePage+':add:'+ai); if(_a) card.appendChild(_a); }
    ed.appendChild(card);
  });
  // free space = total height (pitch) of removed drinks on this page; each new drink needs ~48pt
    const maxAdd=[...removed].filter(k=>k.startsWith(activePage+':')).length;   // one removal frees exactly one row
  const zone=document.createElement('div'); zone.style.cssText='margin:8px 2px 30px';
  const btn=document.createElement('button'); btn.className='addbtn';
  btn.style.cssText='width:100%;padding:12px;border:1px dashed var(--line2);border-radius:11px;color:var(--cream-dim);font:inherit;font-size:13px;background:transparent';
  if(addList.length<maxAdd){ btn.textContent='+  Add drink  ('+(maxAdd-addList.length)+' slot'+(maxAdd-addList.length>1?'s':'')+' free)';
    btn.onclick=()=>{ addList.push({name:'',desc:'',price:'',vol:'',markers:[]}); buildEditor(); const cards=document.querySelectorAll('#editor .card'); const last=cards[cards.length-1]; const f=last&&last.querySelector('.name'); if(f)f.focus(); };
  } else { btn.textContent='Remove a drink to free a slot for a new one'; btn.style.opacity='.5'; btn.style.cursor='default'; btn.disabled=true; }
  zone.appendChild(btn); ed.appendChild(zone);
  validate();
  if(typeof syncRail==='function') syncRail();
}
// Was a stub that always said "All clear" — which is why an over-long description used to lose
// its tail with Export still enabled. Now it reports the real line budget per drink and warns
// when the inline volume would run into the price column. These are LAYOUT warnings, not corrupt
// output, so Export stays enabled: the point is to make overflow loud, not to block work.
function validate(){
  let bad=0;
  descCtrs.forEach(c=>{
    const r=descRender(activePage,c.idx,c.it);
    const cap=Math.max(1,descCapacity(c.it));
    const n=r? r.lines.length : (c.it.desc_spans||[]).length;
    let over=false, msg=n+' / '+cap+' line'+(cap===1?'':'s');
    // distinguish "your line break had nowhere to go" from "this line is genuinely too long" —
    // on tight rows the artwork simply has no gap for another line, and joining is not overflow
    if(r&&r.joined){ over=true; msg+=' — no room for another line, joined'; }
    if(r&&r.wide){ over=true; msg+=' — line too long for the column'; }
    // the volume rides at the end of the last line; flag it running into the price
    if(r && c.it.vol_span && c.it.vol_pos && c.it.price_pos){
      const p=volPlace(c.it,r.lines);
      const vv=val(activePage,c.idx,'vol',c.it.vol)||'';
      const w=((c.it.vol_pre||'')+vv+(c.it.vol_suf||'')).length*DESC_ADV*(c.it.vol_pos.size||5);
      // a shortened description is pulled DOWN onto the price's own line, which is exactly when
      // the volume (which rides the last description line) can run into it
      if(Math.abs(p.y-c.it.price_pos.y)<2 && p.x+w>c.it.price_pos.x-2){ over=true; msg+=' — volume hits the price'; }
    }
    // a name can grow upward into the row's headroom, but only so far — past nameCapacity the
    // extra lines get merged back onto the last line rather than collide with the row above.
    // Uses the SAME nameRoomFree() budget regenerate() clamps with, so the warning can never
    // disagree with what the exported PDF actually does.
    if(pageStreams[activePage] && c.it.name_spans && c.it.name_spans.length){
      const _PTn=new TextDecoder('latin1').decode(pageStreams[activePage].pristine);
      const _typed=renderedNameLines(c.it,_PTn,val(activePage,c.idx,'name',c.it.name)).filter(Boolean).length;
      const _nD=r? r.lines.filter(l=>l&&l.trim()).length : (c.it.desc_spans||[]).length;
      const _free=nameRoomFree(c.it,_PTn);
      const _ng=nameGeomOf(c.it,_PTn);
      let _fit=Math.max(1,_typed);
      while(_fit>1 && (rowLayout(c.it,_PTn,_fit,_nD).nameY0-_ng.topY)>_free+0.5) _fit--;
      if(_typed>_fit){ over=true; msg+=' — name needs '+_typed+' lines, only '+_fit+' fit in this row'; }
    }
    // the NEW badge packs after the name + marker cluster; a long name pushes it to the photo rail
    if(drinkBadge(activePage,c.idx,c.it) && pageStreams[activePage]){
      const _PT=new TextDecoder('latin1').decode(pageStreams[activePage].pristine);
      const _bp=badgePlace(c.it, activePage, c.idx, drinkMarkerSet(activePage,c.idx,c.it), _PT);
      if(_bp && _bp.clamped){ over=true; msg+=' — NEW badge won’t fit beside this name'; }
    }
    c.el.textContent=msg; c.el.classList.toggle('over',over);
    if(over) bad++;
  });
  const pill=document.getElementById('flagpill');
  if(bad){ pill.className='pill warn'; pill.textContent=bad+' drink'+(bad>1?'s':'')+' overflowing'; }
  else { pill.className='pill ok'; pill.textContent='All clear'; }
  document.getElementById('export').disabled=false;
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
const PV_FILE=(typeof BRAND!=='undefined'&&BRAND&&BRAND.download)?BRAND.download:'Capiche_Ahmedabad_Drinks.pdf';
const PV_TITLE="Capiche Ahmedabad — Drinks";
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
document.getElementById('export').addEventListener('click', async()=>{
  // chucky-2: never export a menu whose photos haven't loaded — it would print the old ones
  if(Object.keys(photoPending).length){ await loadPendingPhotos(); if(reportMissingPhotos('export')) return; buildEditor(); }
  const bytes=await regenerate(); const blob=new Blob([bytes],{type:'application/pdf'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=BRAND.download; a.click(); URL.revokeObjectURL(url); try{MEM.snapshot('export');}catch(_){} showChucky(BRAND.download); });
// ---- Publish: chucky-2 — the shared MenuState (assets/js/menustate.js) owns the Publish button:
// the version check, the conflict handling and the live status. Wired up at the end of boot().
// (The old local-only "Save" button is gone: edits are autosaved on this device, and Publish is
// what keeps a menu — with its photos — for every device.)
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
     (assets/js/editor.js); made here: the export celebration and the short notes (#fontnote). */
  const note=document.createElement('div'); note.id='fontnote'; note.setAttribute('role','status');
  document.body.appendChild(note);
})();

// ---------- boot ----------

// ---- edit-memory glue (capiche-ahm) ----
const MEM_BRAND='capiche-ahm';
let memBaseVer='';
// chucky-2: each drink's photo by id, with its crop — loaded or still loading (photoPending), in key
// order, so the same menu always serialises the same way (Publish and autosave compare the JSON)
function photoManifest(){ const o={};
  for(const k in photoPending){ const m=photoPending[k]; o[k]={id:m.id,zoom:m.zoom,dx:m.dx,dy:m.dy,rot:m.rot}; }
  for(const k in photoUploads){ const u=photoUploads[k]; if(u&&u.id) o[k]={id:u.id,zoom:u.zoom,dx:u.dx,dy:u.dy,rot:u.rot}; }
  const out={}; for(const k of Object.keys(o).sort()) out[k]=o[k]; return out; }
function memSnapshot(){ return { qr:QRK.snap(), edits:{...edits}, removed:[...removed], added:addedSnap(), markerEdits:JSON.parse(JSON.stringify(markerEdits)), badgeEdits:{...badgeEdits}, specialsEdits:{...specialsEdits}, reorder:orderSnap(), photos:photoManifest() }; }
// chucky-2: buildEditor() seeds added[page]=[] and an identity reorder[page] for each page it draws, so
// just opening a page used to change the snapshot — the live chip then said "Unpublished changes" and
// newer publishes were held back. An untouched page is left out, whether or not it has been drawn.
function addedSnap(){ const o={}; for(const p in added) if(added[p]&&added[p].length) o[p]=JSON.parse(JSON.stringify(added[p])); return o; }
function orderSnap(){ const o={}; for(const p in reorder){ const r=reorder[p]; if(r&&r.some((v,i)=>v!==i)) o[p]=r.slice(); } return o; }
// defaulting the two flag maps to {} is what lets a PRE-feature snapshot clear stale toggles
function memApply(st){ QRK.load(st&&st.qr); edits=(st&&st.edits)?{...st.edits}:{}; removed=new Set((st&&st.removed)||[]); added=(st&&st.added)?JSON.parse(JSON.stringify(st.added)):{}; markerEdits=(st&&st.markerEdits)?JSON.parse(JSON.stringify(st.markerEdits)):{}; badgeEdits=(st&&st.badgeEdits)?{...st.badgeEdits}:{}; specialsEdits=(st&&st.specialsEdits)?{...st.specialsEdits}:{}; reorder=(st&&st.reorder)?JSON.parse(JSON.stringify(st.reorder)):{};
  // chucky-2: the state's photos are loaded by loadPendingPhotos() (memRebuild, boot)
  for(const k in photoUploads){ try{URL.revokeObjectURL(photoUploads[k].src);}catch(_){} }
  photoUploads={}; photoPending={};
  const ph=(st&&st.photos)||{};
  for(const k in ph){ const m=ph[k]; if(m&&m.id) photoPending[k]={id:m.id,zoom:m.zoom,dx:m.dx,dy:m.dy,rot:m.rot}; } }
async function memRebuild(){ await loadPendingPhotos(); buildEditor(); await regenerate(); renderPreview(); reportMissingPhotos(); }
// ============ EDIT MEMORY — autosave + resume + version history (per brand) ============
// Glue each editor must define BEFORE this block:
//   const MEM_BRAND = 'aiko-drinks';        // unique key
//   function memSnapshot(){ return {...}; }  // serialisable current edit state (order-stable)
//   function memApply(state){ ... }          // mutate editor vars from a saved state
//   function memRebuild(){ ... }             // rebuild UI + regenerate + render after apply (loads the photos)
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
    FM=await (await fetch('fieldmap.json?v='+Date.now())).json(); activePage=FM.menu_pages[0];
    try{ const [bw,cw]=await Promise.all([fetch('base_words.json?v='+Date.now()).then(r=>r.json()),fetch('culinary.json?v='+Date.now()).then(r=>r.json())]); BASE=new Set(bw);CULINARY=new Set(cw);BASE_LIST=bw;CULINARY_LIST=cw; }catch(_){}
    document.getElementById('bootmsg').textContent='Loading your menu…';
    pdfBytesOrig=new Uint8Array(await (await fetch(BRAND.pdf+'?v='+Date.now())).arrayBuffer()); memBaseVer='v'+pdfBytesOrig.length;
    doc=await PDFDocument.load(pdfBytesOrig);
    for(let p=0;p<doc.getPageCount();p++){ const page=doc.getPage(p); const ref=page.node.get(PDFName.of('Contents')); const stream=doc.context.lookup(ref); pageStreams.push({ref,dict:stream.dict,pristine:stream.contents.slice()}); }
    /* chucky-2: MenuState.boot retries the load, applies a published state only if it was made for
       THIS base PDF, falls back to the menu's starting state (start-state.json), and puts up a bar
       and locks Publish when the published menu can't be loaded. The photos it names come next. */
    const _st=await MenuState.boot({ editor:MEM_BRAND, base:memBaseVer, start:'start-state.json' });
    if(_st) memApply(_st);
    if(Object.keys(photoPending).length){ document.getElementById('bootmsg').textContent='Loading the drink photos…'; await loadPendingPhotos(); }
    buildEditor(); try{MEM.init();}catch(e){console.error(e);}
    MenuState.ready({                 // chucky-2: publish, live status, newer-version pickup, versions
      snapshot: memSnapshot,
      apply: st=>{ memApply(st); memRebuild(); },
      beforePublish: ()=>regenerate(),        // refuse to publish a state that doesn't even export
      prepare: uploadPhotos,                  // new photos go to the server before the menu naming them
      keep: label=>MEM.snapshot(label),       // park the current edits in History before replacing them
      rebase: ()=>MEM.rebase(),
    });
    await regenerate(); await renderPreview();
    document.getElementById('boot').style.display='none';
    reportMissingPhotos(); gcPhotoCache();
  }catch(e){ document.getElementById('bootmsg').innerHTML='Couldn’t load. It needs to be <b>served</b>. <br>'+esc(String(e)); console.error(e); }
}
function syncRail(){ const rail=document.getElementById('rail'); if(!rail)return; }
function filterItems(q){ q=(q||'').trim().toLowerCase(); document.querySelectorAll('#editor .card').forEach(c=>{ const t=((c.querySelector('.name')?.value||'')+' '+(c.querySelector('.desc')?.value||'')).toLowerCase(); c.style.display=(!q||t.includes(q))?'':'none'; }); }
// chucky-2: the shell wires the search box to filterItems(); "/" jumps to it, as in the other editors
document.addEventListener('keydown',e=>{ const el=document.activeElement; if(e.key==='/' && !(el&&(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable))){ e.preventDefault(); document.getElementById('q').focus(); } });
boot();

