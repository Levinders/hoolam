-- Pictures, voice notes, videos and stickers for the WhatsApp chat (Console → Settings → WhatsApp → Chat pictures and voice).
-- Hoolam draws every picture and sticker itself; a row here is the owner's replacement (or, for a live card, its background).
-- Voice notes and videos are only sent once the owner uploads them.
CREATE TABLE IF NOT EXISTS wa_media (
  slot        TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  bytes       BYTEA NOT NULL,
  sha256      TEXT NOT NULL,
  file_name   TEXT,
  updated_by  UUID REFERENCES staff(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What WhatsApp gave back for a file we uploaded (ids last 30 days): the same picture is uploaded once, not per message.
CREATE TABLE IF NOT EXISTS wa_media_ids (
  sha256       TEXT PRIMARY KEY,
  media_id     TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "First time only" moments (a voice note or video sent once per person).
CREATE TABLE IF NOT EXISTS wa_firsts (
  phone   TEXT NOT NULL,
  moment  TEXT NOT NULL,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (phone, moment)
);
