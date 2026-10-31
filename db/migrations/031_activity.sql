-- What each person does in the WhatsApp chat (taps, messages, forms), for their Activity tab in the console.
-- Sensitive details are never kept: ID numbers, dates of birth and handover codes are left out, and long numbers
-- (account and phone numbers) keep only their last 4 digits. Kept 12 months.
CREATE TABLE IF NOT EXISTS user_activity (
  id        BIGSERIAL PRIMARY KEY,
  user_id   UUID REFERENCES users(id),
  phone     TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind      TEXT NOT NULL CHECK (kind IN ('tap', 'message', 'form', 'screen')),
  title     TEXT NOT NULL,                       -- in plain words: Tapped "🛡️ Buy safely"
  detail    JSONB NOT NULL DEFAULT '{}',         -- text, answers, the order code or item it's about
  wa_id     TEXT                                 -- WhatsApp's message id (a repeat delivery is recorded once)
);
CREATE INDEX IF NOT EXISTS user_activity_user ON user_activity (user_id, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS user_activity_wa ON user_activity (wa_id) WHERE wa_id IS NOT NULL;
