import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';
import type { Currency } from './money.js';

/**
 * Accounts used by Hoolam. Debits are positive, credits negative; every transaction sums to zero.
 *  cash:<provider>   money sitting with the payment provider / bank (asset)
 *  held:deal         buyers' money we are holding for a deal (liability)
 *  payable:seller    money owed to a seller, waiting for the payout to land (liability)
 *  payable:buyer     money owed back to a buyer, waiting for the refund to land (liability)
 *  revenue:fees      Hoolam's fee (income)
 */
export interface Line { account: string; amountMinor: number }

export async function post(q: Queryable, args: { dealId: string | null; currency: Currency; memo: string; lines: Line[] }): Promise<string> {
  const lines = args.lines.filter((l) => l.amountMinor !== 0);
  const sum = lines.reduce((s, l) => s + l.amountMinor, 0);
  if (lines.length < 2 || sum !== 0) throw new Error(`Unbalanced ledger transaction "${args.memo}" (sum ${sum})`);
  for (const l of lines) if (!Number.isInteger(l.amountMinor)) throw new Error('Ledger amounts must be integers');
  const txnId = randomUUID();
  for (const l of lines) {
    await q.query(
      'INSERT INTO ledger_entries (txn_id, deal_id, account, amount_minor, currency, memo) VALUES ($1,$2,$3,$4,$5,$6)',
      [txnId, args.dealId, l.account, l.amountMinor, args.currency, args.memo],
    );
  }
  return txnId;
}

export async function balance(q: Queryable, account: string, currency: Currency, dealId?: string): Promise<number> {
  const r = await q.query(
    `SELECT COALESCE(SUM(amount_minor),0)::bigint AS b FROM ledger_entries WHERE account=$1 AND currency=$2 ${dealId ? 'AND deal_id=$3' : ''}`,
    dealId ? [account, currency, dealId] : [account, currency],
  );
  return Number(r.rows[0].b);
}
