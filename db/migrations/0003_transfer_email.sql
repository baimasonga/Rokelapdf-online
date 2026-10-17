-- 0003_transfer_email: transfers can be emailed to recipients (one personal link each). Adds the background job that
-- sends those emails and the monthly counter that caps them. The link token is never stored in the job; it is
-- derived again when the email is sent.

BEGIN;

ALTER TABLE share_jobs DROP CONSTRAINT share_jobs_kind_check;
ALTER TABLE share_jobs ADD CONSTRAINT share_jobs_kind_check CHECK (kind IN ('scan','delete_blob','notify_email','share_email'));

ALTER TABLE share_usage DROP CONSTRAINT share_usage_metric_check;
ALTER TABLE share_usage ADD CONSTRAINT share_usage_metric_check
  CHECK (metric IN ('bandwidth_bytes','api_requests','processing_bytes','upload_bytes','emails_sent'));

COMMIT;
