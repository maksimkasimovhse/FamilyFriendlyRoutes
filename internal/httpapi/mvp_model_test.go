package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sync/atomic"
	"testing"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

func TestMVPAssistantInitialAndCatalogChoice(t *testing.T) {
	modelURL := os.Getenv("MVP_MODEL_URL")
	if modelURL == "" {
		t.Skip("set MVP_MODEL_URL to a running model-service")
	}
	store, err := tripstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	source := planner.HTTPSource{Endpoint: modelURL + "/internal/v1/recommendations", Version: "city-osm-v2", Token: os.Getenv("ML_API_TOKEN")}
	language := intentFunc(func(ctx context.Context, id, message string, value any) (assistant.Intent, error) {
		contextValue := value.(map[string]any)
		if contextValue["initial"] == true {
			duration := 3600.0
			evidence := "один час"
			return assistant.Intent{Action: "preferences", DurationSec: &duration, DurationEvidence: &evidence, Preferences: json.RawMessage(`{"taxonomy_version":"1.0","claims":[{"kind":"interest","value":"nature","polarity":"prefer","evidence":"Побольше зелени"}],"needs_clarification":false,"clarification_question":null,"unsupported_requests":[]}`)}, nil
		}
		if message == "Хочу научные места" {
			return assistant.Intent{Action: "preferences", Preferences: json.RawMessage(`{"taxonomy_version":"1.0","claims":[{"kind":"interest","value":"science","polarity":"prefer","evidence":"научные места"}],"needs_clarification":false,"clarification_question":null,"unsupported_requests":[]}`)}, nil
		}
		choices := contextValue["choices"].([]map[string]any)
		idValue := choices[1]["place_id"].(c.ID)
		return assistant.Intent{Action: "add_activity", PlaceID: &idValue}, nil
	})
	handler := TripHandlerWithAssistant(store, planner.Planner{Router: dayRouter{}, Source: source, Interpreter: language}, language, nil)
	browser := bootstrap(t, handler)
	raw, _ := os.ReadFile("../../examples/trip-one-day.json")
	var input c.TripInput
	_ = json.Unmarshal(raw, &input)
	text := "Побольше зелени, на прогулку один час"
	input.RequestText = &text
	input.Selections = []c.Selection{}
	zero := 0.0
	input.Days[0].RestBudgetSec = 0
	input.Days[0].MealDurationSec = &zero
	input.LoadLimits.RestaurantWalkReserveMPerDay = &zero
	created := request(handler, browser, "POST", "/api/v1/trips", body(t, input), "language-create")
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var view c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &view)
	path := "/api/v1/trips/" + string(view.TripID)
	previewResponse := request(handler, browser, "POST", path+"/previews", body(t, map[string]any{"expected_version": view.Version, "command": map[string]string{"kind": "generate_plan"}, "current_position": nil, "observed_at": nil}), "")
	if previewResponse.Code != 201 {
		t.Fatal(previewResponse.Body.String())
	}
	var preview c.PlanPreview
	_ = json.Unmarshal(previewResponse.Body.Bytes(), &preview)
	if preview.ProposedTrip.Input.Days[0].DurationBudgetSec != 3600 || !preview.CanApply || len(preview.ProposedTrip.Days[0].Stops) == 0 {
		t.Fatalf("initial understanding not applied: %+v", preview)
	}
	for _, warning := range preview.Warnings {
		if warning.Code == "REQUEST_TEXT_PARTIALLY_UNDERSTOOD" {
			t.Fatal("validated parsed request did not reach the model")
		}
	}
	applyResponse := request(handler, browser, "POST", path+"/previews/"+string(preview.PreviewID)+"/apply", body(t, c.ApplyRequest{ExpectedVersion: preview.BaseVersion, AcknowledgedWarningCodes: preview.RequiredAcknowledgementCodes}), "language-apply")
	if applyResponse.Code != 200 {
		t.Fatal(applyResponse.Body.String())
	}
	_ = json.Unmarshal(applyResponse.Body.Bytes(), &view)
	message := func(text, key string) assistantReply {
		response := request(handler, browser, "POST", path+"/assistant/messages", body(t, map[string]any{"expected_version": view.Version, "message": text, "observed_at": nil, "current_position": nil}), key)
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
		var answer assistantReply
		_ = json.Unmarshal(response.Body.Bytes(), &answer)
		return answer
	}
	found := message("Хочу научные места", "science")
	if len(found.Places) != 3 {
		t.Fatalf("catalog options missing: %+v", found)
	}
	selected := message("Давай второй", "science-select")
	if selected.Preview == nil || len(selected.Preview.Diff.AddedStopIDS) != 1 {
		t.Fatal("catalog selection did not produce a preview")
	}
}

// Real Python recommendation HTTP service + real Go trip/preview/apply logic.
// Only routing uses dayRouter: this check does not claim to verify OSM geometry.
func TestMVPModelPreviewApply(t *testing.T) {
	modelURL := os.Getenv("MVP_MODEL_URL")
	if modelURL == "" {
		t.Skip("set MVP_MODEL_URL to a running model-service, e.g. http://127.0.0.1:18082")
	}
	target, err := url.Parse(modelURL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	var fail atomic.Bool
	proxy.ModifyResponse = func(response *http.Response) error {
		if response.StatusCode != http.StatusOK {
			return nil
		}
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			return err
		}
		_ = response.Body.Close()
		response.Body = io.NopCloser(bytes.NewReader(raw))
		var result c.RecommendationResponse
		if json.Unmarshal(raw, &result) != nil || result.ModelVersion != "city-content-baseline-v1" {
			t.Error("expected the real city content baseline response")
		}
		return nil
	}
	dependency := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "injected dependency outage", http.StatusServiceUnavailable)
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	defer dependency.Close()
	store, err := tripstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	source := planner.HTTPSource{Endpoint: dependency.URL + "/internal/v1/recommendations", Version: "city-osm-v2", Token: os.Getenv("ML_API_TOKEN")}
	handler := TripHandler(store, planner.Planner{Router: dayRouter{}, Source: source})
	browser := bootstrap(t, handler)
	raw, err := os.ReadFile("../../examples/trip-one-day.json")
	if err != nil {
		t.Fatal(err)
	}
	var input c.TripInput
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	input.Selections = []c.Selection{
		{ActivityID: "activity:main:42:visit", PlaceID: "place:main:42", Mandatory: true},
		{ActivityID: "activity:osm:node:11016554438:visit", PlaceID: "place:osm:node:11016554438", Mandatory: true},
	}
	// Exercise partial text handling and acknowledgement across the HTTP boundary.
	wish := "Хотим животных, занятие в 12:00"
	input.RequestText = &wish
	raw, _ = json.Marshal(input)
	created := request(handler, browser, "POST", "/api/v1/trips", string(raw), "mvp-create")
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var trip c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &trip)
	base := "/api/v1/trips/" + string(trip.TripID)
	previewReply := request(handler, browser, "POST", base+"/previews", `{"expected_version":1,"command":{"kind":"generate_plan"},"current_position":null,"observed_at":null}`, "")
	if previewReply.Code != 201 {
		t.Fatal(previewReply.Code, previewReply.Body.String())
	}
	var preview c.PlanPreview
	if err := json.Unmarshal(previewReply.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if !preview.CanApply || len(preview.ProposedTrip.Days) != 1 || len(preview.ProposedTrip.Days[0].Stops) == 0 {
		t.Fatal("expected an applicable conditional plan with actual catalog stops")
	}
	for _, code := range []string{"OPENING_HOURS_UNKNOWN", "ELIGIBILITY_UNKNOWN", "AGE_FIT_UNKNOWN", "DURATION_ESTIMATED", "REQUEST_TEXT_PARTIALLY_UNDERSTOOD", "OSM_SOURCE_UNVERIFIED"} {
		if !slices.Contains(preview.RequiredAcknowledgementCodes, code) {
			t.Fatalf("missing acknowledgement for %s", code)
		}
	}
	found, foundOSM := false, false
	for _, stop := range preview.ProposedTrip.Days[0].Stops {
		found = found || stop.ActivityID == "activity:main:42:visit"
		foundOSM = foundOSM || stop.ActivityID == "activity:osm:node:11016554438:visit"
	}
	if !found || !foundOSM {
		t.Fatal("lost mandatory selection")
	}
	foundEvidence := false
	for _, evidence := range preview.ProposedTrip.Evidence {
		foundEvidence = foundEvidence || evidence.SourceURL != nil && *evidence.SourceURL == "https://www.openstreetmap.org/node/11016554438"
	}
	if !foundEvidence {
		t.Fatal("OSM source evidence did not reach the backend trip")
	}
	var unchanged c.TripView
	saved := request(handler, browser, "GET", base, "", "")
	_ = json.Unmarshal(saved.Body.Bytes(), &unchanged)
	if unchanged.Version != 1 || len(unchanged.Days) != 0 {
		t.Fatal("preview mutated stored trip")
	}
	applyURL := base + "/previews/" + string(preview.PreviewID) + "/apply"
	missingAck := request(handler, browser, "POST", applyURL, `{"expected_version":1,"acknowledged_warning_codes":[]}`, "mvp-no-ack")
	if missingAck.Code != 422 {
		t.Fatal("unknown data applied without acknowledgement")
	}
	apply, _ := json.Marshal(c.ApplyRequest{ExpectedVersion: 1, AcknowledgedWarningCodes: preview.RequiredAcknowledgementCodes})
	applied := request(handler, browser, "POST", applyURL, string(apply), "mvp-apply")
	if applied.Code != 200 {
		t.Fatal(applied.Body.String())
	}
	replay := request(handler, browser, "POST", applyURL, string(apply), "mvp-apply")
	if replay.Code != 200 || replay.Body.String() != applied.Body.String() {
		t.Fatal("apply replay changed the result")
	}
	stale := request(handler, browser, "POST", applyURL, string(apply), "mvp-stale")
	if stale.Code != 409 {
		t.Fatal("stale apply was accepted")
	}
	fail.Store(true)
	cached := request(handler, browser, "POST", base+"/previews", `{"expected_version":2,"command":{"kind":"generate_plan"},"current_position":null,"observed_at":null}`, "")
	if cached.Code != 201 {
		t.Fatal("validated snapshot should survive a model outage", cached.Code, cached.Body.String())
	}
	fresh := request(handler, browser, "POST", "/api/v1/trips", string(raw), "mvp-outage-create")
	if fresh.Code != 201 {
		t.Fatal(fresh.Body.String())
	}
	var freshTrip c.TripView
	_ = json.Unmarshal(fresh.Body.Bytes(), &freshTrip)
	freshPath := "/api/v1/trips/" + string(freshTrip.TripID)
	outage := request(handler, browser, "POST", freshPath+"/previews", `{"expected_version":1,"command":{"kind":"generate_plan"},"current_position":null,"observed_at":null}`, "")
	if outage.Code != 503 {
		t.Fatal("expected ML outage to remain an outage", outage.Code)
	}
	freshSaved := request(handler, browser, "GET", freshPath, "", "")
	_ = json.Unmarshal(freshSaved.Body.Bytes(), &freshTrip)
	if freshTrip.Version != 1 || len(freshTrip.Days) != 0 {
		t.Fatal("failed fresh lookup changed draft")
	}
	saved = request(handler, browser, "GET", base, "", "")
	var before, after any
	if json.Unmarshal(applied.Body.Bytes(), &before) != nil || json.Unmarshal(saved.Body.Bytes(), &after) != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("dependency outage changed the saved plan")
	}
	fail.Store(false)
	input.Selections = []c.Selection{{ActivityID: "missing-activity", PlaceID: "missing-place", Mandatory: true}}
	input.RequestText = nil
	raw, _ = json.Marshal(input)
	missing := request(handler, browser, "POST", "/api/v1/trips", string(raw), "mvp-missing")
	if missing.Code != 201 {
		t.Fatal(missing.Body.String())
	}
	var missingTrip c.TripView
	_ = json.Unmarshal(missing.Body.Bytes(), &missingTrip)
	invalidPreview := request(handler, browser, "POST", "/api/v1/trips/"+string(missingTrip.TripID)+"/previews", `{"expected_version":1,"command":{"kind":"generate_plan"},"current_position":null,"observed_at":null}`, "")
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(invalidPreview.Body.Bytes(), &failure)
	if invalidPreview.Code != 422 || failure.Error.Code != "UNKNOWN_ACTIVITY" {
		t.Fatal("missing user selection must be explicit, not a dependency outage", invalidPreview.Code, invalidPreview.Body.String())
	}
	t.Logf("Python API → Go backend → preview → acknowledgement → apply/replay passed; %d stops; routing fixture only", len(preview.ProposedTrip.Days[0].Stops))
}
