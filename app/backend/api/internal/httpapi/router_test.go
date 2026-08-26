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

	t.Run("malformed", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(`{"name":`))

		handler.ServeHTTP(rr, req)

		assertErrorResponse(t, rr, http.StatusBadRequest, "malformed_json")
	})

	t.Run("too_large", func(t *testing.T) {
		rr := httptest.NewRecorder()
		body := `{"name":"` + strings.Repeat("a", requestBodyLimit) + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(body))

		handler.ServeHTTP(rr, req)

		assertErrorResponse(t, rr, http.StatusRequestEntityTooLarge, "request_too_large")
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
	if resp.Error.Code != wantCode {
		t.Fatalf("error.code = %q, want %q", resp.Error.Code, wantCode)
	}
	if resp.Error.Message == "" {
		t.Fatal("error.message is empty")
	}
}

