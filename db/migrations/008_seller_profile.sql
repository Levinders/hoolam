-- A seller's public page: a photo and links to where they sell (Instagram, TikTok, Facebook, their own site).
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_instagram TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_tiktok TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_facebook TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_website TEXT;

CREATE TABLE IF NOT EXISTS user_photos (
  user_id     UUID PRIMARY KEY REFERENCES users(id),
  mime        TEXT NOT NULL,
  bytes       BYTEA NOT NULL,
  sha256      TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
