package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

// Opt-in: requires the locally prepared OSM dataset and running Valhalla.
// Places are synthetic test activities positioned on a real OSM path, not venues.
func TestLiveFiftyCandidatePlanning(t *testing.T) {
	if os.Getenv("LIVE_OSM_TEST") != "1" {
		t.Skip("set LIVE_OSM_TEST=1 with local Valhalla running")
	}
	manifest, err := routing.LoadManifest("../../data/routing/source-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	router, err := routing.NewClient("http://127.0.0.1:8002", manifest.RoutingDataVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	path, err := router.Route(ctx, routing.Request{From: routing.Point{Coordinates: routing.Position{44.0059, 56.3269}}, To: planner.DemoActivities()[2].Point, Mode: "walk"})
	if err != nil {
		t.Fatal(err)
	}
	points := []routing.Position{}
	unique := map[routing.Position]bool{}
	for _, point := range path.Geometry.Coordinates {
		if !unique[point] {
			unique[point] = true
			points = append(points, point)
		}
	}
	if len(points) < 50 {
		t.Fatalf("need 50 distinct coordinates, got %d", len(points))
	}
	var mode atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req c.RecommendationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid test request", 400)
			return
		}
		if mode.Load() == 2 {
			http.Error(w, "synthetic ML outage", 503)
			return
		}
		if req.Limit != 50 || len(req.Days) != 2 {
			t.Error("wrong ML request scope")
		}
		unknown := map[string]any{"state": "unknown", "value": nil, "evidence_ids": []string{}}
		candidates := []any{}
		for i := 0; i < 50; i++ {
			id := fmt.Sprintf("fixture-%02d", i)
			availability := []any{}
			for j, day := range req.Days {
				state := "open"
				windows := []c.Interval{{StartAt: c.Instant(string(day.Date) + "T11:00:00+03:00"), EndAt: c.Instant(string(day.Date) + "T17:00:00+03:00")}}
				if i == 0 && j == 0 {
					state = "closed"
					windows = []c.Interval{}
				}
				availability = append(availability, map[string]any{"date": day.Date, "state": state, "visit_windows": windows, "last_entry_at": nil, "occurrences": []any{}, "evidence_ids": []string{}})
			}
			eligibility, interests, credits := []any{}, []any{}, []any{}
			for _, child := range req.Profile.Children {
				eligibility = append(eligibility, map[string]any{"child_id": child.ChildID, "status": "eligible", "reasons": []any{}})
				interests = append(interests, map[string]any{"child_id": child.ChildID, "value": 0.5})
				credits = append(credits, map[string]any{"child_id": child.ChildID, "value": 1 / float64(len(req.Profile.Children))})
			}
			candidates = append(candidates, map[string]any{
				"place":        map[string]any{"place_id": id, "name": "SYNTHETIC " + id, "location": routing.Point{Coordinates: points[i*(len(points)-1)/49]}, "entrance": nil, "categories": []string{"landmark"}, "display_class": "family", "indoor": unknown, "toilet": unknown, "shelter": unknown, "seating": unknown, "restaurant": nil},
				"activity":     map[string]any{"activity_id": id, "place_id": id, "title": "SYNTHETIC " + id, "kind": "visit", "age_min_years": unknown, "age_max_years": unknown, "recommended_age_min_years": unknown, "recommended_age_max_years": unknown, "height_min_cm": unknown, "duration": map[string]any{"duration_sec": 1200, "source": "estimated", "evidence_ids": []string{}}, "admission_rule": unknown, "booking_required": unknown, "evidence_ids": []string{}},
				"availability": availability, "eligibility": eligibility, "scores": map[string]any{"child_interest": interests, "adult_interest": 0.5, "popularity": 0.5, "final_relevance": 1 - float64(i)/100}, "balance_credit": credits, "is_top_place": false, "reasons": []any{}, "warnings": []any{},
			})
		}
		if mode.Load() == 1 {
			candidates = append(candidates, candidates[0])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"contract_version": "1.0", "request_id": req.RequestID, "trip_id": req.TripID, "trip_version": req.TripVersion, "catalog_version": req.CatalogVersion, "model_version": "synthetic-50", "generated_at": time.Now().UTC().Format(time.RFC3339), "status": "complete", "candidates": candidates, "rejected": []any{}, "evidence": []any{}, "warnings": []any{}})
	}))
	defer server.Close()
	store, err := tripstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	handler := TripHandler(store, planner.Planner{Router: router, Source: planner.HTTPSource{Endpoint: server.URL, Version: "synthetic-50-v1"}})
	browser := bootstrap(t, handler)
	raw, err := os.ReadFile("../../examples/trip-two-days.json")
	if err != nil {
		t.Fatal(err)
	}
	var input c.TripInput
	if err = json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	input.Days[0].DurationBudgetSec = 21600
	input.Days[1].DurationBudgetSec = 21600
	limit, reserve := 650.0, 150.0
	input.LoadLimits.MaxWalkDistanceMPerDay = &limit
	input.LoadLimits.RestaurantWalkReserveMPerDay = &reserve
	// An explicit first-day anchor exercises date constraints alongside distance
	// clustering; nearby places need not otherwise occupy every requested day.
	firstDate := input.Days[0].Date
	input.Selections = []c.Selection{{ActivityID: "fixture-01", PlaceID: "fixture-01", Mandatory: true, PreferredDate: &firstDate}}
	report := map[string]any{"checked_at": time.Now().UTC().Format(time.RFC3339), "catalog": "synthetic-50-v1", "candidates": 50, "routing_data_version": manifest.RoutingDataVersion}
	scenario := func(t *testing.T, name string, tripInput c.TripInput, expected int) c.PlanPreview {
		t.Helper()
		raw, err := json.Marshal(tripInput)
		if err != nil {
			t.Fatal(err)
		}
		created := request(handler, browser, "POST", "/api/v1/trips", string(raw), name)
		if created.Code != 201 {
			t.Fatal(created.Body.String())
		}
		var trip c.TripView
		_ = json.Unmarshal(created.Body.Bytes(), &trip)
		base := "/api/v1/trips/" + string(trip.TripID)
		started := time.Now()
		response := request(handler, browser, "POST", base+"/previews", `{"expected_version":1,"command":{"kind":"generate_plan"},"current_position":null,"observed_at":null}`, "")
		previewDuration := time.Since(started).Milliseconds()
		if response.Code != expected {
			t.Fatalf("%s: expected %d got %d: %s", name, expected, response.Code, response.Body.String())
		}
		saved := request(handler, browser, "GET", base, "", "")
		var draft c.TripView
		_ = json.Unmarshal(saved.Body.Bytes(), &draft)
		if draft.Version != 1 || len(draft.Days) != 0 {
			t.Fatal("preview/error mutated stored trip")
		}
		if expected != 201 {
			report[name] = map[string]any{"http_status": response.Code, "draft_unchanged": true}
			return c.PlanPreview{}
		}
		var preview c.PlanPreview
		if err = json.Unmarshal(response.Body.Bytes(), &preview); err != nil {
			t.Fatal(err)
		}
		total, excluded := 0, 0
		seen := map[c.ID]bool{}
		days := []any{}
		for i, day := range preview.ProposedTrip.Days {
			if preview.CanApply && (*day.Totals.ElapsedDurationSec > preview.ProposedTrip.Input.Days[i].DurationBudgetSec || day.Totals.PrimaryWalkBudgetM != nil) {
				t.Fatal("violated user time budget")
			}
			for _, stop := range day.Stops {
				if seen[stop.PlaceID] {
					t.Fatal("duplicate visit")
				}
				seen[stop.PlaceID] = true
				total++
				if i == 0 && stop.PlaceID == "fixture-00" {
					t.Fatal("visited closed place")
				}
			}
			for _, leg := range day.Legs {
				if leg.Status != "calculated" || leg.Geometry == nil || leg.RoutingDataVersion == nil || *leg.RoutingDataVersion != manifest.RoutingDataVersion {
					t.Fatal("missing real OSM geometry")
				}
			}
			if preview.CanApply && (day.Feasibility == "infeasible" || *day.Totals.ElapsedDurationSec > tripInput.Days[i].DurationBudgetSec) {
				t.Fatal("allowed overloaded day")
			}
			days = append(days, map[string]any{"date": day.Date, "stops": len(day.Stops), "walk_distance_m": day.Totals.WalkDistanceM, "walk_budget_m": day.Totals.WalkBudgetM, "restaurant_walk_reserve_m": day.Totals.RestaurantWalkReserveM, "primary_walk_budget_m": day.Totals.PrimaryWalkBudgetM, "wait_sec": day.Totals.WaitDurationSec, "elapsed_sec": day.Totals.ElapsedDurationSec, "feasibility": day.Feasibility})
		}
		for _, warning := range preview.Warnings {
			if warning.Code == "CANDIDATE_NOT_SCHEDULED" {
				excluded++
			}
		}
		if total == 0 || total >= 50 {
			t.Fatalf("unexpected scheduled count %d", total)
		}
		body, _ := json.Marshal(c.ApplyRequest{ExpectedVersion: 1, AcknowledgedWarningCodes: preview.RequiredAcknowledgementCodes})
		applied := request(handler, browser, "POST", base+"/previews/"+string(preview.PreviewID)+"/apply", string(body), name+"-apply")
		expectedApply := 200
		if !preview.CanApply {
			expectedApply = 422
		}
		if applied.Code != expectedApply {
			t.Fatal(applied.Body.String())
		}
		finalResponse := request(handler, browser, "GET", base, "", "")
		var final c.TripView
		if finalResponse.Code != 200 || json.Unmarshal(finalResponse.Body.Bytes(), &final) != nil {
			t.Fatal("failed reading final trip")
		}
		expectedVersion := 1
		if preview.CanApply {
			expectedVersion = 2
		}
		if final.Version != expectedVersion {
			t.Fatalf("unexpected stored version: %d", final.Version)
		}
		report[name] = map[string]any{"http_status": response.Code, "can_apply": preview.CanApply, "apply_status": applied.Code, "scheduled": total, "excluded": excluded, "days": days, "preview_duration_ms": previewDuration, "draft_unchanged_before_apply": true, "stored_version_after_apply": final.Version}
		return preview
	}
	t.Run("two_days", func(t *testing.T) {
		preview := scenario(t, "two_days", input, 201)
		if !preview.CanApply || len(preview.ProposedTrip.Days) != 2 || len(preview.ProposedTrip.Days[0].Stops) == 0 || len(preview.ProposedTrip.Days[1].Stops) == 0 {
			t.Fatal("expected usable two-day plan")
		}
	})
	t.Run("mandatory_overflow", func(t *testing.T) {
		limited := input
		limited.Days = append([]c.DayInput{}, input.Days...)
		limited.Days[1].DurationBudgetSec = 30
		date := limited.Days[1].Date
		limited.Selections = []c.Selection{{ActivityID: "fixture-00", PlaceID: "fixture-00", Mandatory: true, PreferredDate: &date}}
		preview := scenario(t, "mandatory_overflow", limited, 201)
		found := false
		for _, stop := range preview.ProposedTrip.Days[1].Stops {
			if stop.ActivityID == "fixture-00" && stop.Mandatory {
				found = true
			}
		}
		if preview.CanApply || !found {
			t.Fatal("mandatory visit was lost")
		}
	})
	t.Run("invalid_ml_pool", func(t *testing.T) { mode.Store(1); scenario(t, "invalid_ml_pool", input, 502) })
	t.Run("ml_outage", func(t *testing.T) { mode.Store(2); scenario(t, "ml_outage", input, 503) })
	report["passed"] = !t.Failed()
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll("../../data/backend", 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile("../../data/backend/live-planning-report.json", append(encoded, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	t.Log(string(encoded))
}
