import { ICON } from './icons.js';
import { compact, shipText, shortBankName, type SellerStats } from './trust.js';

/** Where a seller page's "Buy" button ends up: Hoolam's WhatsApp with "Buy from @slug" typed in. */
export const buyWhatsApp = (waNumber: string, slug: string) => `https://wa.me/${waNumber}?text=${encodeURIComponent(`Buy from @${slug}`)}`;

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
  markUrl?: string | null;
  gaId?: string | null;      // Google Analytics (with consent: no cookies until the visitor accepts on the banner)
  /** The smallest Hoolam fee, for the line under Buy ("Fee from ₦300"). */
  feeFrom?: string | null;
  /** The chat's pictures, as the website shows them (/site/art/<id>), for "What happens when you buy". */
  artBase?: string | null;
  /** Their live items in the Hoolam market (when it's on), newest first. */
  items?: { url: string; img: string; title: string; price: string; was: string | null }[];
  /** All their items in WhatsApp. */
  itemsMore?: string | null;
}

/** "today", "yesterday", "3 days ago", "2 weeks ago", "4 months ago" */
export function agoText(d: Date, now = new Date()): string {
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export function sellerPage(t: SellerStats, o: SellerPageOptions): string {
  // "Buy" and their social links pass through this server, so the taps are counted for the seller, then move on instantly
  const buyGo = `${o.baseUrl}/s/${o.slug}/buy`;
  const check = `https://wa.me/${o.waNumber}?text=${encodeURIComponent('hi')}`;
  const since = t.since.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const pct = t.rated >= 5 ? Math.round((100 * t.happy) / t.rated) : null;
  const open = t.problems - t.refunded - t.released;
  const page = `${o.baseUrl}/s/${o.slug}`;
  const photo = t.photoVersion ? `${page}/photo.webp?v=${t.photoVersion}` : null;
  const share = `${page}/share.jpg?v=${[t.photoVersion ?? '0', t.completed, t.rated, t.verified ? 1 : 0].join('-')}`; // changes when the card's numbers do
  const home = o.siteUrl || null;

  const stats: { icon: string; big: string; small: string; tone?: string }[] = [];
  stats.push(t.completed ? { icon: ICON.check, big: String(t.completed), small: t.completed === 1 ? 'order completed' : 'orders completed', tone: 'green' } : { icon: ICON.sprout, big: 'New', small: 'on Hoolam' });
  if (t.buyers > 1) stats.push({ icon: ICON.users, big: String(t.buyers), small: 'different buyers' });
  if (pct != null) stats.push({ icon: ICON.thumbsUp, big: `${pct}%`, small: `buyers happy · ${t.rated} ratings`, tone: 'gold' });
  else if (t.rated) stats.push({ icon: ICON.thumbsUp, big: `${t.happy}/${t.rated}`, small: 'buyers happy', tone: 'gold' });
  if (t.pageViews) stats.push({ icon: ICON.eye, big: compact(t.pageViews), small: 'page views' });
  if (t.shipHours != null) stats.push({ icon: ICON.package, big: shipText(t.shipHours).replace(/^in about |^within /, ''), small: 'usually ships' });

  const disputes = t.problems
    ? `${t.problems} problem${t.problems === 1 ? '' : 's'} reported` + [t.refunded ? `${t.refunded} refunded after review` : '', t.released ? `${t.released} settled in the seller's favour` : '', open > 0 ? `${open} being reviewed` : ''].filter(Boolean).map((x) => ` · ${x}`).join('')
    : t.completed ? 'No problems reported' : null;
  const title = `${t.name} on Hoolam${t.city ? ` · seller in ${t.city}` : ''}`;
  const who = `${t.verified ? 'Verified seller' : 'Seller'}${t.city ? ` in ${t.city}, Nigeria` : ' in Nigeria'}`;
  const desc = t.completed
    ? `${who}. ${t.completed} safe ${t.completed === 1 ? 'order' : 'orders'} completed on Hoolam. Pay through Hoolam on WhatsApp: your money is held until you're happy.`
    : `${who}. Buy from ${t.name} safely through Hoolam on WhatsApp: your money is held until you're happy.`;
  // the seller as search engines and AI tools read it (only what the page itself shows)
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'ProfilePage', url: page, name: title, description: desc, inLanguage: 'en-NG',
    ...(home ? { isPartOf: { '@type': 'WebSite', name: 'Hoolam', url: home } } : {}),
    // the platform behind the page, with the logo it shows (the uploaded logo icon, else the drawing)
    publisher: { '@type': 'Organization', name: 'Hoolam', alternateName: 'useHoolam', ...(home ? { url: home } : {}), logo: o.markUrl ?? `${o.baseUrl}/favicon.svg` },
    mainEntity: {
      '@type': 'Organization', name: t.name, url: page, description: desc,
      ...(photo ? { image: photo } : {}),
      address: { '@type': 'PostalAddress', ...(t.city ? { addressLocality: t.city } : {}), addressCountry: 'NG' },
      ...(t.socials.length ? { sameAs: t.socials.map((x) => x.url) } : {}),
    },
  };
  const brand = `${o.markUrl ? `<img class="mark-img" src="${esc(o.markUrl)}" alt="">` : ICON.mark}<span>Hoolam</span>`;
  const name = esc(t.name);
  // what Hoolam checked: each line only when it's true
  const checks = [
    t.verified ? `<span><b>ID checked</b>BVN or NIN, once, through a licensed checker</span>` : '',
    t.verified || (t.bankName && t.bankMatches) ? `<span><b>Payout account in their own name</b>Checked with the bank${t.bankName ? ` (${esc(shortBankName(t.bankName))})` : ''}</span>`
      : t.bankName ? `<span><b>Payout account checked with the bank</b>Money goes only to that account (${esc(shortBankName(t.bankName))})</span>` : '',
    `<span><b>Their own WhatsApp number</b>Every order runs through Hoolam's chat with them</span>`,
  ].filter(Boolean);
  const video = t.video ? `${page}/video.mp4?v=${t.video.version}` : null;
  const art = (id: string) => `${esc((o.artBase ?? o.baseUrl).replace(/\/+$/, ''))}/site/art/${id}`;
  const howSteps: [string, string][] = [['status-3', 'You pay Hoolam. We hold the money.'], ['status-4', `${name} sends your order.`], ['status-5', 'You check it, then tap I\'m happy.'], ['status-6', `${name} is paid. Everybody happy.`]];

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0E5C63">
<link rel="canonical" href="${esc(page)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>
<link rel="icon" href="${esc(o.markUrl ?? `${o.baseUrl}/favicon.svg`)}">
<meta property="og:type" content="profile"><meta property="og:site_name" content="Hoolam">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(page)}">
<meta property="og:image" content="${esc(share)}"><meta property="og:image:width" content="1600"><meta property="og:image:height" content="900">
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
.chip.teal{background:var(--teal);color:#fff;position:relative;cursor:help}
.chip.teal .tip{position:absolute;left:0;bottom:calc(100% + 8px);width:max-content;max-width:220px;background:var(--ink);color:#fff;font-weight:500;font-size:12.5px;line-height:1.35;padding:8px 10px;border-radius:10px;opacity:0;pointer-events:none;transition:opacity .15s}
.chip.teal:hover .tip,.chip.teal:focus .tip{opacity:1}
.chip.teal:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
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
.items{margin:16px 0 0}
.items-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px}
.items-h h2{font:600 16px Poppins,Inter,sans-serif}
.items-h a{font-size:13px;font-weight:600;color:var(--teal);text-decoration:none}
.irow{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;padding-bottom:4px;scroll-snap-type:x mandatory}
.irow::-webkit-scrollbar{display:none}
.it{flex:0 0 140px;scroll-snap-align:start;text-decoration:none;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;transition:transform .2s}
.it:hover{transform:translateY(-2px)}
.it img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:var(--teal-50)}
.it span{display:block;padding:7px 9px 9px;font-size:12.5px;line-height:1.3;overflow:hidden;text-overflow:ellipsis}
.it b{display:block;font-weight:600;color:var(--teal);margin-top:2px}
.it s{color:var(--faint);font-size:11.5px;font-weight:400;margin-left:4px}
.how{margin:16px 0;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px 0 16px}
.how h2{font:600 16px Poppins,Inter,sans-serif;color:var(--ink);padding:0 20px}
.how-sub{color:var(--muted);font-size:13px;padding:2px 20px 0}
.shots{list-style:none;padding:12px 20px 4px;margin:0;display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.shots::-webkit-scrollbar{display:none}
.shots li{flex:0 0 78%;scroll-snap-align:center;display:flex;flex-direction:column;gap:8px}
.shots img{width:100%;height:auto;aspect-ratio:16/9;border-radius:14px;border:1px solid var(--line);background:var(--teal-50);display:block}
.shots span{display:flex;gap:8px;align-items:flex-start;font-size:13.5px;line-height:1.35;font-weight:500}
.shots b{flex:none;width:22px;height:22px;border-radius:50%;background:var(--teal);color:#fff;display:grid;place-items:center;font-size:12px}
.shots li:last-child b{background:var(--green)}
/* the seller's video */
.vid{margin:0 20px 20px}
.vid-frame{position:relative;border-radius:18px;overflow:hidden;background:radial-gradient(120% 90% at 50% 0%,#14595f,#0b2427);aspect-ratio:4/5;max-height:400px;margin:0 auto}
.vid video{width:100%;height:100%;object-fit:cover;display:block}
.vid-frame.on video{object-fit:contain}
.vid-play{position:absolute;inset:0;margin:auto;width:72px;height:72px;border-radius:50%;border:0;background:rgba(255,255,255,.94);color:var(--teal);display:grid;place-items:center;cursor:pointer;box-shadow:0 12px 30px -8px rgba(0,0,0,.55),0 0 0 8px rgba(255,255,255,.22);transition:transform .2s}
.vid-play:hover{transform:scale(1.06)}
.vid-play .ic{width:30px;height:30px;margin-left:4px}
.vid-frame.on .vid-play{display:none}
.vid figcaption{display:flex;gap:6px;align-items:center;justify-content:center;margin-top:8px;font-size:12.5px;color:var(--muted);font-weight:500}
.vid figcaption .ic{width:15px;height:15px;color:var(--green)}
/* the last order, what Hoolam checked, what buyers say, recently delivered */
.recent{display:flex;align-items:center;gap:10px;padding:12px 20px;font-size:13.5px;color:var(--muted);border-bottom:1px solid var(--line)}
.recent b{color:var(--ink)}
.pulse{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(46,139,87,.16);flex:none}
.checked,.words,.delivered{padding:16px 20px 18px}
.sec h2{font:600 14.5px Poppins,Inter,sans-serif;margin-bottom:10px}
.checked ul{list-style:none;padding:0;display:grid;gap:10px}
.checked li{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.35}
.checked .tick{width:22px;height:22px;border-radius:50%;background:var(--green-50);color:var(--green);display:grid;place-items:center;flex:none;margin-top:1px}
.checked .tick .ic{width:14px;height:14px}
.checked li span:not(.tick){display:flex;flex-direction:column;color:var(--muted)}
.checked li span b{color:var(--ink);font-weight:600}
.q{margin:0;padding:12px 14px;border-radius:14px;background:#FCFCFA;border:1px solid var(--line)}
.q+.q{margin-top:8px}
.q blockquote{margin:0;font-size:14px;line-height:1.45}
.q figcaption{margin-top:6px;font-size:12px;color:var(--muted);font-weight:500}
.dgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.dph{position:relative;border-radius:12px;overflow:hidden;aspect-ratio:1;background:var(--teal-50)}
.dph img{width:100%;height:100%;object-fit:cover;display:block}
.dph i{position:absolute;left:6px;bottom:6px;display:inline-flex;align-items:center;gap:3px;font:600 10.5px Inter,sans-serif;font-style:normal;color:#fff;background:rgba(46,139,87,.92);padding:3px 7px 3px 5px;border-radius:99px}
.dph i .ic{width:11px;height:11px}
/* only pay through Hoolam; what the Buy button does */
.safe{display:flex;gap:10px;align-items:flex-start;margin:0 0 4px;padding:13px 16px;border-radius:16px;background:var(--gold-50);color:#5B430C;font-size:13.5px;line-height:1.45}
.safe .ic{color:#8A6418;margin-top:2px}
.safe b{color:#3F2E08}
.cta-note{text-align:center;color:var(--muted);font-size:12px;margin-top:8px;line-height:1.4}
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
</style>${analytics(o)}</head><body><div class="wrap">
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
      ${t.verified ? `<span class="chip teal" tabindex="0" aria-describedby="vtip">${ICON.badgeCheck}Verified seller<span class="tip" id="vtip" role="tooltip">ID and bank account name checked by Hoolam</span></span>` : ''}
      ${t.bankName && !t.verified ? `<span class="chip green">${ICON.badgeCheck}Bank-verified payouts</span>` : ''}
      ${t.isNew ? `<span class="chip gold">${ICON.sprout}New on Hoolam</span>` : ''}
    </div>
  </div>
  ${video ? `<figure class="vid" aria-label="A video from ${name}">
    <div class="vid-frame"><video controls playsinline preload="none"${photo ? ` poster="${esc(photo)}"` : ''} src="${esc(video)}"></video><button type="button" class="vid-play" aria-label="Play ${name}'s video">${ICON.play}</button></div>
    <figcaption>${ICON.shieldCheck}<span>A message from ${name}, checked by Hoolam</span></figcaption>
  </figure>` : ''}
  ${t.socials.length ? `<nav class="socials" aria-label="Where ${esc(t.name)} sells">${t.socials.map((s) => `<a class="soc ${s.kind}" href="${esc(`${page}/go/${s.kind}`)}" data-social="${s.kind}" target="_blank" rel="noopener nofollow ugc"><span class="si">${ICON[s.kind]}</span><span class="txt"><b>${{ instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', website: 'Website' }[s.kind]}</b><span>${esc(s.label)}</span></span><span class="go">${ICON.arrowUpRight}</span></a>`).join('')}</nav>` : ''}
  <div class="sec stats">${stats.map((s) => `<div class="stat"><span class="si ${s.tone ?? ''}">${s.icon}</span><span><b>${esc(s.big)}</b><small>${esc(s.small)}</small></span></div>`).join('')}${stats.length % 2 ? '<div class="stat"></div>' : ''}</div>
  ${t.lastCompletedAt ? `<p class="recent"><span class="pulse" aria-hidden="true"></span>Last order completed <b>${agoText(t.lastCompletedAt)}</b></p>` : ''}
  ${disputes || t.isNew ? `<div class="rows">
    ${disputes ? `<div class="row${t.problems ? '' : ' good'}">${ICON.scale}<span>${esc(disputes)}</span></div>` : ''}
    ${t.isNew ? `<div class="row">${ICON.shieldCheck}<span>New on Hoolam. Every order is still protected: your money is held until you're happy.</span></div>` : ''}
  </div>` : ''}
  <div class="sec checked"><h2>What Hoolam checked</h2><ul>${checks.map((c) => `<li><span class="tick">${ICON.check}</span>${c}</li>`).join('')}</ul></div>
  ${t.reviews?.length ? `<div class="sec words"><h2>What buyers say</h2>${t.reviews.map((r) => `<figure class="q"><blockquote>“${esc(r.text)}”</blockquote><figcaption>${esc(r.name)}${r.area ? `, ${esc(r.area)}` : ''} · ${agoText(r.at)}</figcaption></figure>`).join('')}</div>` : ''}
  ${t.delivered?.length ? `<div class="sec delivered"><h2>Recently delivered</h2><div class="dgrid">${t.delivered.map((id) => `<span class="dph"><img src="${esc(`${page}/delivered/${id}.webp`)}" alt="An item ${name} delivered" width="160" height="160" loading="lazy" decoding="async"><i>${ICON.check}Delivered</i></span>`).join('')}</div></div>` : ''}
  <p class="note">${ICON.info}<span>Counted from real orders paid through Hoolam. Nobody can edit these numbers, not even the seller.</span></p>
</main>
${o.items?.length ? `<section class="items" aria-labelledby="items-h"><div class="items-h"><h2 id="items-h">Items for sale</h2>${o.itemsMore ? `<a href="${esc(o.itemsMore)}">See all on WhatsApp</a>` : ''}</div><div class="irow">${o.items.map((x) => `<a class="it" href="${esc(x.url)}"><img src="${esc(x.img)}" alt="" width="140" height="140" loading="lazy" decoding="async"><span>${esc(x.title)}<b>${esc(x.price)}${x.was ? `<s>${esc(x.was)}</s>` : ''}</b></span></a>`).join('')}</div></section>` : ''}
<section class="how" aria-labelledby="how-h">
  <h2 id="how-h">What happens when you buy</h2>
  <p class="how-sub">What you'll see in WhatsApp, step by step.</p>
  <ol class="shots">${howSteps.map(([id, cap], i) => `<li><img src="${art(id)}" alt="" width="900" height="506" loading="lazy" decoding="async"><span><b>${i + 1}</b>${cap}</span></li>`).join('')}</ol>
</section>
<p class="safe">${ICON.lock}<span><b>Only pay through Hoolam.</b> Pay into the account Hoolam sends you in our WhatsApp chat, never to ${name} directly. That's what keeps your money safe.</span></p>
<div class="cta-bar"><a class="cta" href="${esc(buyGo)}" data-wa>${ICON.whatsapp}Buy from ${name} safely</a><p class="cta-note">Opens WhatsApp · No app or account · You pay only after ${name} accepts${o.feeFrom ? ` · Fee from ${esc(o.feeFrom)}` : ''}</p></div>
<a class="sub" href="${esc(check)}">Have an order code? Open Hoolam on WhatsApp</a>
<footer>${home ? `<a href="${esc(home)}">Hoolam</a>` : '<b>Hoolam</b>'}<span>Pay safe. Ship safe.</span></footer>
</div>
${photo ? `<figure class="lightbox" id="photo" aria-label="${esc(t.name)}"><a class="x" href="#" aria-label="Close"></a><img src="${esc(photo)}" alt="${esc(t.name)}"><a class="close" href="#" aria-label="Close">${ICON.close}</a><figcaption>${esc(t.name)}</figcaption></figure>` : ''}
${video ? `<script>(function(){var f=document.querySelector('.vid-frame');if(!f)return;var v=f.querySelector('video'),b=f.querySelector('.vid-play');v.controls=false;b.onclick=function(){v.controls=true;v.play();};v.addEventListener('play',function(){f.classList.add('on');if(window.gtag)gtag('event','seller_video_play');});v.addEventListener('pause',function(){if(!v.seeking)f.classList.remove('on');});v.addEventListener('ended',function(){f.classList.remove('on');});})();</script>\n` : ''}${o.gaId && home ? `<script src="${esc(home.replace(/\/+$/, ''))}/assets/analytics.js" data-cookies="${esc(home.replace(/\/+$/, ''))}/legal/cookies/" defer></script>\n` : ''}</body></html>`;
}

export interface NotFoundOptions {
  /** What was asked for: a seller's page, an order link, or anything else. */
  kind?: 'seller' | 'order' | 'other';
  waNumber?: string;
  markUrl?: string | null;
  siteUrl?: string | null;
}

/** "This page isn't available", with what to do next: check a seller, start an order, Hoolam's official number. */
export function notFoundPage(o: NotFoundOptions = {}): string {
  const kind = o.kind ?? 'other';
  const wa = (o.waNumber ?? '').replace(/\D/g, '');
  const chat = (t: string) => (wa ? `https://wa.me/${wa}?text=${encodeURIComponent(t)}` : '#');
  const num = wa ? (wa.startsWith('234') ? `0${wa.slice(3)}` : `+${wa}`).replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3') : '';
  const home = o.siteUrl ? o.siteUrl.replace(/\/+$/, '') : null;
  const h1 = kind === 'seller' ? "This page isn't available" : kind === 'order' ? "This link doesn't open an order" : "This page doesn't exist";
  const lead = kind === 'seller' ? 'The seller may have hidden it, or the link is wrong. You can still check them and buy safely.'
    : kind === 'order' ? 'The link may be cut short or old. Your order is safe; open it in our WhatsApp chat instead.'
    : 'The link may be wrong or old. Here is what you can do instead.';
  const mark = o.markUrl ? `<img src="${esc(o.markUrl)}" alt="" width="44" height="44">` : ICON.mark;
  const step = (icon: string, title: string, text: string, href: string) => `<a class="nx" href="${esc(href)}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}><i>${icon}</i><span><b>${title}</b>${text}</span>${ICON.arrowUpRight}</a>`;
  return `<!doctype html><html lang="en-NG"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(h1)} · Hoolam</title>
<style>
*{box-sizing:border-box}body{font:16px/1.55 Inter,system-ui,sans-serif;background:#F7F3EC;color:#1B2321;margin:0;padding:24px 16px 32px;-webkit-font-smoothing:antialiased}
.w{max-width:440px;margin:0 auto}.mk{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;overflow:hidden}.mk img,.mk svg{width:44px;height:44px}
h1{font:700 1.45rem/1.25 Poppins,Inter,sans-serif;letter-spacing:-.02em;margin:18px 0 6px;color:#0E5C63}p{color:#58615E;margin:0}
.list{display:grid;gap:10px;margin-top:22px}
.nx{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:18px;background:#FFFDF9;box-shadow:inset 0 0 0 1px #E8E1D5;text-decoration:none;color:inherit}
.nx:hover{box-shadow:inset 0 0 0 1.5px #0E5C63}.nx:focus-visible{outline:3px solid #C9992E;outline-offset:2px}
.nx i{flex:none;width:40px;height:40px;border-radius:12px;background:#E2EFEA;color:#0E5C63;display:grid;place-items:center}.nx i .ic{width:20px;height:20px}
.nx span{flex:1;min-width:0;font-size:.9rem;color:#58615E}.nx b{display:block;color:#1B2321;font-size:1rem}
.nx>.ic{color:#0E5C63;flex:none}
.off{margin-top:22px;padding:16px;border-radius:18px;background:#DDEFE3;color:#1F5B3A;font-size:.88rem}.off b{display:block;font-size:1.2rem;color:#1B2321;font-variant-numeric:tabular-nums;margin-top:2px}
.home{display:inline-block;margin-top:20px;color:#0E5C63;font-weight:600;font-size:.92rem}
</style></head>
<body><div class="w"><span class="mk">${mark}</span><h1>${esc(h1)}</h1><p>${esc(lead)}</p>
<div class="list">
${kind === 'order' ? step(ICON.whatsapp, 'Open my orders', 'See every order and where the money is', chat('My orders')) : ''}
${step(ICON.shieldCheck, 'Check a seller', 'Send their number. See their record before you pay', chat('Check a seller'))}
${step(ICON.lock, 'Start a safe order', 'Pay Hoolam, not the seller. They\'re paid when you\'re happy', chat('Hi Hoolam, I want to buy safely'))}
</div>
${num ? `<p class="off">Hoolam's only WhatsApp number<b>${esc(num)}</b>We never ask for your PIN or OTP, or for payment into a personal account.</p>` : ''}
${home ? `<a class="home" href="${esc(home)}/">Go to hoolam.com</a>` : ''}
</div></body></html>`;
}

/** The Google tag for a seller's page: every consent starts "denied" (the banner on hoolam.com's analytics.js asks), and events carry the seller. */
function analytics(o: SellerPageOptions): string {
  if (!o.gaId || !/^G-[A-Z0-9]+$/.test(o.gaId) || !o.siteUrl) return '';
  return `
<script>window.HOOLAM_PAGE={seller:${JSON.stringify(o.slug).replace(/</g, '\\u003c')}};window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:/(?:^|;\\s*)hoolam_consent=yes/.test(document.cookie)?'granted':'denied'});
gtag('js',new Date());gtag('config','${o.gaId}',{content_group:'Seller pages',seller:${JSON.stringify(o.slug).replace(/</g, '\\u003c')}});</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${o.gaId}"></script>`;
}
