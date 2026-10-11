-- Sell something now works like Buy something: the buyer accepts the seller's order, then pays, and the seller
-- dispatches with a handover code. Orders a seller started before this keep the old route ("I've sent it") until they finish.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS legacy_ship BOOLEAN NOT NULL DEFAULT false;
UPDATE deals SET legacy_ship = true WHERE started_by = 'SELLER';
