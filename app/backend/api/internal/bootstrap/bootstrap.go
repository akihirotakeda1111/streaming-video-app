package bootstrap

import (
	"context"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
)

type Dependencies struct {
	Server     any
	Repository any
}

type Runtime struct {
	Config       config.Config
	Dependencies Dependencies
}

func New(cfg config.Config, deps Dependencies) *Runtime {
	return &Runtime{
		Config:       cfg,
		Dependencies: deps,
	}
}

func (r *Runtime) Start(ctx context.Context) error {
	_ = ctx
	_ = r
	return nil
}
