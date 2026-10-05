/**
 * Checks your Monnify sandbox keys against the real Monnify API, one step at a time.
 * Needs only the MONNIFY_* values in .env (no database, no WhatsApp, no public URL).
 *
 *   npm run monnify:check                         login, banks, a ₦100 test payment
 *   npm run monnify:check -- --name 058 0123456789   also check an account name
 *   npm run monnify:check -- --payout 058 0123456789 also send a ₦100 test payout
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { MonnifyProvider } from '../src/payments/monnify.js';

const c = { ok: '\x1b[32m✔\x1b[0m', bad: '\x1b[31m✘\x1b[0m', dim: '\x1b[90m', off: '\x1b[0m', bold: '\x1b[1m' };
const env = process.env;
const missing = ['MONNIFY_API_KEY', 'MONNIFY_SECRET_KEY', 'MONNIFY_CONTRACT_CODE'].filter((k) => !env[k]);
if (missing.length) {
  console.log(`${c.bad} Missing in .env: ${missing.join(', ')}`);
  console.log(`${c.dim}Copy .env.example to .env and paste your sandbox values from the Monnify dashboard (Developer section).${c.off}`);
  process.exit(1);
}

const baseUrl = env.MONNIFY_BASE_URL || 'https://sandbox.monnify.com';
if (!baseUrl.includes('sandbox')) {
  console.log(`${c.bad} MONNIFY_BASE_URL is not the sandbox (${baseUrl}). This check moves money; run it on the sandbox only.`);
  process.exit(1);
}

const p = new MonnifyProvider({
  baseUrl, apiKey: env.MONNIFY_API_KEY!, secretKey: env.MONNIFY_SECRET_KEY!, contractCode: env.MONNIFY_CONTRACT_CODE!,
  walletAccountNumber: env.MONNIFY_WALLET_ACCOUNT ?? '', requireSignature: false,
});

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? [args[i + 1], args[i + 2]] as const : null; };

async function step<T>(title: string, fn: () => Promise<T>): Promise<T | null> {
  process.stdout.write(`${c.bold}${title}${c.off} … `);
  try {
    const r = await fn();
    console.log(c.ok);
    return r;
  } catch (e) {
    console.log(`${c.bad}\n  ${(e as Error).message}`);
    return null;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`${c.dim}Monnify sandbox: ${baseUrl}${c.off}\n`);

// 1. Login + banks
const banks = await step('1. Log in and fetch the bank list', () => p.listBanks());
if (!banks) {
  console.log(`\n${c.dim}Check MONNIFY_API_KEY and MONNIFY_SECRET_KEY (sandbox ones, not live).${c.off}`);
  process.exit(1);
}
console.log(`  ${banks.length} banks. e.g. ${banks.slice(0, 4).map((b) => `${b.name} (${b.code})`).join(', ')}`);

// 2. Optional name check
const nameArgs = flag('--name') ?? flag('--payout');
if (nameArgs?.[0] && nameArgs[1]) {
  const name = await step(`2. Look up account ${nameArgs[1]} at bank ${nameArgs[0]}`, () => p.resolveAccount(nameArgs[0]!, nameArgs[1]!));
  console.log(name ? `  Account name: ${name}` : `  ${c.dim}No name returned. The sandbox may only know some test accounts.${c.off}`);
} else {
  console.log(`${c.dim}2. Account name check skipped (add: -- --name BANKCODE ACCOUNTNUMBER)${c.off}`);
}

// 3. A ₦100 test payment
const ref = `HL-CHECK-${Date.now()}`;
const instr = await step('3. Create a ₦100 test payment', () => p.createCollection({
  paymentReference: ref, amountMinor: 100_00, currency: 'NGN', description: 'Hoolam sandbox check', customerName: 'Hoolam Test', customerEmail: 'test@buyers.hoolam.app',
}));
if (!instr) {
  console.log(`\n${c.dim}Check MONNIFY_CONTRACT_CODE, and that "Pay with transfer" is enabled for your sandbox contract.${c.off}`);
  process.exit(1);
}
console.log(`
  Pay ₦100 to this account using Monnify's bank simulator:
    ${c.bold}${instr.accountNumber}${c.off}  ${instr.bankName}  (${instr.accountName})
    https://websim.sdk.monnify.com/#/bankingapp
  Reference: ${instr.providerReference}
  ${c.dim}Waiting up to 10 minutes. Press Ctrl+C to stop.${c.off}`);

let paid = false;
for (let i = 0; i < 120; i++) {
  await sleep(5000);
  try {
    const s = await p.checkCollection(instr.providerReference);
    if (s.status !== 'PENDING') {
      console.log(`  ${s.status === 'PAID' || s.status === 'OVERPAID' ? c.ok : c.bad} Status: ${s.status}, received ₦${(s.amountPaidMinor / 100).toLocaleString('en-NG')}`);
      paid = s.status === 'PAID' || s.status === 'OVERPAID';
      break;
    }
    if (i % 6 === 5) console.log(`  ${c.dim}still waiting…${c.off}`);
  } catch (e) {
    console.log(`  ${c.bad} Status check failed: ${(e as Error).message}`);
    break;
  }
}
if (!paid) console.log(`  ${c.dim}No payment seen. You can re-run the check any time.${c.off}`);

// 4. Optional ₦100 payout
const payout = flag('--payout');
if (payout?.[0] && payout[1]) {
  if (!env.MONNIFY_WALLET_ACCOUNT) {
    console.log(`\n${c.bad} 4. Payout skipped: set MONNIFY_WALLET_ACCOUNT in .env (your sandbox wallet's account number).`);
  } else {
    const name = (await p.resolveAccount(payout[0], payout[1])) ?? 'Hoolam Test';
    const pref = `HL-PAYCHECK-${Date.now()}`;
    let r = await step(`4. Send a ₦100 test payout to ${payout[1]}`, () => p.sendPayout({
      reference: pref, amountMinor: 100_00, currency: 'NGN', bankCode: payout[0]!, accountNumber: payout[1]!, accountName: name, narration: 'Hoolam sandbox check',
    }));
    if (r) {
      console.log(`  Status: ${r.status}`);
      if (r.status === 'NEEDS_AUTHORIZATION') {
        const rl = createInterface({ input: stdin, output: stdout });
        const otp = (await rl.question('  Monnify emailed you an OTP. Type it here: ')).trim();
        rl.close();
        r = await step('   Approve the payout with the OTP', () => p.authorizePayout(pref, otp));
        if (r) console.log(`  Status: ${r.status}`);
      }
      const final = await step('   Check the payout status', () => p.checkPayout(pref));
      if (final) console.log(`  Status: ${final.status}`);
    }
  }
} else {
  console.log(`\n${c.dim}4. Payout check skipped (add: -- --payout BANKCODE ACCOUNTNUMBER)${c.off}`);
}

console.log(`\n${c.dim}Done. Send me any ✘ lines and the message under them; that's all I need to fix the integration.${c.off}`);
