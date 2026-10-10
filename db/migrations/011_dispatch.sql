-- Buyer orders: where to deliver, then the seller's dispatch (pickup, rider or waybill), the handover code,
-- and paying the rider or driver straight from the held money.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS delivery_address TEXT;                 -- from the buyer's form
ALTER TABLE deals ADD COLUMN IF NOT EXISTS dispatch_method TEXT CHECK (dispatch_method IN ('PICKUP', 'RIDER', 'WAYBILL'));
ALTER TABLE deals ADD COLUMN IF NOT EXISTS pickup_address TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS courier_name TEXT;                      -- rider's name (waybill: none)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS courier_phone TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS courier_location TEXT;                  -- drop-off / waybill delivery location
ALTER TABLE deals ADD COLUMN IF NOT EXISTS courier_account_id UUID;               -- bank_accounts row (holder COURIER)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS handover_code TEXT;                     -- 4 digits the buyer gives at handover
ALTER TABLE deals ADD COLUMN IF NOT EXISTS handover_tries INT NOT NULL DEFAULT 0;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS handed_over_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS courier_paid_at TIMESTAMPTZ;            -- delivery fee moved to the rider/driver
ALTER TABLE deals ADD COLUMN IF NOT EXISTS view_token TEXT;                        -- the private order page link
ALTER TABLE deals ADD COLUMN IF NOT EXISTS dispatch_reminded_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ;

-- A rider's or driver's account, saved by the seller. Never anyone's default payout account.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS holder TEXT NOT NULL DEFAULT 'SELF' CHECK (holder IN ('SELF', 'COURIER'));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deals_courier_account_fk') THEN
    ALTER TABLE deals ADD CONSTRAINT deals_courier_account_fk FOREIGN KEY (courier_account_id) REFERENCES bank_accounts(id);
  END IF;
END $$;

-- Payouts can now also pay the rider or driver (DELIVERY).
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'payouts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE payouts DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE payouts ADD CONSTRAINT payouts_kind_check CHECK (kind IN ('SELLER', 'REFUND', 'DELIVERY'));

-- Server-held secrets (the WhatsApp forms encryption key). Never shown in the console.
CREATE TABLE IF NOT EXISTS app_secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
