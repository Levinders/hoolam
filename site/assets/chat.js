/*
 * Hoolam live chat on the website. One script, no libraries, drawn inside its own shadow root so the page's styles
 * never touch it (and it never touches the page). The page adds:
 *   <script src="/assets/chat.js" data-api="https://…" data-logo="…" data-wa="https://wa.me/…" defer></script>
 * and anything can open it with window.HoolamChat.open().
 */
(function () {
  'use strict';
  if (window.HoolamChat) return;
  var me = document.currentScript || document.querySelector('script[data-hoolam-chat]');
  var API = ((me && me.getAttribute('data-api')) || '').replace(/\/+$/, '') + '/livechat';
  var LOGO = (me && me.getAttribute('data-logo')) || '';
  var WA = (me && me.getAttribute('data-wa')) || '';
  var KEY_STORE = 'hoolam:chat:key';

  // ---------- small helpers ----------
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private window */ } },
  };
  var key = store.get(KEY_STORE);
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function linkify(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
  }
  function first(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function hhmm(at) { try { return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function dayOf(at) {
    var d = new Date(at), n = new Date(), y = new Date(); y.setDate(n.getDate() - 1);
    if (d.toDateString() === n.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function ago(at) {
    var s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return dayOf(at);
  }
  function req(path, opts) {
    opts = opts || {};
    var headers = {};
    if (key) headers['x-chat-key'] = key;
    if (opts.body !== undefined && !(opts.body instanceof Blob)) headers['content-type'] = 'application/json';
    if (opts.headers) for (var h in opts.headers) headers[h] = opts.headers[h];
    return fetch(API + path, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: headers, mode: 'cors', credentials: 'omit',
      body: opts.body === undefined ? undefined : opts.body instanceof Blob ? opts.body : JSON.stringify(opts.body),
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = null; }
        if (r.status === 401 && key) { key = null; store.set(KEY_STORE, null); }
        if (!r.ok) { var err = new Error((d && d.error) || 'Something went wrong. Please try again.'); err.status = r.status; throw err; }
        return d;
      });
    });
  }
  var I = {
    chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .7-1.5l7-6a2 2 0 0 1 2.6 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    news: '<path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    send: '<path d="M14.5 21.7a.5.5 0 0 0 .9 0l6.5-19a.5.5 0 0 0-.6-.6l-19 6.5a.5.5 0 0 0 0 .9l7.9 3.2a2 2 0 0 1 1.1 1.1z"/><path d="m21.9 2.1-10.9 10.9"/>',
    clip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    up: '<path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8A2 2 0 0 1 17.4 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/>',
    down: '<path d="M17 14V2M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-8A2 2 0 0 1 6.6 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9Z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    wa: null,
  };
  function ic(name, cls) {
    if (name === 'wa') return '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.8-1.2.2-.6.2-1.1.1-1.2l-.4-.3z"/></svg>';
    return '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[name] + '</svg>';
  }
  /** Hoolam's mark: the logo from the console for this page, or the drawing. */
  function mark(size) {
    if (LOGO) return '<img class="mark" src="' + esc(LOGO) + '" width="' + size + '" height="' + size + '" alt="">';
    return '<svg class="mark" width="' + size + '" height="' + size + '" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="18" fill="#0E5C63"/><g transform="translate(12 12) scale(1.6667)"><circle cx="12" cy="8.5" r="3.7" fill="#C9992E"/><path d="M3.5 12.5c0 4.4 3.8 7.5 8.5 7.5s8.5-3.1 8.5-7.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g></svg>';
  }

  // ---------- state ----------
  // ---------- state ----------
  // One conversation per WhatsApp number: `thread` is it (or null before their first message).
  var S = {
    open: false, tab: 'home', cfg: null, visitor: null, threads: [], thread: null,
    openQ: null, qSearch: '', draft: '', name: '', phone: '', err: '', busy: false,
    typingAt: 0, typingName: '', unread: 0, es: null, lastTyping: 0,
  };

  // ---------- the host and its shadow root ----------
  var host = document.createElement('div');
  host.id = 'hoolam-chat';
  host.style.cssText = 'position:fixed;z-index:2147483000;right:0;bottom:0;width:0;height:0';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var css = document.createElement('style');
  css.textContent = CSS();
  root.appendChild(css);
  var shell = document.createElement('div');
  shell.className = 'hc';
  root.appendChild(shell);
  function mount() { if (!host.isConnected) document.body.appendChild(host); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // ---------- data ----------
  function loadConfig() { return req('/config').then(function (c) { S.cfg = c; render(); }).catch(function () { /* the server may be waking up */ }); }
  function loadMe() {
    if (!key) return Promise.resolve();
    return req('/me').then(function (r) {
      S.visitor = r.visitor; S.threads = r.threads || [];
      S.unread = S.threads.reduce(function (n, t) { return n + (t.unread || 0); }, 0);
      render(); connect();
    }).catch(function () { render(); });
  }
  function loadThread() {
    var t = S.threads[0];
    if (!t) return Promise.resolve();
    return req('/threads/' + t.id).then(function (x) { S.thread = x; render(true); markSeen(); }).catch(function (e) { S.err = e.message; render(); });
  }
  function connect() {
    if (!key || S.es || typeof EventSource === 'undefined') return;
    var es = new EventSource(API + '/events?key=' + encodeURIComponent(key));
    S.es = es;
    es.addEventListener('message', function (ev) {
      var d = JSON.parse(ev.data);
      if (S.thread && d.threadId === S.thread.id) {
        if (!S.thread.messages.some(function (m) { return m.id === d.message.id; })) S.thread.messages.push(d.message);
        if (d.message.kind === 'STAFF') S.typingAt = 0;
        if (d.message.kind === 'SYSTEM') loadThread();
        render(true); markSeen();
      }
      if (d.message.kind === 'STAFF' && !(S.open && S.tab === 'messages' && !document.hidden)) { S.unread++; ping(); }
      loadMe();
    });
    es.addEventListener('typing', function (ev) {
      var d = JSON.parse(ev.data);
      if (S.thread && d.threadId === S.thread.id) { S.typingAt = Date.now(); S.typingName = d.name || ''; render(true); setTimeout(render, 5200); }
    });
    es.addEventListener('seen', function (ev) {
      var d = JSON.parse(ev.data);
      if (S.thread && d.threadId === S.thread.id) { S.thread.seenUpTo = d.upTo; render(); }
    });
    es.addEventListener('thread', function (ev) {
      var d = JSON.parse(ev.data);
      if (S.thread && d.threadId === S.thread.id) loadThread();
    });
    es.onerror = function () { if (!key) { es.close(); S.es = null; } };
  }
  function markSeen() {
    if (!S.open || S.tab !== 'messages' || !S.thread || document.hidden) return;
    var last = 0;
    S.thread.messages.forEach(function (m) { if (m.kind !== 'VISITOR') last = Math.max(last, m.id); });
    if (!last) return;
    req('/threads/' + S.thread.id + '/seen', { body: { upTo: last } }).catch(function () {});
    S.threads.forEach(function (t) { t.unread = 0; });
    S.unread = 0;
    renderBadge();
  }
  /** A soft tick when a rep replies while the chat is closed (or on another tab). */
  function ping() {
    renderBadge();
    try {
      var AC = window.AudioContext || window.webkitAudioContext; var ctx = new AC();
      var o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = 988;
      g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.32); setTimeout(function () { ctx.close(); }, 600);
    } catch (e) { /* no sound */ }
  }

  // ---------- actions ----------
  function openChat(tab) {
    if (!S.open) S.anim = true;
    S.open = true; if (tab) S.tab = tab;
    if (!S.cfg) loadConfig();
    if (S.tab === 'messages') goMessages(); else render();
    lockScroll(true);
  }
  function closeChat() { S.open = false; render(); lockScroll(false); }
  /** On phones the chat covers the page: stop the page underneath from scrolling. */
  function lockScroll(on) {
    if (window.innerWidth > 520) return;
    try { document.documentElement.style.overflow = on ? 'hidden' : ''; } catch (e) { /* ignore */ }
  }
  function goMessages() {
    S.tab = 'messages'; S.err = '';
    render(true);
    if (S.threads[0] && !S.thread) loadThread();
    else markSeen();
    focusBox();
  }
  function focusBox() { setTimeout(function () { var t = root.querySelector('#hc-box, #hc-name'); if (t && window.innerWidth > 520) t.focus(); }, 40); }
  // clear the typed message (the box too, since drawing keeps what is in it)
  function clearDraft() { S.draft = ''; ['hc-box', 'hc-first'].forEach(function (id) { var el = root.querySelector('#' + id); if (el) el.value = ''; }); }
  function send(text) {
    text = String(text || '').trim();
    if (!text || S.busy) return;
    S.err = '';
    // first time on this browser: the details form sends it
    if (!key || !S.visitor) { S.draft = text; render(); focusBox(); return; }
    if (!S.thread) return start(text, S.visitor.name, S.visitor.phone);
    S.busy = true; clearDraft(); render();
    req('/threads/' + S.thread.id + '/messages', { body: { text: text } })
      .then(function () { S.busy = false; render(true); })
      .catch(function (e) { S.busy = false; S.draft = text; S.err = e.message; render(); });
  }
  function start(text, name, phone) {
    S.busy = true; render();
    req('/start', { body: { name: name, phone: phone, text: text, page: location.pathname } }).then(function (r) {
      if (r.key) { key = r.key; store.set(KEY_STORE, key); if (S.es) { S.es.close(); S.es = null; } }
      S.busy = false; clearDraft();
      return loadMe().then(loadThread).then(focusBox);
    }).catch(function (e) { S.busy = false; S.err = e.message; render(); });
  }
  function upload(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { S.err = 'Files can be up to 10 MB.'; return render(); }
    if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.type)) { S.err = 'Send a photo (JPG, PNG or WebP) or a PDF.'; return render(); }
    if (!S.thread) { S.err = 'Send a message first, then add your file.'; return render(); }
    S.busy = true; S.err = ''; render();
    req('/threads/' + S.thread.id + '/files', { body: file, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) } })
      .then(function () { S.busy = false; render(true); })
      .catch(function (e) { S.busy = false; S.err = e.message; render(); });
  }
  function typing() {
    if (!S.thread || Date.now() - S.lastTyping < 3000) return;
    S.lastTyping = Date.now();
    req('/threads/' + S.thread.id + '/typing', { body: {} }).catch(function () {});
  }

  // ---------- drawing ----------
  var scrollNext = false;
  function render(scroll) {
    if (scroll) scrollNext = true;
    var focused = root.activeElement && root.activeElement.id;
    var keep = function (id, k) { var el = root.querySelector('#' + id); if (el) S[k] = el.value; };
    keep('hc-box', 'draft'); keep('hc-first', 'draft'); keep('hc-name', 'name'); keep('hc-phone', 'phone'); keep('hc-q', 'qSearch');
    // keep where they were reading (or stay at the bottom, if they were there)
    var oldMsgs = root.querySelector('.msgs'), oldBody = root.querySelector('.body');
    var atBottom = !oldMsgs || oldMsgs.scrollHeight - oldMsgs.scrollTop - oldMsgs.clientHeight < 60;
    var msgsTop = oldMsgs ? oldMsgs.scrollTop : 0, bodyTop = oldBody ? oldBody.scrollTop : 0;
    shell.innerHTML = launcher() + (S.open ? '<div class="veil' + (S.anim ? ' anim' : '') + '" data-act="close"><span class="ghost" aria-hidden="true">' + mark(132) + '</span></div>' + panel() : '');
    if (S.anim) { var pn = root.querySelector('.panel'); if (pn) pn.classList.add('anim'); S.anim = false; }
    bind();
    if (focused) { var f = root.querySelector('#' + focused); if (f) { f.focus(); if (f.setSelectionRange && f.value) f.setSelectionRange(f.value.length, f.value.length); } }
    var list = root.querySelector('.msgs'), body = root.querySelector('.body');
    if (list) list.scrollTop = scrollNext || (oldMsgs && atBottom) ? list.scrollHeight : msgsTop;
    if (body && !list && oldBody) body.scrollTop = bodyTop;
    scrollNext = false;
  }
  function renderBadge() { var b = root.querySelector('.launch .badge'); if (b) { b.textContent = S.unread > 9 ? '9+' : S.unread; b.hidden = !S.unread; } else render(); }
  function launcher() {
    return '<button class="launch' + (S.open ? ' is-open' : '') + '" aria-label="' + (S.open ? 'Close chat' : 'Chat with Hoolam') + '" data-act="toggle">' +
      (S.open ? ic('x') : ic('chat')) + '<span class="badge"' + (S.unread && !S.open ? '' : ' hidden') + '>' + (S.unread > 9 ? '9+' : S.unread) + '</span></button>';
  }
  function hours() {
    var h = S.cfg && S.cfg.hours;
    if (!h) return '';
    return h.open ? '<span class="status on">Reps are online · usually reply in ' + esc(S.cfg.replyMinutes || 15) + ' min</span>'
      : '<span class="status">Reps are back at ' + esc(h.opens) + '. Leave a message.</span>';
  }
  function welcome() { return (S.cfg && S.cfg.welcome) || 'How can we help today?'; }
  function panel() {
    if (S.tab === 'messages') return '<section class="panel" role="dialog" aria-label="Chat with Hoolam">' + conversation() + '</section>';
    var title = { questions: 'Questions', news: 'News' }[S.tab];
    var head = S.tab === 'home'
      ? '<header class="head big"><div class="brand">' + mark(34) + '<button class="x" data-act="close" aria-label="Close chat">' + ic('x') + '</button></div>' +
        '<h2>' + esc(S.visitor && S.visitor.name ? 'Hi ' + first(S.visitor.name) + '.' : 'Hi there.') + '</h2><p>' + esc(welcome().replace(/^(hi|hello)( there)?[.,!]?\s*/i, '')) + '</p>' + hours() + '</header>'
      : '<header class="head"><div class="brand">' + mark(30) + '<h2 class="small">' + title + '</h2><button class="x" data-act="close" aria-label="Close chat">' + ic('x') + '</button></div></header>';
    var body = S.tab === 'home' ? homeTab() : S.tab === 'questions' ? questionsTab() : newsTab();
    return '<section class="panel" role="dialog" aria-label="Chat with Hoolam">' + head + '<div class="body">' + body + '</div>' +
      '<nav class="tabs" role="tablist">' + tab('home', 'Home', 'home') + tab('messages', 'Messages', 'chat', S.unread) + tab('questions', 'Questions', 'help') + tab('news', 'News', 'news') + '</nav></section>';
  }
  function tab(k, label, icon, n) {
    return '<button role="tab" aria-selected="' + (S.tab === k) + '" class="' + (S.tab === k ? 'on' : '') + '" data-tab="' + k + '">' + ic(icon) + '<span>' + label + '</span>' + (n ? '<i class="n">' + n + '</i>' : '') + '</button>';
  }
  function homeTab() {
    // Home is the greeting (in the header) and WhatsApp; chatting happens on the Messages tab.
    var h = '<div class="pad">';
    if (WA) h += '<a class="card wa" href="' + esc(WA) + '" target="_blank" rel="noopener">' + ic('wa', 'lead') + '<span><b>Prefer WhatsApp?</b><small>Hoolam on WhatsApp works any time, day or night.</small></span>' + ic('right', 'go') + '</a>';
    return h + '</div>';
  }
  /** Their one conversation (or the start of it). */
  function conversation() {
    var t = S.thread;
    var rep = t && t.rep;
    var known = !!(key && S.visitor);
    var h = '<header class="thead"><button class="x dark" data-act="home" aria-label="Back">' + ic('back') + '</button>' + mark(32) +
      '<span class="who"><b>' + esc(rep || 'Hoolam support') + '</b><small>' + (rep ? 'Hoolam support' : (S.cfg && S.cfg.hours && !S.cfg.hours.open ? 'Reps are back at ' + esc(S.cfg.hours.opens) : 'A rep will join shortly')) + '</small></span>' +
      '<button class="x dark" data-act="close" aria-label="Close chat">' + ic('x') + '</button></header>';
    h += '<div class="msgs" aria-live="polite">';
    var w = welcome();
    h += '<div class="msg them"><div class="bubble">' + esc(/^(hi|hello|good)\b/i.test(w) ? w : 'Hi there. ' + w) + '</div><span class="meta">Hoolam</span></div>';
    if (S.cfg && S.cfg.hours && !S.cfg.hours.open && (!t || t.status === 'OPEN')) h += '<div class="sys away">' + ic('clock') + '<span>Our reps are back at ' + esc(S.cfg.hours.opens) + '. Leave a message and we’ll reply here and on WhatsApp.</span></div>';
    if (t) {
      if (t.partial) h += '<div class="sys"><span>Earlier messages are on the device you first used. Open the chat link we sent to your WhatsApp to see them here.</span></div>';
      var lastMine = 0;
      t.messages.forEach(function (m) { if (m.kind === 'VISITOR') lastMine = m.id; });
      var prevDay = '';
      t.messages.forEach(function (m) {
        var d = dayOf(m.at); if (d !== prevDay) { h += '<div class="day"><span>' + d + '</span></div>'; prevDay = d; }
        if (m.kind === 'SYSTEM') {
          var who = first(m.by);
          var line = m.body === 'joined' ? who + ' joined the chat' : m.body === 'closed' ? 'This chat was closed' : m.body === 'ended' ? 'You ended the chat'
            : m.body === 'reopened' ? 'The chat is open again' : m.body === 'whatsapp' ? 'We also let you know on WhatsApp' : '';
          if (line) h += '<div class="sys"><span>' + esc(line) + ' · ' + hhmm(m.at) + '</span></div>';
          return;
        }
        var mine = m.kind === 'VISITOR';
        h += '<div class="msg ' + (mine ? 'me' : 'them') + '"><div class="bubble">' + (m.file ? fileView(m.file) : '') + (m.body ? '<span>' + linkify(m.body) + '</span>' : '') + '</div>' +
          '<span class="meta">' + (mine ? '' : esc(first(m.by) || 'Hoolam') + ' · ') + hhmm(m.at) + (mine && m.id === lastMine && t.seenUpTo >= m.id ? ' · <b class="seen">Seen</b>' : '') + '</span></div>';
      });
      if (S.typingAt && Date.now() - S.typingAt < 5000) h += '<div class="msg them"><div class="typing" aria-label="' + esc(S.typingName || 'A rep') + ' is typing"><i></i><i></i><i></i></div></div>';
      if (t.status === 'CLOSED') {
        h += '<div class="closed"><b>This chat is closed</b>' +
          (t.rating ? '<span>Thanks for telling us.</span>' : '<span>Was this helpful?</span><div class="rate"><button data-rate="UP" aria-label="Yes, helpful">' + ic('up') + 'Yes</button><button data-rate="DOWN" aria-label="Not helpful">' + ic('down') + 'No</button></div>') +
          '<small>Need more help? Send a message and it opens again.</small></div>';
      }
    }
    h += '</div>';
    var chips = (!t || t.messages.length <= 1) && S.cfg && S.cfg.chips && S.cfg.chips.length
      ? '<div class="chips">' + S.cfg.chips.map(function (c) { return '<button data-chip="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' : '';
    if (!known) {
      // first time on this browser: name, WhatsApp number and the message, together
      return h + chips + '<form class="who-form" data-form="start">' +
        '<div class="two"><label>Your name<input id="hc-name" autocomplete="name" maxlength="60" value="' + esc(S.name) + '" placeholder="Ivana Okoro"></label>' +
        '<label>WhatsApp number<input id="hc-phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" value="' + esc(S.phone) + '" placeholder="0803 123 4567"></label></div>' +
        '<label>Your message<textarea id="hc-first" rows="2" maxlength="2000" placeholder="How can we help?">' + esc(S.draft) + '</textarea></label>' +
        '<small>' + ic('lock') + 'Only for this chat. If you leave, we let you know on WhatsApp when a rep replies.</small>' +
        (S.err ? '<p class="err">' + esc(S.err) + '</p>' : '') +
        '<button type="submit" class="go"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Sending…' : 'Start chat') + ic('send') + '</button></form>';
    }
    return h + chips + '<div class="compose">' + (S.err ? '<p class="err">' + esc(S.err) + '</p>' : '') +
      '<div class="inrow"><button class="x dark attach" data-act="attach" aria-label="Attach a photo or PDF" title="Attach a photo or PDF (up to 10 MB)"' + (!t || S.busy ? ' disabled' : '') + '>' + ic('clip') + '</button>' +
      '<input type="file" id="hc-file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden>' +
      '<textarea id="hc-box" rows="1" maxlength="2000" placeholder="' + (t && t.status === 'CLOSED' ? 'Send a message to reopen the chat…' : 'Type your message…') + '" aria-label="Your message">' + esc(S.draft) + '</textarea>' +
      '<button class="sendb" data-act="send" aria-label="Send"' + (S.busy ? ' disabled' : '') + '>' + ic('send') + '</button></div></div>';
  }
  function fileView(f) {
    var url = API + '/files/' + f.id + '?key=' + encodeURIComponent(key || '');
    if (/^image\//.test(f.mime)) return '<a class="img" href="' + url + '" target="_blank" rel="noopener"><img src="' + url + '" alt="' + esc(f.name) + '" loading="lazy"></a>';
    return '<a class="file" href="' + url + '" download="' + esc(f.name) + '">' + ic('file') + '<span><b>' + esc(f.name) + '</b><small>PDF · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB</small></span></a>';
  }
  function questionsTab() {
    var qs = (S.cfg && S.cfg.questions) || [];
    var q = (S.qSearch || '').toLowerCase();
    var list = q ? qs.filter(function (x) { return (x.title + ' ' + x.body).toLowerCase().indexOf(q) >= 0; }) : qs;
    var h = '<div class="pad"><label class="search">' + ic('search') + '<input id="hc-q" placeholder="Search questions" value="' + esc(S.qSearch) + '" aria-label="Search questions"></label><div class="list">';
    if (!list.length) h += '<div class="empty small"><b>' + (q ? 'Nothing matches that' : 'No questions yet') + '</b><span>Ask us in a message instead.</span></div>';
    list.forEach(function (x) {
      var open = S.openQ === x.id;
      h += '<div class="qa' + (open ? ' open' : '') + '"><button class="qrow" data-q="' + x.id + '" aria-expanded="' + open + '"><span>' + esc(x.title) + '</span>' + ic('right', 'go') + '</button>' +
        (open ? '<div class="ans">' + linkify(x.body) + '</div>' : '') + '</div>';
    });
    return h + '</div><button class="cta soft" data-tab="messages">' + ic('chat') + 'Still need help? Message us</button></div>';
  }
  function newsTab() {
    var n = (S.cfg && S.cfg.news) || [];
    var h = '<div class="pad">';
    if (!n.length) h += '<div class="empty small"><b>No news yet</b></div>';
    n.forEach(function (x) {
      h += '<article class="post">' + (x.imageId ? '<img src="' + API + '/media/' + x.imageId + '" alt="" loading="lazy">' : '') +
        '<div class="post-body"><small>' + dayOf(x.at) + '</small><b>' + esc(x.title) + '</b><p>' + linkify(x.body) + '</p>' +
        (x.url ? '<a href="' + esc(x.url) + '"' + (/^https?:/.test(x.url) ? ' target="_blank" rel="noopener"' : '') + '>Read more' + ic('right') + '</a>' : '') + '</div></article>';
    });
    return h + '</div>';
  }

  // ---------- events ----------
  function bind() {
    root.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        var a = b.getAttribute('data-act');
        if (a === 'toggle') return S.open ? closeChat() : openChat();
        if (a === 'close') return closeChat();
        if (a === 'home') { S.tab = 'home'; S.err = ''; return render(); }
        if (a === 'send') { var box = root.querySelector('#hc-box'); return send(box ? box.value : ''); }
        if (a === 'attach') { var fi = root.querySelector('#hc-file'); if (fi) fi.click(); return; }
      });
    });
    root.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { var t = b.getAttribute('data-tab'); S.openQ = null; if (t === 'messages') return goMessages(); S.tab = t; S.err = ''; render(); });
    });
    root.querySelectorAll('[data-q]').forEach(function (b) { b.addEventListener('click', function () { var id = Number(b.getAttribute('data-q')); S.openQ = S.openQ === id ? null : id; render(); }); });
    root.querySelectorAll('[data-chip]').forEach(function (b) {
      b.addEventListener('click', function () {
        var text = b.getAttribute('data-chip');
        if (key && S.visitor) return send(text);
        S.draft = text; render(); var n = root.querySelector('#hc-name'); if (n && !n.value) n.focus();
      });
    });
    root.querySelectorAll('[data-rate]').forEach(function (b) {
      b.addEventListener('click', function () {
        req('/threads/' + S.thread.id + '/rate', { body: { rating: b.getAttribute('data-rate') } }).then(function () { S.thread.rating = b.getAttribute('data-rate'); render(); }).catch(function () {});
      });
    });
    var box = root.querySelector('#hc-box');
    if (box) {
      var fit = function () { box.style.height = 'auto'; box.style.height = Math.min(120, box.scrollHeight) + 'px'; };
      fit();
      box.addEventListener('input', function () { fit(); typing(); });
      box.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(box.value); } });
    }
    var fi = root.querySelector('#hc-file');
    if (fi) fi.addEventListener('change', function () { var f = fi.files && fi.files[0]; fi.value = ''; upload(f); });
    var q = root.querySelector('#hc-q');
    if (q) q.addEventListener('input', function () { S.qSearch = q.value; render(); });
    var form = root.querySelector('[data-form="start"]');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = root.querySelector('#hc-name').value.trim(), phone = root.querySelector('#hc-phone').value.trim(), text = root.querySelector('#hc-first').value.trim();
      S.name = name; S.phone = phone; S.draft = text;
      if (name.length < 2) { S.err = 'Please tell us your name.'; return render(); }
      if (phone.replace(/\D/g, '').length < 10) { S.err = 'Please enter your WhatsApp number, like 08031234567.'; return render(); }
      if (!text) { S.err = 'Please type your message.'; render(); var m = root.querySelector('#hc-first'); if (m) m.focus(); return; }
      start(text, name, phone);
    });
    var first = root.querySelector('#hc-first');
    if (first) first.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); } });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) markSeen(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) closeChat(); });

  // ---------- start ----------
  window.HoolamChat = {
    open: function () { openChat(); },
    message: function () { openChat('messages'); },
  };
  render();
  loadConfig();
  // a WhatsApp "open the chat" link: ?chat=CODE
  var code = new URLSearchParams(location.search).get('chat');
  if (code) {
    req('/resume', { body: { code: code } }).then(function (r) {
      key = r.key; store.set(KEY_STORE, key);
      try { var u = new URL(location.href); u.searchParams.delete('chat'); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (e) { /* old browser */ }
      return loadMe().then(function () { openChat('messages'); });
    }).catch(function () { loadMe(); });
  } else loadMe();

  // ---------- styles (inside the shadow root): the website's soft look ----------
  function CSS() {
    return [
      ':host{all:initial}',
      '.hc{--teal:#0E5C63;--teal-2:#0A464B;--teal-3:#083E43;--gold:#C9992E;--ink:#1B2321;--soft:#58615E;--rule:#E8E1D5;--bg:#F7F3EC;--card:#FFFDF9;--mint:#E2EFEA;--red:#C0392B;font:400 14px/1.5 Inter,"Segoe UI",system-ui,-apple-system,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}',
      '.hc *{box-sizing:border-box}.hc button,.hc input,.hc textarea{font:inherit;color:inherit}.hc a{color:var(--teal)}',
      '.ic{width:19px;height:19px;flex:none;display:block}',
      '.mark{border-radius:10px;flex:none;display:block;object-fit:contain}',
      '.veil{position:fixed;inset:0;background:#061E20;display:grid;place-items:center;padding-right:416px}.veil.anim{animation:fade .25s ease}',
      '.veil .ghost{display:none;opacity:.16;pointer-events:none}.veil .ghost .mark{display:block;border-radius:36px;box-shadow:none}',
      '@media (min-width:900px){.veil .ghost{display:block}}',
      '@keyframes fade{from{opacity:0}to{opacity:1}}',
      '.launch{position:fixed;z-index:2;right:max(18px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));width:56px;height:56px;border-radius:50%;border:0;background:var(--teal);color:#fff;display:grid;place-items:center;cursor:pointer;box-shadow:0 14px 34px -10px rgba(8,62,67,.55),0 3px 8px rgba(0,0,0,.12);transition:transform .2s cubic-bezier(.22,.8,.24,1),background .2s}',
      '.launch:hover{transform:translateY(-2px);background:var(--teal-2)}.launch .ic{width:24px;height:24px}',
      '.launch .badge{position:absolute;top:-3px;right:-3px;min-width:21px;height:21px;padding:0 6px;border-radius:99px;background:var(--red);color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center;box-shadow:0 0 0 2px #fff}.launch .badge[hidden]{display:none}',
      '.launch:focus-visible,.hc button:focus-visible,.hc a:focus-visible,.hc input:focus-visible,.hc textarea:focus-visible{outline:2px solid var(--gold);outline-offset:2px}',
      '.panel{position:fixed;z-index:3;right:max(18px,env(safe-area-inset-right));bottom:calc(max(18px,env(safe-area-inset-bottom)) + 70px);width:380px;height:min(640px,calc(100vh - 110px));display:flex;flex-direction:column;background:var(--bg);border-radius:22px;overflow:hidden;box-shadow:0 30px 70px -20px rgba(8,62,67,.45),0 0 0 1px var(--rule)}.panel.anim{animation:in .28s cubic-bezier(.22,.8,.24,1)}',
      '@keyframes in{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}',
      '@media (max-width:520px){.panel{inset:0;width:auto;height:auto;border-radius:0;bottom:0;right:0}.launch.is-open,.veil{display:none}}',
      '@media (prefers-reduced-motion:reduce){.panel,.veil{animation:none}.typing i{animation:none}}',
      '.head{background:var(--teal);color:#fff;padding:14px 16px 16px;position:relative;overflow:hidden;border-radius:0 0 24px 24px;flex:none}',
      '.head::after{content:"";position:absolute;right:-70px;top:-90px;width:220px;height:220px;border-radius:50%;background:var(--teal-3);opacity:.55}.head>*{position:relative;z-index:1}',
      '.head.big{padding-bottom:22px}',
      '.head .mark{box-shadow:0 0 0 1px rgba(255,255,255,.25)}',
      '.brand{display:flex;align-items:center;gap:10px}',
      '.x{margin-left:auto;width:34px;height:34px;border-radius:11px;border:0;background:rgba(255,255,255,.12);color:#fff;display:grid;place-items:center;cursor:pointer}.x:hover{background:rgba(255,255,255,.2)}.x .ic{width:17px;height:17px}',
      '.x.dark{background:transparent;color:var(--soft);margin-left:0}.x.dark:hover{background:var(--bg);color:var(--ink)}.x.dark[disabled]{opacity:.35;cursor:default}',
      '.head h2{margin:18px 0 2px;font:700 1.45rem/1.15 Poppins,Inter,sans-serif;letter-spacing:-.025em;color:#fff}.head h2.small{margin:0;font-size:1.05rem;font-weight:600}',
      '.head p{margin:0;color:#CFE3E4;font-size:.95rem}',
      '.status{display:inline-flex;align-items:center;gap:7px;margin-top:10px;padding:4px 10px;border-radius:99px;background:rgba(255,255,255,.12);font-size:.76rem;color:#E4F0F0}.status::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--gold)}.status.on::before{background:#5CD08D;box-shadow:0 0 0 3px rgba(92,208,141,.25)}',
      '.body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}',
      '.pad{padding:14px;display:flex;flex-direction:column;gap:8px}',
      '.card{display:flex;align-items:center;gap:12px;padding:13px 14px;border-radius:16px;background:var(--card);border:0;box-shadow:inset 0 0 0 1px var(--rule);text-align:left;text-decoration:none;color:var(--ink);cursor:pointer;width:100%;transition:box-shadow .2s,transform .2s}',
      '.card:hover{box-shadow:inset 0 0 0 1px var(--teal);transform:translateY(-1px)}.card span{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}.card b{font-weight:600;font-size:.93rem}.card small{color:var(--soft);font-size:.8rem;line-height:1.4}',
      '.card .go{width:17px;height:17px;color:var(--teal)}.card .lead{width:24px;height:24px;color:#25A55F}',
      '.tabs{display:flex;background:var(--card);border-top:1px solid var(--rule);padding:5px 6px max(5px,env(safe-area-inset-bottom));flex:none}',
      '.tabs button{flex:1;position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;border:0;background:none;color:var(--soft);font-size:.7rem;font-weight:600;cursor:pointer;border-radius:12px}',
      '.tabs button.on{color:var(--teal)}.tabs button:hover{background:var(--bg)}.tabs .ic{width:20px;height:20px}',
      '.n{font-style:normal;min-width:17px;height:17px;padding:0 5px;border-radius:99px;background:var(--red);color:#fff;font-size:10px;font-weight:700;display:grid;place-items:center}.tabs .n{position:absolute;top:2px;left:calc(50% + 6px)}',
      '.empty{display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;padding:30px 16px 18px;color:var(--soft)}.empty b{color:var(--ink)}.empty.small{padding:18px 10px}',
      '.cta{display:flex;align-items:center;justify-content:center;gap:8px;min-height:44px;border-radius:14px;border:0;background:var(--teal);color:#fff;font-weight:600;cursor:pointer;margin-top:4px}.cta:hover{background:var(--teal-2)}.cta .ic{width:17px;height:17px}',
      '.cta.soft{background:var(--card);color:var(--teal);box-shadow:inset 0 0 0 1px var(--rule)}.cta.soft:hover{box-shadow:inset 0 0 0 1px var(--teal);background:var(--card)}',
      '.list{display:flex;flex-direction:column;border-radius:16px;background:var(--card);box-shadow:inset 0 0 0 1px var(--rule);overflow:hidden}',
      '.thead{display:flex;align-items:center;gap:9px;padding:9px 10px 9px 8px;background:var(--card);border-bottom:1px solid var(--rule);flex:none}',
      '.who{flex:1;min-width:0;display:flex;flex-direction:column}.who b{font-weight:600;line-height:1.25;font-size:.93rem}.who small{color:var(--soft);font-size:.75rem}',
      '.msgs{flex:1;min-height:0;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:9px;background:#EFE7DC;background-image:radial-gradient(rgba(14,92,99,.06) 1.2px,transparent 1.3px);background-size:18px 18px}',
      '.day{text-align:center}.day span{display:inline-block;padding:2px 9px;border-radius:8px;background:#fff;color:var(--soft);font-size:.68rem;font-weight:600;box-shadow:0 1px 1px rgba(0,0,0,.05)}',
      '.sys{text-align:center}.sys span{display:inline-block;padding:4px 10px;border-radius:99px;background:rgba(255,255,255,.8);color:var(--soft);font-size:.72rem;line-height:1.4}',
      '.sys.away{display:flex;gap:8px;align-items:flex-start;text-align:left;padding:10px 12px;border-radius:14px;background:#F6EBD2;color:#5C430B;font-size:.8rem}.sys.away .ic{width:16px;height:16px;margin-top:1px}.sys.away span{background:none;padding:0;color:inherit;font-size:inherit}',
      '.msg{display:flex;flex-direction:column;gap:2px;max-width:84%}.msg.me{align-self:flex-end;align-items:flex-end}.msg.them{align-self:flex-start}',
      '.bubble{padding:8px 12px;border-radius:15px;font-size:.88rem;line-height:1.45;box-shadow:0 1px 1px rgba(0,0,0,.07);display:flex;flex-direction:column;gap:6px;overflow-wrap:anywhere}',
      '.them .bubble{background:#fff;border-top-left-radius:5px}.me .bubble{background:#D9FDD3;border-top-right-radius:5px}',
      '.meta{font-size:.68rem;color:var(--soft)}.seen{color:var(--teal);font-weight:600}',
      '.img img{display:block;max-width:210px;max-height:210px;border-radius:11px;object-fit:cover}',
      '.file{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:11px;background:rgba(0,0,0,.05);text-decoration:none;color:var(--ink)}.file b{display:block;font-size:.8rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.file small{color:var(--soft);font-size:.7rem}',
      '.typing{display:inline-flex;gap:4px;padding:11px 13px;border-radius:15px;border-top-left-radius:5px;background:#fff;box-shadow:0 1px 1px rgba(0,0,0,.07)}.typing i{width:6px;height:6px;border-radius:50%;background:#9AA5A2;animation:blink 1.2s infinite}.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}',
      '@keyframes blink{0%,60%,100%{opacity:.35}30%{opacity:1}}',
      '.closed{align-self:center;display:flex;flex-direction:column;align-items:center;gap:3px;text-align:center;padding:13px 15px;border-radius:16px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.05);margin-top:6px;max-width:92%;font-size:.88rem}.closed span{color:var(--soft)}.closed small{color:var(--soft);font-size:.72rem;margin-top:4px}',
      '.rate{display:flex;gap:8px;margin-top:6px}.rate button{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 13px;border-radius:99px;border:0;background:var(--mint);color:var(--teal);font-weight:600;font-size:.85rem;cursor:pointer}.rate button:hover{background:#D3E6E2}.rate .ic{width:15px;height:15px}',
      '.chips{display:flex;gap:6px;padding:9px 10px 0;background:var(--card);overflow-x:auto;scrollbar-width:none;flex:none}.chips::-webkit-scrollbar{display:none}',
      '.chips button{flex:none;height:31px;padding:0 12px;border-radius:99px;border:1px solid var(--rule);background:#fff;color:var(--teal);font-size:.8rem;font-weight:600;cursor:pointer;white-space:nowrap}.chips button:hover{border-color:var(--teal)}',
      '.compose{background:var(--card);padding:9px 10px max(9px,env(safe-area-inset-bottom));flex:none}',
      '.inrow{display:flex;align-items:flex-end;gap:6px}.inrow textarea{flex:1;min-height:40px;max-height:120px;resize:none;padding:9px 12px;border-radius:14px;border:1px solid var(--rule);background:var(--bg);font-size:.88rem;line-height:1.4;outline:none}.inrow textarea:focus{border-color:var(--teal);background:#fff}',
      '.attach{width:38px;height:40px}.sendb{width:42px;height:40px;border-radius:13px;border:0;background:var(--teal);color:#fff;display:grid;place-items:center;cursor:pointer;flex:none}.sendb:hover{background:var(--teal-2)}.sendb[disabled]{opacity:.5}.sendb .ic{width:17px;height:17px}',
      '.err{margin:0 0 6px;color:var(--red);font-size:.8rem}',
      '.who-form{background:var(--card);padding:12px 12px max(12px,env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--rule);flex:none}',
      '.who-form .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.who-form label{display:flex;flex-direction:column;gap:4px;font-size:.74rem;font-weight:600;color:var(--soft)}',
      '.who-form input,.who-form textarea{width:100%;padding:9px 11px;border-radius:12px;border:1px solid var(--rule);background:var(--bg);font-size:.88rem;font-weight:400;color:var(--ink);outline:none;resize:none}.who-form input{height:40px}.who-form input:focus,.who-form textarea:focus{border-color:var(--teal);background:#fff}',
      '.who-form small{display:flex;gap:6px;align-items:flex-start;color:var(--soft);font-size:.72rem;line-height:1.4}.who-form small .ic{width:13px;height:13px;margin-top:1px;color:var(--teal)}',
      '.who-form .go{display:flex;align-items:center;justify-content:center;gap:8px;height:42px;border-radius:13px;border:0;background:var(--teal);color:#fff;font-weight:600;cursor:pointer}.who-form .go:hover{background:var(--teal-2)}.who-form .go[disabled]{opacity:.6}.who-form .go .ic{width:16px;height:16px}',
      '.search{display:flex;align-items:center;gap:8px;height:42px;padding:0 12px;border-radius:14px;background:#fff;box-shadow:inset 0 0 0 1px var(--rule)}.search .ic{width:17px;height:17px;color:var(--soft)}.search input{flex:1;border:0;background:none;outline:none;font-size:.88rem}',
      '.qa{border-top:1px solid var(--rule)}.qa:first-child{border-top:0}',
      '.qrow{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border:0;background:none;text-align:left;cursor:pointer;font-weight:600;font-size:.88rem}.qrow:hover{background:#fff}.qrow span{flex:1}',
      '.qrow .go{width:16px;height:16px;color:var(--teal);transition:transform .2s}.qa.open .qrow .go{transform:rotate(90deg)}.qa.open .qrow{color:var(--teal)}',
      '.ans{padding:0 14px 13px;color:var(--soft);font-size:.86rem;line-height:1.55}',
      '.post{display:flex;flex-direction:column;border-radius:16px;background:var(--card);box-shadow:inset 0 0 0 1px var(--rule);overflow:hidden}',
      '.post img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--rule)}',
      '.post-body{display:flex;flex-direction:column;gap:3px;padding:12px 14px}.post small{color:var(--soft);font-size:.7rem}.post b{font-weight:600;font-size:.93rem}.post p{margin:0;color:var(--soft);font-size:.84rem}.post a{display:inline-flex;align-items:center;gap:4px;font-weight:600;font-size:.82rem;text-decoration:none;margin-top:2px}.post a .ic{width:14px;height:14px}',
    ].join('\n');
  }
})();
