import { localPhone } from './phone.js';
import { categoryTitle } from './deals/categories.js';
import { dayText, type Deal } from './deals/service.js';
import { ICON } from './icons.js';
import { formatMoney } from './money.js';
import { mapsLink, STATUS_WORDS } from './whatsapp/messages.js';

/**
 * THE PRIVATE ORDER PAGE: /o/HL-XXXXX?k=<key>. The key is only ever sent to the buyer and the seller.
 * It shows the order like a receipt: photos, details, money, delivery and progress. It never shows the
 * handover code (both sides get this link; only the buyer may know the code). Not indexed by search engines.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface OrderPageOptions {
  photoIds: number[];
  photoUrl: (id: number) => string;
  /** This side's receipts (pictures), newest last. */
  receipts?: { label: string; url: string }[];
  chatUrl: string;
  markUrl: string | null;
  sellerName: string | null;
  buyerName: string | null;
  /** Whose link opened the page: each side sees their own fee. Null = the neutral page. */
  viewer?: 'buyer' | 'seller' | null;
  /** The chat's status pictures (/site/art/status-N), for "where the money is now". */
  artBase?: string | null;
  /** Minutes after the handover before the seller is paid automatically (Settings → Timing). */
  autoReleaseMinutes?: number;
  /** Hours within which a rep answers a problem (Settings → Timing). */
  problemReplyHours?: number;
  /** The seller's trust line and public page, for the buyer. */
  sellerTrust?: { line: string; url: string | null } | null;
  /** The chat link that opens this order ("View HL-…") and the one that pays it ("Pay HL-…"). */
  viewUrl?: string;
  payUrl?: string;
}

/** "18 hours", "45 minutes", "2 days" */
export function leftText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}

/** Where the money is now (the status picture's step) and what happens next, for whoever opened the page. */
export function nextFor(d: Deal, o: OrderPageOptions, now = Date.now()): { step: number; title: string; text: string; deadline: Date | null; tone: 'teal' | 'gold' | 'green' | 'red'; action: { label: string; url: string } | null } {
  const v = o.viewer ?? null;
  const seller = o.sellerName ?? 'The seller', buyer = o.buyerName ?? 'The buyer';
  const view = o.viewUrl ?? o.chatUrl, pay = o.payUrl ?? o.chatUrl;
  const open = { label: 'Open this order in WhatsApp', url: view };
  const deadline = (at: Date | null) => (at && new Date(at).getTime() > now ? new Date(at) : null);
  switch (d.status) {
    case 'AWAITING_SELLER': return { step: 1, tone: 'gold', deadline: deadline(d.accept_by),
      title: v === 'seller' ? 'Accept or decline this order' : `Waiting for ${seller} to accept`,
      text: v === 'seller' ? 'Nothing is paid yet. Once you accept, the buyer pays Hoolam and you\'re told the moment the money is held.' : 'Nothing is paid yet. Once they accept, you get a one-time account to pay Hoolam (never the seller).',
      action: v === 'seller' ? { label: 'Accept in WhatsApp', url: view } : open };
    case 'AWAITING_BUYER': return { step: 1, tone: 'gold', deadline: deadline(d.accept_by),
      title: v === 'buyer' ? 'Accept this order' : `Waiting for ${buyer} to accept`,
      text: v === 'buyer' ? 'Nothing is paid yet. Accept in WhatsApp to get a one-time account to pay Hoolam. Your money waits with Hoolam until you\'re happy.' : 'Nothing is paid yet. Once they accept and pay, you\'re told the moment the money is held.',
      action: v === 'buyer' ? { label: 'Accept in WhatsApp', url: view } : open };
    case 'AWAITING_PAYMENT': return { step: 2, tone: 'gold', deadline: null,
      title: v === 'seller' ? `Waiting for ${buyer} to pay` : 'Pay Hoolam to start',
      text: v === 'seller' ? 'Don\'t send anything yet. You\'ll get a message the moment the money is held by Hoolam.' : 'Pay into the one-time account Hoolam sent in the chat. The money waits with Hoolam; the seller is paid only when you\'re happy.',
      action: v === 'seller' ? open : { label: 'Pay in WhatsApp', url: pay } };
    case 'FUNDED': return { step: 3, tone: 'teal', deadline: null,
      title: v === 'seller' ? 'The money is held. Send the item' : 'Your money is held by Hoolam',
      text: v === 'seller' ? 'The buyer has paid Hoolam. Send the item, then tap Dispatch in WhatsApp. You\'re paid once the buyer is happy.' : `${seller} can see the money is ready and sends your item next. Nobody can touch the money until you're happy.`,
      action: open };
    case 'SHIPPED': {
      if (d.handed_over_at) {
        const at = new Date(new Date(d.handed_over_at).getTime() + (o.autoReleaseMinutes ?? 1440) * 60_000);
        return { step: 5, tone: 'gold', deadline: deadline(at),
          title: v === 'seller' ? 'Handed over. The buyer is checking it' : 'Check it now',
          text: v === 'seller' ? 'You\'re paid as soon as the buyer taps I\'m happy, or automatically when the time below runs out, unless they report a problem.'
            : `Open it and check it well. Tap I'm happy, or Problem if anything is wrong. If you do neither, ${seller} is paid automatically when the time below runs out.`,
          action: open };
      }
      return { step: 4, tone: 'teal', deadline: null,
        title: v === 'seller' ? 'On the way: hand it over' : 'On the way to you',
        text: v === 'seller' ? 'At the handover, ask the buyer for their 4-digit code and enter it in WhatsApp.' : 'When it arrives, see the item first. Then give the 4-digit code from your chat. Never share it before.',
        action: open };
    }
    case 'RELEASING': case 'PAYOUT_PENDING': return { step: 6, tone: 'green', deadline: null, title: v === 'seller' ? 'You\'re being paid' : `Paying ${seller} now`, text: 'The money is on its way to the seller\'s bank account. A receipt follows in the chat.', action: open };
    case 'COMPLETED': return { step: 6, tone: 'green', deadline: null, title: 'Done. Everybody happy', text: v === 'seller' ? 'You were paid to your bank account. Your receipt is below.' : `${seller} was paid. Thank you for buying safely.`, action: null };
    case 'DISPUTED': return { step: 3, tone: 'red', deadline: null, title: 'Problem reported: the money is frozen',
      text: `Nobody can take it while a Hoolam rep looks at it. A real person replies in the chat within ${o.problemReplyHours ?? 24} hours. Send photos or videos there.`, action: open };
    case 'REFUNDING': return { step: 3, tone: 'teal', deadline: null, title: 'Refunding the buyer', text: 'Everything the buyer paid is on its way back to their bank account.', action: open };
    case 'REFUNDED': return { step: 3, tone: 'green', deadline: null, title: 'Refunded in full', text: 'Everything the buyer paid went back to their bank account. Receipt below.', action: null };
    case 'CANCELLED': return { step: 0, tone: 'red', deadline: null, title: 'Cancelled', text: 'Cancelled before any money moved. Nothing to pay, nothing owed.', action: null };
    case 'EXPIRED': return { step: 0, tone: 'red', deadline: null, title: 'Closed', text: 'Nobody answered in time, so it closed. No money moved.', action: null };
    default: return { step: 0, tone: 'teal', deadline: null, title: STATUS_WORDS[d.status] ?? d.status, text: '', action: open };
  }
}

interface Step { label: string; at: Date | string | null; done: boolean; now?: boolean; bad?: boolean }

function steps(d: Deal): Step[] {
  const paid = !!d.funded_at || ['FUNDED', 'SHIPPED', 'RELEASING', 'PAYOUT_PENDING', 'COMPLETED', 'DISPUTED', 'REFUNDING', 'REFUNDED'].includes(d.status);
  // accepted: by the seller (buyer's order) or by the buyer (seller's order: the buyer is set when they accept)
  const other = d.started_by === 'BUYER' ? d.seller_id : d.buyer_id;
  const accepted = !['AWAITING_SELLER', 'AWAITING_BUYER'].includes(d.status) && !(['CANCELLED', 'EXPIRED'].includes(d.status) && !paid && !other);
  const closedEarly = ['CANCELLED', 'EXPIRED'].includes(d.status) && !paid;
  const refunded = ['REFUNDING', 'REFUNDED'].includes(d.status);
  const list: Step[] = [
    { label: 'Order sent', at: d.created_at, done: true },
    { label: d.started_by === 'BUYER' ? 'Seller accepted' : d.legacy_ship ? 'Buyer joined' : 'Buyer accepted', at: null, done: accepted },
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
  const status = (STATUS_WORDS[d.status] ?? d.status).replace(/^./, (c) => c.toUpperCase());
  const deliveryFee = Number(d.delivery_fee_minor ?? 0);
  // each side sees only their own fee: Hoolam's fee for whoever started the order, the transaction fee for the other
  const buyerFee = d.buyer_pays_minor - d.price_minor, sellerFee = d.price_minor - d.seller_gets_minor;
  const buyerFeeLabel = d.fee_payer === 'BUYER' ? 'Hoolam fee' : 'Transaction fee';
  const sellerFeeLabel = d.fee_payer === 'SELLER' ? 'Hoolam fee' : 'Transaction fee';
  const deliveryRow = deliveryFee ? [['Delivery fee', `−${m(deliveryFee)} <small>to the ${d.dispatch_method === 'WAYBILL' ? 'driver' : 'rider'}</small>`] as [string, string]] : [];
  const total: [string, string] = ['Total price', m(d.price_minor) + (d.started_by === 'BUYER' || !d.legacy_ship ? ' <small>delivery included</small>' : '')];
  const rows: [string, string][] = o.viewer === 'buyer'
    ? [total, ...(buyerFee > 0 ? [[buyerFeeLabel, m(buyerFee)] as [string, string]] : []), ['You pay', `<b>${m(d.buyer_pays_minor)}</b>`]]
    : o.viewer === 'seller'
      ? [total, ...(sellerFee > 0 ? [[sellerFeeLabel, `−${m(sellerFee)}`] as [string, string]] : []), ...deliveryRow, ['You receive', `<b>${m(d.seller_gets_minor - deliveryFee)}</b>`]]
      : [total, ['Buyer pays', `<b>${m(d.buyer_pays_minor)}</b>`], ...deliveryRow, ['Seller receives', `<b>${m(d.seller_gets_minor - deliveryFee)}</b>`]];
  const delivery: string[] = [
    d.delivery_address ? `${ICON.mapPin}<span><b>Deliver to</b>${esc(d.delivery_address)}${mapsLink(d.delivery_address, d.delivery_pin) ? ` · <a href="${esc(mapsLink(d.delivery_address, d.delivery_pin)!)}" target="_blank" rel="noopener">Open in Maps</a>` : ''}</span>` : '',
    d.arrive_by ? `${ICON.calendar}<span><b>${d.started_by === 'SELLER' ? 'Ready by' : 'Expected by'}</b>${esc(dayText(String(d.arrive_by)))}</span>` : '',
    d.dispatch_method === 'PICKUP' ? `${ICON.mapPin}<span><b>Pickup at</b>${esc(d.pickup_address ?? '')}</span>` : '',
    d.dispatch_method === 'RIDER' ? `${ICON.truck}<span><b>Rider</b>${esc([d.courier_name, localPhone(d.courier_phone)].filter(Boolean).join(' · '))}</span>` : '',
    d.dispatch_method === 'WAYBILL' ? `${ICON.truck}<span><b>Waybill driver</b>${esc(localPhone(d.courier_phone))}${d.courier_location ? ` · to ${esc(d.courier_location)}` : ''}</span>` : '',
  ].filter(Boolean);
  const n = nextFor(d, o);
  const art = (step: number) => `${(o.artBase ?? '').replace(/\/+$/, '')}/site/art/status-${step}`;
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
.cta{display:flex;align-items:center;justify-content:center;gap:10px;background:var(--teal);color:#fff;text-decoration:none;font-weight:600;min-height:54px;border-radius:16px;margin-top:14px;padding:0 18px;text-align:center}
.cta:hover{background:var(--teal-d)}
.cta.ghost{background:#fff;color:var(--teal);box-shadow:inset 0 0 0 1.5px var(--line)}
.cta.ghost:hover{box-shadow:inset 0 0 0 1.5px var(--teal)}
/* where the money is now, and what happens next */
.now-pic{display:block;width:100%;height:auto;aspect-ratio:16/9;background:var(--teal-50);border-bottom:1px solid var(--line)}
.now-body{padding:16px 20px 20px}
.now h1{font:700 22px/1.25 Poppins,Inter,sans-serif;margin:0}
.now p{color:var(--muted);margin-top:6px}
.now.red{border-color:#F0CFCA}.now.red h1{color:var(--red)}
.now.green h1{color:var(--green)}
.left{display:flex;align-items:center;gap:8px;margin-top:12px!important;padding:10px 12px;border-radius:12px;background:var(--gold-50);color:#6B4F0E!important;font-size:14px}
.left b{color:#3F2E08;font-variant-numeric:tabular-nums}
.left .ic{color:#8A6418}
.trustline{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;padding:12px 16px;border-radius:16px;background:var(--card);border:1px solid var(--line);text-decoration:none;color:var(--ink);font-size:14px}
.trustline>.ic{color:var(--green)}
.trustline span{flex:1;min-width:0}
.trustline em{display:inline-flex;align-items:center;gap:4px;font-style:normal;color:var(--teal);font-weight:600;font-size:13px}
.trustline em .ic{width:14px;height:14px}
.safe{display:flex;gap:10px;align-items:flex-start;margin:0 0 14px;padding:12px 16px;border-radius:16px;background:var(--gold-50);color:#5B430C;font-size:13.5px;line-height:1.45}
.safe .ic{color:#8A6418;margin-top:2px}.safe b{color:#3F2E08}
.item{font:700 20px/1.25 Poppins,Inter,sans-serif;letter-spacing:-.01em;margin-top:4px;padding:0!important;word-wrap:break-word}
footer{text-align:center;color:var(--faint);font-size:12px;margin-top:18px}
@media (min-width:600px){.photos{grid-auto-columns:minmax(45%,1fr)}}
</style></head><body><div class="wrap">
<header><a class="brand" href="${esc(o.chatUrl)}">${o.markUrl ? `<img src="${esc(o.markUrl)}" alt="">` : ''}<span>Hoolam</span></a><span class="private">${ICON.shieldCheck}Private order page</span></header>

<section class="card now ${n.tone}" aria-labelledby="now-h">
  ${n.step ? `<img class="now-pic" src="${esc(art(n.step))}" alt="Where this order is: step ${n.step} of 6" width="900" height="506">` : ''}
  <div class="now-body">
    <h1 id="now-h">${esc(n.title)}</h1>
    ${n.text ? `<p>${esc(n.text)}</p>` : ''}
    ${n.deadline ? `<p class="left" data-until="${n.deadline.toISOString()}">${ICON.clock}<span><b>${esc(leftText(n.deadline.getTime() - Date.now()))}</b> left · until ${esc(when(n.deadline))}</span></p>` : ''}
    ${n.action ? `<a class="cta" href="${esc(n.action.url)}">${ICON.whatsapp}${esc(n.action.label)}</a>` : ''}
  </div>
</section>
${o.viewer === 'buyer' && o.sellerTrust ? `<a class="trustline" ${o.sellerTrust.url ? `href="${esc(o.sellerTrust.url)}" target="_blank" rel="noopener"` : ''}>${ICON.shieldCheck}<span>${esc(o.sellerTrust.line)}</span>${o.sellerTrust.url ? `<em>See their trust card${ICON.arrowUpRight}</em>` : ''}</a>` : ''}
${o.viewer !== 'seller' && ['AWAITING_SELLER', 'AWAITING_BUYER', 'AWAITING_PAYMENT'].includes(d.status) ? `<p class="safe">${ICON.lock}<span><b>Only pay through Hoolam.</b> Pay into the one-time account Hoolam sends you in our WhatsApp chat, never to the seller directly.</span></p>` : ''}

<section class="card">
  <div class="top">
    <div class="code">Order ${esc(d.code)}</div>
    <h2 class="item">${esc(d.item)}</h2>
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

${o.receipts?.length ? `<section class="card"><h2>Receipts</h2><div class="photos">${o.receipts.map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener" style="aspect-ratio:auto;background:#fff"><img src="${esc(r.url)}" alt="${esc(r.label)}" loading="lazy" style="object-fit:contain;height:auto"></a>`).join('')}</div></section>` : ''}

<a class="cta ghost" href="${esc(o.viewUrl ?? o.chatUrl)}">${ICON.whatsapp}Open this order in WhatsApp</a>
<footer>Only the buyer and the seller have this link. Please don't share it.<br>Hoolam only chats from its own number, and never asks for your PIN or OTP.</footer>
</div>
${n.deadline ? `<script>(function(){var el=document.querySelector('.left[data-until]');if(!el)return;var b=el.querySelector('b'),t=+new Date(el.getAttribute('data-until'));function f(){var ms=t-Date.now();if(ms<=0){b.textContent='Time is up';return;}var m=Math.max(1,Math.round(ms/60000)),h=Math.floor(m/60);b.textContent=h>=48?Math.round(h/24)+' days':h>=1?h+'h '+String(m%60).padStart(2,'0')+'m':m+' minutes';}f();setInterval(f,30000);})();</script>` : ''}
</body></html>`;
}
