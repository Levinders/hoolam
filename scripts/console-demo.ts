/**
 * Try the console on your computer with realistic pretend data:  npm run console:demo
 * Starts a throwaway database, plays ~40 deals through the real WhatsApp flow (pretend money, nothing sent),
 * creates an owner account, and serves the console at http://localhost:4000/console
 * (run `npm run build:console` first).
 */
import { startHarness } from './harness.js';
import { hashPassword, totpCode } from '../src/console/crypto.js';

const PORT = Number(process.env.DEMO_PORT ?? 4000);
const OWNER = { email: 'owner@hoolam.demo', password: 'HoolamDemo2026', name: 'Raphael Levinders', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };

const h = await startHarness({ quiet: true, twoStep: false, env: { TRUST_COUNT_TEST_DEALS: 'true', PUBLIC_BASE_URL: `http://localhost:${PORT}` } });
const sellers = [
  ['+2348031110001', 'Bayo Adeyemi', 'Bayo Kicks'], ['+2348031110002', 'Kemi Okafor', 'Kemi Wigs & Hair'], ['+2348031110003', 'Chidi Eze', 'Chidi Gadgets'],
  ['+2348031110004', 'Amaka Nwosu', 'Amaka Thrift'], ['+2290190000005', 'Koffi Mensah', 'Koffi Wax Prints'],
];
const buyers = ['+2348052220001', '+2348052220002', '+2348052220003', '+2348052220004', '+2348052220005', '+2348052220006', '+2348052220007', '+2348052220008'];
const buyerNames = ['Ada Obi', 'Tolu Bakare', 'Femi Ola', 'Ngozi Uche', 'Segun Ade', 'Zainab Bello', 'Ife Johnson', 'Musa Danjuma'];
const items = ['Black sneakers, size 42', 'Brazilian wig, 18 inch', 'iPhone 12 case + charger', 'Vintage denim jacket', 'Ankara fabric, 6 yards', 'Gold earrings', 'Bluetooth speaker', 'Leather bag', 'Smart watch', 'Silk scarf'];
const prices = ['8500', '12000', '15000', '18500', '22000', '25000', '32000', '45000', '9500', '14000'];
const pick = <T,>(a: T[], i: number) => a[i % a.length]!;

for (const [p, name] of sellers) { await h.say(p!, 'hi', name); await h.tap(p!, 'menu:account'); await h.say(p!, '0123456789 GTBank'); await h.tap(p!, 'bank:yes'); }
for (let i = 0; i < buyers.length; i++) await h.say(buyers[i]!, 'hi', buyerNames[i]);
for (const [p, , shop] of sellers) await h.db.query('UPDATE users SET business_name=$2, city=$3 WHERE phone=$1', [p, shop, p!.startsWith('+229') ? 'Cotonou' : 'Lagos']);

// a seller's order sent to a buyer's number (the buyer accepts it when they pay)
async function sellerDeal(i: number, buyer = pick(buyers, i)): Promise<string> {
  return h.sellOrder(pick(sellers, i)[0]!, buyer, { item: pick(items, i), price: pick(prices, i * 3) });
}
async function pay(code: string, buyer: string) {
  await h.acceptOrder(buyer, code);
  const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1) ORDER BY created_at DESC LIMIT 1', [code]);
  h.provider.pay(r.rows[0].provider_reference); await h.app.deals.handleCollection(r.rows[0].provider_reference);
}
const seller = async (code: string) => (await h.db.query('SELECT u.phone FROM deals d JOIN users u ON u.id=d.seller_id WHERE d.code=$1', [code])).rows[0].phone;
const age = async (code: string, daysAgo: number) => h.db.query(
  `UPDATE deals SET created_at = now() - make_interval(hours => $2), updated_at = now() - make_interval(hours => $2 - 3),
          funded_at = CASE WHEN funded_at IS NULL THEN NULL ELSE now() - make_interval(hours => $2 - 2) END,
          shipped_at = CASE WHEN shipped_at IS NULL THEN NULL ELSE now() - make_interval(hours => $2 - 2 - $3) END,
          closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE now() - make_interval(hours => $2 - 30) END WHERE code=$1`,
  [code, Math.round(daysAgo * 24), Math.round(6 + (daysAgo * 7) % 30)]);

// completed deals spread across 30 days, most with a 👍
for (let i = 0; i < 26; i++) {
  const b = pick(buyers, i * 5 + (i % 3));
  const code = await sellerDeal(i, b);
  await pay(code, b);
  await h.handOver(await seller(code), code);
  await h.tap(b, `happy:${code}`);
  if (i % 4 !== 3) await h.tap(b, i % 9 === 4 ? `ratedown:${code}` : `rateup:${code}`);
  await age(code, 29 - i + (i % 3) * 0.4);
}
// money held, on the way
for (let i = 26; i < 30; i++) { const code = await sellerDeal(i); await pay(code, pick(buyers, i)); if (i % 2) await h.handOver(await seller(code), code); await age(code, (30 - i) * 0.6); }
// shipped a while ago, not confirmed (flagged)
{ const code = await sellerDeal(31, buyers[2]!); await pay(code, buyers[2]!); await h.handOver(await seller(code), code); await age(code, 5); }
// disputes
for (const [i, why] of [[32, 'They sent size 40, I ordered 42. Seller not responding.'], [33, 'The wig is not the length in the photo. It is 14 inch, not 18.']] as const) {
  const b = pick(buyers, i); const code = await sellerDeal(i, b);
  await pay(code, b); await h.handOver(await seller(code), code); await h.tap(b, `problem:${code}`); await h.say(b, why);
  if (/account number/.test(h.last(b))) { await h.say(b, '8012345678 Opay'); await h.tap(b, 'bank:yes'); }
  await age(code, i === 32 ? 2.2 : 0.4);
}
// a resolved dispute (refunded)
{ const b = buyers[4]!; const code = await sellerDeal(34, b); await pay(code, b); await h.tap(b, `problem:${code}`); await h.say(b, 'Never arrived after a week.'); await h.say(b, '8012345678 Opay'); await h.tap(b, 'bank:yes'); await h.app.deals.adminRefund(code, 'Seller admitted it was never sent'); await age(code, 9); }
// a payout waiting for OTP, and a failed one
h.provider.payoutOutcome = 'NEEDS_AUTHORIZATION';
{ const b = buyers[5]!; const code = await sellerDeal(35, b); await pay(code, b); await h.handOver(await seller(code), code); await h.tap(b, `happy:${code}`); await age(code, 0.3); }
h.provider.payoutOutcome = 'FAILED';
{ const b = buyers[6]!; const code = await sellerDeal(36, b); await pay(code, b); await h.handOver(await seller(code), code); await h.tap(b, `happy:${code}`); await age(code, 1.1); }
h.provider.payoutOutcome = 'SUCCESS';
// waiting deals (unpaid, buyer-started waiting for seller)
for (let i = 37; i < 40; i++) { const code = await sellerDeal(i); await age(code, 0.2 * (i - 36)); }
{ const b = buyers[7]!; await h.tap(b, 'menu:buy'); await h.say(b, 'Second-hand PS5 with 2 pads'); await h.say(b, 'Like new, both pads work'); await h.tap(b, 'cat:electronics'); await h.say(b, '48000'); await h.say(b, '4 Allen Avenue, Ikeja'); await h.tap(b, 'bdate:3'); await h.tap(b, 'buy:nophotos'); await h.say(b, '08031110003'); await h.tap(b, 'buy:send');
  const code = h.last(b).match(/HL-[A-Z2-9]{5}/)![0]; await h.db.query(`UPDATE deals SET accept_by = now() + interval '4 hours' WHERE code=$1`, [code]); }
// a short payment needing attention
{ const b = buyers[1]!; const code = await sellerDeal(40, b); await h.acceptOrder(b, code);
  const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
  h.provider.pay(r.rows[0].provider_reference, 500_000); await h.app.deals.handleCollection(r.rows[0].provider_reference); }
// support messages
for (const [p, text] of [[buyers[3]!, 'Hello, I paid yesterday but the seller says he hasn\'t seen anything. Please help.'], [sellers[1]![0]!, 'How long does it take for my money to reach my bank after the buyer is happy?']] as const) {
  await h.say(p, '/human'); await h.say(p, text);
}

// the market: on, a few sellers' items, buyers browsing, saving and buying, 30 days of numbers
{
  const sharp = (await import('sharp')).default;
  const tones = [[14, 92, 99], [201, 153, 46], [46, 139, 87], [192, 57, 43], [70, 70, 90], [120, 80, 160]];
  let k = 0;
  (h.app.chat as any).o.media = { download: async () => {
    const [r, g, b] = tones[k++ % tones.length]!;
    const px = Buffer.alloc(240 * 240 * 3);
    for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) { const i = (y * 240 + x) * 3, w = ((x * 7 + y * 3 + k * 37) % 255) / 255; px[i] = r * (0.6 + w * 0.6); px[i + 1] = g * (0.6 + w * 0.5); px[i + 2] = b * (0.6 + w * 0.4); }
    return { bytes: await sharp(px, { raw: { width: 240, height: 240, channels: 3 } }).jpeg().toBuffer(), mimeType: 'image/jpeg' };
  } };
  await h.app.settings.save(h.db, { feature_market: true, mk_cat_phones: true, mk_upgrade_on: true, mk_ad_links: true }, null);
  const listing: [number, string, string, string, string][] = [
    [0, 'Nike Air Force 1, size 43', 'shoes', '45k', 'Ikeja, Lagos'], [0, 'Adidas slides, size 42', 'shoes', '12000', 'Ikeja, Lagos'], [0, 'New Balance 550, size 44', 'shoes', '58000', 'Ikeja, Lagos'],
    [1, 'Brazilian wig, 18 inch', 'beauty', '65000', 'Lekki Phase 1, Lagos'], [1, 'Bone straight, 22 inch', 'beauty', '120000', 'Lekki Phase 1, Lagos'], [1, 'Edge control and gel set', 'beauty', '6500', 'Lekki Phase 1, Lagos'],
    [2, 'iPhone 12, 128GB, UK used', 'phones', '320000', 'Wuse 2, Abuja'], [2, 'AirPods Pro 2', 'phones', '85000', 'Wuse 2, Abuja'],
    [3, 'Vintage denim jacket', 'clothing', '18500', 'Woji, Port Harcourt'], [3, 'Ankara gown, size 12', 'clothing', '25000', 'Woji, Port Harcourt'], [3, 'Black leather bag', 'bags', '22000', 'Woji, Port Harcourt'],
  ];
  for (const [si, title, cat, price, where] of listing) {
    const p = sellers[si]![0]!;
    await h.tap(p, 'menu:items'); await h.tap(p, 'mk:new');
    for (let n = 0; n < 2; n++) await (h.app.chat as any).handle({ id: `img${Math.random()}`, phone: p, name: null, type: 'image', text: '', buttonId: null, mediaId: `m${Math.random()}` });
    await h.tap(p, 'mk:photosdone'); await h.say(p, title); await h.tap(p, `mk:lcat:${cat}`); await h.say(p, price); await h.say(p, String(1 + (title.length % 4))); await h.tap(p, 'mk:ldel:all'); await h.say(p, where);
    if (/Did you mean/.test(h.last(p))) await h.tap(p, 'mk:lpl:0');
  }
  const ids = (await h.db.query('SELECT id FROM market_listings ORDER BY id')).rows.map((r) => Number(r.id));
  await h.db.query(`UPDATE market_listings SET promo_minor = price_minor * 9 / 10, promo_ends = now() + interval '5 days' WHERE id=$1`, [ids[0]]);
  // buyers browse, save, search and buy
  for (let i = 0; i < 6; i++) {
    const b = buyers[i]!;
    await h.tap(b, 'menu:market'); await h.tap(b, 'mk:all'); await h.tap(b, 'mk:cat:shoes');
    await h.tap(b, `mk:see:${pick(ids, i)}`); if (i % 2) await h.tap(b, `mk:save:${pick(ids, i)}`);
    await h.say(b, pick(['ankara gown', 'iphone 12', 'power bank', 'black bag under 30k', 'perfume', 'wig'], i));
  }
  { const b = buyers[0]!; await h.tap(b, `mk:go:${ids[5]}:1`); await h.say(b, '12 Allen Avenue, Ikeja'); await h.tap(b, 'bdate:2'); await h.tap(b, 'buy:send');
    const code = h.last(b).match(/HL-[A-Z2-9]{5}/)?.[0];
    if (code) { await h.tap(sellers[1]![0]!, `saccept:${code}`); await h.tap(b, `pay:${code}`); const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]); if (r.rows[0]) { h.provider.pay(r.rows[0].provider_reference); await h.app.deals.handleCollection(r.rows[0].provider_reference); } } }
  // reports on one item, a seller asking for more items
  for (let i = 0; i < 2; i++) await h.tap(buyers[i + 3]!, `mk:rr:${ids[7]}:${i}`);
  await h.tap(sellers[0]![0]!, 'mk:upask');
  // 30 days of browsing numbers
  await h.db.query(`INSERT INTO market_stats (listing_id, day, seen, views, saves, buys, orders)
    SELECT l.id, d::date, 20 + (random() * 60)::int, 4 + (random() * 18)::int, (random() * 4)::int, (random() * 3)::int, (random() < .25)::int
    FROM market_listings l, generate_series(current_date - 29, current_date - 1, interval '1 day') d ON CONFLICT DO NOTHING`);
  await h.db.query(`UPDATE market_listings SET kept_at = now() WHERE id = ANY($1)`, [ids.slice(0, 4)]);
}

// the owner account (two-step code from the fixed demo secret)
await h.db.query(`INSERT INTO staff (email, name, role, password_hash, totp_secret, totp_enabled) VALUES ($1,$2,'OWNER',$3,$4,true)`,
  [OWNER.email, OWNER.name, await hashPassword(OWNER.password), OWNER.secret]);
for (const [email, name, role] of [['ada@hoolam.demo', 'Ada Support', 'SUPPORT'], ['tunde@hoolam.demo', 'Tunde Finance', 'FINANCE'], ['bola@hoolam.demo', 'Bola Admin', 'ADMIN']] as const) {
  await h.db.query(`INSERT INTO staff (email, name, role, password_hash, totp_secret, totp_enabled) VALUES ($1,$2,$3,$4,$5,true)`, [email, name, role, await hashPassword(OWNER.password), OWNER.secret]);
}
await h.db.query(`INSERT INTO audit_log (staff_id, actor, action, target_type, target_id, reason, details, at)
  SELECT id, name, 'deal.note', 'deal', (SELECT code FROM deals ORDER BY created_at LIMIT 1), NULL, '{"note":"Called the buyer to confirm delivery","ok":true}', now() - interval '3 days' FROM staff WHERE role='SUPPORT'`);

await h.app.app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`\nHoolam Console demo: http://localhost:${PORT}/console`);
console.log(`Email: ${OWNER.email}   Password: ${OWNER.password}`);
console.log(`Authenticator code (only when it's on in Settings → Security): ${totpCode(OWNER.secret)}  (or add secret ${OWNER.secret} to an authenticator app)`);
console.log('Press Ctrl+C to stop. Everything is deleted when it stops.');
process.on('SIGINT', async () => { await h.stop(); process.exit(0); });
