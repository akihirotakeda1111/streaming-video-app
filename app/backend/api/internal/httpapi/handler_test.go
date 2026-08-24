package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewHandler(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		method          string
		path            string
		wantStatus      int
		wantContentType string
		wantBody        string
		wantAllow       string
	}{
		{
			name:            "healthz get",
			method:          http.MethodGet,
			path:            "/healthz",
			wantStatus:      http.StatusOK,
			wantContentType: "application/json",
			wantBody:        `{"status":"ok"}` + "\n",
		},
		{
			name:            "videos get",
			method:          http.MethodGet,
			path:            "/api/v1/videos",
			wantStatus:      http.StatusOK,
			wantContentType: "application/json",
			wantBody:        `{"videos":[]}` + "\n",
		},
		{
			name:            "healthz post not allowed",
			method:          http.MethodPost,
			path:            "/healthz",
			wantStatus:      http.StatusMethodNotAllowed,
			wantContentType: "application/json",
			wantBody:        `{"error":"method not allowed"}` + "\n",
			wantAllow:       http.MethodGet,
		},
		{
			name:            "unknown path",
			method:          http.MethodGet,
			path:            "/unknown",
			wantStatus:      http.StatusNotFound,
			wantContentType: "application/json",
			wantBody:        `{"error":"not found"}` + "\n",
		},
	}

	handler := NewHandler()

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(tc.method, tc.path, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if got := rec.Header().Get("Content-Type"); got != tc.wantContentType {
				t.Fatalf("content-type = %q, want %q", got, tc.wantContentType)
			}
			if got := rec.Body.String(); got != tc.wantBody {
				t.Fatalf("body = %q, want %q", got, tc.wantBody)
			}
			if tc.wantAllow != "" {
				if got := rec.Header().Get("Allow"); got != tc.wantAllow {
					t.Fatalf("allow = %q, want %q", got, tc.wantAllow)
				}
			}
		})
	}
}
