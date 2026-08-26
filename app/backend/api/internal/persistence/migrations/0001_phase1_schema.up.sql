CREATE TABLE videos (
    video_id uuid PRIMARY KEY,
    file_name text NOT NULL,
    content_type text NOT NULL CHECK (content_type = 'video/mp4'),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    upload_bucket text NOT NULL,
    upload_key text NOT NULL,
    upload_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    video_id uuid NOT NULL UNIQUE REFERENCES videos(video_id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('UPLOADING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED')),
    failure_code text,
    failure_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT jobs_failure_details_check CHECK (
        (status = 'FAILED' AND failure_code IS NOT NULL AND failure_message IS NOT NULL)
        OR
        (status <> 'FAILED' AND failure_code IS NULL AND failure_message IS NULL)
    )
);

CREATE INDEX jobs_status_idx ON jobs (status);
