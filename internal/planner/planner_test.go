package planner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

type testRouter struct {
	err   error
	calls int
}

func (r *testRouter) Route(ctx context.Context, request routing.Request) (routing.Result, error) {
	r.calls++
	if r.err != nil {
		return routing.Result{}, r.err
	}
	return routing.Result{Mode: "walk", Status: "calculated", DistanceM: 100, TravelDurationSec: 60, Geometry: routing.LineString{Type: "LineString", Coordinates: []routing.Position{request.From.Coordinates, request.To.Coordinates}}, RoutingDataVersion: "test-osm"}, nil
}
func sample(t *testing.T) c.TripInput {
	t.Helper()
	raw, err := os.ReadFile("../../examples/trip-one-day.json")
	if err != nil {
		t.Fatal(err)
	}
	var input c.TripInput
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	return input
}
func TestPlanTimingLimitsAndNoHiddenMutation(t *testing.T) {
	input := sample(t)
	now := time.Now().UTC()
	draft := NewDraft("trip", input, now)
	router := &testRouter{}
	p := Planner{router, DemoActivities()}
	view, err := p.Build(context.Background(), draft, now)
	if err != nil {
		t.Fatal(err)
	}
	day := view.Days[0]
	if len(day.Stops) != 3 || len(day.Legs) != 4 || router.calls != 4 {
		t.Fatal("incomplete path")
	}
	if *day.Totals.ElapsedDurationSec != 2340 || *day.Totals.WalkDistanceM != 400 {
		t.Fatalf("totals %+v", day.Totals)
	}
	if day.Presentation != "relative" || day.Stops[0].Timing.EstimatedArrivalAt != nil || day.Feasibility != "conditional" {
		t.Fatal("pre-arrival plan claims an exact schedule")
	}
	if draft.Version != 1 || len(draft.Days) != 0 || view.Version != 2 {
		t.Fatal("preview mutated saved input")
	}
	if view.Policy.ChildInterestWeights[0].Weight != 0.5 || view.FamilyBalance[0].PlannedCredit != 1.5 {
		t.Fatal("family balance mismatch")
	}
	input.PlanningContext = "in_city"
	clockView, err := p.Build(context.Background(), NewDraft("clock", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	if clockView.Days[0].Presentation != "clock" || clockView.Days[0].Stops[0].Timing.EstimatedArrivalAt == nil {
		t.Fatal("missing clock timing")
	}
	input.Days[0].DurationBudgetSec = 100
	limited, err := p.Build(context.Background(), NewDraft("limited", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	if limited.Days[0].Feasibility != "infeasible" || len(limited.Days[0].Stops) != 3 {
		t.Fatal("silently removed stops to hide infeasibility")
	}
}
func TestAgeValidationAndRoutingFailure(t *testing.T) {
	input := sample(t)
	input.Family.Children[0].AgeYears = 2
	if !errors.Is(Validate(input), ErrValidation) {
		t.Fatal("accepted age outside scope")
	}
	input = sample(t)
	activities := DemoActivities()
	activities[0].MinAge = 8
	router := &testRouter{}
	p := Planner{router, activities}
	if _, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now()); !errors.Is(err, ErrValidation) {
		t.Fatal(err)
	}
	if router.calls != 0 {
		t.Fatal("routed before checking age")
	}
	p = Planner{&testRouter{err: routing.ErrUnavailable}, DemoActivities()}
	if _, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now()); !errors.Is(err, routing.ErrUnavailable) {
		t.Fatal("routing outage was hidden")
	}
}
