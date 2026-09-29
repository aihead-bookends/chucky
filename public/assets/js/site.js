/* Shared by the landing, hub and secret-menu pages. */

// Pointer-tracked tilt on .tile cards. Off for touch screens and reduced motion.
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(hover: none)').matches) return;
  document.querySelectorAll('.tile').forEach((t) => {
    let raf = 0;
    t.addEventListener('pointermove', (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = t.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
        t.style.transform = `translateY(-6px) rotateX(${(-py * 5).toFixed(2)}deg) rotateY(${(px * 6).toFixed(2)}deg)`;
      });
    });
    t.addEventListener('pointerleave', () => { cancelAnimationFrame(raf); t.style.transform = ''; });
  });
})();

// SHA-256 in plain JS, for when crypto.subtle is missing: browsers only provide it on https and
// localhost, so a phone opening the dev server by its network address (http://172.16.x.x:3000)
// has none. Round constants are derived, not typed out: the fractional parts of the square and
// cube roots of the first primes, as the standard defines them.
function sha256Hex(text) {
  const primes = []; for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  const frac = (x) => ((x - Math.floor(x)) * 2 ** 32) | 0;
  const K = primes.map((p) => frac(Math.cbrt(p)));
  const H = primes.slice(0, 8).map((p) => frac(Math.sqrt(p)));
  const bytes = new TextEncoder().encode(text), len = bytes.length;
  const size = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(size); msg.set(bytes); msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(size - 8, Math.floor(len / 2 ** 29)); view.setUint32(size - 4, (len * 8) >>> 0);
  const w = new Int32Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < size; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getInt32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, k) => { H[k] = (H[k] + v) | 0; });
  }
  return H.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

// Staff passphrase. A client-side check only: it keeps casual visitors out of the editor picker
// and the back door, it is not access control. The hash is SHA-256 of the passphrase.
window.ChuckyGate = {
  HASH: 'f76660f75ff19a500e061678a57a50c9ad0bba521cb5a2b7d91733c6dbb55855',
  KEY: 'galley_auth',
  unlocked() { try { return sessionStorage.getItem(this.KEY) === '1'; } catch { return false; } },
  lock() { try { sessionStorage.removeItem(this.KEY); } catch { /* storage blocked */ } },
  async check(phrase) {
    let hex;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phrase.trim()));
      hex = [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
    } else hex = sha256Hex(phrase.trim());      // plain http on a network address (see sha256Hex)
    if (hex !== this.HASH) return false;
    try { sessionStorage.setItem(this.KEY, '1'); } catch { /* storage blocked: unlocked for this page only */ }
    return true;
  },
  shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); },
};
