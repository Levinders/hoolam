-- Where each person came from (Console → a person → Source). Set once, from their first message.
ALTER TABLE users ADD COLUMN IF NOT EXISTS source        TEXT;   -- ad, post, campaign, website, ambassador, order, seller_page, market, market_ad, direct
ALTER TABLE users ADD COLUMN IF NOT EXISTS source_detail JSONB;  -- what exactly: the ad's headline, the link, the order code and who sent it…
ALTER TABLE users ADD COLUMN IF NOT EXISTS source_at     TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_source ON users (source, source_at DESC);

-- People from before this: an ambassador who brought them, else someone's order that reached their number first.
UPDATE users u SET source='ambassador', source_at=r.created_at,
  source_detail=jsonb_build_object('by', r.ambassador_id, 'byName', COALESCE(NULLIF(a.business_name, ''), a.display_name), 'via', r.via, 'slug', r.slug)
FROM ambassador_referrals r JOIN users a ON a.id=r.ambassador_id
WHERE r.referred_id=u.id AND u.source IS NULL;

UPDATE users u SET source='order', source_at=d.created_at,
  source_detail=jsonb_build_object('code', d.code, 'by', d.by, 'byName', d.by_name, 'role', d.role)
FROM (
  SELECT DISTINCT ON (x.invited_phone) x.invited_phone, x.code, x.created_at,
    CASE WHEN x.started_by='SELLER' THEN x.seller_id ELSE x.buyer_id END AS by,
    (SELECT COALESCE(NULLIF(c.business_name, ''), c.display_name) FROM users c WHERE c.id = CASE WHEN x.started_by='SELLER' THEN x.seller_id ELSE x.buyer_id END) AS by_name,
    CASE WHEN x.started_by='SELLER' THEN 'buyer' ELSE 'seller' END AS role
  FROM deals x WHERE x.invited_phone IS NOT NULL ORDER BY x.invited_phone, x.created_at
) d
WHERE d.invited_phone=u.phone AND u.source IS NULL AND d.created_at <= u.created_at + interval '10 minutes';
