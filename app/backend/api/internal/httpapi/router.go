package httpapi

import "net/http"

const requestBodyLimit = 1 << 20

// NewRouter builds the contract HTTP handler tree without relying on global state.
func NewRouter() http.Handler {
	return NewRouterWithVideoCreation(nil)
}

// NewRouterWithVideoCreation builds the routes with an injected create-video service.
func NewRouterWithVideoCreation(service *VideoCreationService) http.Handler {
	mux := http.NewServeMux()
	RegisterContractRoutesWithVideoCreation(mux, service)
	return withRequestSizeLimit(mux)
}

// RegisterContractRoutes registers the API contract routes onto the provided mux.
func RegisterContractRoutes(mux *http.ServeMux) {
	RegisterContractRoutesWithVideoCreation(mux, nil)
}

func RegisterContractRoutesWithVideoCreation(mux *http.ServeMux, service *VideoCreationService) {
	mux.HandleFunc("GET /api/v1/health", healthHandler)
	if service != nil {
		mux.HandleFunc("POST /api/v1/videos", createVideoHandler(service))
	}
}

func withRequestSizeLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, requestBodyLimit)
		next.ServeHTTP(w, r)
	})
}
