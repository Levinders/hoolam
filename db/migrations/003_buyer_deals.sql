-- Deals a BUYER starts: the seller is unknown until they accept.
ALTER TYPE deal_status ADD VALUE IF NOT EXISTS 'AWAITING_SELLER' BEFORE 'AWAITING_BUYER';

ALTER TABLE deals ALTER COLUMN seller_id DROP NOT NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS started_by    TEXT NOT NULL DEFAULT 'SELLER' CHECK (started_by IN ('SELLER', 'BUYER'));
ALTER TABLE deals ADD COLUMN IF NOT EXISTS invited_phone TEXT;          -- seller's number the buyer typed (we alert it once)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS arrive_by     DATE;          -- when the buyer expects the item
ALTER TABLE deals ADD COLUMN IF NOT EXISTS accept_by     TIMESTAMPTZ;   -- seller must accept before this
ALTER TABLE deals ADD CONSTRAINT deals_has_a_side CHECK (seller_id IS NOT NULL OR buyer_id IS NOT NULL);

-- Photos of what was promised. Kept as evidence for disputes.
CREATE TABLE IF NOT EXISTS deal_photos (
  id            BIGSERIAL PRIMARY KEY,
  deal_id       UUID NOT NULL REFERENCES deals(id),
  uploaded_by   UUID REFERENCES users(id),
  mime_type     TEXT NOT NULL DEFAULT 'image/jpeg',
  bytes         BYTEA,                    -- the photo itself (null only in dry-run tests)
  sha256        TEXT,
  wa_media_id   TEXT,                     -- the id WhatsApp gave us when it arrived
  sent_media_id TEXT,                     -- our re-upload, reusable for 30 days when showing it to the seller
  sent_media_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_photos_deal ON deal_photos (deal_id, id);

-- People who tapped "Not me" on a seller alert. We never send them an alert again.
CREATE TABLE IF NOT EXISTS contact_optouts (
  phone      TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
