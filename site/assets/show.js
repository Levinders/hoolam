/*
 * What the website shows from the chat (built from the server's site.json `show`, kept in window.HOOLAM_SHOW):
 *   - [data-voice="<slot>"]   a voice note button: shows only once that voice note is uploaded (Console → Settings →
 *                             WhatsApp) and the browser can play it; tap to play or pause; one plays at a time.
 *   - [data-proof]            live numbers from real orders: each [data-n="completed|started|refunded|ambPaid"] shows
 *                             only when the server says it may; the whole block stays hidden until one does.
 *                             Numbers count up once when they come into view (not with reduced motion).
 * The numbers baked in when the site was built show straight away, then the server's fresher ones replace them.
 */
(function () {
  var S = window.HOOLAM_SHOW || {};
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- voice notes ----------
  var playing = null;
  function fmt(t) { if (!isFinite(t) || t <= 0) return ''; t = Math.round(t); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }
  document.querySelectorAll('[data-voice]').forEach(function (btn) {
    var v = (S.voices || {})[btn.getAttribute('data-voice')];
    if (!v || !v.src) return;
    var a = document.createElement('audio');
    if (v.mime && !a.canPlayType(v.mime)) return;
    a.preload = 'none'; a.src = v.src;
    var time = btn.querySelector('[data-time]'), label = btn.querySelector('[data-label]');
    var idle = label ? label.textContent : '';
    btn.hidden = false;
    btn.setAttribute('aria-pressed', 'false');
    function set(on) {
      btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on));
      if (label) label.textContent = on ? 'Playing… tap to pause' : idle;
    }
    a.addEventListener('loadedmetadata', function () { if (time && fmt(a.duration)) time.textContent = fmt(a.duration); });
    a.addEventListener('timeupdate', function () { btn.style.setProperty('--p', a.duration ? (a.currentTime / a.duration).toFixed(3) : 0); if (time && a.duration) time.textContent = fmt(a.duration - a.currentTime) || time.textContent; });
    a.addEventListener('ended', function () { set(false); btn.style.setProperty('--p', 0); a.currentTime = 0; if (time) time.textContent = fmt(a.duration); playing = null; });
    a.addEventListener('pause', function () { set(false); });
    a.addEventListener('play', function () { set(true); });
    btn.addEventListener('click', function () {
      if (playing && playing !== a) playing.pause();
      if (a.paused) { playing = a; a.play().catch(function () { set(false); }); if (window.gtag) gtag('event', 'voice_play', { voice: btn.getAttribute('data-voice') }); }
      else a.pause();
    });
  });

  // ---------- live numbers ----------
  var blocks = [].slice.call(document.querySelectorAll('[data-proof]'));
  if (!blocks.length) return;
  function text(n, money) {
    var s = n >= 10000 ? Math.floor(n / 100) * 100 : n; // big numbers rounded down, never up
    var t = s.toLocaleString('en-NG');
    return (money ? '₦' : '') + t + (s !== n ? '+' : '');
  }
  function count(el, n, money) {
    el.textContent = text(n, money); // the real number first; the count-up is only a flourish
    if (reduce || !('IntersectionObserver' in window) || el.dataset.done) return;
    var io = new IntersectionObserver(function (es) {
      if (!es[0].isIntersecting) return;
      io.disconnect(); el.dataset.done = '1';
      var t0 = performance.now(), D = 1100;
      (function step(t) { var k = Math.min(1, (t - t0) / D); k = 1 - Math.pow(1 - k, 3); el.textContent = text(Math.round(n * k), money); if (k < 1) requestAnimationFrame(step); })(t0);
    }, { threshold: 0.4 });
    io.observe(el);
  }
  function show(p) {
    if (!p) return;
    blocks.forEach(function (b) {
      var any = false;
      b.querySelectorAll('[data-n]').forEach(function (item) {
        var n = p[item.getAttribute('data-n')];
        var ok = typeof n === 'number' && n > 0;
        item.hidden = !ok;
        if (!ok) return;
        any = true;
        var el = item.querySelector('[data-v]');
        if (el && el.getAttribute('data-was') !== String(n)) { el.setAttribute('data-was', String(n)); count(el, n, item.hasAttribute('data-money')); }
      });
      b.hidden = !any;
    });
  }
  show(S.proof);
  if (S.api) fetch(S.api + '/site/proof.json', { mode: 'cors' }).then(function (r) { return r.ok ? r.json() : null; }).then(show).catch(function () {});
})();
