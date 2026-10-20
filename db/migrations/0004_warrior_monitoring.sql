BEGIN;
CREATE TABLE warrior_outbox (
 id uuid PRIMARY KEY,
 component_id text NOT NULL CHECK(component_id ~ '^opm_[a-f0-9]{24}$'),
 envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),
 coalesce_key text UNIQUE,
 created_at timestamptz NOT NULL,
 available_at timestamptz NOT NULL,
 deadline timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','claimed','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 claim_token uuid,
 lease_until timestamptz,
 CHECK((state='claimed')=(claim_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(deadline=created_at+interval '23 hours')
);
CREATE INDEX warrior_outbox_due_idx ON warrior_outbox(available_at) WHERE state IN ('pending','claimed');
CREATE TABLE warrior_monitor_state (
 id integer PRIMARY KEY CHECK(id=1),
 dropped bigint NOT NULL DEFAULT 0 CHECK(dropped>=0),
 last_ack_at timestamptz,
 last_failure text CHECK(last_failure IN ('transport','rejected','expired','queue_full'))
);
INSERT INTO warrior_monitor_state(id) VALUES (1);
CREATE FUNCTION warrior_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.component_id,NEW.envelope,NEW.coalesce_key,NEW.created_at,NEW.deadline) IS DISTINCT FROM ROW(OLD.id,OLD.component_id,OLD.envelope,OLD.coalesce_key,OLD.created_at,OLD.deadline) OR OLD.state='failed' THEN
  RAISE EXCEPTION 'immutable monitor event' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER warrior_outbox_guard BEFORE UPDATE ON warrior_outbox FOR EACH ROW EXECUTE FUNCTION warrior_outbox_guard();
COMMIT;
