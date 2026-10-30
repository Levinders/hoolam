import { ICON } from './icons.js';

/**
 * An item in the Hoolam market, on its own public page: go.hoolam.com/i/<code>.
 * Photos you can swipe, the price (old one struck through on a promo), how it gets to you, who sells it and their
 * record, and one button: "Buy safely on WhatsApp", which opens Hoolam's chat on this item.
 * Live items are for search engines (product data with the price and stock); anything else is noindex.
 * Everything a seller typed is escaped.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'H';

export interface ItemPageData {
  code: string; title: string; details: string | null; category: string | null;
  priceMinor: number; nowMinor: number; onPromo: boolean; offPct: number; promoEnds: Date | null;
  stock: number; live: boolean; soldOut: boolean;
  delivery: ('pickup' | 'rider' | 'waybill')[];
  area: string | null; city: string | null; state: string | null;
  photos: number;
  seller: { name: string; verified: boolean; orders: number; happyPct: number | null; slug: string | null; photo: boolean; since: Date };
  /** Other live items from the same seller (up to 6). */
  more: { code: string; title: string; price: string; was: string | null }[];
  updatedAt: Date;
}
export interface ItemPageOptions {
  baseUrl: string; siteUrl?: string | null; markUrl?: string | null; artBase?: string | null;
  money: (minor: number) => string;
  /** The seller's round photo (their trust page photo), when they have one. */
  sellerPhotoUrl?: string | null;
}

export function itemPage(d: ItemPageData, o: ItemPageOptions): string {
  const base = o.baseUrl.replace(/\/+$/, '');
  const page = `${base}/i/${d.code}`;
  const pic = (i: number) => `${page}/${i + 1}.jpg`;
  const buy = `${page}/buy`;
  const m = o.money;
  const where = [d.area, d.city].filter(Boolean).join(', ') || d.state || 'Nigeria';
  const home = o.siteUrl || null;
  const sellerPage = d.seller.slug ? `${base}/s/${d.seller.slug}` : null;
  const name = esc(d.seller.name);
  const ends = d.onPromo && d.promoEnds ? d.promoEnds.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' }) : null;
  const title = `${d.title} · ${m(d.nowMinor)} · ${d.seller.name} on Hoolam`;
  const desc = `${d.title} for ${m(d.nowMinor)}${d.onPromo ? ` (was ${m(d.priceMinor)})` : ''}, from ${d.seller.name}${d.seller.verified ? ', a verified seller' : ''} in ${where}. Buy safely on WhatsApp: Hoolam holds your money until you're happy.`;
  const deliveryRows: [string, string, string][] = d.delivery.map((x) => x === 'pickup'
    ? ['store', 'Pickup', `From the seller in ${where}`]
    : x === 'rider' ? ['truck', 'Dispatch rider', `Delivered in ${d.city ?? 'the seller\'s city'}`]
    : ['package', 'Waybill', 'Sent to other states']);
  const record = d.seller.orders ? `${d.seller.orders} order${d.seller.orders === 1 ? '' : 's'} completed${d.seller.happyPct != null ? ` · ${d.seller.happyPct}% happy` : ''}` : 'New on Hoolam';

  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Product', name: d.title, url: page, sku: d.code,
    ...(d.details ? { description: d.details } : { description: desc }),
    ...(d.category ? { category: d.category } : {}),
    image: Array.from({ length: Math.max(1, d.photos) }, (_, i) => pic(i)),
    offers: {
      '@type': 'Offer', url: page, priceCurrency: 'NGN', price: (d.nowMinor / 100).toFixed(2),
      availability: d.live && !d.soldOut ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      ...(ends && d.promoEnds ? { priceValidUntil: d.promoEnds.toISOString().slice(0, 10) } : {}),
      seller: { '@type': 'Organization', name: d.seller.name, ...(sellerPage ? { url: sellerPage } : {}) },
      areaServed: 'NG',
    },
  };
  const brand = `${o.markUrl ? `<img class="mark-img" src="${esc(o.markUrl)}" alt="">` : ICON.mark}<span>Hoolam</span>`;
  const art = (id: string) => `${esc((o.artBase ?? base).replace(/\/+$/, ''))}/site/art/${id}`;
  const how: [string, string][] = [['status-3', 'You pay Hoolam. We hold the money.'], ['status-4', `${name} sends your item.`], ['status-5', 'You check it, then tap I\'m happy.'], ['status-6', `${name} is paid.`]];
  const avatar = o.sellerPhotoUrl ? `<img src="${esc(o.sellerPhotoUrl)}" alt="" width="52" height="52">` : `<span class="ini">${esc(initials(d.seller.name))}</span>`;
  const available = d.live && !d.soldOut;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0E5C63">
<link rel="canonical" href="${esc(page)}">
<meta name="robots" content="${available ? 'index,follow,max-image-preview:large' : 'noindex,follow'}">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>
<link rel="icon" href="${esc(o.markUrl ?? `${base}/favicon.svg`)}">
<meta property="og:type" content="product"><meta property="og:site_name" content="Hoolam">
<meta property="og:title" content="${esc(`${d.title} · ${m(d.nowMinor)}`)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(page)}">
<meta property="og:image" content="${esc(`${page}/card.jpg?v=${d.updatedAt.getTime().toString(36)}`)}"><meta property="og:image:width" content="1080"><meta property="og:image:height" content="1080">
<meta property="product:price:amount" content="${(d.nowMinor / 100).toFixed(2)}"><meta property="product:price:currency" content="NGN">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@600;700&display=swap" rel="stylesheet">
<style>
:root{--teal:#0E5C63;--teal-d:#0A4146;--teal-50:#EAF3F3;--gold:#C9992E;--gold-50:#FBF4E3;--green:#2E8B57;--green-50:#E7F4EC;--red:#C0392B;--bg:#FAFAF7;--ink:#17292b;--muted:#5d6b6c;--faint:#8a9696;--line:#e6e8e3;--card:#fff}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{font:15px/1.5 Inter,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:inherit}
.ic{display:block;flex:none;width:18px;height:18px}
.wrap{width:100%;max-width:480px;margin:0 auto;padding:16px 16px 28px}
header{display:flex;align-items:center;justify-content:space-between;height:44px;margin-bottom:12px}
.brand{display:inline-flex;align-items:center;gap:9px;text-decoration:none;color:var(--teal);font:600 18px Poppins,Inter,sans-serif}
.brand .ic{width:30px;height:30px}
.mark-img{width:30px;height:30px;border-radius:9px;object-fit:contain}
.tag{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--teal);background:var(--teal-50);padding:6px 10px;border-radius:999px}
.tag .ic{width:15px;height:15px}
.card{background:var(--card);border:1px solid var(--line);border-radius:24px;overflow:hidden;box-shadow:0 1px 2px rgba(10,65,70,.05),0 24px 48px -28px rgba(14,92,99,.4)}
.gal{position:relative;background:var(--teal-50)}
.ph{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.ph::-webkit-scrollbar{display:none}
.ph img{flex:0 0 100%;width:100%;aspect-ratio:1;object-fit:cover;scroll-snap-align:center;display:block}
.dots{position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center;gap:6px}
.dots i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.6);box-shadow:0 0 0 1px rgba(0,0,0,.08);transition:width .2s,background .2s}
.dots i.on{width:18px;border-radius:4px;background:#fff}
.off{position:absolute;top:14px;left:14px;background:var(--red);color:#fff;font:700 15px Poppins,Inter;padding:6px 11px;border-radius:10px;box-shadow:0 6px 16px -6px rgba(192,57,43,.6)}
.gone{position:absolute;inset:0;display:grid;place-items:center;background:rgba(250,250,247,.55)}
.gone span{background:var(--ink);color:#fff;font:600 15px Poppins,Inter;padding:9px 16px;border-radius:12px}
.body{padding:18px 20px 6px}
h1{font:600 21px/1.25 Poppins,Inter,sans-serif;letter-spacing:-.01em;word-wrap:break-word}
.price{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;margin-top:8px}
.price b{font:700 28px/1.1 Poppins,Inter,sans-serif;color:var(--teal);letter-spacing:-.02em}
.price s{color:var(--faint);font-size:16px}
.price small{color:#7A5A10;background:var(--gold-50);font-weight:600;font-size:12.5px;padding:3px 8px;border-radius:999px}
.left{margin-top:6px;font-size:13.5px;font-weight:600;color:#9C4A1A}
.details{margin-top:12px;color:var(--ink);font-size:14.5px;white-space:pre-line}
.list{list-style:none;padding:0;margin:14px 0 0;border-top:1px solid var(--line)}
.list li{display:flex;gap:12px;align-items:center;padding:12px 0;font-size:14px}
.list li+li{border-top:1px solid var(--line)}
.list .ic{color:var(--teal);width:20px;height:20px}
.list span{display:flex;flex-direction:column;line-height:1.3}
.list small{color:var(--muted);font-size:12.5px}
.seller{display:flex;gap:12px;align-items:center;padding:14px 20px;border-top:1px solid var(--line);text-decoration:none;background:#FCFCFA}
.av{width:52px;height:52px;border-radius:50%;overflow:hidden;flex:none;box-shadow:0 0 0 3px #fff,0 0 0 4.5px var(--gold);background:var(--teal-50)}
.av img{width:100%;height:100%;object-fit:cover;display:block}
.av .ini{width:100%;height:100%;display:grid;place-items:center;font:700 19px Poppins,Inter;color:var(--teal)}
.seller .t{flex:1;min-width:0}
.seller b{display:flex;align-items:center;gap:6px;font-weight:600}
.seller b .ic{width:16px;height:16px;color:var(--teal)}
.seller small{display:block;color:var(--muted);font-size:12.5px}
.seller .go{color:var(--faint)}
.more{margin:16px 0 0}
.more h2,.how h2{font:600 15px Poppins,Inter,sans-serif;margin:0 0 10px}
.mrow{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;padding-bottom:4px}
.mrow::-webkit-scrollbar{display:none}
.mi{flex:0 0 132px;text-decoration:none;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.mi img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:var(--teal-50)}
.mi span{display:block;padding:7px 9px 9px;font-size:12.5px;line-height:1.3}
.mi b{display:block;font-weight:600;color:var(--teal)}
.mi s{color:var(--faint);font-size:11.5px;margin-left:4px}
.how{margin:16px 0;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px 0 16px}
.how h2{padding:0 20px}
.shots{list-style:none;padding:4px 20px 0;margin:0;display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}
.shots::-webkit-scrollbar{display:none}
.shots li{flex:0 0 78%;scroll-snap-align:center;display:flex;flex-direction:column;gap:8px}
.shots img{width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;border-radius:14px;border:1px solid var(--line);background:var(--teal-50);display:block}
.shots span{display:flex;gap:8px;align-items:flex-start;font-size:13.5px;line-height:1.35;font-weight:500}
.shots b{flex:none;width:22px;height:22px;border-radius:50%;background:var(--teal);color:#fff;display:grid;place-items:center;font-size:12px}
.shots li:last-child b{background:var(--green)}
.safe{display:flex;gap:10px;align-items:flex-start;padding:13px 16px;border-radius:16px;background:var(--gold-50);color:#5B430C;font-size:13.5px;line-height:1.45}
.safe .ic{color:#8A6418;margin-top:2px}
.safe b{color:#3F2E08}
.cta-bar{position:sticky;bottom:0;padding:12px 0 calc(12px + env(safe-area-inset-bottom));background:linear-gradient(rgba(250,250,247,0),var(--bg) 30%)}
.cta{display:flex;align-items:center;justify-content:center;gap:10px;background:var(--teal);color:#fff;text-decoration:none;font-weight:600;font-size:16px;min-height:56px;padding:0 20px;border-radius:16px;box-shadow:0 14px 28px -14px rgba(14,92,99,.75);transition:transform .2s,background .2s}
.cta .ic{width:22px;height:22px}
.cta:hover{background:var(--teal-d)}
.cta:active{transform:scale(.98)}
.cta.quiet{background:#fff;color:var(--teal);border:1.5px solid var(--teal);box-shadow:none}
.cta-note{text-align:center;color:var(--muted);font-size:12px;margin-top:8px;line-height:1.4}
footer{margin-top:22px;display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);text-align:center}
footer a{text-decoration:none;color:var(--teal);font-weight:600}
a:focus-visible{outline:3px solid var(--gold);outline-offset:2px;border-radius:12px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><div class="wrap">
<header>
  ${home ? `<a class="brand" href="${esc(home)}">${brand}</a>` : `<span class="brand">${brand}</span>`}
  <span class="tag">${ICON.shieldCheck}Hoolam market</span>
</header>
<main class="card">
  <div class="gal">
    <div class="ph" aria-label="Photos">${Array.from({ length: Math.max(1, d.photos) }, (_, i) => `<img src="${esc(pic(i))}" alt="${esc(d.title)}${d.photos > 1 ? `, photo ${i + 1}` : ''}" width="600" height="600"${i ? ' loading="lazy"' : ''} decoding="async">`).join('')}</div>
    ${d.photos > 1 ? `<div class="dots" aria-hidden="true">${Array.from({ length: d.photos }, (_, i) => `<i${i ? '' : ' class="on"'}></i>`).join('')}</div>` : ''}
    ${d.onPromo && available ? `<span class="off">−${d.offPct}%</span>` : ''}
    ${!available ? `<div class="gone"><span>${d.soldOut ? 'Sold out for now' : 'Not available now'}</span></div>` : ''}
  </div>
  <div class="body">
    <h1>${esc(d.title)}</h1>
    <div class="price"><b>${esc(m(d.nowMinor))}</b>${d.onPromo ? `<s>${esc(m(d.priceMinor))}</s>${ends ? `<small>Promo until ${esc(ends)}</small>` : ''}` : ''}</div>
    ${available && d.stock > 0 && d.stock <= 3 ? `<p class="left">Only ${d.stock} left</p>` : ''}
    ${d.details ? `<p class="details">${esc(d.details)}</p>` : ''}
    <ul class="list">
      <li>${ICON.mapPin}<span>${esc(where)}<small>Where the item is</small></span></li>
      ${deliveryRows.map(([ic, t, s]) => `<li>${ICON[ic as keyof typeof ICON]}<span>${esc(t)}<small>${esc(s)}</small></span></li>`).join('')}
    </ul>
  </div>
  ${sellerPage ? `<a class="seller" href="${esc(sellerPage)}">` : '<div class="seller">'}
    <span class="av">${avatar}</span>
    <span class="t"><b>${name}${d.seller.verified ? ICON.badgeCheck : ''}</b><small>${d.seller.verified ? 'Verified seller · ' : ''}${esc(record)}</small></span>
    ${sellerPage ? `<span class="go">${ICON.chevronRight}</span></a>` : '</div>'}
</main>
${d.more.length ? `<section class="more" aria-labelledby="more-h"><h2 id="more-h">More from ${name}</h2><div class="mrow">${d.more.map((x) => `<a class="mi" href="${esc(`${base}/i/${x.code}`)}"><img src="${esc(`${base}/i/${x.code}/1.jpg`)}" alt="" width="132" height="132" loading="lazy"><span>${esc(x.title)}<b>${esc(x.price)}${x.was ? `<s>${esc(x.was)}</s>` : ''}</b></span></a>`).join('')}</div></section>` : ''}
<section class="how" aria-labelledby="how-h">
  <h2 id="how-h">How buying safely works</h2>
  <ol class="shots">${how.map(([id, cap], i) => `<li><img src="${art(id)}" alt="" width="900" height="506" loading="lazy" decoding="async"><span><b>${i + 1}</b>${cap}</span></li>`).join('')}</ol>
</section>
<p class="safe">${ICON.lock}<span><b>Only pay through Hoolam.</b> Pay into the account Hoolam sends you in our WhatsApp chat, never to the seller directly.</span></p>
<div class="cta-bar">${available
    ? `<a class="cta" href="${esc(buy)}">${ICON.whatsapp}Buy safely on WhatsApp</a><p class="cta-note">Opens WhatsApp · No app or account · You pay only after ${name} accepts</p>`
    : `<a class="cta quiet" href="${esc(`${buy}?more=1`)}">${ICON.whatsapp}See other items on WhatsApp</a>`}</div>
<footer>${home ? `<a href="${esc(home)}">Hoolam</a>` : '<b>Hoolam</b>'}<span>Pay safe. Ship safe.</span></footer>
</div>
${d.photos > 1 ? `<script>(function(){var p=document.querySelector('.ph'),d=document.querySelectorAll('.dots i');if(!p)return;p.addEventListener('scroll',function(){var i=Math.round(p.scrollLeft/p.clientWidth);d.forEach(function(x,j){x.className=j===i?'on':'';});},{passive:true});})();</script>` : ''}
</body></html>`;
}
