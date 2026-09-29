/* The published menu, for every editor that has one: loading it, publishing it, and never losing it.

   The old Chucky lost published changes, silently, in several ways. Each has a guard here:
   - Loading: the published menu was fetched once with a 4s timeout, and any failure quietly showed
     the old starting menu. Anyone who then published from it wiped everyone's changes. Now: retried,
     and if it still fails, a red bar says so and Publish is switched off until it loads.
   - A menu made for a different menu PDF was applied anyway (its edits point at byte positions in
     the old file). Now it is not applied, and a bar says so. It stays in the version history.
   - Stale copies overwrote newer ones: a tab left open since before someone else published. Every
     publish names the version it started from, and the server refuses it if that isn't current.
     The person is asked to load the latest first; their own edits are kept in History.
   - Whether the screen was live was invisible, and the chip said "Saved" for edits kept only on this
     device. The live chip says which: live, unpublished changes, not connected. Leaving the page with
     unpublished changes asks first, and a newer publish from another device is picked up while open.
   - Nothing could be recovered. The server keeps every replaced version; "Versions" loads one back.

   The engine plugs in with MenuState.boot() (while loading) and MenuState.ready() (once its editor
   is built), and calls MenuState.touch() whenever its state changes. An engine whose menu names
   files kept on the server (the drinks menus' photos) also passes ready() a prepare(key) hook that
   uploads them when publishing, and can put up its own message in the bar with MenuState.notice(). */
window.MenuState = (function () {
  const API = '/api/menu-state/';
  const KEY_STORE = 'chucky_publishkey';
  let editor = '', base = '';
  let loadedT = null;       // the published version this editor's state starts from (null: none)
  let status = 'loading';   // loading | live | none | mismatch | offline
  let mismatchRec = null, baseline = '', busy = false, hooks = null, timer = null;

  const $ = (s) => document.querySelector(s);
  const J = (o) => { try { return JSON.stringify(o); } catch { return ''; } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const when = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  // for the chip: the time if it was today, else the date
  const short = (t) => (new Date(t).toDateString() === new Date().toDateString()
    ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJSON(url, timeout = 8000) {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, body };
  }
  // A 404 is an answer ("nothing published"); network errors, timeouts and 5xx are retried.
  async function getLatest(tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await getJSON(API + encodeURIComponent(editor));
        if (r.status === 200 || r.status === 404) return r;
        last = new Error((r.body && r.body.error) || 'server answered ' + r.status);
      } catch (e) { last = e; }
      if (i < tries - 1) await sleep(800 * (i + 1));
    }
    throw last;
  }
  const reason = (e) => (e && e.name === 'TimeoutError' ? 'the server took too long' : (e && e.message) || 'network error');

  // ---------------- boot: which state should this editor open with? ----------------
  async function startState(url) {
    try { const r = await getJSON(url + '?v=' + Date.now()); if (r.ok && r.body && r.body.base === base) return r.body.state; } catch { /* none */ }
    return null;
  }
  async function boot(opts) {
    editor = opts.editor; base = opts.base;
    let r;
    try { r = await getLatest(); }
    catch (e) {
      status = 'offline';
      bar('bad', 'Couldn’t load the published menu (' + esc(reason(e)) + '). You may be looking at an out-of-date menu, so <b>Publish is switched off</b> until it loads.',
        [['Try again', () => location.reload()]]);
      return startState(opts.start);
    }
    if (r.status === 404) { status = 'none'; loadedT = null; return startState(opts.start); }
    loadedT = r.body.t;
    if (r.body.base !== base) {
      status = 'mismatch'; mismatchRec = r.body;
      bar('warn', 'The menu published on ' + esc(when(r.body.t)) + ' was made for an older version of this menu’s PDF, so it can’t be shown here. You’re seeing the starting menu. Publishing will replace it; the old one stays in <b>Versions</b>.',
        [['Versions', openVersions]]);
      return startState(opts.start);
    }
    status = 'live';
    return r.body.state;
  }

  // ---------------- once the editor is built ----------------
  function ready(h) {
    hooks = h;
    baseline = J(hooks.snapshot());
    $('#publish').addEventListener('click', publish);
    const chip = $('#livechip');
    chip.addEventListener('click', openVersions);
    chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVersions(); } });
    addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
    timer = setInterval(() => { if (!document.hidden) checkForNewer(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForNewer(); });
    render();
  }
  const dirty = () => !!hooks && J(hooks.snapshot()) !== baseline;
  function markClean() { baseline = J(hooks.snapshot()); hooks.rebase(); render(); }

  function render() {
    const chip = $('#livechip'), btn = $('#publish');
    if (!chip || !btn) return;
    let cls = 'idle', text = 'Loading…', tip = '';
    if (status === 'offline') { cls = 'bad'; text = 'Not connected'; tip = 'The published menu could not be loaded'; }
    else if (status === 'mismatch') { cls = 'bad'; text = dirty() ? 'Unpublished changes' : 'Published menu not shown'; tip = 'The published menu was made for an older PDF'; }
    else if (dirty()) { cls = 'warn'; text = 'Unpublished changes'; tip = 'Only you can see these until you Publish'; }
    else if (status === 'live') { cls = 'ok'; text = 'Live · ' + short(loadedT); tip = 'Everyone sees this menu — published ' + when(loadedT); }
    else if (status === 'none') { cls = 'idle'; text = 'Not published'; tip = 'Nothing has been published for this menu yet'; }
    chip.className = 'pill ' + cls; chip.textContent = text; chip.title = tip + ' · click for versions'; chip.hidden = false;
    if (!busy) {
      btn.disabled = status === 'offline';
      btn.title = status === 'offline' ? 'Publishing is off until the published menu loads' : 'Push the current menu live for everyone';
    }
  }

  // ---------------- the bar above the editor ----------------
  function bar(kind, html, actions = [], autoHide = 0) {
    const el = $('#statebar'); if (!el) return;
    el.className = 'statebar ' + kind; el.hidden = false;
    el.innerHTML = '<span class="sbmsg">' + html + '</span>';
    for (const [label, fn] of actions) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.addEventListener('click', fn); el.appendChild(b);
    }
    const x = document.createElement('button'); x.type = 'button'; x.className = 'sbx'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '✕';
    x.addEventListener('click', () => { el.hidden = true; }); el.appendChild(x);
    clearTimeout(bar._t); if (autoHide) bar._t = setTimeout(() => { el.hidden = true; }, autoHide);
  }
  const clearBar = () => { const el = $('#statebar'); if (el) el.hidden = true; };

  // ---------------- a dialog in the page ----------------
  /* Not prompt()/confirm(): some phone browsers (and apps' built-in browsers) block them, and a
     blocked prompt reads as "cancelled" — Publish then did nothing at all, with no message. */
  function dialog({ title, text, input = false, ok = 'OK', error = '' }) {
    return new Promise((resolve) => {
      const ov = document.createElement('div'); ov.className = 'msdialog';
      ov.innerHTML = '<form class="mscard" autocomplete="off"><h2>' + esc(title) + '</h2><p>' + text + '</p>'
        + (input ? '<input type="password" name="k" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="' + esc(title) + '">' : '')
        + '<div class="mserr" aria-live="polite">' + esc(error) + '</div>'
        + '<div class="msbtns"><button type="button" data-a="cancel">Cancel</button><button type="submit" class="pri">' + esc(ok) + '</button></div></form>';
      document.body.appendChild(ov);
      const form = ov.querySelector('form'), field = form.querySelector('input');
      const done = (v) => { ov.remove(); resolve(v); };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (field && !field.value.trim()) { form.querySelector('.mserr').textContent = 'Type the key first.'; field.focus(); return; }
        done({ ok: true, value: field ? field.value.trim() : '' });
      });
      form.querySelector('[data-a=cancel]').addEventListener('click', () => done({ ok: false }));
      ov.addEventListener('click', (e) => { if (e.target === ov) done({ ok: false }); });
      setTimeout(() => (field || form.querySelector('.pri')).focus(), 30);
    });
  }

  // ---------------- publish ----------------
  const storedKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };
  const rememberKey = (k) => { try { localStorage.setItem(KEY_STORE, k); } catch { /* storage blocked: asked again next time */ } };
  const forgetKey = () => { try { localStorage.removeItem(KEY_STORE); } catch { /* storage blocked */ } };
  const post = (key, state) => fetch(API + encodeURIComponent(editor), {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ state, base, prev: loadedT }),
  }).then(async (res) => ({ status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) }));

  // One publish at a time — a second tap while the key box is open does nothing.
  let flow = false;
  async function publish() {
    if (flow) return;
    flow = true;
    try { await publishFlow(); } finally { flow = false; }
  }
  // Every way out of here either publishes or says why it didn't.
  async function publishFlow() {
    if (busy) return;
    if (!hooks) { bar('bad', 'Not published: the editor hasn’t finished loading. Reload the page.', [['Reload', () => location.reload()]]); return; }
    if (status === 'offline') {
      bar('bad', 'Publish is off: the published menu couldn’t be loaded, so this could be an old copy. Reload to try again.', [['Reload', () => location.reload()]]);
      return;
    }
    if (status === 'mismatch') {
      const d = await dialog({ title: 'Replace the published menu?', ok: 'Publish',
        text: 'The menu published on ' + esc(when(mismatchRec.t)) + ' was made for an older PDF and isn’t shown here. Publish what you see now instead? The old one stays in <b>Versions</b>.' });
      if (!d.ok) return;
    }
    const btn = $('#publish'), label = btn.textContent;
    const setBusy = (on) => { busy = on; btn.disabled = on; btn.textContent = on ? 'Publishing…' : label; if (!on) render(); };
    setBusy(true);
    let state;
    try { await hooks.beforePublish(); state = hooks.snapshot(); }   // refuse a state that doesn't even export
    catch (e) { setBusy(false); bar('bad', 'Not published: the menu couldn’t be built (' + esc(reason(e)) + '). Report a bug with the button below.'); return; }

    let key = storedKey(), error = '';
    try {
      for (;;) {
        if (!key) {
          setBusy(false);
          const d = await dialog({ title: 'Publish key', input: true, ok: 'Publish', error,
            text: 'Publishing changes the menu for everyone, so it needs the publish key. This device will remember it.' });
          if (!d.ok) { bar('info', 'Not published — publishing needs the publish key. Your edits are still here.'); return; }
          key = d.value; setBusy(true);
        }
        // Anything the menu names that isn't on the server yet (a drinks menu's new photos) goes up
        // first, with the same key. If it can't, nothing is published: a menu naming a photo no
        // other device can load would show them a gap.
        if (hooks.prepare) {
          let p;
          try { p = await hooks.prepare(key); }
          catch (e) { bar('bad', 'Not published: ' + esc(reason(e)) + '. Nothing changed for anyone else — your edits are still here.', [['Try again', publish]]); return; }
          if (p === 'forbidden') { forgetKey(); key = ''; error = 'That key wasn’t accepted. Check it and try again.'; continue; }
          state = hooks.snapshot();
        }
        const res = await post(key, state);
        if (res.status === 403) { forgetKey(); key = ''; error = 'That key wasn’t accepted. Check it and try again.'; continue; }
        rememberKey(key);                                   // anything but 403: the server took the key
        if (res.status === 409) { conflict(res.body.current); return; }
        if (!res.ok || !res.body.ok) {
          const why = res.status === 503 ? 'the server’s storage isn’t connected' : (res.body.error || 'the server answered ' + res.status);
          bar('bad', 'Not published: ' + esc(why) + '. Nothing changed for anyone else — your edits are still here.', [['Try again', publish]]);
          return;
        }
        loadedT = res.body.t; status = 'live'; mismatchRec = null;
        markClean();
        bar('ok', 'Published — everyone now sees this menu (' + esc(when(loadedT)) + ').', [], 6000);
        return;
      }
    } catch (e) {
      bar('bad', (e && e.name === 'TimeoutError')
        ? 'The server didn’t confirm the publish in time. It may or may not have gone through — <b>reload</b> to check before publishing again.'
        : 'Not published: couldn’t reach the server (' + esc(reason(e)) + '). Your edits are still here.', [['Reload', () => location.reload()]]);
    } finally {
      if (busy) setBusy(false);
    }
  }

  function conflict(cur) {
    bar('warn', cur
      ? 'Not published: someone else published a newer menu at <b>' + esc(when(cur.t)) + '</b>, after you opened this editor. Load it first, then make your change again. Your edits are kept in <b>History</b> on this device.'
      : 'Not published: the published menu changed after you opened this editor. Load the latest first.',
    [['Load the latest menu', () => loadLatest('My edits, before loading the latest menu')]]);
  }

  // ---------------- picking up newer publishes ----------------
  async function loadLatest(keepLabel) {
    let r;
    try { r = await getLatest(); } catch (e) { bar('bad', 'Couldn’t load the latest menu (' + esc(reason(e)) + ').', [['Try again', () => loadLatest(keepLabel)]]); return; }
    if (r.status === 404) { loadedT = null; status = 'none'; clearBar(); render(); return; }
    loadedT = r.body.t;
    if (r.body.base !== base) { status = 'mismatch'; mismatchRec = r.body; render(); bar('warn', 'The latest published menu was made for a different version of this menu’s PDF, so it can’t be shown here.'); return; }
    if (dirty()) hooks.keep(keepLabel || 'My edits, before loading the latest menu');
    hooks.apply(r.body.state);
    status = 'live'; mismatchRec = null;
    markClean();
    bar('ok', 'Showing the menu published at ' + esc(when(loadedT)) + '.', [], 6000);
  }
  async function checkForNewer() {
    if (!hooks || busy || status === 'offline' || status === 'loading') return;
    let r;
    try { r = await getJSON(API + encodeURIComponent(editor)); } catch { return; }
    if (r.status !== 200 || !r.body || r.body.t === loadedT) return;
    if (!dirty()) { loadLatest(); return; }              // nothing of ours to lose: just update
    bar('info', 'A newer menu was published at <b>' + esc(when(r.body.t)) + '</b> on another device. Load it before you publish — your edits will be kept in <b>History</b>.',
      [['Load it', () => loadLatest('My edits, before loading the latest menu')]]);
  }

  // ---------------- versions ----------------
  async function openVersions() {
    closeVersions();
    const panel = document.createElement('div'); panel.id = 'verpanel';
    panel.innerHTML = '<h4>Published versions</h4><div class="vrow empty">Loading…</div>';
    document.body.appendChild(panel);
    const chip = $('#livechip').getBoundingClientRect();
    panel.style.top = (chip.bottom + 8) + 'px';
    panel.style.right = Math.max(12, innerWidth - chip.right) + 'px';
    setTimeout(() => document.addEventListener('click', outside), 0);
    let list;
    try { const r = await getJSON(API + encodeURIComponent(editor) + '?history=1'); if (!r.ok) throw new Error(r.body && r.body.error); list = r.body.versions; }
    catch (e) { panel.querySelector('.vrow').textContent = 'Couldn’t load versions (' + reason(e) + ').'; return; }
    if (!list.length) { panel.querySelector('.vrow').textContent = 'Nothing has been published yet.'; return; }
    panel.innerHTML = '<h4>Published versions</h4>' + list.map((v) =>
      '<div class="vrow" data-t="' + v.t + '"><div class="vl"><div>' + esc(when(v.t)) + (v.current ? ' <span class="vcur">live</span>' : '') + (v.base !== base ? ' <span class="vold">older PDF</span>' : '') + '</div>'
      + '<div class="vm">' + (v.drinks != null ? v.drinks + ' drinks' : v.edits + ' edits · ' + v.removed + ' removed · ' + v.added + ' added') + '</div></div>'
      + (v.base === base && v.t !== loadedT ? '<button type="button" data-load="' + v.t + '">Load</button>' : '') + '</div>').join('')
      + '<p class="vnote">Loading a version puts it in the editor. Nobody else sees it until you Publish.</p>';
    panel.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => loadVersion(+b.dataset.load)));
  }
  function outside(e) { const p = $('#verpanel'); if (p && !p.contains(e.target) && e.target.id !== 'livechip') closeVersions(); }
  function closeVersions() { const p = $('#verpanel'); if (p) p.remove(); document.removeEventListener('click', outside); }
  async function loadVersion(t) {
    closeVersions();
    let r;
    try { r = await getJSON(API + encodeURIComponent(editor) + '?v=' + t); if (!r.ok) throw new Error(r.body && r.body.error); }
    catch (e) { bar('bad', 'Couldn’t load that version (' + esc(reason(e)) + ').'); return; }
    if (dirty()) hooks.keep('My edits, before loading the version from ' + when(t));
    hooks.apply(r.body.state);
    render();
    bar('info', 'Loaded the version from <b>' + esc(when(t)) + '</b>. Nobody else sees it until you <b>Publish</b>.', [], 8000);
  }

  return {
    boot, ready, render,
    notice: bar,
    touch: () => render(),
    version: () => loadedT,
    status: () => status,
    dirty,
  };
})();
