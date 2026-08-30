# syntax=docker/dockerfile:1
FROM golang:1.25.1-bookworm AS builder
WORKDIR /source
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/video-api ./cmd/api

FROM debian:bookworm-20250811-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 api
COPY --from=builder /out/video-api /usr/local/bin/video-api
USER api
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/video-api"]
