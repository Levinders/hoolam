/**
 * Plays a full deal end to end on your machine and prints the WhatsApp conversation.
 * No real money, no real WhatsApp, no database setup needed.   npm run simulate
 */
import { startHarness } from './harness.js';

const SELLER = '+2348011111111';
const BUYER = '+2348022222222';
const who = (p: string) => (p === SELLER ? 'Hoolam → Seller' : 'Hoolam → Buyer ');
const h = await startHarness({ quiet: true, onMessage: (p, t) => console.log(`\n\x1b[36m${who(p)}\x1b[0m\n${t}`) });
const me = (p: string, t: string) => console.log(`\n\x1b[33m${p === SELLER ? 'Seller' : 'Buyer '} →\x1b[0m ${t}`);

try {
  me(SELLER, 'hi'); await h.say(SELLER, 'hi', 'Mama Bella');
  me(SELLER, '[Sell something]'); await h.tap(SELLER, 'menu:sell');
  me(SELLER, '2 pairs of sneakers, size 42'); await h.say(SELLER, '2 pairs of sneakers, size 42');
  me(SELLER, '15k'); await h.say(SELLER, '15k');
  me(SELLER, '0123456789 GTBank'); await h.say(SELLER, '0123456789 GTBank');
  me(SELLER, "[Yes, that's me]"); await h.tap(SELLER, 'bank:yes');
  me(SELLER, '[Create deal]'); await h.tap(SELLER, 'sell:confirm');
  const code = h.last(SELLER).match(/HL-[A-Z2-9]{5}/)![0];

  me(BUYER, `Pay ${code}`); await h.say(BUYER, `Pay ${code}`, 'Koffi');
  me(BUYER, '[Pay now]'); await h.tap(BUYER, `pay:${code}`);

  console.log('\n\x1b[90m… the buyer makes the bank transfer …\x1b[0m');
  const pi = await h.db.query('SELECT provider_reference FROM payment_intents ORDER BY created_at DESC LIMIT 1');
  h.provider.pay(pi.rows[0].provider_reference);
  await h.app.deals.handleCollection(pi.rows[0].provider_reference);

  me(SELLER, "[I've sent it]"); await h.tap(SELLER, `shipped:${code}`);
  me(BUYER, "[I'm happy]"); await h.tap(BUYER, `happy:${code}`);

  const bal = await h.db.query('SELECT account, SUM(amount_minor)::bigint AS b FROM ledger_entries GROUP BY account ORDER BY account');
  console.log('\n\x1b[90mLedger after the deal (kobo):\x1b[0m');
  for (const r of bal.rows) console.log(`  ${r.account.padEnd(16)} ${String(r.b).padStart(10)}`);
} finally {
  await h.stop();
}
