package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPInterpreterContractAuthenticationAndFailures(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		id     string
		want   error
	}{{"valid", 200, "request-1", nil}, {"wrong request", 200, "another-request", ErrContract}, {"malformed intent", 502, "", ErrContract}, {"unavailable", 503, "", ErrUnavailable}} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer service-token" || r.Header.Get("Content-Type") != "application/json" {
					t.Error("missing internal request authentication")
				}
				var payload struct {
					ContractVersion string         `json:"contract_version"`
					RequestID       string         `json:"request_id"`
					Message         string         `json:"message"`
					Context         map[string]any `json:"context"`
				}
				if json.NewDecoder(r.Body).Decode(&payload) != nil || payload.ContractVersion != "1.0" || payload.RequestID != "request-1" || payload.Message != "Хотим поесть" || payload.Context["selected_date"] != "2030-06-15" {
					t.Error("context was not transported")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"contract_version": "1.0", "request_id": test.id, "intent": map[string]any{"action": "find_places", "needs": []map[string]string{{"kind": "food", "urgency": "now", "evidence": "Хотим поесть"}}}})
			}))
			defer server.Close()
			client := HTTPInterpreter{Endpoint: server.URL, Token: "service-token"}
			intent, err := client.Interpret(context.Background(), "request-1", "Хотим поесть", map[string]any{"selected_date": "2030-06-15"})
			if !errors.Is(err, test.want) {
				t.Fatalf("want %v got %v", test.want, err)
			}
			if err == nil && (intent.Action != "find_places" || len(intent.Needs) != 1 || intent.Needs[0].Kind != "food") {
				t.Fatal("intent was not decoded")
			}
		})
	}
}
