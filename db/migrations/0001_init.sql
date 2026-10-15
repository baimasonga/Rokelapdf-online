-- 0001_init: identity mirror, workspaces, roles, plans, audit, rate limits.
-- Conventions: ids are application-generated prefixed opaque text (org_…); users.id is the Supabase Auth user id
-- (uuid as text). Secrets are stored only as hashes. Timestamps are timestamptz.

BEGIN;

-- Mirror of Supabase Auth users, upserted from verified access tokens. Never a source of authentication.
CREATE TABLE users (
  id              text PRIMARY KEY CHECK (id ~ '^[0-9a-f-]{36}$'),
  email           text NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  email_verified  boolean NOT NULL,
  is_operator     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX users_email_uq ON users (email);

CREATE TABLE organizations (
  id          text PRIMARY KEY CHECK (id ~ '^org_[0-9a-f]{24}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind        text NOT NULL CHECK (kind IN ('personal','team')),
  created_at  timestamptz NOT NULL
);

CREATE TABLE memberships (
  org_id      text NOT NULL REFERENCES organizations(id),
  user_id     text NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

-- Plan entitlements per workspace, set only by operators (share_* keys; see docs/sharing.md).
CREATE TABLE org_plans (
  org_id        text PRIMARY KEY REFERENCES organizations(id),
  plan          text NOT NULL CHECK (length(plan) BETWEEN 1 AND 60),
  entitlements  jsonb NOT NULL CHECK (jsonb_typeof(entitlements) = 'object'),
  updated_at    timestamptz NOT NULL,
  updated_by    text NOT NULL REFERENCES users(id),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500)
);

-- Append-only audit log. The application role may only insert and read (see db/grants.ts); the trigger stops even
-- the owner from editing history by accident.
CREATE TABLE audit_events (
  seq          bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL,
  actor_type   text NOT NULL CHECK (actor_type IN ('user','system','anonymous','operator')),
  actor_id     text,
  action       text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type  text,
  target_id    text,
  org_id       text,
  reason       text CHECK (length(reason) <= 500),
  metadata     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_org ON audit_events (org_id, seq DESC);
CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- Fixed-window rate-limit counters shared by every instance.
CREATE TABLE rate_limits (
  key           text NOT NULL CHECK (length(key) <= 200),
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);

COMMIT;
