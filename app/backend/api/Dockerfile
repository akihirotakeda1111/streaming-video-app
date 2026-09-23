# syntax=docker/dockerfile:1
FROM golang:1.25.1-bookworm AS builder
WORKDIR /source
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/video-api ./cmd/api

FROM debian:bookworm-20250811-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 api
RUN mkdir -p /app/certs \
    && curl --fail --silent --show-error --location --retry 3 \
       https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
       -o /app/certs/rds-global-bundle.pem \
    && test -s /app/certs/rds-global-bundle.pem \
    && chmod 0644 /app/certs/rds-global-bundle.pem
COPY --from=builder /out/video-api /usr/local/bin/video-api
COPY internal/persistence/migrations /app/migrations
USER api
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/video-api"]
