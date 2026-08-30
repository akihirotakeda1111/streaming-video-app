package bootstrap

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/config"
)

func TestRuntimeStartShutsDownOnContextCancel(t *testing.T) {
	server := newFakeHTTPServer(http.ErrServerClosed, nil)

	rt := New(config.Config{HTTPAddr: "127.0.0.1:0"}, Dependencies{Server: server})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- rt.Start(ctx)
	}()

	waitListen(t, server)
	cancel()
	if err := waitStart(t, done); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if !server.shutdownCalled {
		t.Fatal("Shutdown() was not called")
	}
}

func TestRuntimeStartReturnsListenAndServeError(t *testing.T) {
	want := errors.New("bind: address already in use")
	server := &fakeHTTPServer{listenErr: want}

	err := New(config.Config{HTTPAddr: "127.0.0.1:0"}, Dependencies{Server: server}).Start(context.Background())
	if !errors.Is(err, want) {
		t.Fatalf("Start() error = %v, want %v", err, want)
	}
	if server.shutdownCalled {
		t.Fatal("Shutdown() was called after listen failure")
	}
}

func TestRuntimeStartReturnsShutdownError(t *testing.T) {
	want := errors.New("graceful shutdown failed")
	server := newFakeHTTPServer(http.ErrServerClosed, want)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- New(config.Config{HTTPAddr: "127.0.0.1:0"}, Dependencies{Server: server}).Start(ctx)
	}()

	waitListen(t, server)
	cancel()
	err := waitStart(t, done)
	if !errors.Is(err, want) {
		t.Fatalf("Start() error = %v, want %v", err, want)
	}
	if !server.shutdownCalled {
		t.Fatal("Shutdown() was not called")
	}
}

func TestRuntimeStartReturnsListenErrorAfterShutdown(t *testing.T) {
	want := errors.New("listener closed unexpectedly")
	server := newFakeHTTPServer(want, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- New(config.Config{HTTPAddr: "127.0.0.1:0"}, Dependencies{Server: server}).Start(ctx)
	}()

	waitListen(t, server)
	cancel()
	err := waitStart(t, done)
	if !errors.Is(err, want) {
		t.Fatalf("Start() error = %v, want listen error after cancel", err)
	}
	if !server.shutdownCalled {
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

func waitListen(t *testing.T, server *fakeHTTPServer) {
	t.Helper()
	select {
	case <-server.listenStarted:
	case <-time.After(time.Second):
		t.Fatal("server did not start")
	}
}

func waitStart(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(time.Second):
		t.Fatal("Start() did not return")
		return nil
	}
}

type fakeHTTPServer struct {
	listenStarted  chan struct{}
	shutdownCh     chan struct{}
	listenErr      error
	shutdownErr    error
	shutdownOnce   sync.Once
	shutdownCalled bool
}

func newFakeHTTPServer(listenErr, shutdownErr error) *fakeHTTPServer {
	return &fakeHTTPServer{
		listenStarted: make(chan struct{}),
		shutdownCh:    make(chan struct{}),
		listenErr:     listenErr,
		shutdownErr:   shutdownErr,
	}
}

func (s *fakeHTTPServer) ListenAndServe() error {
	if s.listenStarted != nil {
		close(s.listenStarted)
	}
	if s.shutdownCh != nil {
		<-s.shutdownCh
	}
	if s.listenErr != nil {
		return s.listenErr
	}
	return http.ErrServerClosed
}

func (s *fakeHTTPServer) Shutdown(context.Context) error {
	s.shutdownCalled = true
	s.shutdownOnce.Do(func() {
		if s.shutdownCh != nil {
			close(s.shutdownCh)
		}
	})
	return s.shutdownErr
}
