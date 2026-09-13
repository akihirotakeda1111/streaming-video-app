ALTER TABLE jobs
    DROP CONSTRAINT IF EXISTS jobs_terminal_lease_check,
    DROP CONSTRAINT IF EXISTS jobs_attempt_non_negative_check,
    DROP CONSTRAINT IF EXISTS jobs_lease_ownership_check,
    DROP COLUMN IF EXISTS attempt,
    DROP COLUMN IF EXISTS lease_expires_at,
    DROP COLUMN IF EXISTS worker_id;
