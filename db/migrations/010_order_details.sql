-- What the buyer tells us about the order, beyond the item name and price.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS description TEXT;               -- size, colour, condition…
ALTER TABLE deals ADD COLUMN IF NOT EXISTS category TEXT;                  -- food, clothing, shoes… (see CATEGORIES in src/deals/categories.ts)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS delivery_method TEXT CHECK (delivery_method IN ('DELIVERY', 'PICKUP'));
-- Paid by the buyer on top of the price, held with it, and paid to the seller with it (the seller arranges the rider).
-- Hoolam's fee is on the item price only.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS delivery_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0);

-- The seller now receives price + delivery fee, so "never more than the price" becomes "never more than price + delivery".
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'deals'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%seller_gets_minor <= price_minor)%'
  LOOP
    EXECUTE format('ALTER TABLE deals DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE deals ADD CONSTRAINT deals_seller_gets_cap CHECK (seller_gets_minor <= price_minor + delivery_fee_minor);
