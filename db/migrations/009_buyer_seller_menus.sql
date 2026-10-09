-- Two menus: one for buying, one for selling.
-- seller_since: when this person became a seller (set up their trust card, or sold or accepted an order). Null = buyer only.
-- menu_mode: which menu they see. Follows their last order, and they can switch any time.
ALTER TABLE users ADD COLUMN IF NOT EXISTS seller_since TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS menu_mode TEXT NOT NULL DEFAULT 'buyer' CHECK (menu_mode IN ('buyer', 'seller'));

-- Everyone who has already sold, or named their shop, is a seller.
UPDATE users u SET seller_since = COALESCE(
    (SELECT min(d.created_at) FROM deals d WHERE d.seller_id = u.id),
    CASE WHEN u.business_name IS NOT NULL THEN u.created_at END)
  WHERE u.seller_since IS NULL;

-- Their menu follows their latest order.
UPDATE users u SET menu_mode = 'seller'
  WHERE u.seller_since IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM deals b WHERE b.buyer_id = u.id
        AND b.created_at > COALESCE((SELECT max(s.created_at) FROM deals s WHERE s.seller_id = u.id), '-infinity'));
