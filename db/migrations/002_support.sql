-- Messages people send through "Talk to a person". A human answers them from the admin API.
CREATE TABLE IF NOT EXISTS support_requests (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  phone       TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS support_requests_open ON support_requests (created_at) WHERE status = 'OPEN';
