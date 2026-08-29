package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewRouterHealthEndpoint(t *testing.T) {
	handler := NewRouter()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if got := rr.Header().Get("Content-Type"); got != jsonContentType {
		t.Fatalf("Content-Type = %q, want %q", got, jsonContentType)
	}

	var resp HealthResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal health response: %v", err)
	}
	if resp.Status != "ok" {
		t.Fatalf("Status = %q, want %q", resp.Status, "ok")
	}
}

func TestRegisterContractRoutesIsolated(t *testing.T) {
	first := http.NewServeMux()
	RegisterContractRoutes(first)

	second := http.NewServeMux()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)

	firstRR := httptest.NewRecorder()
	first.ServeHTTP(firstRR, req)
	if firstRR.Code != http.StatusOK {
		t.Fatalf("registered mux status = %d, want %d", firstRR.Code, http.StatusOK)
	}

	secondRR := httptest.NewRecorder()
	second.ServeHTTP(secondRR, req)
	if secondRR.Code != http.StatusNotFound {
		t.Fatalf("unregistered mux status = %d, want %d", secondRR.Code, http.StatusNotFound)
	}
}

func TestWithCORSAllowsOnlyConfiguredOrigin(t *testing.T) {
	const allowedOrigin = "http://localhost:5173"
	handler := WithCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), allowedOrigin)

	t.Run("preflight", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/api/v1/videos", nil)
		req.Header.Set("Origin", allowedOrigin)
		req.Header.Set("Access-Control-Request-Method", http.MethodPost)
		req.Header.Set("Access-Control-Request-Headers", "content-type")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != allowedOrigin {
			t.Fatalf("Access-Control-Allow-Origin = %q", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Methods"); got != corsAllowedMethods {
			t.Fatalf("Access-Control-Allow-Methods = %q", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Headers"); got != corsAllowedHeaders {
			t.Fatalf("Access-Control-Allow-Headers = %q", got)
		}
	})

	t.Run("actual request", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/videos", nil)
		req.Header.Set("Origin", allowedOrigin)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != allowedOrigin {
			t.Fatalf("Access-Control-Allow-Origin = %q", got)
		}
	})

	t.Run("different origin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/videos", nil)
		req.Header.Set("Origin", "https://example.invalid")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("Access-Control-Allow-Origin = %q, want empty", got)
		}
	})
}

func TestDecodeJSONAndBodyLimit(t *testing.T) {
	handler := withRequestSizeLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Name string `json:"name"`
		}
		if !decodeJSON(w, r, &payload) {
			return
		}
		_ = writeJSON(w, http.StatusCreated, payload)
	}))

	t.Run("valid", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(`{"name":"ok"}`))

		handler.ServeHTTP(rr, req)

		if rr.Code != http.StatusCreated {
			t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("empty body", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(""))

		handler.ServeHTTP(rr, req)

		assertErrorResponse(t, rr, http.StatusBadRequest, "INVALID_REQUEST")
	})

	t.Run("malformed", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(`{"name":`))

		handler.ServeHTTP(rr, req)

		assertErrorResponse(t, rr, http.StatusBadRequest, "INVALID_REQUEST")
	})

	t.Run("concatenated objects", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(`{"name":"one"}{"name":"two"}`))

		handler.ServeHTTP(rr, req)

		assertErrorResponse(t, rr, http.StatusBadRequest, "INVALID_REQUEST")
	})

	t.Run("trailing junk after valid json", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(`{"name":"ok"} not-json`))

		handler.ServeHTTP(rr, req)

		assertErrorResponse(t, rr, http.StatusBadRequest, "INVALID_REQUEST")
	})

	t.Run("too_large", func(t *testing.T) {
		rr := httptest.NewRecorder()
		body := `{"name":"` + strings.Repeat("a", requestBodyLimit) + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(body))

		handler.ServeHTTP(rr, req)

		assertErrorResponse(t, rr, http.StatusBadRequest, "INVALID_REQUEST")
	})
}

func assertErrorResponse(t *testing.T, rr *httptest.ResponseRecorder, wantStatus int, wantCode string) {
	t.Helper()

	if rr.Code != wantStatus {
		t.Fatalf("status = %d, want %d", rr.Code, wantStatus)
	}
	if got := rr.Header().Get("Content-Type"); got != jsonContentType {
		t.Fatalf("Content-Type = %q, want %q", got, jsonContentType)
	}

	var resp ErrorResponse
	data, err := io.ReadAll(rr.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("unmarshal error response: %v", err)
	}
	if resp.Code != wantCode {
		t.Fatalf("code = %q, want %q", resp.Code, wantCode)
	}
	if resp.Message == "" {
		t.Fatal("message is empty")
	}
}
