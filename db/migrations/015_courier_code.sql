-- The rider or waybill driver can enter the buyer's handover code from their own WhatsApp.
-- handover_by: who entered the right code ('seller' or 'courier'). courier_alert: what happened to the message
-- sent to the rider/driver at dispatch ('sent', 'not-sent' when we couldn't reach them, 'skipped' for the seller's
-- or buyer's own number).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS handover_by   TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS courier_alert TEXT;
