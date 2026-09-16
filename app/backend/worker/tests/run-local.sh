#!/bin/bash
# Dedicated, disposable PostgreSQL instances; never use a shared database.
set -euo pipefail
root=$(mktemp -d /tmp/worker-runtime.XXXXXX)
pgbin=/usr/lib/postgresql/15/bin
cleanup() {
  for name in valid expired; do
    if test -f "$root/$name/postmaster.pid"; then
      runuser -u postgres -- "$pgbin/pg_ctl" -D "$root/$name" -m immediate stop >/dev/null
    fi
  done
  rm -rf -- "$root"
}
trap cleanup EXIT
chmod 755 "$root"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$root/ca.key" -out "$root/ca.pem" -days 2 -subj /CN=WorkerTestCA >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$root/server.key" -out "$root/server.csr" -subj /CN=localhost >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n' > "$root/extensions"
openssl x509 -req -in "$root/server.csr" -CA "$root/ca.pem" -CAkey "$root/ca.key" -CAcreateserial -out "$root/valid.pem" -days 2 -extfile "$root/extensions" >/dev/null 2>&1
openssl x509 -req -in "$root/server.csr" -CA "$root/ca.pem" -CAkey "$root/ca.key" -CAcreateserial -out "$root/expired.pem" -days -1 -extfile "$root/extensions" >/dev/null 2>&1
port=55432
for name in valid expired; do
  mkdir "$root/$name"
  chown postgres:postgres "$root/$name"
  runuser -u postgres -- "$pgbin/initdb" -D "$root/$name" -A trust >/dev/null
  cp "$root/$name.pem" "$root/$name/server.crt"
  cp "$root/server.key" "$root/$name/server.key"
  chown postgres:postgres "$root/$name/server.key" "$root/$name/server.crt"
  chmod 600 "$root/$name/server.key"
  runuser -u postgres -- "$pgbin/pg_ctl" -D "$root/$name" -l "$root/$name/server.log" -o "-p $port -h 127.0.0.1 -c ssl=on" -w start >/dev/null
  port=$((port + 1))
done
export WORKER_RUNTIME_MODE=local
export TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55432/postgres?sslmode=disable'
export TEST_TLS_DATABASE_URL='postgres://postgres@localhost:55432/postgres?sslmode=verify-full'
export TEST_TLS_WRONG_HOST_URL='postgres://postgres@127.0.0.1:55432/postgres?sslmode=verify-full'
export TEST_TLS_EXPIRED_URL='postgres://postgres@localhost:55433/postgres?sslmode=verify-full'
export TEST_TLS_CA_CERT="$root/ca.pem"
cargo test --locked --manifest-path app/backend/worker/Cargo.toml
cargo test --locked --manifest-path app/backend/worker/Cargo.toml --test tls_database -- --ignored
cargo test --locked --manifest-path app/backend/worker/Cargo.toml -p encoding --test media_limits -- --ignored
cargo test --locked --manifest-path app/backend/worker/Cargo.toml -p worker --bin worker sigterm_stops_receive_and_terminates_real_ffmpeg -- --ignored
python3 app/scripts/validate_contracts.py
