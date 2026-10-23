-- Team members join by accepting an invitation instead of being added directly, so nobody is placed in a workspace
-- without agreeing and the invite form no longer reveals whether an address has an account. The invitee proves the
-- address by signing in with it confirmed; the invitation email is sent by the job worker.
BEGIN;

CREATE TABLE member_invitations (
  id            text PRIMARY KEY CHECK (id ~ '^inv_[0-9a-f]{24}$'),
  org_id        text NOT NULL REFERENCES organizations(id),
  email         text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  role          text NOT NULL CHECK (role IN ('owner','admin','member')),
  invited_by    text NOT NULL REFERENCES users(id),
  status        text NOT NULL CHECK (status IN ('pending','accepted','declined','cancelled','expired')),
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL CHECK (expires_at > created_at),
  responded_at  timestamptz
);
CREATE UNIQUE INDEX member_invitations_pending ON member_invitations (org_id, email) WHERE status = 'pending';
CREATE INDEX member_invitations_invitee ON member_invitations (email) WHERE status = 'pending';

ALTER TABLE share_jobs DROP CONSTRAINT share_jobs_kind_check;
ALTER TABLE share_jobs ADD CONSTRAINT share_jobs_kind_check CHECK (kind IN ('scan','delete_blob','notify_email','share_email','member_invite'));

COMMIT;
