/**
 * Chat with Hoolam in your terminal, playing both the seller and the buyer.
 * No accounts, no real money, no real WhatsApp. A throwaway database starts automatically.
 *
 *   npm run chat
 */
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { startHarness } from './harness.js';

const PEOPLE = { seller: { phone: '+2348011111111', name: 'Mama Bella' }, buyer: { phone: '+2348022222222', name: 'Koffi' } };
type Who = keyof typeof PEOPLE;

const c = { dim: '\x1b[90m', cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m', off: '\x1b[0m' };

console.log(`${c.dim}Starting a private test database…${c.off}`);
const h = await startHarness({ quiet: true });
let me: Who = 'seller';
let lastId = 0;
const lastButtons: Record<Who, { id: string; title: string }[]> = { seller: [], buyer: [] };

const help = () => console.log(`
${c.bold}How to use${c.off}
  Type anything              send it as the current person (try "hi")
  1, 2, 3 ...                tap a button (or menu option) from Hoolam's last message
  /menu, /sell, /pay ...     slash commands, like typing "/" in WhatsApp
  seller / buyer             switch who you are
  open                       as the buyer, open the newest deal link
  pay                        the buyer's transfer lands in full
  pay 5000                   the buyer only sends ₦5,000
  payout fail | otp | ok     how the next payout to a seller behaves
  admin deals                list deals
  admin refund HL-XXXXX      refund the buyer (after a problem)
  admin release HL-XXXXX     pay the seller (after a problem)
  admin otp REF 123456       approve a payout waiting for an OTP
  ledger                     money totals by account
  quit
`);

/** Prints everything Hoolam sent since last time, with numbered buttons. */
async function flush() {
  const r = await h.db.query('SELECT id, phone, body, status FROM outbound_messages WHERE id > $1 ORDER BY id', [lastId]);
  for (const row of r.rows) {
    lastId = row.id;
    const who: Who = row.phone === PEOPLE.seller.phone ? 'seller' : 'buyer';
    const label = who === 'seller' ? 'Hoolam → Seller' : 'Hoolam → Buyer';
    const extra = row.status === 'NEEDS_TEMPLATE' ? ` ${c.red}(outside 24h window: would need a template)${c.off}` : '';
    const head = row.body.header ? `${c.yellow}${row.body.header}${c.off}\n` : '';
    const foot = row.body.footer ? `\n${c.dim}${row.body.footer}${c.off}` : '';
    console.log(`\n${c.cyan}${label}${c.off}${extra}\n${head}${row.body.text}${foot}`);
    if (row.body.kind === 'buttons') {
      lastButtons[who] = row.body.buttons;
      row.body.buttons.forEach((b: { title: string }, i: number) => console.log(`  ${c.green}[${i + 1}] ${b.title}${c.off}`));
    }
    if (row.body.kind === 'list') {
      // On a phone this is one "Open menu" button that opens the list. Here every row gets a number.
      const rows: { id: string; title: string }[] = [];
      for (const sec of row.body.sections as { title: string; rows: { id: string; title: string; description?: string }[] }[]) {
        console.log(`  ${c.dim}${sec.title}${c.off}`);
        for (const r of sec.rows) {
          rows.push(r);
          console.log(`  ${c.green}[${rows.length}] ${r.title}${c.off}${r.description ? c.dim + '  ' + r.description + c.off : ''}`);
        }
      }
      lastButtons[who] = rows;
    }
  }
}

async function latestIntent() {
  const r = await h.db.query(`SELECT pi.provider_reference, pi.amount_minor, d.code FROM payment_intents pi JOIN deals d ON d.id=pi.deal_id ORDER BY pi.created_at DESC LIMIT 1`);
  return r.rows[0] as { provider_reference: string; amount_minor: number; code: string } | undefined;
}

async function command(line: string): Promise<boolean> {
  const [cmd, a, b] = line.split(/\s+/);
  switch (cmd?.toLowerCase()) {
    case 'quit': case 'exit': return false;
    case 'help': help(); return true;
    case 'seller': case 'buyer': me = cmd.toLowerCase() as Who; console.log(`${c.dim}You are now the ${me}.${c.off}`); return true;
    case 'open': {
      const r = await h.db.query('SELECT code FROM deals ORDER BY created_at DESC LIMIT 1');
      if (!r.rows[0]) { console.log(`${c.red}No deal yet. As the seller, create one first.${c.off}`); return true; }
      me = 'buyer';
      console.log(`${c.dim}You are now the buyer, tapping the seller's link…${c.off}`);
      await h.say(PEOPLE.buyer.phone, `Pay ${r.rows[0].code}`, PEOPLE.buyer.name);
      return true;
    }
    case 'pay': {
      const pi = await latestIntent();
      if (!pi) { console.log(`${c.red}The buyer hasn't asked to pay yet. As the buyer, tap "Pay now" first.${c.off}`); return true; }
      const kobo = a ? Math.round(Number(a.replace(/,/g, '')) * 100) : pi.amount_minor;
      h.provider.pay(pi.provider_reference, kobo);
      console.log(`${c.dim}… ₦${(kobo / 100).toLocaleString('en-NG')} transfer lands for ${pi.code} …${c.off}`);
      await h.app.deals.handleCollection(pi.provider_reference);
      return true;
    }
    case 'payout': {
      h.provider.payoutOutcome = a === 'fail' ? 'FAILED' : a === 'otp' ? 'NEEDS_AUTHORIZATION' : 'SUCCESS';
      console.log(`${c.dim}Next payout will: ${h.provider.payoutOutcome}${c.off}`);
      return true;
    }
    case 'ledger': {
      const r = await h.db.query('SELECT account, SUM(amount_minor)::bigint AS b FROM ledger_entries GROUP BY account ORDER BY account');
      for (const x of r.rows) console.log(`  ${x.account.padEnd(16)} ₦${(Number(x.b) / 100).toLocaleString('en-NG')}`);
      if (!r.rows.length) console.log(`${c.dim}  No money has moved yet.${c.off}`);
      return true;
    }
    case 'admin': {
      try {
        if (a === 'deals') {
          const r = await h.db.query(`SELECT d.code, d.item, d.status, (SELECT reference FROM payouts p WHERE p.deal_id=d.id ORDER BY created_at DESC LIMIT 1) AS payout FROM deals d ORDER BY created_at`);
          for (const x of r.rows) console.log(`  ${x.code}  ${x.status.padEnd(16)} ${x.item}${x.payout ? `  payout: ${x.payout}` : ''}`);
          if (!r.rows.length) console.log(`${c.dim}  No deals yet.${c.off}`);
        } else if (a === 'refund' && b) await h.app.deals.adminRefund(b, 'Refunded in test');
        else if (a === 'release' && b) await h.app.deals.adminRelease(b, 'Released in test');
        else if (a === 'otp' && b) console.log(await h.app.deals.authorizePayout(b, line.split(/\s+/)[3] ?? '123456'));
        else console.log(`${c.red}Try: admin deals | admin refund HL-XXXXX | admin release HL-XXXXX | admin otp REF 123456${c.off}`);
      } catch (e) { console.log(`${c.red}${(e as Error).message}${c.off}`); }
      return true;
    }
  }
  const p = PEOPLE[me];
  const n = /^([1-9]|10)$/.test(line) ? Number(line) : 0;
  if (n) {
    const btn = lastButtons[me][n - 1];
    if (!btn) { console.log(`${c.red}No button ${n} on the ${me}'s last message.${c.off}`); return true; }
    await h.tap(p.phone, btn.id, btn.title);
  } else {
    await h.say(p.phone, line, p.name);
  }
  return true;
}

help();
console.log(`${c.dim}You are the seller. Say "hi" to start.${c.off}`);
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
const prompt = () => { rl.setPrompt(`\n${c.yellow}${me === 'seller' ? 'Seller' : 'Buyer'} › ${c.off}`); rl.prompt(); };
try {
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      if (!stdin.isTTY) console.log(line); // echo when input is piped in
      if (!(await command(line))) break;
      await flush();
    }
    prompt();
  }
} finally {
  rl.close();
  console.log(`${c.dim}Shutting down…${c.off}`);
  await h.stop();
}
