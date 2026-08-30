package bootstrap

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
)

type Dependencies struct {
	Server HTTPServer
}

type Runtime struct {
	Config       config.Config
	Dependencies Dependencies
}

type HTTPServer interface {
	ListenAndServe() error
	Shutdown(context.Context) error
}

func New(cfg config.Config, deps Dependencies) *Runtime {
	return &Runtime{
		Config:       cfg,
		Dependencies: deps,
	}
}

func (r *Runtime) Start(ctx context.Context) error {
	if r.Dependencies.Server == nil {
		return errors.New("http server dependency is required")
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- r.Dependencies.Server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if err := r.Dependencies.Server.Shutdown(shutdownCtx); err != nil {
			return err
		}

		err := <-errCh
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
