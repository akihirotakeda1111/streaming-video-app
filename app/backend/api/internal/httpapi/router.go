package httpapi

import "net/http"

const requestBodyLimit = 1 << 20

// NewRouter builds the contract HTTP handler tree without relying on global state.
func NewRouter() http.Handler {
	mux := http.NewServeMux()
	RegisterContractRoutes(mux)
	return withRequestSizeLimit(mux)
}

// RegisterContractRoutes registers the API contract routes onto the provided mux.
func RegisterContractRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/health", healthHandler)
}

func withRequestSizeLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, requestBodyLimit)
		next.ServeHTTP(w, r)
	})
}

