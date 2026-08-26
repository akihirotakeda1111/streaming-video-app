// Command api is the Phase 1 Go API executable.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/bootstrap"
	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
)

func main() {
	if err := run(context.Background(), os.LookupEnv, bootstrap.Dependencies{}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, lookupEnv config.LookupEnvFunc, deps bootstrap.Dependencies) error {
	cfg, err := config.Load(lookupEnv)
	if err != nil {
		return err
	}

	return bootstrap.New(cfg, deps).Start(ctx)
}
