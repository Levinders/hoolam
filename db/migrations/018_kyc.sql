-- ID checks (KYC). Needed once per person: for an order above the no-ID limit, and for every seller before
-- their payout account (then the account name must match the ID). We keep only the result: never the BVN or NIN.
-- users.kyc_status already exists (001): UNVERIFIED, VERIFIED, or REVIEW (a rep should look: 3 failed tries, or they asked for help).
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_verified_at   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_method        TEXT CHECK (kyc_method IN ('BVN', 'NIN', 'MANUAL'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_name          TEXT;  -- the name on the ID, as the checker gave it
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_last4         TEXT;  -- last 4 digits only
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_ref           TEXT;  -- the checker's reference (or the staff member, for MANUAL)
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_review_reason TEXT;  -- why they're in Needs review
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_review_at     TIMESTAMPTZ;

-- Every try, so we can allow 3 a day and staff can see what happened. Last 4 digits only.
CREATE TABLE IF NOT EXISTS kyc_checks (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id),
  method     TEXT NOT NULL CHECK (method IN ('BVN', 'NIN')),
  last4      TEXT NOT NULL,
  result     TEXT NOT NULL CHECK (result IN ('VERIFIED', 'NOT_FOUND', 'DOB_MISMATCH', 'UNAVAILABLE')),
  provider   TEXT NOT NULL,
  reference  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kyc_checks_user_idx ON kyc_checks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS users_kyc_review_idx ON users (kyc_review_at) WHERE kyc_status = 'REVIEW';

-- Seller payouts wait in payouts.status = 'WAITING_KYC' until the seller verifies (status is free text).
