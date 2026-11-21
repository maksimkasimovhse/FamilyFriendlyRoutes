package httpapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

// Real Python parser (offline fallback) and RecSys HTTP, with fixture route distances.
func TestUserJourneyExplicitWalkingLimit(t *testing.T) {
	modelURL, parserURL := os.Getenv("MVP_MODEL_URL"), os.Getenv("MVP_PARSER_URL")
	if modelURL == "" || parserURL == "" {
		t.Skip("run scripts/check_recsys.py")
	}
	store, err := tripstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../examples/trip-one-day.json")
	if err != nil {
		t.Fatal(err)
	}
	var input c.TripInput
	if err = json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	text := "На прогулку один час"
	input.RequestText = &text
	policy := "ranked_prefix"
	input.PlanningPolicy = &policy
	source := planner.HTTPSource{Endpoint: modelURL + "/internal/v1/recommendations", Version: "city-enriched-v3", Token: os.Getenv("ML_API_TOKEN")}
	language := assistant.HTTPInterpreter{Endpoint: parserURL + "/internal/v1/assistant-intents", Token: os.Getenv("ML_API_TOKEN")}
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	handler := tripHandlerWithAssistant(store, planner.Planner{Router: dayRouter{}, Source: source, Interpreter: language}, func() time.Time { return now }, language, nil)
	browser := bootstrap(t, handler)
	created := request(handler, browser, "POST", "/api/v1/trips", body(t, input), "limit-create")
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var draft c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &draft)
	path := "/api/v1/trips/" + string(draft.TripID)
	picks := request(handler, browser, "POST", path+"/planning-options", body(t, map[string]any{"expected_version": draft.Version}), "")
	if picks.Code != 200 {
		t.Fatal(picks.Body.String())
	}
	preview := request(handler, browser, "POST", path+"/previews", body(t, map[string]any{"expected_version": draft.Version, "command": map[string]any{"kind": "generate_plan"}, "current_position": nil, "observed_at": nil}), "")
	if preview.Code != 201 {
		t.Fatal(preview.Body.String())
	}
	var result c.PlanPreview
	_ = json.Unmarshal(preview.Body.Bytes(), &result)
	day := result.ProposedTrip.Days[0]
	if day.Totals.ElapsedDurationSec == nil || *day.Totals.ElapsedDurationSec > 3600 {
		t.Fatalf("explicit limit ignored: %+v", day.Totals)
	}
	if result.ProposedTrip.Input.Days[0].DurationBudgetSec != 3600 {
		t.Fatal("time limit did not reach trip input")
	}
	current := request(handler, browser, "GET", path, "", "")
	var unchanged c.TripView
	_ = json.Unmarshal(current.Body.Bytes(), &unchanged)
	if unchanged.Version != draft.Version || unchanged.Input.Days[0].MaxWalkDistanceM != nil {
		t.Fatal("preview changed saved draft")
	}
}
