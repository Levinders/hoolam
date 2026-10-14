-- Campaign links: hoolam.com/<slug> opens the website and tells Google Analytics where the visitor came from.
CREATE TABLE IF NOT EXISTS campaign_links (
  slug        TEXT PRIMARY KEY,                    -- hoolam.com/<slug>
  source      TEXT NOT NULL,                       -- where it's posted: instagram, tiktok, x, facebook, whatsapp, flyer, email, other
  campaign    TEXT,                                -- optional, e.g. launch
  page        TEXT NOT NULL DEFAULT '/',           -- where it opens on hoolam.com
  created_by  UUID REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS campaign_link_taps (
  slug  TEXT NOT NULL REFERENCES campaign_links(slug) ON DELETE CASCADE,
  day   DATE NOT NULL,
  taps  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day)
);

-- Sellers' public page stats, counted on our own server: daily totals only, never who the visitor was.
CREATE TABLE IF NOT EXISTS seller_page_stats (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      DATE NOT NULL,
  views    INT NOT NULL DEFAULT 0,
  buys     INT NOT NULL DEFAULT 0,   -- "Buy" taps
  socials  INT NOT NULL DEFAULT 0,   -- taps on their Instagram, TikTok, Facebook or website
  PRIMARY KEY (user_id, day)
);
-- one-way codes (a hash of the visitor's browser and network for that day) so a visitor counts once a day; deleted after 2 days
CREATE TABLE IF NOT EXISTS seller_page_seen (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      DATE NOT NULL,
  visitor  TEXT NOT NULL,
  PRIMARY KEY (user_id, day, visitor)
);
