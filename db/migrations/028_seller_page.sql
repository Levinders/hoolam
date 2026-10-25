-- The seller's public page shows more proof (Console → Settings → Features → Seller videos).
--  * seller_videos: a short video a seller sends in WhatsApp (My page → Video). Hoolam checks each one before buyers see it.
--    A seller has at most one live (APPROVED) video; a new one waits as PENDING while the old one stays up.
--  * seller_reviews: a few words a buyer writes after a happy order. Shown on the seller's page only if the buyer said yes,
--    with their first name and area; the team can hide any of them.
--  * users.show_delivered: the seller chose to show photos of items they've delivered on their page.

CREATE TABLE IF NOT EXISTS seller_videos (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  mime        TEXT NOT NULL,
  bytes       BYTEA NOT NULL,
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reason      TEXT,                                   -- why it wasn't approved (the seller is told)
  reviewed_by UUID REFERENCES staff(id),
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seller_videos_user ON seller_videos (user_id, status);
CREATE INDEX IF NOT EXISTS seller_videos_pending ON seller_videos (created_at) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS seller_reviews (
  deal_id     UUID PRIMARY KEY REFERENCES deals(id),
  buyer_id    UUID NOT NULL REFERENCES users(id),
  seller_id   UUID NOT NULL REFERENCES users(id),
  text        TEXT NOT NULL,
  public      BOOLEAN NOT NULL DEFAULT false,          -- the buyer agreed to show it with their first name and area
  hidden      BOOLEAN NOT NULL DEFAULT false,          -- taken down by the team
  hidden_by   UUID REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seller_reviews_seller ON seller_reviews (seller_id, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS show_delivered BOOLEAN NOT NULL DEFAULT false;
