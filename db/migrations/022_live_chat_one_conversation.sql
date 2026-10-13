-- One conversation per WhatsApp number. A browser key that joined from a new device sees only the messages after
-- it joined (since_id), until the person opens the WhatsApp link (a key with since_id 0).
ALTER TABLE chat_visitor_keys ADD COLUMN IF NOT EXISTS since_id BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS chat_visitors_phone ON chat_visitors (phone);

-- Pictures for News posts in the chat (shown to anyone, so kept apart from the private chat files).
CREATE TABLE IF NOT EXISTS chat_media (
  id          BIGSERIAL PRIMARY KEY,
  mime        TEXT NOT NULL,
  size        INT NOT NULL,
  bytes       BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chat_content ADD COLUMN IF NOT EXISTS image_id BIGINT REFERENCES chat_media(id) ON DELETE SET NULL;
