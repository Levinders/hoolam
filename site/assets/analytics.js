/*
 * Hoolam analytics: Google Analytics 4 with consent mode, plus the cookie banner and the events we count.
 *
 * The page's <head> already set every Google consent to "denied" and loaded the Google tag, so before anyone
 * chooses, GA only gets cookieless pings. This script:
 *   - shows a small banner (once) asking to allow analytics cookies, and remembers the answer in the
 *     hoolam_consent cookie (on .hoolam.com, so hoolam.com and sellers' pages share it, for a year);
 *   - on Allow, turns analytics cookies on; on "Not now", keeps them off;
 *   - counts the things that matter: WhatsApp taps, live chats, the price calculator, questions opened,
 *     email / phone / map taps, social links, and how far people read the home page (each section once).
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
    if (host) { host.hidden = false; host.style.display = ''; return; }
    host = document.createElement('div');
    host.id = 'hoolam-consent';
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = '<style>' +
      ':host{all:initial}:host([hidden]){display:none!important}' +
      '.c{position:fixed;z-index:2147482000;left:16px;bottom:16px;width:360px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:18px;border-radius:18px;background:#1B2321;color:#fff;' +
      'box-shadow:0 22px 48px -20px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.06);font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;animation:in .3s cubic-bezier(.22,.8,.24,1)}' +
      '@keyframes in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
      'h2{margin:0 0 4px;font:600 15px/1.35 Poppins,Inter,system-ui,sans-serif;letter-spacing:-.01em;color:#fff}' +
      'p{margin:0 0 14px;color:#C5CFCC}a{color:#fff;font-weight:600;text-decoration:underline;text-decoration-color:rgba(255,255,255,.35);text-underline-offset:3px}a:hover{text-decoration-color:#fff}' +
      '.r{display:flex;gap:8px}' +
      'button{flex:1;font:600 14px/1 Inter,system-ui,sans-serif;border-radius:11px;height:42px;padding:0 16px;cursor:pointer;border:0}' +
      '.y{background:#C9992E;color:#1B2321}.y:hover{background:#D9AB41}' +
      '.n{background:transparent;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.26)}.n:hover{background:rgba(255,255,255,.07)}' +
      'button:focus-visible,a:focus-visible{outline:2px solid #C9992E;outline-offset:2px}' +
      '@media (max-width:520px){.c{left:12px;right:84px;bottom:12px;width:auto;max-width:none;padding:16px}}' +
      '@media (prefers-reduced-motion:reduce){.c{animation:none}}' +
      '</style>' +
      '<div class="c" role="dialog" aria-live="polite" aria-labelledby="t">' +
      '<h2 id="t">Help us make Hoolam better for you.</h2>' +
      '<p>Allow cookies so we can see what works and fix what doesn\u2019t. <a href="' + COOKIES_URL + '">Cookies</a></p>' +
      '<div class="r"><button class="y" data-v="yes">Allow</button><button class="n" data-v="no">Not now</button></div></div>';
    root.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { var v = b.getAttribute('data-v'); save(v); apply(v); host.hidden = true; host.style.display = 'none'; gtag('event', v === 'yes' ? 'consent_accept' : 'consent_decline'); });
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
    if (a.hasAttribute('data-social')) return send('seller_social_click', { network: a.getAttribute('data-social') });
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

  // how far people read the home page: each section counted once, when it comes into view
  var SECTIONS = [['.hero', 'Hero'], ['section.old', 'True life story'], ['#journey .journey-intro', 'How it works'],
    ['#step-1', 'Step 1'], ['#step-2', 'Step 2'], ['#step-3', 'Step 3'], ['#step-4', 'Step 4'], ['#step-5', 'Step 5'],
    ['#pricing', 'Pricing'], ['#trust', 'Why trust us'], ['section.voices', 'In their own words'], ['#faq', 'Questions'], ['section.close', 'Closing']];
  ready(function () {
    if (!('IntersectionObserver' in window) || !document.getElementById('journey')) return; // the home page only
    var seen = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var i = Number(en.target.getAttribute('data-hl-sec'));
        if (seen[i]) return;
        seen[i] = true; io.unobserve(en.target);
        send('section_view', { section: SECTIONS[i][1], section_index: i + 1 });
      });
    }, { rootMargin: '0px 0px -40% 0px' }); // counted once its top reaches 60% down the screen (works for tall sections too)
    SECTIONS.forEach(function (s, i) {
      var el = document.querySelector(s[0]);
      if (el && !el.hidden) { el.setAttribute('data-hl-sec', String(i)); io.observe(el); }
    });
  });

  // the live chat on the page (chat.js says when it opens and when a chat starts)
  window.addEventListener('hoolam:chat', function (e) {
    var act = e.detail && e.detail.action;
    if (act) send('chat_' + act);
  });
})();
