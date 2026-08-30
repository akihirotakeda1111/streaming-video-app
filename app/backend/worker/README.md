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
