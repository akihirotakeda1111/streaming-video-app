package httpapi

import "net/http"

func healthHandler(w http.ResponseWriter, r *http.Request) {
	_ = writeJSON(w, http.StatusOK, HealthResponse{Status: "ok"})
}

