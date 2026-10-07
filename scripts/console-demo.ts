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

const h = await startHarness({ quiet: true, env: { TRUST_COUNT_TEST_DEALS: 'true', PUBLIC_BASE_URL: `http://localhost:${PORT}` } });
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

async function sellerDeal(i: number): Promise<string> {
  const s = pick(sellers, i)[0]!;
  await h.tap(s, 'menu:sell'); await h.say(s, pick(items, i)); await h.say(s, pick(prices, i * 3));
  await h.tap(s, 'sell:nophotos'); await h.tap(s, 'sell:nophone'); await h.tap(s, 'sell:confirm');
  return h.last(s).match(/HL-[A-Z2-9]{5}/)![0];
}
async function pay(code: string, buyer: string) {
  await h.say(buyer, `Pay ${code}`); await h.tap(buyer, `pay:${code}`);
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
  const code = await sellerDeal(i);
  const b = pick(buyers, i * 5 + (i % 3));
  await pay(code, b);
  await h.tap(await seller(code), `shipped:${code}`);
  await h.tap(b, `happy:${code}`);
  if (i % 4 !== 3) await h.tap(b, i % 9 === 4 ? `ratedown:${code}` : `rateup:${code}`);
  await age(code, 29 - i + (i % 3) * 0.4);
}
// money held, on the way
for (let i = 26; i < 30; i++) { const code = await sellerDeal(i); await pay(code, pick(buyers, i)); if (i % 2) await h.tap(await seller(code), `shipped:${code}`); await age(code, (30 - i) * 0.6); }
// shipped a while ago, not confirmed (flagged)
{ const code = await sellerDeal(31); await pay(code, buyers[2]!); await h.tap(await seller(code), `shipped:${code}`); await age(code, 5); }
// disputes
for (const [i, why] of [[32, 'They sent size 40, I ordered 42. Seller not responding.'], [33, 'The wig is not the length in the photo. It is 14 inch, not 18.']] as const) {
  const code = await sellerDeal(i); const b = pick(buyers, i);
  await pay(code, b); await h.tap(await seller(code), `shipped:${code}`); await h.tap(b, `problem:${code}`); await h.say(b, why);
  if (/account number/.test(h.last(b))) { await h.say(b, '8012345678 Opay'); await h.tap(b, 'bank:yes'); }
  await age(code, i === 32 ? 2.2 : 0.4);
}
// a resolved dispute (refunded)
{ const code = await sellerDeal(34); const b = buyers[4]!; await pay(code, b); await h.tap(b, `problem:${code}`); await h.say(b, 'Never arrived after a week.'); await h.say(b, '8012345678 Opay'); await h.tap(b, 'bank:yes'); await h.app.deals.adminRefund(code, 'Seller admitted it was never sent'); await age(code, 9); }
// a payout waiting for OTP, and a failed one
h.provider.payoutOutcome = 'NEEDS_AUTHORIZATION';
{ const code = await sellerDeal(35); const b = buyers[5]!; await pay(code, b); await h.tap(await seller(code), `shipped:${code}`); await h.tap(b, `happy:${code}`); await age(code, 0.3); }
h.provider.payoutOutcome = 'FAILED';
{ const code = await sellerDeal(36); const b = buyers[6]!; await pay(code, b); await h.tap(await seller(code), `shipped:${code}`); await h.tap(b, `happy:${code}`); await age(code, 1.1); }
h.provider.payoutOutcome = 'SUCCESS';
// waiting deals (unpaid, buyer-started waiting for seller)
for (let i = 37; i < 40; i++) { const code = await sellerDeal(i); await age(code, 0.2 * (i - 36)); }
{ const b = buyers[7]!; await h.tap(b, 'menu:buy'); await h.say(b, 'Second-hand PS5 with 2 pads'); await h.say(b, '48000'); await h.tap(b, 'buy:nophotos'); await h.tap(b, 'buy:nophone'); await h.tap(b, 'buy:send');
  const code = h.last(b).match(/HL-[A-Z2-9]{5}/)![0]; await h.db.query(`UPDATE deals SET accept_by = now() + interval '4 hours' WHERE code=$1`, [code]); }
// a short payment needing attention
{ const code = await sellerDeal(40); const b = buyers[1]!; await h.say(b, `Pay ${code}`); await h.tap(b, `pay:${code}`);
  const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
  h.provider.pay(r.rows[0].provider_reference, 500_000); await h.app.deals.handleCollection(r.rows[0].provider_reference); }
// support messages
for (const [p, text] of [[buyers[3]!, 'Hello, I paid yesterday but the seller says he hasn\'t seen anything. Please help.'], [sellers[1]![0]!, 'How long does it take for my money to reach my bank after the buyer is happy?']] as const) {
  await h.say(p, '/human'); await h.say(p, text);
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
console.log(`Two-step code right now: ${totpCode(OWNER.secret)}  (or add secret ${OWNER.secret} to an authenticator app)`);
console.log('Press Ctrl+C to stop. Everything is deleted when it stops.');
process.on('SIGINT', async () => { await h.stop(); process.exit(0); });
