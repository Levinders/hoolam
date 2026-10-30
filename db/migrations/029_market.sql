-- The Hoolam market (Console → Settings → Features → Market, off by default).
-- Sellers list items in WhatsApp; buyers browse them as swipe cards, save favourites, and buy one item or a basket
-- from one seller as an ordinary Hoolam order (the money is held as usual).

-- One item a seller lists. `code` is its short public name: go.hoolam.com/i/<code>, and "Buy <code>" in the chat.
CREATE TABLE IF NOT EXISTS market_listings (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  seller_id     UUID NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  details       TEXT,
  category      TEXT NOT NULL,
  price_minor   BIGINT NOT NULL CHECK (price_minor > 0),
  promo_minor   BIGINT CHECK (promo_minor IS NULL OR promo_minor > 0),  -- a lower price for a while (the old one shows struck through)
  promo_ends    TIMESTAMPTZ,
  stock         INT NOT NULL DEFAULT 1 CHECK (stock >= 0),
  delivery      TEXT[] NOT NULL DEFAULT '{pickup}',                     -- any of pickup, rider (same city), waybill (other states)
  area          TEXT,                                                   -- neighbourhood, as matched ("Woji")
  city          TEXT,                                                   -- "Port Harcourt"
  state         TEXT,                                                   -- "Rivers"
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  status        TEXT NOT NULL DEFAULT 'LIVE' CHECK (status IN ('LIVE', 'PAUSED', 'HIDDEN', 'SOLD_OUT', 'EXPIRED', 'REMOVED', 'DELETED')),
  status_reason TEXT,                                                   -- why it's hidden or removed (the seller is told)
  kept_at       TIMESTAMPTZ,                                            -- the team looked at it and kept it (regular check)
  kept_by       UUID REFERENCES staff(id),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  warned_at     TIMESTAMPTZ,                                            -- "hides on …" sent
  is_test       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_listings_live ON market_listings (category, created_at DESC) WHERE status = 'LIVE';
CREATE INDEX IF NOT EXISTS market_listings_seller ON market_listings (seller_id, status);
CREATE INDEX IF NOT EXISTS market_listings_new ON market_listings (created_at DESC) WHERE kept_at IS NULL;

CREATE TABLE IF NOT EXISTS market_photos (
  id          BIGSERIAL PRIMARY KEY,
  listing_id  BIGINT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  position    INT NOT NULL DEFAULT 0,
  mime        TEXT NOT NULL,
  bytes       BYTEA NOT NULL,
  sha256      TEXT NOT NULL,
  look        TEXT                                                     -- a short fingerprint of how it looks, to spot another seller's photo
);
CREATE INDEX IF NOT EXISTS market_photos_listing ON market_photos (listing_id, position);
CREATE INDEX IF NOT EXISTS market_photos_look ON market_photos (look);

-- Who may list, when approval is on; a seller's own item limit; listing stopped after strikes.
CREATE TABLE IF NOT EXISTS market_sellers (
  user_id     UUID PRIMARY KEY REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPLIED', 'APPROVED', 'DECLINED', 'STOPPED')),
  note        TEXT,                                                    -- what they sell (their application)
  reason      TEXT,                                                    -- why declined or stopped (they're told)
  item_limit  INT,                                                     -- their own limit (else the setting)
  limit_until TIMESTAMPTZ,                                             -- a paid upgrade's end
  decided_by  UUID REFERENCES staff(id),
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A removed listing counts against the seller (older than 90 days stops counting).
CREATE TABLE IF NOT EXISTS market_strikes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  listing_id  BIGINT REFERENCES market_listings(id),
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_strikes_user ON market_strikes (user_id, created_at);

-- "Get more items": a seller asks; the team confirms payment and the limit rises.
CREATE TABLE IF NOT EXISTS market_upgrades (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id),
  items        INT NOT NULL,
  amount_minor BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ASKED' CHECK (status IN ('ASKED', 'DONE', 'DECLINED')),
  reference    TEXT,
  decided_by   UUID REFERENCES staff(id),
  decided_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_saves (
  user_id     UUID NOT NULL REFERENCES users(id),
  listing_id  BIGINT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  told_at     TIMESTAMPTZ,                                             -- "back in stock" sent
  PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS market_reports (
  id          BIGSERIAL PRIMARY KEY,
  listing_id  BIGINT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, user_id)
);

-- Where a buyer is browsing (area, page, search), their basket (one seller at a time), and whether they want updates.
CREATE TABLE IF NOT EXISTS market_browsers (
  user_id     UUID PRIMARY KEY REFERENCES users(id),
  place       JSONB,                                                   -- {area, city, state, lat, lng} or {all:true}
  browse      JSONB,                                                   -- the current results: query, ring, page, shown ids
  basket      JSONB,                                                   -- {sellerId, items:[{id, qty}]}
  updates_ok  BOOLEAN,                                                 -- said yes / no to "new items from sellers you like"
  asked_at    TIMESTAMPTZ,
  news_at     TIMESTAMPTZ,                                             -- last "new from sellers you bought from" message
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The items an order came from (one listing, or a basket from one seller). Stock moves when the buyer pays.
CREATE TABLE IF NOT EXISTS market_order_items (
  deal_id      UUID NOT NULL REFERENCES deals(id),
  listing_id   BIGINT NOT NULL REFERENCES market_listings(id),
  qty          INT NOT NULL CHECK (qty > 0),
  price_minor  BIGINT NOT NULL,
  title        TEXT NOT NULL,
  stock_taken  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (deal_id, listing_id)
);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS from_market BOOLEAN NOT NULL DEFAULT false;

-- Counts per item and day: seen (a card shown), views (See more, the web page), saves, buys (Buy safely taps), orders (paid).
CREATE TABLE IF NOT EXISTS market_stats (
  listing_id  BIGINT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  seen        INT NOT NULL DEFAULT 0,
  views       INT NOT NULL DEFAULT 0,
  saves       INT NOT NULL DEFAULT 0,
  buys        INT NOT NULL DEFAULT 0,
  orders      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (listing_id, day)
);
-- Searches people typed (to see what buyers want and what's missing). Kept 90 days.
CREATE TABLE IF NOT EXISTS market_searches (
  id          BIGSERIAL PRIMARY KEY,
  query       TEXT NOT NULL,
  found       INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ad links (Features → Market → Ads that open WhatsApp on an item): which ad brought a visit and an order.
CREATE TABLE IF NOT EXISTS market_ad_links (
  id          BIGSERIAL PRIMARY KEY,
  listing_id  BIGINT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                                           -- "ig-nov" (the team names it)
  taps        INT NOT NULL DEFAULT 0,
  orders      INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, name)
);
