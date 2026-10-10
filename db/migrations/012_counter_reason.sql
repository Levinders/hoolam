-- Why the seller asked for a different price (the buyer sees it next to the new price).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS counter_reason text;
