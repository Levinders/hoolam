import { categoryTitle } from './deals/categories.js';
import { dayText, type Deal } from './deals/service.js';
import { ICON } from './icons.js';
import { formatMoney } from './money.js';
import { STATUS_WORDS } from './whatsapp/messages.js';

/**
 * THE PRIVATE ORDER PAGE: /o/HL-XXXXX?k=<key>. The key is only ever sent to the buyer and the seller.
 * It shows the order like a receipt: photos, details, money, delivery and progress. It never shows the
 * handover code (both sides get this link; only the buyer may know the code). Not indexed by search engines.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface OrderPageOptions {
  photoIds: number[];
  photoUrl: (id: number) => string;
  chatUrl: string;
  markUrl: string | null;
  sellerName: string | null;
  buyerName: string | null;
}

interface Step { label: string; at: Date | string | null; done: boolean; now?: boolean; bad?: boolean }

function steps(d: Deal): Step[] {
  const paid = !!d.funded_at || ['FUNDED', 'SHIPPED', 'RELEASING', 'PAYOUT_PENDING', 'COMPLETED', 'DISPUTED', 'REFUNDING', 'REFUNDED'].includes(d.status);
  const accepted = !['AWAITING_SELLER'].includes(d.status) && !(d.status === 'CANCELLED' && !paid && !d.seller_id) && !(d.status === 'EXPIRED' && !d.seller_id);
  const closedEarly = ['CANCELLED', 'EXPIRED'].includes(d.status) && !paid;
  const refunded = ['REFUNDING', 'REFUNDED'].includes(d.status);
  const list: Step[] = [
    { label: 'Order sent', at: d.created_at, done: true },
    { label: d.started_by === 'BUYER' ? 'Seller accepted' : 'Buyer joined', at: null, done: accepted },
    { label: 'Paid, money held by Hoolam', at: d.funded_at, done: paid },
    { label: d.dispatch_method === 'PICKUP' ? 'Ready for pickup' : 'Dispatched', at: d.dispatched_at ?? d.shipped_at, done: !!(d.dispatched_at ?? d.shipped_at) },
    { label: 'Handed over', at: d.handed_over_at, done: !!d.handed_over_at || d.status === 'COMPLETED' },
    { label: refunded ? (d.status === 'REFUNDED' ? 'Refunded to the buyer' : 'Refunding the buyer') : 'Seller paid', at: null, done: ['COMPLETED', 'REFUNDED'].includes(d.status) },
  ];
  if (closedEarly) return [list[0]!, { label: d.status === 'EXPIRED' ? 'Closed: nobody answered in time' : 'Cancelled before payment', at: null, done: true, bad: true }];
  const firstOpen = list.findIndex((s) => !s.done);
  if (firstOpen >= 0) list[firstOpen]!.now = true;
  if (d.status === 'DISPUTED') list.splice(Math.max(1, firstOpen), 0, { label: 'Problem reported: money frozen', at: null, done: true, bad: true });
  return list;
}

const when = (at: Date | string | null) => at ? new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '';

export function orderPage(d: Deal, o: OrderPageOptions): string {
  const m = (minor: number) => formatMoney(minor, d.currency);
  const fee = d.buyer_pays_minor - d.price_minor > 0 ? d.buyer_pays_minor - d.price_minor : d.price_minor - d.seller_gets_minor;
  const status = (STATUS_WORDS[d.status] ?? d.status).replace(/^./, (c) => c.toUpperCase());
  const deliveryFee = Number(d.delivery_fee_minor ?? 0);
  const rows: [string, string][] = [
    ['Total price', m(d.price_minor) + (d.started_by === 'BUYER' ? ' <small>delivery included</small>' : '')],
    ['Hoolam fee', `${m(fee)} <small>paid by the ${d.fee_payer === 'SELLER' ? 'seller' : 'buyer'}</small>`],
    ['Buyer pays', `<b>${m(d.buyer_pays_minor)}</b>`],
    ...(deliveryFee ? [['Delivery fee', `${m(deliveryFee)} <small>to the ${d.dispatch_method === 'WAYBILL' ? 'driver' : 'rider'}, from the seller's share</small>`] as [string, string]] : []),
    ['Seller receives', `<b>${m(d.seller_gets_minor - deliveryFee)}</b>`],
  ];
  const delivery: string[] = [
    d.delivery_address ? `${ICON.mapPin}<span><b>Deliver to</b>${esc(d.delivery_address)}</span>` : '',
    d.arrive_by ? `${ICON.calendar}<span><b>Expected by</b>${esc(dayText(String(d.arrive_by)))}</span>` : '',
    d.dispatch_method === 'PICKUP' ? `${ICON.mapPin}<span><b>Pickup at</b>${esc(d.pickup_address ?? '')}</span>` : '',
    d.dispatch_method === 'RIDER' ? `${ICON.truck}<span><b>Rider</b>${esc([d.courier_name, d.courier_phone].filter(Boolean).join(' · '))}</span>` : '',
    d.dispatch_method === 'WAYBILL' ? `${ICON.truck}<span><b>Waybill driver</b>${esc(d.courier_phone ?? '')}${d.courier_location ? ` · to ${esc(d.courier_location)}` : ''}</span>` : '',
  ].filter(Boolean);
  const timeline = steps(d).map((s) => `<li class="${s.bad ? 'bad' : s.done ? 'done' : s.now ? 'now' : ''}"><i></i><span>${esc(s.label)}${s.at && s.done ? `<small>${esc(when(s.at))}</small>` : ''}</span></li>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Order ${esc(d.code)} · Hoolam</title>
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0E5C63">
<link rel="icon" href="${esc(o.markUrl ?? '/favicon.svg')}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@600;700&display=swap" rel="stylesheet">
<style>
:root{--teal:#0E5C63;--teal-d:#0A4146;--teal-50:#EAF3F3;--gold:#C9992E;--gold-50:#FBF4E3;--green:#2E8B57;--green-50:#E7F4EC;--red:#B4473A;--red-50:#FBECEA;--bg:#FAFAF7;--ink:#17292b;--muted:#5d6b6c;--faint:#8a9696;--line:#e6e8e3;--card:#fff}
*{box-sizing:border-box;margin:0}
body{font:15px/1.5 Inter,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
.ic{display:block;flex:none}
.wrap{max-width:560px;margin:0 auto;padding:16px 16px 32px}
header{display:flex;align-items:center;justify-content:space-between;height:44px;margin-bottom:12px}
.brand{display:inline-flex;align-items:center;gap:9px;color:var(--teal);font:600 18px Poppins,Inter,sans-serif;text-decoration:none}
.brand img{width:30px;height:30px;border-radius:9px}
.private{font-size:12px;color:var(--muted);display:inline-flex;gap:6px;align-items:center}
.card{background:var(--card);border:1px solid var(--line);border-radius:22px;overflow:hidden;box-shadow:0 1px 2px rgba(10,65,70,.05),0 24px 48px -30px rgba(14,92,99,.35);margin-bottom:14px}
.top{padding:18px 20px 16px}
.code{font:600 13px Inter;color:var(--teal);letter-spacing:.02em}
h1{font:700 24px/1.2 Poppins,Inter,sans-serif;letter-spacing:-.02em;margin-top:4px;word-wrap:break-word}
.desc{color:var(--muted);margin-top:6px;white-space:pre-line}
.pill{display:inline-flex;align-items:center;gap:6px;margin-top:12px;font-size:13px;font-weight:600;padding:6px 11px;border-radius:999px;background:var(--teal-50);color:var(--teal)}
.pill.done{background:var(--green-50);color:var(--green)}.pill.bad{background:var(--red-50);color:var(--red)}
.cat{display:inline-block;margin:12px 0 0 6px;font-size:12.5px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 10px}
.photos{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(70%,1fr);gap:8px;overflow-x:auto;padding:0 20px 18px;scroll-snap-type:x mandatory}
.photos a{scroll-snap-align:start;display:block;border-radius:14px;overflow:hidden;background:var(--teal-50);aspect-ratio:4/3}
.photos img{width:100%;height:100%;object-fit:cover;display:block}
h2{font:600 15px Poppins,Inter,sans-serif;padding:16px 20px 4px}
.money{padding:4px 20px 16px}
.money div{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px dashed var(--line);font-variant-numeric:tabular-nums}
.money div:last-child{border-bottom:0}
.money span:first-child{color:var(--muted)}
.money span:last-child{text-align:right}
.money small,.rowsx small{display:block;color:var(--faint);font-size:12px;font-weight:400;text-align:right}
.rowsx{padding:4px 20px 14px}
.rowsx div{display:flex;gap:12px;align-items:flex-start;padding:9px 0}
.rowsx div+div{border-top:1px solid var(--line)}
.rowsx .ic{color:var(--teal);margin-top:2px}
.rowsx b{display:block;font-size:12px;color:var(--faint);font-weight:500}
.tl{list-style:none;padding:8px 20px 18px}
.tl li{display:flex;gap:12px;align-items:flex-start;position:relative;padding:7px 0;color:var(--faint)}
.tl li i{width:14px;height:14px;border-radius:50%;border:2px solid var(--line);background:#fff;margin-top:4px;flex:none;position:relative;z-index:1}
.tl li:not(:last-child):after{content:"";position:absolute;left:6px;top:22px;bottom:-8px;width:2px;background:var(--line)}
.tl li.done{color:var(--ink)}.tl li.done i{background:var(--green);border-color:var(--green)}
.tl li.now{color:var(--ink);font-weight:600}.tl li.now i{border-color:var(--gold);box-shadow:0 0 0 4px var(--gold-50)}
.tl li.bad{color:var(--red)}.tl li.bad i{background:var(--red);border-color:var(--red)}
.tl small{display:block;font-size:12px;color:var(--faint);font-weight:400}
.note{display:flex;gap:8px;font-size:13px;color:var(--muted);padding:14px 20px;background:#FCFCFA;border-top:1px solid var(--line)}
.note .ic{color:var(--teal);margin-top:2px}
.cta{display:flex;align-items:center;justify-content:center;gap:10px;background:var(--teal);color:#fff;text-decoration:none;font-weight:600;min-height:54px;border-radius:16px;margin-top:6px}
.cta:hover{background:var(--teal-d)}
footer{text-align:center;color:var(--faint);font-size:12px;margin-top:18px}
@media (min-width:600px){.photos{grid-auto-columns:minmax(45%,1fr)}}
</style></head><body><div class="wrap">
<header><a class="brand" href="${esc(o.chatUrl)}">${o.markUrl ? `<img src="${esc(o.markUrl)}" alt="">` : ''}<span>Hoolam</span></a><span class="private">${ICON.shieldCheck}Private order page</span></header>

<section class="card">
  <div class="top">
    <div class="code">Order ${esc(d.code)}</div>
    <h1>${esc(d.item)}</h1>
    ${d.description ? `<p class="desc">${esc(d.description)}</p>` : ''}
    <span class="pill${['COMPLETED'].includes(d.status) ? ' done' : ['DISPUTED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'REFUNDING'].includes(d.status) ? ' bad' : ''}">${esc(status)}</span>${d.category ? `<span class="cat">${esc(categoryTitle(d.category) ?? '')}</span>` : ''}
  </div>
  ${o.photoIds.length ? `<div class="photos">${o.photoIds.map((id, i) => `<a href="${esc(o.photoUrl(id))}" target="_blank" rel="noopener"><img src="${esc(o.photoUrl(id))}" alt="Photo ${i + 1} of the item" loading="lazy"></a>`).join('')}</div>` : ''}
</section>

<section class="card"><h2>Progress</h2><ol class="tl">${timeline}</ol></section>

<section class="card"><h2>Money</h2><div class="money">${rows.map(([a, b]) => `<div><span>${a}</span><span>${b}</span></div>`).join('')}</div>
  <p class="note">${ICON.shieldCheck}<span>The buyer's money is held by Hoolam. The seller is paid only when the buyer is happy, or after the time set once the item is handed over.</span></p></section>

${delivery.length || o.sellerName || o.buyerName ? `<section class="card"><h2>People and delivery</h2><div class="rowsx">
  ${o.sellerName ? `<div>${ICON.badgeCheck}<span><b>Seller</b>${esc(o.sellerName)}</span></div>` : ''}
  ${o.buyerName ? `<div>${ICON.users}<span><b>Buyer</b>${esc(o.buyerName)}</span></div>` : ''}
  ${delivery.map((x) => `<div>${x}</div>`).join('')}
</div></section>` : ''}

<a class="cta" href="${esc(o.chatUrl)}">Continue on WhatsApp</a>
<footer>Only the buyer and the seller have this link. Please don't share it.</footer>
</div></body></html>`;
}
