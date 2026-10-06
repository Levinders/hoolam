-- The staff console: staff accounts, sessions, invites, settings, notes, and an audit trail of every action.

CREATE TABLE IF NOT EXISTS staff (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'FINANCE', 'SUPPORT')),
  password_hash   TEXT,                      -- scrypt; null until the invite is accepted
  totp_secret     TEXT,                      -- base32; two-step login code
  totp_enabled    BOOLEAN NOT NULL DEFAULT false,
  active          BOOLEAN NOT NULL DEFAULT true,
  failed_logins   INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  id          TEXT PRIMARY KEY,               -- sha256 of the cookie value (the raw value is never stored)
  staff_id    UUID NOT NULL REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS staff_sessions_staff ON staff_sessions (staff_id);

CREATE TABLE IF NOT EXISTS staff_invites (
  id          TEXT PRIMARY KEY,               -- sha256 of the invite token
  staff_id    UUID NOT NULL REFERENCES staff(id),
  created_by  UUID REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

-- Who did what, when, and why. Append-only: the console never edits or deletes rows here.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  staff_id     UUID REFERENCES staff(id),       -- null = the system or the admin token
  actor        TEXT NOT NULL,                   -- name shown in the trail (kept even if the staff member is removed)
  action       TEXT NOT NULL,                   -- e.g. deal.release, settings.update, staff.invite
  target_type  TEXT,                            -- deal, payout, user, staff, settings, support
  target_id    TEXT,
  reason       TEXT,
  details      JSONB NOT NULL DEFAULT '{}',
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target ON audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS audit_log_staff ON audit_log (staff_id, at DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- Settings the console can change (fees, limits, timings, switches). Missing keys fall back to Render's environment.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES staff(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Internal notes on a deal (never shown to buyers or sellers).
CREATE TABLE IF NOT EXISTS deal_notes (
  id          BIGSERIAL PRIMARY KEY,
  deal_id     UUID NOT NULL REFERENCES deals(id),
  staff_id    UUID REFERENCES staff(id),
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_notes_deal ON deal_notes (deal_id, id);

-- Controls on a person.
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deal_cap_minor BIGINT CHECK (deal_cap_minor > 0); -- overrides the normal per-deal cap

-- Replies sent from the console to a support request.
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES staff(id);

-- "Mark as handled" on Needs-action items that have no other way to be resolved (e.g. a 👎 rating).
CREATE TABLE IF NOT EXISTS inbox_dismissals (
  item_key    TEXT PRIMARY KEY,
  staff_id    UUID REFERENCES staff(id),
  reason      TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
