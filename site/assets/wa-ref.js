/*
 * Where people come from: every "Chat on WhatsApp" button adds "(ref: …)" to the message, so Hoolam knows which page
 * (web-home, web-pricing…) or which campaign link (hoolam.com/<name> → its name) brought them. Shown in the console
 * as the person's Source. Links that already say who sent them (ambassadors, sellers, items) are left as they are.
 */
(function () {
  try {
    var q = new URLSearchParams(location.search);
    var camp = q.get('utm_medium') ? (q.get('utm_content') || q.get('utm_campaign')) : null;
    if (camp) try { sessionStorage.setItem('hoolam_ref', camp.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)); } catch (e) {}
    var saved = null; try { saved = sessionStorage.getItem('hoolam_ref'); } catch (e) {}
    var page = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || 'home';
    var ref = saved || ('web-' + page.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30));
    var tag = function (a) {
      var u; try { u = new URL(a.href); } catch (e) { return; }
      if (!/(^|\.)wa\.me$/.test(u.hostname)) return;
      var t = u.searchParams.get('text') || '';
      if (/\(ref:|sent me|buy this|buy from @|\bHL-/i.test(t)) return;
      // spaces as %20, not "+": WhatsApp shows a "+" literally
      a.href = u.origin + u.pathname + '?text=' + encodeURIComponent((t || 'Hi Hoolam') + ' (ref: ' + ref + ')');
    };
    var all = function () { document.querySelectorAll('a[href*="wa.me/"]').forEach(tag); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', all); else all();
    document.addEventListener('click', function (e) { var a = e.target && e.target.closest && e.target.closest('a[href*="wa.me/"]'); if (a) tag(a); }, true);
  } catch (e) {}
})();
