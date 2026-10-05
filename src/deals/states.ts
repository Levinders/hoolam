export const DealStatus = {
  AWAITING_BUYER: 'AWAITING_BUYER',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  FUNDED: 'FUNDED',
  SHIPPED: 'SHIPPED',
  RELEASING: 'RELEASING',
  PAYOUT_PENDING: 'PAYOUT_PENDING',
  COMPLETED: 'COMPLETED',
  DISPUTED: 'DISPUTED',
  REFUNDING: 'REFUNDING',
  REFUNDED: 'REFUNDED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type DealStatus = (typeof DealStatus)[keyof typeof DealStatus];

const S = DealStatus;

/** The only moves a deal is allowed to make. Anything else is a bug and is refused. */
export const TRANSITIONS: Record<DealStatus, DealStatus[]> = {
  AWAITING_BUYER: [S.AWAITING_PAYMENT, S.CANCELLED, S.EXPIRED],
  AWAITING_PAYMENT: [S.FUNDED, S.CANCELLED, S.EXPIRED],
  FUNDED: [S.SHIPPED, S.DISPUTED, S.REFUNDING],
  SHIPPED: [S.RELEASING, S.DISPUTED],
  RELEASING: [S.COMPLETED, S.PAYOUT_PENDING],
  PAYOUT_PENDING: [S.RELEASING, S.REFUNDING, S.COMPLETED, S.REFUNDED],
  DISPUTED: [S.RELEASING, S.REFUNDING],
  REFUNDING: [S.REFUNDED, S.PAYOUT_PENDING],
  COMPLETED: [],
  REFUNDED: [],
  CANCELLED: [],
  EXPIRED: [S.FUNDED], // a late payment can still land on an expired deal; we honour it
};

export function canMove(from: DealStatus, to: DealStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses where the buyer's money is with us. */
export const HOLDING: DealStatus[] = [S.FUNDED, S.SHIPPED, S.DISPUTED, S.RELEASING, S.REFUNDING, S.PAYOUT_PENDING];
