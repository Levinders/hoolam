/*
 * Hoolam analytics: Google Analytics 4 with consent mode, plus the cookie banner and the events we count.
 *
 * The page's <head> already set every Google consent to "denied" and loaded the Google tag, so before anyone
 * chooses, GA only gets cookieless pings. This script:
 *   - shows a small banner (once) asking to allow analytics cookies, and remembers the answer in the
 *     hoolam_consent cookie (on .hoolam.com, so hoolam.com and sellers' pages share it, for a year);
 *   - on Accept, turns analytics cookies on; on "No, thanks", keeps them off;
 *   - counts the things that matter: WhatsApp taps, live chats, the price calculator, questions opened,
 *     email / phone / map taps, social links.
 * Any element with data-consent-open (the Cookies page has one) opens the banner again.
 */
(function () {
  if (window.__hoolamAnalytics) return;
  window.__hoolamAnalytics = true;
  var gtag = window.gtag || function () { (window.dataLayer = window.dataLayer || []).push(arguments); };
  var me = document.currentScript;
  var COOKIES_URL = (me && me.getAttribute('data-cookies')) || '/legal/cookies/';
  var PAGE = window.HOOLAM_PAGE || {};

  // ---------- consent ----------
  var NAME = 'hoolam_consent';
  function read() { var m = document.cookie.match(/(?:^|;\s*)hoolam_consent=(yes|no)/); return m ? m[1] : null; }
  function save(v) {
    var host = location.hostname, domain = /(^|\.)hoolam\.com$/.test(host) ? '; domain=.hoolam.com' : '';
    document.cookie = NAME + '=' + v + '; max-age=' + 60 * 60 * 24 * 365 + '; path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '') + domain;
  }
  function apply(v) { gtag('consent', 'update', { analytics_storage: v === 'yes' ? 'granted' : 'denied' }); }

  var host, root;
  function banner() {
    if (host) { host.hidden = false; return; }
    host = document.createElement('div');
    host.id = 'hoolam-consent';
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = '<style>' +
      ':host{all:initial}' +
      '.c{position:fixed;z-index:2147482000;left:16px;bottom:16px;max-width:380px;box-sizing:border-box;padding:16px 16px 14px;border-radius:16px;background:#FFFDF9;color:#1B2321;' +
      'box-shadow:0 18px 40px -18px rgba(8,62,67,.45),0 0 0 1px #E8E1D5;font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;animation:in .3s cubic-bezier(.22,.8,.24,1)}' +
      '@keyframes in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
      'p{margin:0 0 12px}b{font-weight:600}a{color:#0E5C63;font-weight:600}' +
      '.r{display:flex;gap:8px;align-items:center}' +
      'button{font:600 14px/1 Inter,system-ui,sans-serif;border-radius:10px;padding:11px 16px;cursor:pointer;border:0}' +
      '.y{background:#0E5C63;color:#fff}.y:hover{background:#0A464B}' +
      '.n{background:transparent;color:#1B2321;box-shadow:inset 0 0 0 1px #E8E1D5}.n:hover{background:#F3EDE3}' +
      'button:focus-visible,a:focus-visible{outline:2px solid #C9992E;outline-offset:2px}' +
      '@media (max-width:520px){.c{left:12px;right:84px;bottom:12px;max-width:none;padding:14px}.r{flex-wrap:wrap}button{flex:1}}' +
      '@media (prefers-reduced-motion:reduce){.c{animation:none}}' +
      '</style>' +
      '<div class="c" role="dialog" aria-live="polite" aria-label="Cookies on Hoolam">' +
      '<p><b>Can we count your visit?</b> We use analytics cookies to see how people use this site, so we can make it better. No ads, and we never sell your data. <a href="' + COOKIES_URL + '">Cookies</a></p>' +
      '<div class="r"><button class="y" data-v="yes">Accept</button><button class="n" data-v="no">No, thanks</button></div></div>';
    root.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { var v = b.getAttribute('data-v'); save(v); apply(v); host.hidden = true; gtag('event', v === 'yes' ? 'consent_accept' : 'consent_decline'); });
    });
    document.body.appendChild(host);
  }
  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
  ready(function () {
    if (!read()) banner();
    document.addEventListener('click', function (e) {
      var o = e.target && e.target.closest && e.target.closest('[data-consent-open]');
      if (o) { e.preventDefault(); banner(); }
    });
  });

  // ---------- events ----------
  function send(name, params) {
    params = params || {};
    if (PAGE.seller) params.seller = PAGE.seller;
    gtag('event', name, params);
  }
  function where(el) {
    var s = el.closest('section[id], header, footer, nav, aside');
    return s ? (s.id || s.tagName.toLowerCase()) : 'page';
  }
  function text(el) { return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80); }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a, button');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (a.hasAttribute('data-live-chat')) return send('live_chat_click', { link_text: text(a), section: where(a) });
    if (/wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//.test(href) || a.hasAttribute('data-wa')) return send('whatsapp_click', { link_text: text(a), section: where(a) });
    if (/^mailto:/.test(href)) return send('email_click', { section: where(a) });
    if (/^tel:/.test(href)) return send('phone_click', { section: where(a) });
    if (/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/.test(href)) return send('map_click', { section: where(a) });
    var social = href.match(/\/\/(?:www\.|m\.)?(instagram|tiktok|facebook|x|twitter|linkedin|youtube)\.com/);
    if (social) return send(PAGE.seller ? 'seller_social_click' : 'social_click', { network: social[1] === 'twitter' ? 'x' : social[1] });
  }, true);

  // questions opened (the home page's FAQ)
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d && d.tagName === 'DETAILS' && d.open && d.closest('#faq')) {
      var s = d.querySelector('summary');
      send('faq_open', { question: s ? text(s) : '' });
    }
  }, true);

  // the price calculator: counted once per visit to the page
  var calcDone = false;
  function calc(e) { if (!calcDone && e.target && e.target.closest && e.target.closest('.calc')) { calcDone = true; send('calculator_use'); } }
  document.addEventListener('input', calc, true);
  document.addEventListener('click', calc, true);

  // the live chat on the page (chat.js says when it opens and when a chat starts)
  window.addEventListener('hoolam:chat', function (e) {
    var act = e.detail && e.detail.action;
    if (act) send('chat_' + act);
  });
})();
