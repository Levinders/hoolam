-- The flat transaction fee: paid by the side that didn't start the order (the starter pays Hoolam's % fee).
-- Buyer started: taken from the seller's payout. Seller started: added to what the buyer pays.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS txn_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (txn_fee_minor >= 0);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS txn_fee_payer TEXT CHECK (txn_fee_payer IN ('BUYER', 'SELLER'));
-- buyer_pays can now be price + a transaction fee on seller-started orders (still never below price - fee)
