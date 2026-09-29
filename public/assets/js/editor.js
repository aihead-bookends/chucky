/* The editor shell, shared by all seven editors. Each editor page is a thin HTML file that sets
   <html data-editor="…">; the brand comes from brands.js and its colours from editor.css.

   Two modes, chosen per brand in brands.js:
   - `menu: true` — the editor's menu and PDF engine are in place. The shell draws the frame and
     hands over: the page's engine.js (loaded right after this file) fills the editing surface,
     renders the preview, and runs the tabs, search, boot screen, Export and Publish.
   - otherwise — no menu yet. The editing surface shows an empty state with a backend check, and
     Export / Publish stay disabled.
   Either way the shell provides the home link, Chucky's greeting, and what bug reports attach. */
// Older phone browsers (Safari before 16, Chrome before 103) have no AbortSignal.timeout, which every
// request to the server uses. Without it the published menu never loads and Publish stays off.
if (!AbortSignal.timeout) {
  AbortSignal.timeout = (ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return c.signal;
  };
}

(function () {
  const id = document.documentElement.dataset.editor;
  const B = window.CHUCKY_BRANDS[id];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  if (!B) { document.body.textContent = 'Unknown editor "' + id + '"'; return; }
  const live = !!B.menu;

  const brandMark = (mark = B.mark) => B.text
    ? `<span class="wordtext ${B.text.cls}">${esc(B.text.label)}</span>`
    : `<span class="mark ${mark}" role="img" aria-label="${esc(B.name)}"></span>`;
  // an action button: live with its tooltip, or disabled until there's a menu
  const act = (title) => (live ? `title="${title}"` : 'title="Available once the menu is added" disabled');

  const emptyState = `
    <div class="empty">
      <div class="cat">${Chucky.SVG}</div>
      <h1>No menu loaded yet</h1>
      <p>The ${esc(B.name)} editor is ready. Once its menu is added, every dish shows up here as a card you can edit, with the live preview alongside.</p>
      <dl class="status">
        <div><dt>Editor</dt><dd><code>${esc(B.mem)}</code></dd></div>
        <div><dt>Backend</dt><dd id="st-api" data-state="wait">Checking…</dd></div>
        <div><dt>Published menu</dt><dd id="st-pub" data-state="wait">Checking…</dd></div>
      </dl>
    </div>`;

  document.body.insertAdjacentHTML('afterbegin', `
<div id="boot" aria-hidden="true"><div class="bootmark">${brandMark(B.bootMark)}</div><div class="spin"></div><div class="s" id="bootmsg">${esc(B.boot)}</div></div>
${live ? '<div id="statebar" class="statebar" role="status" hidden></div>' : ''}
<header class="bar">
  <div class="brand">
    <a class="homelink" href="/chucky/" title="Back to the menu picker" aria-label="Back to the menu picker"><span aria-hidden="true">↩</span>${Chucky.SVG}</a>
    ${brandMark()}<span class="tag">${esc(B.tag)}</span>
  </div>
  <label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="q" type="search" placeholder="${esc(B.search)}" aria-label="${esc(B.search)}" autocomplete="off"><kbd>/</kbd></label>
  <div class="spacer"></div>
  <span id="flagpill" class="pill idle">${live ? 'Loading…' : 'No menu yet'}</span>
  <div class="actions">
    ${B.personalise ? `<button class="btn" id="persona" ${act('Add an occasion + guest name to the cover')}>✨ Personalise</button>` : ''}
    <button class="btn" id="fullprev" ${act('Open the current menu full-size in a new tab')}>Full Preview ↗</button>
    <button class="btn primary" id="export" ${act('Download the print-ready PDF')}>Export PDF</button>
    ${live ? '<span id="livechip" class="pill idle" role="button" tabindex="0" hidden>Loading…</span>' : ''}
    <button class="btn publish" id="publish" ${act('Push the current menu live for everyone')}>Publish</button>
  </div>
</header>
<main class="app">
  <nav class="rail" id="rail" aria-label="Menu pages and sections">
    <div class="tabs" role="tablist">${B.tabs.map((t, i) => `<button role="tab" data-pg="${i}" aria-selected="${i === 0}"${i === 0 ? ' class="on"' : ''}>${esc(t)}</button>`).join('')}</div>
    <div class="lbl2">Sections</div>
    ${live ? '' : '<div class="note">Sections appear here once the menu is added.</div>'}
  </nav>
  <section id="editor" aria-label="Menu items">${live ? '' : emptyState}</section>
  <aside id="previewPane" aria-label="Live preview">
    <div class="plabel">Live preview <span id="ptag">— ${esc(B.tabs[0])}</span></div>
    <div id="wrap">${live
      ? '<canvas id="preview"></canvas><div id="busy">updating…</div>'
      : `<div class="sheet"><div class="sheetmark">${brandMark()}</div><small>Preview appears here</small></div>`}</div>
  </aside>
</main>
${live ? '<div class="scrim" id="scrim"></div><div id="popover"></div>' : ''}
<div id="chuckysay" role="status"></div>`);

  // ---- Chucky says hello ----
  const say = $('#chuckysay');
  say.addEventListener('click', () => say.classList.remove('on'));
  setTimeout(() => {
    say.textContent = Chucky.greeting();
    say.classList.add('on');
    setTimeout(() => say.classList.remove('on'), 6000);
  }, 1200);

  const q = $('#q');
  if (live) {
    // engine.js hides the boot screen once the menu has loaded, and owns the tabs and "/" key.
    // These are its globals, looked up when used.
    q.addEventListener('input', () => filterItems(q.value));
    window.CHUCKY_CTX = {
      editor: B.mem,
      page: () => activePage,
      state: () => memSnapshot(),
      shot: () => { const c = $('#preview'); return c && c.width ? c.toDataURL('image/jpeg', 0.5) : null; },
    };
    return;
  }

  // ---------------- no menu yet ----------------
  // The edit overlay that Publish would send and bug reports attach: empty without a menu.
  const state = { edits: {}, removed: [], added: [] };
  let page = 0;
  window.CHUCKY_CTX = { editor: B.mem, page: () => page, state: () => state, shot: () => null };

  // Fade the boot screen out. Read its layout first so the browser has a starting opacity to
  // transition from, and remove it on a timer: transitionend never fires if no transition ran.
  const boot = $('#boot');
  boot.getBoundingClientRect();
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 400);

  const tabs = [...document.querySelectorAll('.tabs button')];
  tabs.forEach((b) => b.addEventListener('click', () => {
    page = +b.dataset.pg;
    tabs.forEach((t) => { t.classList.toggle('on', t === b); t.setAttribute('aria-selected', t === b); });
    $('#ptag').textContent = '— ' + b.textContent;
  }));

  document.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    if (e.key === '/' && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) { e.preventDefault(); q.focus(); }
  });

  // ---- backend status ----
  const ago = (t) => {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  };
  const show = (el, st, text) => { el.dataset.state = st; el.textContent = text; };
  const getJSON = async (url) => {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    return { status: res.status, body };
  };

  getJSON('/api/health').then(({ body }) => {
    if (body?.ok) show($('#st-api'), 'ok', 'Connected');
    else if (body?.store === 'none') show($('#st-api'), 'warn', 'Storage not connected');
    else show($('#st-api'), 'bad', 'Storage error');
  }, () => show($('#st-api'), 'bad', 'Unreachable'));

  getJSON('/api/menu-state/' + encodeURIComponent(B.mem)).then(({ status, body }) => {
    if (status === 200 && body?.t) show($('#st-pub'), 'ok', 'Published ' + ago(body.t));
    else if (status === 404) show($('#st-pub'), 'idle', 'Nothing published yet');
    else show($('#st-pub'), 'warn', 'Unavailable');
  }, () => show($('#st-pub'), 'bad', 'Unreachable'));
})();
