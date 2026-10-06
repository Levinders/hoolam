-- Trust card: seller profile, buyer ratings, and keeping test deals out of the numbers.
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_name  TEXT;                       -- what buyers see (shop/brand name)
ALTER TABLE users ADD COLUMN IF NOT EXISTS city           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_public BOOLEAN NOT NULL DEFAULT false; -- public page on/off (seller's choice)
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_slug   TEXT UNIQUE;                -- hoolam…/s/<slug>

ALTER TABLE deals ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;    -- pretend money: never counts on a trust card

-- One tap after "I'm happy". Only the buyer of a completed deal can rate it, once.
CREATE TABLE IF NOT EXISTS deal_ratings (
  deal_id    UUID PRIMARY KEY REFERENCES deals(id),
  buyer_id   UUID NOT NULL REFERENCES users(id),
  seller_id  UUID NOT NULL REFERENCES users(id),
  happy      BOOLEAN NOT NULL,
  comment    TEXT,                 -- private: for the Hoolam team only, never shown publicly
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_ratings_seller ON deal_ratings (seller_id);
