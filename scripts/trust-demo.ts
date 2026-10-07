/**
 * Shows a seller's public trust page with pretend history:  npx tsx scripts/trust-demo.ts
 * Opens http://localhost:4300/s/bayo-kicks (nothing is sent, nothing real is paid).
 */
import { startHarness } from './harness.js';

const PORT = Number(process.env.DEMO_PORT ?? 4300);
const h = await startHarness({ quiet: true, env: { TRUST_COUNT_TEST_DEALS: 'true', PUBLIC_BASE_URL: `http://localhost:${PORT}` } });
const seller = '+2348031110001';
const buyers = ['+2348052220001', '+2348052220002', '+2348052220003', '+2348052220004', '+2348052220005'];
const names = ['Ada Obi', 'Tolu Bakare', 'Femi Ola', 'Ngozi Uche', 'Segun Ade'];
await h.say(seller, 'hi', 'Bayo Adeyemi'); await h.tap(seller, 'menu:account'); await h.say(seller, '0123456789 GTBank'); await h.tap(seller, 'bank:yes');
await h.db.query(`UPDATE users SET business_name='Bayo Kicks', city='Lagos', created_at = now() - interval '7 months' WHERE phone=$1`, [seller]);
for (let i = 0; i < buyers.length; i++) await h.say(buyers[i]!, 'hi', names[i]);

const items = ['Black sneakers, size 42', 'White Air Force 1, size 44', 'Jordan 4, size 43', 'Slides, size 41', 'Running shoes, size 42'];
for (let i = 0; i < 14; i++) {
  await h.tap(seller, 'menu:sell'); await h.say(seller, items[i % items.length]!); await h.say(seller, String(15000 + (i % 4) * 5000));
  await h.tap(seller, 'sell:nophotos'); await h.tap(seller, 'sell:nophone'); await h.tap(seller, 'sell:confirm');
  const code = h.last(seller).match(/HL-[A-Z2-9]{5}/)![0];
  const b = buyers[i % buyers.length]!;
  await h.say(b, `Pay ${code}`); await h.tap(b, `pay:${code}`);
  const r = await h.db.query('SELECT provider_reference FROM payment_intents WHERE deal_id=(SELECT id FROM deals WHERE code=$1)', [code]);
  h.provider.pay(r.rows[0].provider_reference); await h.app.deals.handleCollection(r.rows[0].provider_reference);
  await h.tap(seller, `shipped:${code}`);
  await h.db.query(`UPDATE deals SET shipped_at = funded_at + interval '20 hours' WHERE code=$1`, [code]);
  await h.tap(b, `happy:${code}`);
  await h.tap(b, i === 6 ? `ratedown:${code}` : `rateup:${code}`);
}
const id = (await h.db.query('SELECT id FROM users WHERE phone=$1', [seller])).rows[0].id;
const slug = await h.app.trust.setPublic(id, true);
// a photo (the website's drawn seller portrait) and links, as a seller would add from "Edit my page"
const { readFileSync } = await import('node:fs');
await h.app.trust.setPhoto(id, readFileSync(new URL('../console/public/slots/s4-1.webp', import.meta.url)));
for (const [k, v] of [['instagram', '@bayokicks'], ['tiktok', '@bayokicks'], ['facebook', 'facebook.com/BayoKicksNG'], ['website', 'bayokicks.com']] as const) await h.app.trust.setSocial(id, k, v);

// what a buyer sees in WhatsApp when they check this seller, and what a seller sees about a buyer
await h.tap(buyers[0]!, 'menu:check'); await h.say(buyers[0]!, '08031110001');
console.log('\n--- "Check a seller" in WhatsApp ---\n' + h.last(buyers[0]!));
const bid = (await h.db.query('SELECT id FROM users WHERE phone=$1', [buyers[0]])).rows[0].id;
const { msg } = await import('../src/whatsapp/messages.js');
console.log('\n--- buyer record a seller sees ---\n' + msg.buyerLine((await h.app.trust.buyer(bid))!));

await h.app.app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`\nTrust page: http://localhost:${PORT}/s/${slug}`);
