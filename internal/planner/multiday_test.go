package planner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

func secondDay(input c.TripInput) c.TripInput {
	day := input.Days[0]
	day.Date = "2030-06-16"
	day.AvailableWindow = &c.Interval{StartAt: "2030-06-16T10:00:00+03:00", EndAt: "2030-06-16T17:00:00+03:00"}
	input.Days = append(input.Days, day)
	return input
}

func TestMultiDayCapacityPreferredDateAndNoDuplicates(t *testing.T) {
	input := secondDay(sample(t))
	limit := 250.0
	input.LoadLimits.MaxWalkDistanceMPerDay = &limit
	input.Days[0].DurationBudgetSec = 1200
	input.Days[1].DurationBudgetSec = 1200
	date := input.Days[1].Date
	input.Selections = []c.Selection{{ActivityID: "demo-2", PlaceID: "demo-place-2", Mandatory: true, PreferredDate: &date}}
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	result, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	seen := map[c.ID]bool{}
	for _, day := range result.Days {
		if day.Feasibility == "infeasible" || *day.Totals.ElapsedDurationSec > 1200 {
			t.Fatal("ignored capacity")
		}
		for _, stop := range day.Stops {
			if seen[stop.ActivityID] {
				t.Fatal("scheduled twice")
			}
			seen[stop.ActivityID] = true
			if stop.ActivityID == "demo-2" && day.Date != date {
				t.Fatal("ignored preferred date")
			}
		}
	}
	if len(seen) != 2 {
		t.Fatalf("expected two fitting activities, got %d", len(seen))
	}
	if len(input.Selections) != 1 || len(input.Days) != 2 {
		t.Fatal("mutated input")
	}
}

type directionalRouter struct{ testRouter }

func (r *directionalRouter) Route(ctx context.Context, req routing.Request) (routing.Result, error) {
	result, err := r.testRouter.Route(ctx, req)
	// A cheap outbound path with an expensive directed return.
	if req.From.Coordinates[0] > 44.006 && req.To.Coordinates[0] < 44.006 {
		result.TravelDurationSec = 3000
		result.DistanceM = 3000
	}
	return result, err
}
func TestReturnPathAndMandatoryInfeasibility(t *testing.T) {
	input := sample(t)
	input.Days[0].DurationBudgetSec = 1500
	limit := 1500.0
	input.LoadLimits.MaxWalkDistanceMPerDay = &limit
	p := Planner{Router: &directionalRouter{}, Activities: DemoActivities()[:1]}
	result, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Days[0].Stops) != 0 {
		t.Fatal("ignored return path")
	}
	input.Selections = []c.Selection{{ActivityID: "demo-1", PlaceID: "demo-place-1", Mandatory: true}}
	result, err = p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if result.Days[0].Feasibility != "infeasible" || len(result.Days[0].Stops) != 1 {
		t.Fatal("hid required infeasible stop")
	}
}

func mlResponse(t *testing.T, view c.TripView, count int) c.RecommendationResponse {
	t.Helper()
	response := c.RecommendationResponse{ContractVersion: "1.0", TripID: view.TripID, TripVersion: view.Version, CatalogVersion: view.CatalogVersion, ModelVersion: "fixture", GeneratedAt: c.Instant(time.Now().Format(time.RFC3339)), Status: "complete", Candidates: []c.Candidate{}, Evidence: []c.Evidence{}, Warnings: []c.Warning{}}
	unknown := json.RawMessage(`{"state":"unknown","value":null,"evidence_ids":[]}`)
	for i := 0; i < count; i++ {
		candidate := c.Candidate{Place: c.Place{PlaceID: c.ID(fmt.Sprintf("place-%d", i)), Location: DemoActivities()[i%3].Point, Categories: []c.Category{"landmark"}}, Activity: c.Activity{ActivityID: c.ID(fmt.Sprintf("activity-%d", i)), PlaceID: c.ID(fmt.Sprintf("place-%d", i)), Title: "Fixture", Kind: "visit", AgeMinYears: unknown, AgeMaxYears: unknown, HeightMinCm: unknown, AdmissionRule: unknown, Duration: c.DurationEstimate{DurationSec: 600, Source: "estimated", EvidenceIDS: []c.ID{}}}, Reasons: []c.Reason{}, Warnings: []c.Warning{}}
		for _, day := range view.Input.Days {
			candidate.Availability = append(candidate.Availability, c.AvailabilityDay{Date: day.Date, State: "unknown"})
		}
		for _, child := range view.Input.Family.Children {
			raw, _ := json.Marshal(map[string]any{"child_id": child.ChildID, "status": "eligible", "reasons": []c.Reason{}})
			var row struct {
				ChildID c.ID       `json:"child_id"`
				Status  string     `json:"status"`
				Reasons []c.Reason `json:"reasons"`
			}
			_ = json.Unmarshal(raw, &row)
			candidate.Eligibility = append(candidate.Eligibility, row)
			candidate.Scores.ChildInterest = append(candidate.Scores.ChildInterest, struct {
				ChildID c.ID    `json:"child_id"`
				Value   float64 `json:"value"`
			}{child.ChildID, 0.5})
			candidate.BalanceCredit = append(candidate.BalanceCredit, struct {
				ChildID c.ID    `json:"child_id"`
				Value   float64 `json:"value"`
			}{child.ChildID, 0.5})
		}
		response.Candidates = append(response.Candidates, candidate)
	}
	return response
}

func TestHTTPMLBoundaryAndSchedule(t *testing.T) {
	var received c.RecommendationRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("incorrect ML request")
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		view := NewDraft(received.TripID, c.TripInput{Family: received.Profile, Days: received.Days}, time.Now())
		view.CatalogVersion = received.CatalogVersion
		view.Version = received.TripVersion
		response := mlResponse(t, view, 1)
		response.RequestID = received.RequestID
		response.Candidates[0].Availability[0].State = "open"
		response.Candidates[0].Availability[0].VisitWindows = []c.Interval{{StartAt: "2030-06-15T11:00:00+03:00", EndAt: "2030-06-15T12:00:00+03:00"}}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()
	p := Planner{Router: &testRouter{}, Source: HTTPSource{Endpoint: server.URL, Version: "catalog-test", Token: "test-token"}}
	input := sample(t)
	input.PlanningContext = "in_city"
	view := p.Draft("trip", input, time.Now())
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if received.Limit != 50 || received.Purpose != "initial" || len(received.Days) != 1 {
		t.Fatal("ML received wrong scope")
	}
	stop := result.Days[0].Stops[0]
	if string(*stop.Timing.EstimatedVisitStartAt) != "2030-06-15T11:00:00+03:00" || *result.Days[0].Totals.WaitDurationSec != 3540 {
		t.Fatal("hours or wait not applied")
	}
	for _, warning := range result.Warnings {
		if warning.Code == "DEMO_CATALOG" {
			t.Fatal("real ML marked demo")
		}
	}
}

func TestMLRejectsMalformedPool(t *testing.T) {
	view := NewDraft("trip", sample(t), time.Now())
	tests := map[string]func(*c.RecommendationResponse){
		"too many": func(r *c.RecommendationResponse) { r.Candidates = append(r.Candidates, r.Candidates...) },
		"duplicate place": func(r *c.RecommendationResponse) {
			r.Candidates[1].Place.PlaceID = r.Candidates[0].Place.PlaceID
			r.Candidates[1].Activity.PlaceID = r.Candidates[0].Place.PlaceID
		},
		"wrong version": func(r *c.RecommendationResponse) { r.TripVersion++ },
		"missing date":  func(r *c.RecommendationResponse) { r.Candidates[0].Availability = nil },
		"age restriction": func(r *c.RecommendationResponse) {
			r.Candidates[0].Activity.AgeMinYears = json.RawMessage(`{"state":"known","value":8,"evidence_ids":["official"]}`)
		},
		"unknown child": func(r *c.RecommendationResponse) { r.Candidates[0].Eligibility[0].ChildID = "foreign" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			count := 2
			if name == "too many" {
				count = 26
			}
			response := mlResponse(t, view, count)
			mutate(&response)
			if _, _, err := normalize(response, view); !errors.Is(err, ErrMLContract) {
				t.Fatal("accepted malformed ML pool", err)
			}
		})
	}
}

type fixedSource struct{ response c.RecommendationResponse }

func (s fixedSource) CatalogVersion() string { return s.response.CatalogVersion }
func (s fixedSource) Recommend(context.Context, c.TripView) (c.RecommendationResponse, error) {
	return s.response, nil
}

func TestFiftyCandidatesArePoolNotFiftyVisits(t *testing.T) {
	input := secondDay(sample(t))
	limit := 250.0
	input.LoadLimits.MaxWalkDistanceMPerDay = &limit
	for i := range input.Days {
		input.Days[i].DurationBudgetSec = 1000
	}
	view := NewDraft("trip", input, time.Now())
	response := mlResponse(t, view, 50)
	p := Planner{Router: &testRouter{}, Source: fixedSource{response}}
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, day := range result.Days {
		total += len(day.Stops)
		if day.Feasibility == "infeasible" {
			t.Fatal("overflowed day")
		}
	}
	if total != 2 {
		t.Fatalf("50 candidates must not force 50 visits: %d", total)
	}
	count := 0
	for _, warning := range result.Warnings {
		if warning.Code == "CANDIDATE_NOT_SCHEDULED" {
			count++
		}
	}
	if count != 48 {
		t.Fatalf("missing exclusion reasons: %d", count)
	}
}

func TestFixedSessionKeepsTimeBeforeArrival(t *testing.T) {
	input := sample(t)
	view := NewDraft("trip", input, time.Now())
	response := mlResponse(t, view, 1)
	candidate := response.Candidates[0]
	candidate.Activity.Kind = "session"
	candidate.Availability[0].State = "open"
	raw := []byte(`[{"occurrence_id":"session","interval":{"start_at":"2030-06-15T11:00:00+03:00","end_at":"2030-06-15T12:00:00+03:00"},"booking_status":"available"}]`)
	_ = json.Unmarshal(raw, &candidate.Availability[0].Occurrences)
	activities, metadata, err := normalize(response, view)
	if err != nil {
		t.Fatal(err)
	}
	metadata[candidate.Activity.ActivityID] = candidate
	input.Selections = []c.Selection{{ActivityID: candidate.Activity.ActivityID, PlaceID: candidate.Place.PlaceID}}
	p := Planner{Router: &testRouter{}, Activities: activities, metadata: metadata}
	result, err := p.buildDay(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	stop := result.Days[0].Stops[0]
	if result.Days[0].Presentation != "relative" || stop.Timing.FixedEventInterval == nil || stop.Duration.DurationSec != 3600 || string(*stop.Timing.EstimatedDepartureAt) != "2030-06-15T12:00:00+03:00" {
		t.Fatal("lost fixed session time")
	}
}
