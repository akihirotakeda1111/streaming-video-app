# syntax=docker/dockerfile:1
FROM mwader/static-ffmpeg:7.1.1 AS media-tools

FROM rust:1.89.0-bookworm AS builder
WORKDIR /source
COPY . .
RUN cargo build --locked --release -p worker

FROM debian:bookworm-20250811-slim
COPY --from=media-tools /ffmpeg /usr/local/bin/ffmpeg
COPY --from=media-tools /ffprobe /usr/local/bin/ffprobe
COPY --from=builder /source/target/release/worker /usr/local/bin/video-worker

ENV FFMPEG_PATH=/usr/local/bin/ffmpeg \
    TMPDIR=/tmp/video-worker
RUN /usr/local/bin/ffmpeg -version && /usr/local/bin/ffprobe -version \
    && useradd --create-home --uid 10001 worker \
    && mkdir -p "$TMPDIR" \
    && chown worker:worker "$TMPDIR"
USER worker
ENTRYPOINT ["/usr/local/bin/video-worker"]
