// Command api is the Phase 1 Go API executable.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/bootstrap"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/httpapi"
)

const (
	readHeaderTimeout = 10 * time.Second
	writeTimeout      = 30 * time.Second
	idleTimeout       = 60 * time.Second
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.LookupEnv, bootstrap.Dependencies{}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, lookupEnv config.LookupEnvFunc, deps bootstrap.Dependencies) error {
	cfg, err := config.Load(lookupEnv)
	if err != nil {
		return err
	}

	if deps.Server == nil {
		deps.Server = &http.Server{
			Addr:              cfg.HTTPAddr,
			Handler:           httpapi.NewRouter(),
			ReadHeaderTimeout: readHeaderTimeout,
			WriteTimeout:      writeTimeout,
			IdleTimeout:       idleTimeout,
		}
	}

	return bootstrap.New(cfg, deps).Start(ctx)
}
