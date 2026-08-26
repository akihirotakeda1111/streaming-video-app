package bootstrap

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
)

func TestRuntimeStartShutsDownOnContextCancel(t *testing.T) {
	server := &fakeHTTPServer{
		listenStarted: make(chan struct{}),
		shutdownCalled: make(chan struct{}),
	}

	rt := New(config.Config{HTTPAddr: "127.0.0.1:0"}, Dependencies{Server: server})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- rt.Start(ctx)
	}()

	select {
	case <-server.listenStarted:
	case <-time.After(time.Second):
		t.Fatal("server did not start")
	}

	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Start() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Start() did not return")
	}

	select {
	case <-server.shutdownCalled:
	default:
		t.Fatal("Shutdown() was not called")
	}
}

func TestRuntimeStartRequiresServer(t *testing.T) {
	rt := New(config.Config{}, Dependencies{})

	err := rt.Start(context.Background())
	if err == nil {
		t.Fatal("Start() error = nil, want failure")
	}
	if err.Error() == "" {
		t.Fatal("Start() returned an empty error")
	}
}

type fakeHTTPServer struct {
	listenStarted  chan struct{}
	shutdownCalled chan struct{}
}

func (s *fakeHTTPServer) ListenAndServe() error {
	close(s.listenStarted)
	<-s.shutdownCalled
	return http.ErrServerClosed
}

func (s *fakeHTTPServer) Shutdown(context.Context) error {
	close(s.shutdownCalled)
	return nil
}
