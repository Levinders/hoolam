import { ICON } from './icons.js';
import { shipText, shortBankName, type SellerStats } from './trust.js';

/**
 * A seller's public page: their photo, links, trust card and one button, "Buy safely", that opens WhatsApp with
 * "Buy from @slug" typed in. Hoolam then starts a protected buyer deal pointed at this seller.
 * Brand: deep teal #0E5C63, muted gold #C9992E, green only for good news, off-white #FAFAF7.
 * Everything a seller typed (name, city, links) is escaped; links open in a new tab and are marked as user content.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'H';

export interface SellerPageOptions {
  slug: string; waNumber: string; baseUrl: string; siteUrl?: string | null;
  logoUrl?: string | null; markUrl?: string | null;
}

export function sellerPage(t: SellerStats, o: SellerPageOptions): string {
  const buy = `https://wa.me/${o.waNumber}?text=${encodeURIComponent(`Buy from @${o.slug}`)}`;
  const check = `https://wa.me/${o.waNumber}?text=${encodeURIComponent('hi')}`;
  const since = t.since.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const pct = t.rated >= 5 ? Math.round((100 * t.happy) / t.rated) : null;
  const open = t.problems - t.refunded - t.released;
  const page = `${o.baseUrl}/s/${o.slug}`;
  const photo = t.photoVersion ? `${page}/photo.webp?v=${t.photoVersion}` : null;
  const share = `${page}/share.jpg?v=${t.photoVersion ?? '0'}`;
  const home = o.siteUrl || null;

  const stats: { icon: string; big: string; small: string; tone?: string }[] = [];
  stats.push(t.completed ? { icon: ICON.check, big: String(t.completed), small: t.completed === 1 ? 'deal completed' : 'deals completed', tone: 'green' } : { icon: ICON.sprout, big: 'New', small: 'on Hoolam' });
  if (t.buyers > 1) stats.push({ icon: ICON.users, big: String(t.buyers), small: 'different buyers' });
  if (pct != null) stats.push({ icon: ICON.thumbsUp, big: `${pct}%`, small: `buyers happy · ${t.rated} ratings`, tone: 'gold' });
  else if (t.rated) stats.push({ icon: ICON.thumbsUp, big: `${t.happy}/${t.rated}`, small: 'buyers happy', tone: 'gold' });
  if (t.shipHours != null) stats.push({ icon: ICON.package, big: shipText(t.shipHours).replace(/^in about |^within /, ''), small: 'usually ships' });

  const disputes = t.problems
    ? `${t.problems} problem${t.problems === 1 ? '' : 's'} reported` + [t.refunded ? `${t.refunded} refunded after review` : '', t.released ? `${t.released} settled in the seller's favour` : '', open > 0 ? `${open} being reviewed` : ''].filter(Boolean).map((x) => ` · ${x}`).join('')
    : t.completed ? 'No problems reported' : null;
  const title = `${t.name} on Hoolam`;
  const desc = t.completed ? `${t.completed} safe deals completed. Pay through Hoolam: your money is held until you're happy.` : `Buy from ${t.name} safely: your money is held until you're happy.`;
  const brand = o.logoUrl
    ? `<img class="logo-img" src="${esc(o.logoUrl)}" alt="Hoolam">`
    : `${o.markUrl ? `<img class="mark-img" src="${esc(o.markUrl)}" alt="">` : ICON.mark}<span>Hoolam</span>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0E5C63">
<link rel="canonical" href="${esc(page)}">
<link rel="icon" href="${esc(o.markUrl ?? `${o.baseUrl}/favicon.svg`)}">
<meta property="og:type" content="profile"><meta property="og:site_name" content="Hoolam">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(page)}">
<meta property="og:image" content="${esc(share)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@600;700&display=swap" rel="stylesheet">
<style>
:root{--teal:#0E5C63;--teal-d:#0A4146;--gold:#C9992E;--gold-50:#FBF4E3;--green:#2E8B57;--green-50:#E7F4EC;--bg:#FAFAF7;--ink:#17292b;--muted:#5d6b6c;--faint:#8a9696;--line:#e6e8e3;--card:#fff;--teal-50:#EAF3F3}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{font:15px/1.5 Inter,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:inherit}
.ic{display:block;flex:none}
.wrap{width:100%;max-width:480px;margin:0 auto;padding:16px 16px 28px}
header{display:flex;align-items:center;justify-content:space-between;height:44px;margin-bottom:14px}
.brand{display:inline-flex;align-items:center;gap:9px;text-decoration:none;color:var(--teal);font:600 18px Poppins,Inter,sans-serif;letter-spacing:-.01em}
.logo-img{height:28px;width:auto;max-width:160px;display:block}
.mark-img{width:30px;height:30px;border-radius:9px;object-fit:contain}
.tag{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--teal);background:var(--teal-50);padding:6px 10px;border-radius:999px}
.tag .ic{width:15px;height:15px}
.card{background:var(--card);border:1px solid var(--line);border-radius:24px;overflow:hidden;box-shadow:0 1px 2px rgba(10,65,70,.05),0 24px 48px -28px rgba(14,92,99,.4)}
.cover{height:96px;background:radial-gradient(120% 140% at 85% -20%,rgba(201,153,46,.45),transparent 55%),linear-gradient(135deg,#12737b,var(--teal) 55%,var(--teal-d));position:relative;overflow:hidden}
.cover:after{content:"";position:absolute;right:-50px;top:-70px;width:200px;height:200px;border-radius:50%;border:2px solid rgba(255,255,255,.12)}
.who{padding:0 20px 18px;margin-top:-56px;position:relative}
.avatar{width:112px;height:112px;border-radius:50%;display:block;position:relative;background:var(--teal-50);box-shadow:0 0 0 5px #fff,0 0 0 7px var(--gold),0 14px 28px -12px rgba(10,65,70,.55);overflow:hidden;text-decoration:none}
.avatar img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s cubic-bezier(.2,.8,.2,1)}
.avatar:hover img{transform:scale(1.05)}
.avatar .ini{width:100%;height:100%;display:grid;place-items:center;font:700 38px Poppins,Inter;color:var(--teal);background:linear-gradient(135deg,#EAF3F3,#D3E6E7)}
.avatar .zoom{position:absolute;right:8px;bottom:8px;width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,.92);display:grid;place-items:center;color:var(--teal);box-shadow:0 2px 6px rgba(0,0,0,.18)}
.avatar .zoom .ic{width:14px;height:14px}
h1{font:700 26px/1.15 Poppins,Inter,sans-serif;letter-spacing:-.02em;margin-top:14px;word-wrap:break-word}
.meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;color:var(--muted);font-size:13.5px}
.meta span{display:inline-flex;align-items:center;gap:5px}
.meta .ic{color:var(--faint)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:5px 10px 5px 8px;border-radius:999px}
.chip .ic{width:15px;height:15px}
.chip.green{background:var(--green-50);color:var(--green)}
.chip.gold{background:var(--gold-50);color:#7A5A10}
.socials{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;padding:0 20px 20px}
.soc{display:flex;align-items:center;gap:10px;min-height:48px;padding:8px 12px;border:1px solid var(--line);border-radius:14px;text-decoration:none;transition:border-color .2s,background .2s,transform .2s}
.soc:hover{border-color:#cfdcdc;background:#FCFCFA;transform:translateY(-1px)}
.soc .si{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;flex:none;color:#fff}
.soc.instagram .si{background:radial-gradient(circle at 30% 107%,#fdf497 0%,#fd5949 45%,#d6249f 60%,#285AEB 90%)}
.soc.tiktok .si{background:#111}
.soc.facebook .si{background:#1877F2}
.soc.website .si{background:var(--teal)}
.soc b{display:block;font-size:12px;color:var(--faint);font-weight:500;line-height:1.2}
.soc span{display:block;font-weight:600;font-size:13.5px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.soc .txt{min-width:0;flex:1}
.soc .go{color:var(--faint)}
.sec{border-top:1px solid var(--line)}
.stats{display:grid;grid-template-columns:1fr 1fr}
.stat{padding:16px 18px;display:flex;gap:12px;align-items:flex-start;border-bottom:1px solid var(--line)}
.stat:nth-child(odd){border-right:1px solid var(--line)}
.stat .si{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--teal-50);color:var(--teal);flex:none}
.stat .si.green{background:var(--green-50);color:var(--green)}
.stat .si.gold{background:var(--gold-50);color:#9C7520}
.stat b{display:block;font:700 21px/1.15 Poppins,Inter,sans-serif;color:var(--ink);letter-spacing:-.01em}
.stat small{display:block;font-size:12.5px;color:var(--muted);line-height:1.3;margin-top:2px}
.rows{padding:4px 20px}
.row{display:flex;gap:12px;align-items:center;padding:12px 0;font-size:14px;line-height:1.4}
.row+.row{border-top:1px solid var(--line)}
.row .ic{color:var(--teal);width:20px;height:20px}
.row.good .ic{color:var(--green)}
.note{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--muted);padding:12px 20px 18px;background:#FCFCFA;border-top:1px solid var(--line)}
.note .ic{margin-top:2px;color:var(--faint)}
.how{margin:16px 0;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px 20px}
.how h2{font:600 16px Poppins,Inter,sans-serif;color:var(--ink);margin-bottom:12px}
.steps{list-style:none;padding:0;display:flex;flex-direction:column;gap:0}
.steps li{display:flex;gap:12px;align-items:center;position:relative;padding:7px 0;font-size:14px}
.steps li:not(:last-child):after{content:"";position:absolute;left:17px;top:42px;bottom:-8px;width:2px;background:var(--line)}
.steps .si{width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:var(--teal-50);color:var(--teal);flex:none;position:relative;z-index:1}
.steps li:last-child .si{background:var(--green-50);color:var(--green)}
.steps .ic{width:18px;height:18px}
.cta-bar{position:sticky;bottom:0;padding:12px 0 calc(12px + env(safe-area-inset-bottom));background:linear-gradient(rgba(250,250,247,0),var(--bg) 30%)}
.cta{display:flex;align-items:center;justify-content:center;gap:10px;background:var(--teal);color:#fff;text-decoration:none;font-weight:600;font-size:16px;min-height:56px;padding:0 20px;border-radius:16px;box-shadow:0 14px 28px -14px rgba(14,92,99,.75);transition:transform .2s,background .2s}
.cta:hover{background:var(--teal-d)}
.cta:active{transform:scale(.98)}
.sub{display:block;text-align:center;color:var(--teal);font-size:14px;font-weight:500;margin-top:10px;text-decoration:none}
.sub:hover{text-decoration:underline}
footer{margin-top:22px;display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);text-align:center}
footer a{text-decoration:none;color:var(--teal);font-weight:600}
.lightbox{position:fixed;inset:0;z-index:50;background:rgba(8,30,32,.88);display:none;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(6px)}
.lightbox:target{display:flex;animation:fade .25s ease}
.lightbox img{max-width:min(520px,100%);max-height:80vh;border-radius:24px;box-shadow:0 30px 80px -20px rgba(0,0,0,.7);animation:pop .3s cubic-bezier(.2,.8,.2,1)}
.lightbox .x{position:absolute;inset:0}
.lightbox .close{position:absolute;top:calc(16px + env(safe-area-inset-top));right:16px;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.14);display:grid;place-items:center;color:#fff}
.lightbox figcaption{position:absolute;bottom:calc(24px + env(safe-area-inset-bottom));left:0;right:0;text-align:center;color:#fff;font:600 16px Poppins,Inter,sans-serif}
@keyframes fade{from{opacity:0}}
@keyframes pop{from{transform:scale(.94);opacity:0}}
a:focus-visible{outline:3px solid var(--gold);outline-offset:2px;border-radius:12px}
@media (max-width:360px){.stat{padding:14px}.stat b{font-size:19px}h1{font-size:23px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><div class="wrap">
<header>
  ${home ? `<a class="brand" href="${esc(home)}">${brand}</a>` : `<span class="brand">${brand}</span>`}
  <span class="tag">${ICON.shieldCheck}Trust card</span>
</header>
<main class="card">
  <div class="cover" aria-hidden="true"></div>
  <div class="who">
    ${photo
      ? `<a class="avatar" href="#photo" aria-label="See ${esc(t.name)}'s photo"><img src="${esc(photo)}" alt="${esc(t.name)}" width="112" height="112"><span class="zoom">${ICON.zoom}</span></a>`
      : `<span class="avatar" aria-hidden="true"><span class="ini">${esc(initials(t.name))}</span></span>`}
    <h1>${esc(t.name)}</h1>
    <div class="meta">${t.city ? `<span>${ICON.mapPin}${esc(t.city)}</span>` : ''}<span>${ICON.calendar}On Hoolam since ${since}</span></div>
    <div class="chips">
      ${t.bankName ? `<span class="chip green">${ICON.badgeCheck}Bank-verified payouts</span>` : ''}
      ${t.isNew ? `<span class="chip gold">${ICON.sprout}New on Hoolam</span>` : ''}
    </div>
  </div>
  ${t.socials.length ? `<nav class="socials" aria-label="Where ${esc(t.name)} sells">${t.socials.map((s) => `<a class="soc ${s.kind}" href="${esc(s.url)}" target="_blank" rel="noopener nofollow ugc"><span class="si">${ICON[s.kind]}</span><span class="txt"><b>${{ instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', website: 'Website' }[s.kind]}</b><span>${esc(s.label)}</span></span><span class="go">${ICON.arrowUpRight}</span></a>`).join('')}</nav>` : ''}
  <div class="sec stats">${stats.map((s) => `<div class="stat"><span class="si ${s.tone ?? ''}">${s.icon}</span><span><b>${esc(s.big)}</b><small>${esc(s.small)}</small></span></div>`).join('')}${stats.length % 2 ? '<div class="stat"></div>' : ''}</div>
  ${disputes || t.bankName || t.isNew ? `<div class="rows">
    ${disputes ? `<div class="row${t.problems ? '' : ' good'}">${ICON.scale}<span>${esc(disputes)}</span></div>` : ''}
    ${t.bankName ? `<div class="row">${ICON.landmark}<span>Paid out to ${esc(shortBankName(t.bankName))}, bank-verified${t.bankMatches ? ' · matches their name' : ''}</span></div>` : ''}
    ${t.isNew ? `<div class="row">${ICON.shieldCheck}<span>New on Hoolam. Every deal is still protected: your money is held until you're happy.</span></div>` : ''}
  </div>` : ''}
  <p class="note">${ICON.info}<span>Counted from real deals paid through Hoolam. Nobody can edit these numbers, not even the seller.</span></p>
</main>
<section class="how" aria-labelledby="how-h">
  <h2 id="how-h">How buying safely works</h2>
  <ol class="steps">
    <li><span class="si">${ICON.wallet}</span>You pay Hoolam, not the seller</li>
    <li><span class="si">${ICON.shieldCheck}</span>We hold the money safely</li>
    <li><span class="si">${ICON.truck}</span>${esc(t.name)} delivers</li>
    <li><span class="si">${ICON.check}</span>You're happy, then they get paid</li>
  </ol>
</section>
<div class="cta-bar"><a class="cta" href="${esc(buy)}">${ICON.whatsapp}Buy from ${esc(t.name)} safely</a></div>
<a class="sub" href="${esc(check)}">Have a deal code? Open Hoolam on WhatsApp</a>
<footer>${home ? `<a href="${esc(home)}">Hoolam</a>` : '<b>Hoolam</b>'}<span>Pay safe. Ship safe.</span></footer>
</div>
${photo ? `<figure class="lightbox" id="photo" aria-label="${esc(t.name)}"><a class="x" href="#" aria-label="Close"></a><img src="${esc(photo)}" alt="${esc(t.name)}"><a class="close" href="#" aria-label="Close">${ICON.close}</a><figcaption>${esc(t.name)}</figcaption></figure>` : ''}
</body></html>`;
}

export function notFoundPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hoolam</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#FAFAF7;color:#17292b;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}h1{color:#0E5C63;font-size:22px;margin:14px 0 6px}p{color:#5d6b6c;max-width:34ch;margin:0 auto}</style></head>
<body><div>${ICON.mark}<h1>This page isn't available</h1><p>The seller may have hidden it. You can still buy safely with Hoolam on WhatsApp.</p></div></body></html>`;
}
