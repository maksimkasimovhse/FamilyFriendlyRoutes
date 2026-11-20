package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthProbeRejectsPythonOrGenericHealth(t *testing.T) {
	for _, valid := range []bool{false, true} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if valid {
				w.Header().Set("X-Family-Routes-Service", "backend")
			}
			_, _ = w.Write([]byte(`{"status":"alive"}`))
		}))
		err := checkBackendHealth(server.URL)
		server.Close()
		if (err == nil) != valid {
			t.Fatalf("valid=%v error=%v", valid, err)
		}
	}
}
