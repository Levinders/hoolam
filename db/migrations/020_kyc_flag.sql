-- ID checks Prembly flags (a BVN watchlisted by NIBSS, a NIN suspended by NIMC): the person goes to Needs review,
-- and no more checks run for them (BVN or NIN) until the team approves or declines.
-- kyc_flag: why (plain words, staff only). kyc_declined_at: the team declined; they stay at the limit without ID.
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_flag TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_declined_at TIMESTAMPTZ;
-- A check that found the ID but its issuer had flagged it.
ALTER TABLE kyc_checks DROP CONSTRAINT IF EXISTS kyc_checks_result_check;
ALTER TABLE kyc_checks ADD CONSTRAINT kyc_checks_result_check CHECK (result IN ('VERIFIED', 'NOT_FOUND', 'DOB_MISMATCH', 'UNAVAILABLE', 'FLAGGED'));
