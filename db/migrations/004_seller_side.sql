-- Seller side: who pays the fee, price changes, proof of shipping.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS fee_payer TEXT NOT NULL DEFAULT 'BUYER' CHECK (fee_payer IN ('BUYER', 'SELLER')); -- whoever starts the deal
ALTER TABLE deals ADD COLUMN IF NOT EXISTS counter_price_minor BIGINT CHECK (counter_price_minor > 0); -- a seller's new price, waiting for the buyer
ALTER TABLE deals ADD COLUMN IF NOT EXISTS counter_seller_id   UUID REFERENCES users(id);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS counter_account_id  UUID REFERENCES bank_accounts(id);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS shipping_note       TEXT;  -- tracking number, rider's name, etc.

ALTER TABLE deal_photos ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ITEM' CHECK (kind IN ('ITEM', 'SHIPPING'));
