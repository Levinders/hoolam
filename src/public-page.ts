import { shipText, shortBankName, type SellerStats } from './trust.js';

/**
 * A seller's public page: their trust card and one button, "Buy safely", that opens WhatsApp with
 * "Buy from @slug" typed in. Hoolam then starts a protected buyer deal pointed at this seller.
 * Brand: deep teal #0E5C63, muted gold #C9992E, green only for good news, off-white #FAFAF7.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function sellerPage(t: SellerStats, o: { slug: string; waNumber: string; baseUrl: string }): string {
  const buy = `https://wa.me/${o.waNumber}?text=${encodeURIComponent(`Buy from @${o.slug}`)}`;
  const check = `https://wa.me/${o.waNumber}?text=${encodeURIComponent('hi')}`;
  const since = t.since.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const pct = t.rated >= 5 ? Math.round((100 * t.happy) / t.rated) : null;
  const open = t.problems - t.refunded - t.released;

  const stats: [string, string, string][] = []; // icon, big, small
  stats.push(t.completed ? ['✅', String(t.completed), t.completed === 1 ? 'deal completed' : 'deals completed'] : ['🌱', 'New', 'on Hoolam']);
  if (t.buyers > 1) stats.push(['👥', String(t.buyers), 'different buyers']);
  if (pct != null) stats.push(['👍', `${pct}%`, `buyers happy · ${t.rated} ratings`]);
  else if (t.rated) stats.push(['👍', `${t.happy}/${t.rated}`, 'buyers happy']);
  if (t.shipHours != null) stats.push(['📦', shipText(t.shipHours).replace(/^in about |^within /, ''), 'usually ships']);

  const disputes = t.problems
    ? `${t.problems} problem${t.problems === 1 ? '' : 's'} reported` + [t.refunded ? `${t.refunded} refunded after review` : '', t.released ? `${t.released} settled in the seller's favour` : '', open > 0 ? `${open} being reviewed` : ''].filter(Boolean).map((x) => ' · ' + x).join('')
    : t.completed ? 'No problems reported' : null;
  const title = `${t.name} on Hoolam`;
  const desc = t.completed ? `${t.completed} safe deals completed. Pay through Hoolam: your money is held until you're happy.` : `Buy from ${t.name} safely: your money is held until you're happy.`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(o.baseUrl)}/share.png"><meta property="og:type" content="profile">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@600&display=swap" rel="stylesheet">
<style>
:root{--teal:#0E5C63;--gold:#C9992E;--green:#2E8B57;--bg:#FAFAF7;--ink:#17292b;--muted:#5d6b6c;--line:#e6e8e3;--card:#fff}
*{box-sizing:border-box;margin:0}
body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px 40px}
.wrap{width:100%;max-width:440px}
.brand{display:flex;align-items:center;gap:8px;color:var(--teal);font:600 16px Poppins;margin-bottom:18px}
.brand i{width:26px;height:26px;border-radius:8px;background:var(--teal);display:grid;place-items:center;color:var(--bg);font-style:normal;font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden;box-shadow:0 18px 40px -24px rgba(14,92,99,.35)}
.top{background:var(--teal);color:var(--bg);padding:22px 22px 20px;position:relative;overflow:hidden}
.top:after{content:"";position:absolute;right:-60px;top:-60px;width:180px;height:180px;border-radius:50%;border:2px solid rgba(201,153,46,.35)}
.top small{color:var(--gold);font-weight:600;letter-spacing:.12em;text-transform:uppercase;font-size:11px}
.top h1{font:600 26px/1.15 Poppins;margin-top:6px}
.top p{opacity:.8;font-size:14px;margin-top:6px}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line)}
.stat{background:var(--card);padding:16px 18px}
.stat b{display:block;font:600 22px Poppins;color:var(--teal)}
.stat span{font-size:12.5px;color:var(--muted)}
.rows{padding:6px 20px 14px}
.row{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px;line-height:1.4}
.row:last-child{border-bottom:0}
.note{font-size:12px;color:var(--muted);padding:0 20px 18px}
.how{margin:18px 0;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;font-size:14px;line-height:1.9}
.how b{font:600 15px Poppins;color:var(--teal);display:block;margin-bottom:4px}
.cta{display:block;text-align:center;background:var(--teal);color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:16px;border-radius:14px}
.cta:hover{filter:brightness(1.08)}
.sub{display:block;text-align:center;color:var(--teal);font-size:14px;margin-top:12px}
footer{margin-top:22px;font-size:12px;color:var(--muted);text-align:center}
</style></head><body><div class="wrap">
<div class="brand"><i>H</i>Hoolam</div>
<div class="card">
  <div class="top"><small>🛡️ Trust card</small><h1>${esc(t.name)}</h1><p>${t.city ? esc(t.city) + ' · ' : ''}On Hoolam since ${since}</p></div>
  <div class="stats">${stats.map(([i, big, sm]) => `<div class="stat"><b>${i} ${esc(big)}</b><span>${esc(sm)}</span></div>`).join('')}${stats.length % 2 ? '<div class="stat"></div>' : ''}</div>
  <div class="rows">
    ${disputes ? `<div class="row">⚖️<span>${esc(disputes)}</span></div>` : ''}
    ${t.bankName ? `<div class="row">🏦<span>Paid out to ${esc(shortBankName(t.bankName))}, bank-verified${t.bankMatches ? ' · matches their name' : ''}</span></div>` : ''}
    ${t.isNew ? `<div class="row">🌱<span>New on Hoolam. Every deal is still protected: your money is held until you're happy.</span></div>` : ''}
  </div>
  <p class="note">Counted from real deals paid through Hoolam. Nobody can edit these numbers, not even the seller.</p>
</div>
<div class="how"><b>How buying safely works</b>💳 You pay Hoolam, not the seller<br>🛡️ We hold the money<br>📦 ${esc(t.name)} delivers<br>✅ You're happy → they get paid</div>
<a class="cta" href="${esc(buy)}">🛒 Buy from ${esc(t.name)} safely</a>
<a class="sub" href="${esc(check)}">Have a deal code? Open Hoolam on WhatsApp</a>
<footer>Hoolam · Paid safely, or not at all.</footer>
</div></body></html>`;
}

export function notFoundPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hoolam</title>
<style>body{font-family:system-ui,sans-serif;background:#FAFAF7;color:#17292b;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}h1{color:#0E5C63;font-size:22px}</style></head>
<body><div><h1>This page isn't available</h1><p>The seller may have hidden it. You can still buy safely with Hoolam on WhatsApp.</p></div></body></html>`;
}
