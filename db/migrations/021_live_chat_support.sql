-- Live chat on the website, answered from the console's support widget (next to WhatsApp support).

-- Who can answer which support: null = what their role allows (Owner always both).
ALTER TABLE staff ADD COLUMN IF NOT EXISTS access_whatsapp BOOLEAN;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS access_live BOOLEAN;

-- A visitor: the name and WhatsApp number they gave. Linked to a Hoolam user with the same number.
CREATE TABLE IF NOT EXISTS chat_visitors (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  user_id     UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The browser keys that open a visitor's chats (only a hash is stored). A WhatsApp "open the chat" link adds one.
CREATE TABLE IF NOT EXISTS chat_visitor_keys (
  key_hash    TEXT PRIMARY KEY,
  visitor_id  BIGINT NOT NULL REFERENCES chat_visitors(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_threads (
  id              BIGSERIAL PRIMARY KEY,
  ref             TEXT NOT NULL UNIQUE,              -- LC-7K2QF, shown to the team
  visitor_id      BIGINT NOT NULL REFERENCES chat_visitors(id) ON DELETE CASCADE,
  resume_code     TEXT NOT NULL UNIQUE,              -- in the WhatsApp "open the chat" link
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  assigned_to     UUID REFERENCES staff(id),
  assigned_at     TIMESTAMPTZ,
  source_page     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_visitor_at TIMESTAMPTZ,
  last_staff_at   TIMESTAMPTZ,
  visitor_read_id BIGINT NOT NULL DEFAULT 0,         -- the last message the visitor has seen
  wa_notified_at  TIMESTAMPTZ,                       -- the WhatsApp "a rep replied" message
  rating          TEXT CHECK (rating IN ('UP', 'DOWN')),
  rated_at        TIMESTAMPTZ,
  rated_staff     UUID REFERENCES staff(id),         -- who handled it (for performance reviews)
  closed_at       TIMESTAMPTZ,
  closed_by       UUID REFERENCES staff(id)
);
CREATE INDEX IF NOT EXISTS chat_threads_visitor ON chat_threads (visitor_id);
CREATE INDEX IF NOT EXISTS chat_threads_status ON chat_threads (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_files (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INT NOT NULL,
  bytes       BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- VISITOR and STAFF messages both sides see; NOTE is for the team only; SYSTEM lines ("Chioma joined").
CREATE TABLE IF NOT EXISTS chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('VISITOR', 'STAFF', 'NOTE', 'SYSTEM')),
  staff_id    UUID REFERENCES staff(id),
  staff_name  TEXT,
  body        TEXT NOT NULL DEFAULT '',
  file_id     BIGINT REFERENCES chat_files(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages (thread_id, id);

-- What each teammate has read: live chats and WhatsApp support (for unread counts).
CREATE TABLE IF NOT EXISTS chat_reads (
  staff_id      UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  thread_id     BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  last_read_id  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (staff_id, thread_id)
);
CREATE TABLE IF NOT EXISTS support_reads (
  staff_id    UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  request_id  BIGINT NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, request_id)
);

-- What the chat shows: Home cards, Questions, News, quick-reply chips, saved replies for reps, the welcome line.
-- {fee_rate}, {fee_min}, {fee_max}, {txn_min}, {max_deal}, {max_deal_verified}, {whatsapp} are filled from the console.
CREATE TABLE IF NOT EXISTS chat_content (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('HOME', 'QUESTION', 'NEWS', 'CHIP', 'SAVED', 'WELCOME')),
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  url         TEXT,
  shortcut    TEXT,                                  -- saved replies: /fees
  published   BOOLEAN NOT NULL DEFAULT true,
  position    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES staff(id)
);
CREATE INDEX IF NOT EXISTS chat_content_kind ON chat_content (kind, position);

-- Starting content: the home page's questions (published), a welcome line, chips, saved replies, a news post.
INSERT INTO chat_content (kind, title, body, url, shortcut, position)
SELECT * FROM (VALUES
  ('WELCOME', '', 'Hi there. How can we help today?', NULL, NULL, 0),
  ('HOME', 'How Hoolam works', 'From order to payment, step by step.', '/#journey', NULL, 1),
  ('HOME', 'See our pricing', 'What an order costs, and who pays.', '/#pricing', NULL, 2),
  ('HOME', 'Where the money sits', 'The bank, and every step your money takes.', '/legal/money/', NULL, 3),
  ('QUESTION', 'Do I need an app?', 'No. It all happens in WhatsApp.', NULL, NULL, 1),
  ('QUESTION', 'How much does it cost?', '{fee_rate} of the price, starting from {fee_min}, never more than {fee_max}. Whoever starts the order pays it. The other side pays a small flat transaction fee, from {txn_min}.', NULL, NULL, 2),
  ('QUESTION', 'What if my item never comes?', 'You get your money back, all of it, fully refunded. The money doesn’t reach the seller until you’ve seen the delivery person.', NULL, NULL, 3),
  ('QUESTION', 'What if the buyer says no at the gate?', 'Tell us in the chat. The money stays frozen while a rep sorts it out with you both. Wrong item? The buyer gets it all back.', NULL, NULL, 4),
  ('QUESTION', 'How do I pay or get paid?', 'Buyers pay by bank transfer to a one-time account we send for that order. Sellers are paid straight to the bank account they provided.', NULL, NULL, 5),
  ('QUESTION', 'Who do I talk to if something goes wrong?', 'A rep, in the same WhatsApp chat. Tap “Talk to a rep” in the menu. Or message us right here.', NULL, NULL, 6),
  ('CHIP', '', 'How does Hoolam work?', NULL, NULL, 1),
  ('CHIP', '', 'How much does it cost?', NULL, NULL, 2),
  ('CHIP', '', 'Is my money safe?', NULL, NULL, 3),
  ('CHIP', '', 'I have a problem with an order', NULL, NULL, 4),
  ('SAVED', 'Fees', '{fee_rate} of the price, starting from {fee_min}, never more than {fee_max}. Whoever starts the order pays it. The other side pays a small flat transaction fee, from {txn_min}.', NULL, 'fees', 1),
  ('SAVED', 'Is my money safe?', 'Yes. Your money is held with Moniepoint Microfinance Bank, a bank licensed by the Central Bank of Nigeria. It only goes to the seller when you confirm the item arrived.', NULL, 'safe', 2),
  ('SAVED', 'Order code', 'Please share your order code (it starts with HL-) and I’ll check it for you right away.', NULL, 'order', 3),
  ('SAVED', 'Our hours', 'Our reps are available from 9am to 5pm, every day. Hoolam on WhatsApp works any time.', NULL, 'hours', 4),
  ('NEWS', 'Live chat is here', 'You can now chat with a Hoolam rep right here on our website, from 9am to 5pm, every day.', NULL, NULL, 1)
) AS v(kind, title, body, url, shortcut, position)
WHERE NOT EXISTS (SELECT 1 FROM chat_content);
