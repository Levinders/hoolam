-- "Not me" no longer blocks a number for everyone. It only stops the SAME person (the buyer or seller who typed
-- that number) from alerting it again. Everyone else can still send it order alerts.
CREATE TABLE IF NOT EXISTS alert_refusals (
  phone        TEXT NOT NULL,                                  -- the number that said "Not me"
  from_user_id UUID NOT NULL REFERENCES users(id),             -- who alerted it
  deal_code    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (phone, from_user_id)
);
-- carry over who alerted the numbers already blocked, then empty the old for-everyone list
INSERT INTO alert_refusals (phone, from_user_id, deal_code, created_at)
  SELECT o.phone, COALESCE(d.buyer_id, d.seller_id), d.code, o.created_at
  FROM contact_optouts o JOIN deals d ON d.code = substring(o.reason from 'Not me on (HL-[A-Z0-9]+)')
  WHERE COALESCE(d.buyer_id, d.seller_id) IS NOT NULL
  ON CONFLICT DO NOTHING;
DELETE FROM contact_optouts;
