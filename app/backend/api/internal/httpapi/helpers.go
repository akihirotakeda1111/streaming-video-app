package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

const jsonContentType = "application/json; charset=utf-8"

type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}

type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type HealthResponse struct {
	Status string `json:"status"`
}

func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", jsonContentType)
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	_ = writeJSON(w, status, ErrorResponse{
		Error: ErrorDetail{
			Code:    code,
			Message: message,
		},
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	if err := dec.Decode(dst); err != nil {
		if isBodyTooLarge(err) {
			writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "request body is too large")
			return false
		}
		writeError(w, http.StatusBadRequest, "malformed_json", "request body must be valid JSON")
		return false
	}

	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			writeError(w, http.StatusBadRequest, "malformed_json", "request body must contain a single JSON object")
			return false
		}
		if isBodyTooLarge(err) {
			writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "request body is too large")
			return false
		}
		writeError(w, http.StatusBadRequest, "malformed_json", "request body must be valid JSON")
		return false
	}

	return true
}

func isBodyTooLarge(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return false
	}
	return strings.Contains(err.Error(), "http: request body too large")
}
