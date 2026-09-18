ALTER TABLE jobs
    DROP CONSTRAINT jobs_mode_check,
    DROP COLUMN published_manifest_key,
    DROP COLUMN mode;
