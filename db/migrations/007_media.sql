-- Images set from Console → Settings: the logo, the logo icon, and the pictures on the website.
-- Each slot holds at most one image. Raster images are resized and stored as WebP; SVG logos are kept as they are.
CREATE TABLE IF NOT EXISTS media (
  slot           TEXT PRIMARY KEY,
  mime           TEXT NOT NULL,
  bytes          BYTEA NOT NULL,
  sha256         TEXT NOT NULL,
  width          INT,
  height         INT,
  size_bytes     INT NOT NULL,
  original_name  TEXT,
  updated_by     UUID REFERENCES staff(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
