FROM rust:1.98.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends postgresql ffmpeg python3-yaml python3-jsonschema \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
