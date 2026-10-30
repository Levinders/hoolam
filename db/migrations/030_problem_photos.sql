-- Photos a buyer sends as proof when they report a problem (from the Report a problem form, or the chat).
ALTER TABLE deal_photos DROP CONSTRAINT IF EXISTS deal_photos_kind_check;
ALTER TABLE deal_photos ADD CONSTRAINT deal_photos_kind_check CHECK (kind IN ('ITEM', 'SHIPPING', 'PROBLEM'));
