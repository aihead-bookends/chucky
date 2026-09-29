/* "Report a bug" on every editor: a floating button and a short form. Sends POST /api/bug with the
   editor, page, description and URL, plus the current edit state and a preview snapshot when the
   editor provides them (window.CHUCKY_CTX, set by editor.js). Reports land on the /bugs/ dashboard. */
(function () {
  const ctx = () => window.CHUCKY_CTX || {};
  const call = (fn) => { try { return typeof fn === 'function' ? fn() : null; } catch { return null; } };

  document.body.insertAdjacentHTML('beforeend', `
<button id="bugbtn" type="button">🐞 Report a bug</button>
<div id="bugmodal" role="dialog" aria-modal="true" aria-labelledby="bugtitle"><div id="bugcard">
  <h2 id="bugtitle">Report a bug</h2>
  <p>Describe what looks wrong. Your current edits (and a snapshot of the preview, when there is one) are attached, so it can be reproduced without you re-doing anything.</p>
  <textarea id="bugdesc" maxlength="2000" placeholder="e.g. after removing a drink and adding one, the new drink overlaps the last line"></textarea>
  <div class="r"><span id="bugnote" aria-live="polite"></span><button type="button" id="bugcancel">Cancel</button><button type="button" class="pri" id="bugsend">Send report</button></div>
</div></div>`);

  const $ = (s) => document.querySelector(s);
  const modal = $('#bugmodal'), desc = $('#bugdesc'), note = $('#bugnote'), send = $('#bugsend');
  const setNote = (text, cls = '') => { note.textContent = text; note.className = cls; };

  const open = () => {
    modal.classList.add('on');
    setNote(call(ctx().shot) ? '✓ preview snapshot attached' : '', 'ok');
    desc.focus();
  };
  const close = () => { modal.classList.remove('on'); $('#bugbtn').focus(); };

  $('#bugbtn').addEventListener('click', open);
  $('#bugcancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('on')) close(); });

  send.addEventListener('click', async () => {
    const text = desc.value.trim();
    if (!text) { desc.focus(); setNote('Add a short description first.', 'bad'); return; }
    send.disabled = true; send.textContent = 'Sending…'; setNote('');
    const c = ctx();
    const payload = {
      editor: c.editor || location.pathname,
      page: call(c.page),
      desc: text,
      url: location.href,
      state: call(c.state),
      shot: call(c.shot),
    };
    try {
      const res = await fetch('/api/bug', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(res.status === 503 ? 'The bug queue isn’t connected yet.' : body.error || 'Server said ' + res.status);
      send.textContent = 'Sent ✓'; setNote('Thanks — it’s in the queue.', 'ok');
      setTimeout(() => { close(); desc.value = ''; setNote(''); send.textContent = 'Send report'; send.disabled = false; }, 1200);
    } catch (e) {
      setNote(e.name === 'TypeError' ? 'Couldn’t reach the server — offline?' : e.message, 'bad');
      send.textContent = 'Send report'; send.disabled = false;
    }
  });
})();
