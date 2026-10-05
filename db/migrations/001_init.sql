-- Hoolam Phase 1 schema.
-- Money is always stored as BIGINT in the currency's smallest unit (kobo for NGN, francs for XOF),
-- together with its ISO currency code. Never use floats or NUMERIC for amounts.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE deal_status AS ENUM (
  'AWAITING_BUYER',    -- seller created it; no buyer has opened the link yet
  'AWAITING_PAYMENT',  -- buyer joined; waiting for the transfer
  'FUNDED',            -- money confirmed and held; seller should ship
  'SHIPPED',           -- seller says it's on the way
  'RELEASING',         -- buyer is happy; payout to seller in progress
  'PAYOUT_PENDING',    -- payout needs manual approval (e.g. provider OTP)
  'COMPLETED',         -- seller paid
  'DISPUTED',          -- buyer reported a problem; money frozen
  'REFUNDING',         -- refund to buyer in progress
  'REFUNDED',          -- buyer paid back
  'CANCELLED',         -- cancelled before any money moved
  'EXPIRED'            -- nobody paid in time
);

CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        TEXT NOT NULL UNIQUE,            -- E.164, e.g. +2348012345678
  display_name TEXT,
  country      CHAR(2) NOT NULL DEFAULT 'NG',
  kyc_status   TEXT NOT NULL DEFAULT 'UNVERIFIED',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where a user gets paid (sellers) or refunded (buyers).
CREATE TABLE bank_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  bank_code      TEXT NOT NULL,
  bank_name      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,                 -- from the provider's name check
  is_default     BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, bank_code, account_number)
);

CREATE TABLE deals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,        -- short public code, e.g. HL-7KQ2
  seller_id        UUID NOT NULL REFERENCES users(id),
  buyer_id         UUID REFERENCES users(id),
  item             TEXT NOT NULL,
  currency         CHAR(3) NOT NULL,
  price_minor      BIGINT NOT NULL CHECK (price_minor > 0),
  fee_minor        BIGINT NOT NULL CHECK (fee_minor >= 0),
  buyer_pays_minor BIGINT NOT NULL,
  seller_gets_minor BIGINT NOT NULL,
  seller_account_id UUID REFERENCES bank_accounts(id),
  status           deal_status NOT NULL DEFAULT 'AWAITING_BUYER',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  funded_at        TIMESTAMPTZ,
  shipped_at       TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ,
  reminded_at      TIMESTAMPTZ,
  CHECK (buyer_pays_minor >= price_minor - fee_minor),
  CHECK (seller_gets_minor <= price_minor)
);
CREATE INDEX deals_status_idx ON deals (status, updated_at);
CREATE INDEX deals_seller_idx ON deals (seller_id, created_at DESC);
CREATE INDEX deals_buyer_idx ON deals (buyer_id, created_at DESC);

-- Every status change, who did it and why. Never updated, only appended.
CREATE TABLE deal_events (
  id          BIGSERIAL PRIMARY KEY,
  deal_id     UUID NOT NULL REFERENCES deals(id),
  from_status deal_status,
  to_status   deal_status NOT NULL,
  actor       TEXT NOT NULL,                    -- 'seller', 'buyer', 'system', 'admin', 'provider'
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deal_events_deal_idx ON deal_events (deal_id, id);

-- One row per payment instruction shown to a buyer (account numbers expire, so there can be several).
CREATE TABLE payment_intents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id          UUID NOT NULL REFERENCES deals(id),
  provider         TEXT NOT NULL,
  payment_reference TEXT NOT NULL UNIQUE,       -- ours
  provider_reference TEXT UNIQUE,               -- theirs (e.g. MNFY|...)
  amount_minor     BIGINT NOT NULL,
  currency         CHAR(3) NOT NULL,
  account_number   TEXT,
  account_name     TEXT,
  bank_name        TEXT,
  expires_at       TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, PAID, PARTIAL, EXPIRED, FAILED
  amount_paid_minor BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_intents_deal_idx ON payment_intents (deal_id);

CREATE TABLE payouts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id        UUID NOT NULL REFERENCES deals(id),
  kind           TEXT NOT NULL CHECK (kind IN ('SELLER', 'REFUND')),
  provider       TEXT NOT NULL,
  reference      TEXT NOT NULL UNIQUE,
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  currency       CHAR(3) NOT NULL,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  status         TEXT NOT NULL DEFAULT 'CREATED', -- CREATED, SUBMITTED, NEEDS_AUTHORIZATION, SUCCESS, FAILED, REVERSED
  provider_message TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payouts_deal_idx ON payouts (deal_id);

-- Double-entry ledger. Balances are always derived from here, never stored.
-- Each txn_id groups lines that must sum to zero (debits positive, credits negative).
CREATE TABLE ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  txn_id       UUID NOT NULL,
  deal_id      UUID REFERENCES deals(id),
  account      TEXT NOT NULL,                  -- e.g. cash:monnify, held:deal, payable:seller, revenue:fees
  amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),
  currency     CHAR(3) NOT NULL,
  memo         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_txn_idx ON ledger_entries (txn_id);
CREATE INDEX ledger_deal_idx ON ledger_entries (deal_id);
CREATE INDEX ledger_account_idx ON ledger_entries (account, currency);

-- Rejects any ledger transaction whose lines don't balance, at commit time.
CREATE FUNCTION ledger_txn_balanced() RETURNS trigger AS $$
DECLARE total BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_minor), 0) INTO total FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (sum %)', NEW.txn_id, total;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_txn_balanced();

CREATE TABLE disputes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     UUID NOT NULL REFERENCES deals(id),
  opened_by   UUID NOT NULL REFERENCES users(id),
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'OPEN',    -- OPEN, RESOLVED_RELEASE, RESOLVED_REFUND
  resolution_note TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX disputes_deal_idx ON disputes (deal_id);

-- Every incoming webhook, stored before processing. event_key makes processing idempotent.
CREATE TABLE webhook_events (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,                  -- 'whatsapp' | 'monnify' | ...
  event_key    TEXT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  UNIQUE (source, event_key)
);
CREATE INDEX webhook_events_pending_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

-- Where each person is in a WhatsApp conversation.
CREATE TABLE chat_sessions (
  phone      TEXT PRIMARY KEY,
  state      TEXT NOT NULL DEFAULT 'IDLE',
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_inbound_at TIMESTAMPTZ,                -- WhatsApp only allows free-form replies within 24h of this
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages we sent (or would have sent in dry-run mode). Useful for support and testing.
CREATE TABLE outbound_messages (
  id         BIGSERIAL PRIMARY KEY,
  phone      TEXT NOT NULL,
  kind       TEXT NOT NULL,                   -- text | buttons | template
  body       JSONB NOT NULL,
  status     TEXT NOT NULL,                   -- SENT | DRY_RUN | FAILED
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbound_phone_idx ON outbound_messages (phone, id);
