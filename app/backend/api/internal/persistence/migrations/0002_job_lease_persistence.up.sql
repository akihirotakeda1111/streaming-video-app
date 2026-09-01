ALTER TABLE jobs
    ADD COLUMN worker_id text,
    ADD COLUMN lease_expires_at timestamptz,
    ADD COLUMN attempt integer NOT NULL DEFAULT 0;

ALTER TABLE jobs
    ADD CONSTRAINT jobs_lease_ownership_check CHECK (
        (worker_id IS NULL AND lease_expires_at IS NULL)
        OR (worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    ADD CONSTRAINT jobs_attempt_non_negative_check CHECK (attempt >= 0),
    ADD CONSTRAINT jobs_terminal_lease_check CHECK (
        status NOT IN ('COMPLETED', 'FAILED')
        OR (worker_id IS NULL AND lease_expires_at IS NULL)
    );
