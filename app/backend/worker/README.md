# Phase 1 worker container

Build from this directory so the Cargo workspace is the Docker build context:

```sh
docker build -t streaming-video-worker:phase1 .
```

The image copies both `/usr/local/bin/ffmpeg` and
`/usr/local/bin/ffprobe` from the explicitly pinned
`mwader/static-ffmpeg:7.1.1` image. `FFMPEG_PATH` defaults to the former;
`ffprobe` is available on `PATH`. The worker runs as the unprivileged `worker`
user and receives its remaining required configuration through environment
variables.

The heartbeat interval must be at most half both the lease duration and visibility
extension. The source queue visibility timeout must retain the same margin.
PostgreSQL driver termination stops receipt and cancels in-flight work through
the bounded shutdown path, then exits with status 1. Run the worker with a restart
policy (as in Compose) so it establishes a fresh connection after a database outage.
