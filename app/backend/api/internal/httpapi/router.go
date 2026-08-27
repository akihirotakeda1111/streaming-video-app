package httpapi

import (
	"net/http"

	"github.com/akihirotakeda1111/streaming-video-app/backend/api/internal/persistence"
)

const requestBodyLimit = 1 << 20

// NewRouter builds the contract HTTP handler tree without relying on global state.
func NewRouter() http.Handler {
	return NewRouterWithVideoCreation(nil)
}

// NewRouterWithVideoCreation builds the routes with an injected create-video service.
func NewRouterWithVideoCreation(service *VideoCreationService) http.Handler {
	return NewRouterWithServices(service, nil)
}

// NewRouterWithServices builds the routes with the injected API services.
func NewRouterWithServices(creation *VideoCreationService, status *VideoStatusService) http.Handler {
	mux := http.NewServeMux()
	RegisterContractRoutesWithServices(mux, creation, status)
	return withRequestSizeLimit(mux)
}

// RegisterContractRoutes registers the API contract routes onto the provided mux.
func RegisterContractRoutes(mux *http.ServeMux) {
	RegisterContractRoutesWithVideoCreation(mux, nil)
}

func RegisterContractRoutesWithVideoCreation(mux *http.ServeMux, service *VideoCreationService) {
	RegisterContractRoutesWithServices(mux, service, nil)
}

// RegisterContractRoutesWithServices registers the API routes onto a mux.
func RegisterContractRoutesWithServices(mux *http.ServeMux, creation *VideoCreationService, status *VideoStatusService) {
	mux.HandleFunc("GET /api/v1/health", healthHandler)
	if creation != nil {
		mux.HandleFunc("POST /api/v1/videos", createVideoHandler(creation))
	}
	if status != nil {
		mux.HandleFunc("GET /api/v1/videos/{videoId}", getVideoHandler(status))
	}
}

// NewRouterWithVideoStatus builds the routes needed to read video status.
func NewRouterWithVideoStatus(repo persistence.Repository) http.Handler {
	return NewRouterWithServices(nil, NewVideoStatusService(repo))
}

func withRequestSizeLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, requestBodyLimit)
		next.ServeHTTP(w, r)
	})
}
