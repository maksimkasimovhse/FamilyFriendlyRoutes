package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

// Actual Python HTTP RecSys, real backend endpoints/preview/apply; routing is a fixture.
func TestRecSysBackendScenarios(t *testing.T) {
	modelURL := os.Getenv("MVP_MODEL_URL")
	if modelURL == "" {
		t.Skip("run scripts/check_recsys.py for real model HTTP acceptance")
	}
	store, err := tripstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 21, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	source := planner.HTTPSource{Endpoint: modelURL + "/internal/v1/recommendations", Version: "city-enriched-v3", Token: os.Getenv("ML_API_TOKEN"), Limit: 1}
	language := intentFunc(func(ctx context.Context, id, message string, value any) (assistant.Intent, error) {
		if message == "Хотим поесть" {
			return assistant.Intent{Action: "find_places", Needs: []assistant.Need{{Kind: "food", Urgency: "now", Evidence: message}}}, nil
		}
		choices := value.(map[string]any)["choices"].([]map[string]any)
		idValue := choices[0]["place_id"].(c.ID)
		return assistant.Intent{Action: "add_activity", PlaceID: &idValue}, nil
	})
	handler := tripHandlerWithAssistant(store, planner.Planner{Router: dayRouter{}, Source: source}, func() time.Time { return now }, language, nil)
	file, err := os.Open("../../data/catalog/enriched/catalog.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var event struct {
		Activity struct {
			ActivityID c.ID   `json:"activity_id"`
			Title      string `json:"title"`
		} `json:"activity"`
		Place struct {
			PlaceID c.ID `json:"place_id"`
		} `json:"place"`
		Occurrences []struct {
			OccurrenceID c.ID   `json:"occurrence_id"`
			StartAt      string `json:"start_at"`
		} `json:"occurrences"`
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		_ = json.Unmarshal(scanner.Bytes(), &event)
		if strings.Contains(event.Activity.Title, "Новогодняя весточка") {
			break
		}
	}
	if err = scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(event.Occurrences) == 0 {
		t.Fatal("real official holiday programme missing")
	}
	date := c.ISODate(event.Occurrences[0].StartAt[:10])
	now, _ = time.Parse(time.RFC3339, string(date)+"T09:00:00+03:00")
	browser := bootstrap(t, handler)
	occ := event.Occurrences[0].OccurrenceID
	raw, err := os.ReadFile("../../examples/trip-one-day.json")
	if err != nil {
		t.Fatal(err)
	}
	var input c.TripInput
	_ = json.Unmarshal(raw, &input)
	for i := range input.Family.Children {
		input.Family.Children[i].AgeYears = 8
	}
	input.Days[0].Date = date
	input.Days[0].AvailableWindow = &c.Interval{StartAt: c.Instant(string(date) + "T09:00:00+03:00"), EndAt: c.Instant(string(date) + "T18:00:00+03:00")}
	zero := 0.0
	input.Days[0].MealDurationSec = &zero
	input.Selections = []c.Selection{{ActivityID: event.Activity.ActivityID, PlaceID: event.Place.PlaceID, OccurrenceID: &occ, Mandatory: true, PreferredDate: &date}}
	created := request(handler, browser, "POST", "/api/v1/trips", body(t, input), "recsys-create")
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var view c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &view)
	path := "/api/v1/trips/" + string(view.TripID)
	search := func(purpose string, filters map[string]any) c.PublicRecommendationResponse {
		t.Helper()
		payload := map[string]any{"expected_version": view.Version, "purpose": purpose, "date": date, "request_text": nil, "exclude_activity_ids": []string{}, "limit": 50}
		if filters != nil {
			payload["restaurant_filters"] = filters
		}
		w := request(handler, browser, "POST", path+"/recommendations", body(t, payload), "")
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", purpose, w.Code, w.Body.String())
		}
		var result c.PublicRecommendationResponse
		_ = json.Unmarshal(w.Body.Bytes(), &result)
		return result
	}
	for _, purpose := range []string{"initial", "restaurant", "along_route"} {
		result := search(purpose, nil)
		if len(result.Candidates) == 0 {
			t.Fatalf("%s returned no candidates", purpose)
		}
		seen := map[c.ID]bool{}
		for _, candidate := range result.Candidates {
			if seen[candidate.Place.PlaceID] {
				t.Fatal("duplicate place")
			}
			seen[candidate.Place.PlaceID] = true
		}
	}
	menus := search("restaurant", map[string]any{"children_menu": true})
	if len(menus.Candidates) == 0 {
		t.Fatal("source-backed kids menus missing")
	}
	for _, candidate := range menus.Candidates {
		var fact struct {
			State string `json:"state"`
			Value bool   `json:"value"`
		}
		_ = json.Unmarshal(candidate.Place.Restaurant.ChildrenMenu, &fact)
		if fact.State != "known" || !fact.Value {
			t.Fatal("unknown menu satisfied requirement")
		}
		if candidate.Activity.Kind != "meal" {
			t.Fatal("restaurant is not a meal")
		}
		for _, credit := range candidate.BalanceCredit {
			if credit.Value != 0 {
				t.Fatal("food changed child activity balance")
			}
		}
	}
	if result := search("restaurant", map[string]any{"small_portions": true}); len(result.Candidates) != 0 || result.Status != "no_candidates" {
		t.Fatal("unknown property fabricated")
	}
	previewResponse := request(handler, browser, "POST", path+"/previews", body(t, map[string]any{"expected_version": view.Version, "command": map[string]any{"kind": "generate_plan"}, "current_position": nil, "observed_at": nil}), "")
	if previewResponse.Code != 201 {
		t.Fatal(previewResponse.Body.String())
	}
	var preview c.PlanPreview
	_ = json.Unmarshal(previewResponse.Body.Bytes(), &preview)
	if !preview.CanApply || len(preview.ProposedTrip.Days[0].Stops) != 1 {
		t.Fatalf("session plan failed %+v", preview)
	}
	stop := preview.ProposedTrip.Days[0].Stops[0]
	if stop.OccurrenceID == nil || *stop.OccurrenceID != occ || stop.Duration.Source != "official" {
		t.Fatal("selected session lost its time/duration")
	}
	apply := func(preview c.PlanPreview, key string) {
		t.Helper()
		w := request(handler, browser, "POST", path+"/previews/"+string(preview.PreviewID)+"/apply", body(t, c.ApplyRequest{ExpectedVersion: preview.BaseVersion, AcknowledgedWarningCodes: preview.RequiredAcknowledgementCodes}), key)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		_ = json.Unmarshal(w.Body.Bytes(), &view)
	}
	apply(preview, "session-apply")
	for _, need := range []string{"toilet", "rain", "playground", "tired", "hotel"} {
		payload := map[string]any{"expected_version": view.Version, "date": date, "need": need, "current_position": nil, "observed_at": nil}
		w := request(handler, browser, "POST", path+"/needs", body(t, payload), "")
		if need == "hotel" {
			if w.Code != 422 || !strings.Contains(w.Body.String(), "HOTEL_POINT_REQUIRED") {
				t.Fatal("hotel inferred from end point")
			}
			payload["hotel_point"] = input.Days[0].EndPoint
			w = request(handler, browser, "POST", path+"/needs", body(t, payload), "")
		}
		if w.Code != 200 {
			t.Fatalf("%s: %s", need, w.Body.String())
		}
		var result c.NeedResponse
		_ = json.Unmarshal(w.Body.Bytes(), &result)
		if len(result.Options) == 0 {
			t.Fatalf("%s: missing real options", need)
		}
	}
	meal := menus.Candidates[0]
	mealPreview := request(handler, browser, "POST", path+"/previews", body(t, map[string]any{"expected_version": view.Version, "command": map[string]any{"kind": "add_activity", "date": date, "selection": c.Selection{ActivityID: meal.Activity.ActivityID, PlaceID: meal.Place.PlaceID}}, "current_position": nil, "observed_at": nil}), "")
	if mealPreview.Code != 201 {
		t.Fatal(mealPreview.Body.String())
	}
	_ = json.Unmarshal(mealPreview.Body.Bytes(), &preview)
	if !preview.CanApply {
		t.Fatalf("meal preview infeasible: %+v", preview.Warnings)
	}
	apply(preview, "meal-apply")
	if view.Days[0].Totals.MealDurationSec != 2700 {
		t.Fatal("real meal duration missing or double counted")
	}
	before := view.Version
	for i, message := range []string{"Хотим поесть", "Давай первый"} {
		w := request(handler, browser, "POST", path+"/assistant/messages", body(t, map[string]any{"expected_version": view.Version, "date": date, "message": message, "current_position": nil, "observed_at": nil}), []string{"food-find", "food-choice"}[i])
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var reply assistantReply
		_ = json.Unmarshal(w.Body.Bytes(), &reply)
		if i == 0 && len(reply.Places) == 0 {
			t.Fatal("assistant did not use RecSys without a map database")
		}
		if i == 1 && reply.Preview == nil {
			t.Fatal("assistant meal selection did not create preview")
		}
	}
	read := request(handler, browser, "GET", path, "", "")
	_ = json.Unmarshal(read.Body.Bytes(), &view)
	if view.Version != before {
		t.Fatal("read/search/assistant preview mutated the saved trip")
	}
	w := request(handler, browser, "POST", path+"/recommendations", body(t, map[string]any{"expected_version": 1, "purpose": "initial", "date": nil, "request_text": nil, "exclude_activity_ids": []string{}, "limit": 10}), "")
	if w.Code != 409 {
		t.Fatal("stale search version accepted")
	}
	stranger := bootstrap(t, handler)
	w = request(handler, stranger, "POST", path+"/recommendations", body(t, map[string]any{"expected_version": view.Version, "purpose": "initial", "date": nil, "request_text": nil, "exclude_activity_ids": []string{}, "limit": 10}), "")
	if w.Code != 404 {
		t.Fatal("another session can read family recommendations")
	}
	// The same source-backed availability survives starting/progress/replanning.
	now, _ = time.Parse(time.RFC3339, string(date)+"T09:00:00+03:00")
	startAt := c.Instant(now.Format(time.RFC3339))
	started := request(handler, browser, "POST", path+"/previews", body(t, map[string]any{"expected_version": view.Version, "command": map[string]any{
		"kind": "start_day", "date": date, "point": input.Days[0].StartPoint, "start_at": startAt}, "current_position": nil, "observed_at": nil}), "")
	if started.Code != 201 {
		t.Fatal(started.Body.String())
	}
	_ = json.Unmarshal(started.Body.Bytes(), &preview)
	if !preview.CanApply {
		t.Fatal("source-backed active start infeasible")
	}
	apply(preview, "recsys-start")
	first := view.Days[0].Stops[0]
	if first.Timing.EstimatedDepartureAt == nil {
		t.Fatal("active stop lost timeline")
	}
	now, _ = time.Parse(time.RFC3339Nano, string(*first.Timing.EstimatedDepartureAt))
	progress := request(handler, browser, "POST", path+"/progress", body(t, c.ProgressRequest{ExpectedVersion: view.Version, Date: date, StopID: first.StopID, Status: "visited", ObservedAt: c.Instant(now.Format(time.RFC3339Nano))}), "recsys-progress")
	if progress.Code != 200 {
		t.Fatal(progress.Body.String())
	}
	_ = json.Unmarshal(progress.Body.Bytes(), &view)
	if view.Days[0].Stops[0].Progress != "visited" {
		t.Fatal("visited source activity not preserved")
	}
	now = now.Add(time.Minute)
	at := c.Instant(now.Format(time.RFC3339Nano))
	replanned := request(handler, browser, "POST", path+"/previews", body(t, map[string]any{"expected_version": view.Version, "command": map[string]any{
		"kind": "replan_day", "date": date}, "current_position": first.Location, "observed_at": at}), "")
	if replanned.Code != 201 {
		t.Fatal(replanned.Body.String())
	}
	_ = json.Unmarshal(replanned.Body.Bytes(), &preview)
	if !preview.CanApply || preview.ProposedTrip.Days[0].Stops[0].Progress != "visited" {
		t.Fatal("replan lost real RecSys history")
	}
	apply(preview, "recsys-replan")
}
