ALTER TABLE jobs
    ADD COLUMN mode text,
    ADD COLUMN published_manifest_key text;

UPDATE jobs SET mode = 'cli' WHERE mode IS NULL;

ALTER TABLE jobs
    ADD CONSTRAINT jobs_mode_check CHECK (mode IS NULL OR mode IN ('cli', 'distributed'));
