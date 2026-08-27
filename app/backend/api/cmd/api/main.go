// Command api is the Phase 1 Go API executable.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
)

const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 15 * time.Second
	writeTimeout      = 30 * time.Second
	idleTimeout       = 60 * time.Second
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.LookupEnv, defaultRuntimeFactories()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, lookupEnv config.LookupEnvFunc, factories runtimeFactories) error {
	cfg, err := config.Load(lookupEnv)
	if err != nil {
		return err
	}

	runtime, db, err := buildRuntime(ctx, cfg, factories)
	if err != nil {
		return err
	}
	defer db.Close()

	return runtime.Start(ctx)
}
