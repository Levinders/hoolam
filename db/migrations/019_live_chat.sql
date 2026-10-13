-- Feeling live in the chat, receipts and locations.
-- WhatsApp's id for each message we send: read receipts ("seen") come back with it.
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS wa_id TEXT;
CREATE INDEX IF NOT EXISTS outbound_messages_wa_idx ON outbound_messages (wa_id) WHERE wa_id IS NOT NULL;
-- The person's message a support request came from, so a rep's reply can quote it.
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS wa_message_id TEXT;
-- The order alert sent to the other side, and when they first saw the order (read the alert or opened it).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS alert_wa_id TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS deals_alert_wa_idx ON deals (alert_wa_id) WHERE alert_wa_id IS NOT NULL;
-- A shared location ("lat,lng") for the delivery address and the rider's drop-off point.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS delivery_pin TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS courier_pin TEXT;
-- Who has been sent Hoolam's contact card (once, on their first message): buyers, sellers, riders, anyone.
CREATE TABLE IF NOT EXISTS contact_cards (phone TEXT PRIMARY KEY, sent_at TIMESTAMPTZ NOT NULL DEFAULT now());
