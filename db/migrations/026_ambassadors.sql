-- The ambassador programme: people Hoolam approves bring new sellers and buyers, and earn a share of what Hoolam
-- makes on their orders, plus a bonus when a seller they brought completes their first orders. Paid monthly.

-- A one-way code of the ID number checked (BVN or NIN), so we can tell when two accounts are the same person
-- without keeping the number itself. Set from now on, at each successful ID check.
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_id_hash TEXT;
CREATE INDEX IF NOT EXISTS users_kyc_id_hash_idx ON users (kyc_id_hash) WHERE kyc_id_hash IS NOT NULL;

-- Applications, from the website, WhatsApp, or added by the team ("Invite someone").
CREATE TABLE IF NOT EXISTS ambassador_applications (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id),
  phone         TEXT NOT NULL,                        -- E.164
  full_name     TEXT NOT NULL,
  email         TEXT,
  state         TEXT,
  city          TEXT,
  community     TEXT,                                 -- campus, market or community
  knows         TEXT[] NOT NULL DEFAULT '{}',         -- vendors, students, traders, shoppers, riders
  channels      TEXT[] NOT NULL DEFAULT '{}',         -- status, groups, instagram, tiktok, x, facebook, in_person, flyers
  handle        TEXT,
  reach         TEXT,                                 -- under_500, 500_2000, 2000_10000, over_10000
  sells_online  BOOLEAN,
  why           TEXT,
  source        TEXT NOT NULL CHECK (source IN ('website', 'whatsapp', 'invite')),
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED')),
  decision_note TEXT,
  decided_by    UUID REFERENCES staff(id),
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS amb_apps_status_idx ON ambassador_applications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS amb_apps_phone_idx ON ambassador_applications (phone, created_at DESC);

-- One row per ambassador (approved). SETUP until they've checked their ID, saved a bank account, chosen a term and a name.
CREATE TABLE IF NOT EXISTS ambassadors (
  user_id          UUID PRIMARY KEY REFERENCES users(id),
  application_id   BIGINT REFERENCES ambassador_applications(id),
  status           TEXT NOT NULL DEFAULT 'SETUP' CHECK (status IN ('SETUP', 'ACTIVE', 'PAUSED', 'ENDED')),
  slug             TEXT UNIQUE,                       -- hoolam.com/a/<slug>
  area             TEXT,                              -- shown on their link: "Tobi · UNILAG"
  term_months      INT CHECK (term_months IN (3, 6, 12)),
  next_term_months INT CHECK (next_term_months IN (3, 6, 12)), -- a switch, from the next term
  term_started_at  TIMESTAMPTZ,
  term_ends_at     TIMESTAMPTZ,
  notice_for       TIMESTAMPTZ,                       -- the term end the "ends soon" notice was sent for
  summary_month    DATE,                              -- the last month-end summary sent
  seller_pct       NUMERIC(5,2),                      -- a custom share for this ambassador (null = the default)
  buyer_pct        NUMERIC(5,2),
  photo_ok_at      TIMESTAMPTZ,                       -- agreed their photo and first name show on their link
  approved_by      UUID REFERENCES staff(id),
  approved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at     TIMESTAMPTZ,
  paused_at        TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  end_reason       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every link name ever taken: never given to anyone else, even after the ambassador ends or changes it.
-- An old name keeps working and moves people to the ambassador's current one.
CREATE TABLE IF NOT EXISTS ambassador_names (
  slug       TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ambassador_photos (
  user_id    UUID PRIMARY KEY REFERENCES users(id),
  mime       TEXT NOT NULL,
  bytes      BYTEA NOT NULL,
  sha256     TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who brought whom: one ambassador per person, for good (first come). Only people new to Hoolam.
CREATE TABLE IF NOT EXISTS ambassador_referrals (
  referred_id   UUID PRIMARY KEY REFERENCES users(id),
  ambassador_id UUID NOT NULL REFERENCES users(id),
  via           TEXT NOT NULL CHECK (via IN ('link', 'code', 'team')),
  slug          TEXT,
  bonus_at      TIMESTAMPTZ,                          -- the seller bonus was earned
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS amb_ref_amb_idx ON ambassador_referrals (ambassador_id, created_at DESC);

-- People who were asked "Did an ambassador send you?" (asked once).
ALTER TABLE users ADD COLUMN IF NOT EXISTS amb_asked_at TIMESTAMPTZ;

-- What each ambassador earned. SHARE: their % of what Hoolam made on one order. BONUS: a seller they brought completed
-- their first orders. CONFIRMED counts (and is in the ledger); HELD waits for the team (reason given); VOID was cancelled.
CREATE TABLE IF NOT EXISTS ambassador_earnings (
  id            BIGSERIAL PRIMARY KEY,
  ambassador_id UUID NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('SHARE', 'BONUS')),
  referred_id   UUID NOT NULL REFERENCES users(id),
  side          TEXT NOT NULL CHECK (side IN ('SELLER', 'BUYER')),
  deal_id       UUID NOT NULL REFERENCES deals(id),
  revenue_minor BIGINT NOT NULL DEFAULT 0,            -- what Hoolam earned on the order (SHARE)
  percent       NUMERIC(5,2),                         -- the % used (SHARE)
  amount_minor  BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency      CHAR(3) NOT NULL,
  month         DATE NOT NULL,                        -- the month it counts in (Lagos time), first day
  status        TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'HELD', 'VOID')),
  hold_reason   TEXT,
  decided_by    UUID REFERENCES staff(id),
  decided_at    TIMESTAMPTZ,
  payout_id     UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ambassador_id, deal_id, kind, side)
);
CREATE INDEX IF NOT EXISTS amb_earn_amb_idx ON ambassador_earnings (ambassador_id, month);
CREATE INDEX IF NOT EXISTS amb_earn_held_idx ON ambassador_earnings (status) WHERE status = 'HELD';

-- Monthly payouts. DUE until the team pays (a bank transfer for now) and marks it paid.
CREATE TABLE IF NOT EXISTS ambassador_payouts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ambassador_id   UUID NOT NULL REFERENCES users(id),
  period          DATE NOT NULL,                      -- the month it's for (first day); a final payout uses the month it ended
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        CHAR(3) NOT NULL,
  bank_account_id UUID REFERENCES bank_accounts(id),
  status          TEXT NOT NULL DEFAULT 'DUE' CHECK (status IN ('DUE', 'PAID')),
  final           BOOLEAN NOT NULL DEFAULT false,     -- the last one, when they ended (paid whatever the amount)
  reference       TEXT,
  paid_by         UUID REFERENCES staff(id),
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS amb_payouts_status_idx ON ambassador_payouts (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS amb_payouts_month_idx ON ambassador_payouts (ambassador_id, period) WHERE NOT final;

-- Taps on hoolam.com/a/<name> (daily totals).
CREATE TABLE IF NOT EXISTS ambassador_link_taps (
  slug TEXT NOT NULL,
  day  DATE NOT NULL,
  taps INT NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day)
);

-- The ambassador's web dashboard: a 6-digit code sent to their WhatsApp, then a session on that device.
-- Only hashes are stored.
CREATE TABLE IF NOT EXISTS ambassador_codes (
  phone      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  tries      INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ambassador_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id),
  device       TEXT,                                  -- "Chrome on Android", for the "new device" message
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS amb_sessions_user_idx ON ambassador_sessions (user_id);

-- Staff: who may review applications (reps can be given this, like WhatsApp support and live chat).
ALTER TABLE staff ADD COLUMN IF NOT EXISTS access_ambassadors BOOLEAN;
