package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

// An unavailable new assistant must not intercept or become a dependency of the
// established session/profile/trip/preview/apply API.
func TestAssistantOutagePreservesExistingBackendFlow(t *testing.T) {
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	store, err := tripstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	languageCalls := 0
	language := intentFunc(func(context.Context, string, string, any) (assistant.Intent, error) {
		languageCalls++
		return assistant.Intent{}, assistant.ErrUnavailable
	})
	dependency := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request c.RecommendationRequest
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("bad recommendation body")
		}
		view := planner.NewDraft(request.TripID, c.TripInput{Family: request.Profile, Days: request.Days}, now)
		view.Version = request.TripVersion
		view.CatalogVersion = request.CatalogVersion
		// An empty pool is a legitimate deterministic response and still produces a preview.
		_ = json.NewEncoder(w).Encode(c.RecommendationResponse{ContractVersion: "1.0", RequestID: request.RequestID, TripID: view.TripID, TripVersion: view.Version, CatalogVersion: view.CatalogVersion, ModelVersion: "legacy-fixture", GeneratedAt: c.Instant(now.Format(time.RFC3339)), Status: "no_candidates", Candidates: []c.Candidate{}, Evidence: []c.Evidence{}, Warnings: []c.Warning{}})
	}))
	defer dependency.Close()
	p := planner.Planner{Router: dayRouter{}, Source: planner.HTTPSource{Endpoint: dependency.URL, Version: "mock-ml-v1"}}
	handler := tripHandlerWithAssistant(store, p, func() time.Time { return now }, language, nil)
	b := bootstrap(t, handler)
	for _, path := range []string{"/api/v1/reference-data", "/api/v1/trips"} {
		w := request(handler, b, "GET", path, "", "")
		if w.Code != 200 {
			t.Fatalf("legacy %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	health := request(handler, b, "GET", "/healthz", "", "")
	if health.Code != 200 || health.Header().Get("X-Family-Routes-Service") != "backend" {
		t.Fatal("backend identity missing")
	}
	raw, _ := os.ReadFile("../../examples/trip-one-day.json")
	var input c.TripInput
	_ = json.Unmarshal(raw, &input)
	text := "Любим музеи"
	input.RequestText = &text
	created := request(handler, b, "POST", "/api/v1/trips", body(t, input), "legacy-create")
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var view c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &view)
	path := "/api/v1/trips/" + string(view.TripID)
	reply := request(handler, b, "POST", path+"/previews", body(t, map[string]any{"expected_version": view.Version, "command": map[string]string{"kind": "generate_plan"}, "current_position": nil, "observed_at": nil}), "")
	if reply.Code != 201 || languageCalls != 0 {
		t.Fatalf("legacy planning depends on LLM: status=%d calls=%d body=%s", reply.Code, languageCalls, reply.Body.String())
	}
	failed := request(handler, b, "POST", path+"/assistant/messages", body(t, map[string]any{"expected_version": view.Version, "message": "Помоги", "current_position": nil, "observed_at": nil}), "assistant-down")
	// Drafts without a saved plan require planning first, not an LLM call.
	if failed.Code != 422 {
		t.Fatal(failed.Code, failed.Body.String())
	}
	if w := request(handler, b, "GET", path, "", ""); w.Code != 200 {
		t.Fatal("assistant broke trip reads")
	}
	// An existing session with bad CSRF keeps its original protection.
	bad := b
	bad.csrf = "wrong"
	if w := request(handler, bad, "POST", "/api/v1/trips", body(t, input), "bad-csrf"); w.Code != 403 {
		t.Fatal("legacy CSRF protection changed")
	}
}
