package planner

import (
	"context"
	"errors"
	"fmt"
	"math"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

type geographicRouter struct{}

func (geographicRouter) Route(_ context.Context, request routing.Request) (routing.Result, error) {
	a, b := request.From.Coordinates, request.To.Coordinates
	distance := math.Hypot((a[0]-b[0])*62000, (a[1]-b[1])*111000)
	return routing.Result{Mode: "walk", Status: "calculated", DistanceM: distance, TravelDurationSec: distance, Geometry: routing.LineString{Type: "LineString", Coordinates: []routing.Position{a, b}}, RoutingDataVersion: "test-geography"}, nil
}

func TestTripChoicesClusterGeographicallyWithoutPreferredDates(t *testing.T) {
	input := secondDay(sample(t))
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	input.Selections = []c.Selection{{ActivityID: "activity-0", PlaceID: "place-0"}, {ActivityID: "activity-1", PlaceID: "place-1"}, {ActivityID: "activity-2", PlaceID: "place-2"}, {ActivityID: "activity-3", PlaceID: "place-3"}}
	for i := range input.Days {
		input.Days[i].StartPoint.Coordinates = routing.Position{44.025, 56.32}
		input.Days[i].EndPoint = input.Days[i].StartPoint
	}
	if err := Validate(input); err != nil {
		t.Fatal(err)
	}
	view := NewDraft("geographic-manual", input, time.Now())
	response := mlResponse(t, view, 4)
	for i, point := range []routing.Position{{44, 56.32}, {44.05, 56.32}, {44.001, 56.32}, {44.051, 56.32}} {
		response.Candidates[i].Place.Location.Coordinates = point
	}
	p := Planner{Router: geographicRouter{}, Source: fixedSource{response: response}}
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	assigned := map[c.ID]int{}
	for i, day := range result.Days {
		if len(day.Stops) != 2 {
			t.Fatalf("expected two clustered choices per day, got %d", len(day.Stops))
		}
		for _, stop := range day.Stops {
			assigned[stop.ActivityID] = i
		}
	}
	if assigned["activity-0"] != assigned["activity-2"] || assigned["activity-1"] != assigned["activity-3"] || assigned["activity-0"] == assigned["activity-1"] {
		t.Fatalf("nearby choices were not grouped: %+v", assigned)
	}
}

func completionFixture(t *testing.T) (Planner, c.TripView) {
	t.Helper()
	input := sample(t)
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	input.Days[0].DurationBudgetSec = 1800
	date := input.Days[0].Date
	input.Selections = []c.Selection{{ActivityID: "activity-0", PlaceID: "place-0", PreferredDate: &date}}
	view := NewDraft("completion", input, time.Now())
	response := mlResponse(t, view, 5)
	positions := []routing.Position{{44, 56.32}, {44.002, 56.32}, {44.005, 56.32}, {44.05, 56.32}, {43.9, 56.32}}
	for i := range response.Candidates {
		response.Candidates[i].Scores.FinalRelevance = 1 - float64(i)/10
		response.Candidates[i].Place.Location.Coordinates = positions[i]
	}
	response.Candidates[1].Activity.Duration.DurationSec = 3000
	response.Candidates[2].Activity.Duration.DurationSec = 300
	return Planner{Router: &testRouter{}, Source: fixedSource{response: response}}, view
}
func TestRankedPrefixAndUnlimitedManualChoices(t *testing.T) {
	p, view := completionFixture(t)
	view.Input.Days[0].DurationBudgetSec = 2400
	policy := "ranked_prefix"
	view.Input.PlanningPolicy = &policy
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Days[0].Stops) < 3 {
		t.Fatal("auto selection stopped after an oversized candidate or at two stops")
	}
	for _, stop := range result.Days[0].Stops {
		if stop.ActivityID == "activity-1" {
			t.Fatal("oversized candidate exceeded day budget")
		}
	}
	date := view.Input.Days[0].Date
	view.Input.Selections = append(view.Input.Selections, c.Selection{ActivityID: "activity-2", PlaceID: "place-2", PreferredDate: &date}, c.Selection{ActivityID: "activity-3", PlaceID: "place-3", PreferredDate: &date})
	if err := Validate(view.Input); err != nil {
		t.Fatalf("rejected three manual choices: %v", err)
	}
}
func TestManualChoicesNeverSilentlyFillOtherStopsOrDays(t *testing.T) {
	input := secondDay(sample(t))
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	date := input.Days[0].Date
	input.Selections = []c.Selection{{ActivityID: "activity-0", PlaceID: "place-0", PreferredDate: &date}}
	view := NewDraft("manual-no-autofill", input, time.Now())
	response := mlResponse(t, view, 3)
	p := Planner{Router: &testRouter{}, Source: fixedSource{response: response}}
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Days[0].Stops) != 1 || result.Days[0].Stops[0].ActivityID != "activity-0" || len(result.Days[1].Stops) != 0 {
		t.Fatal("manual choices caused silent automatic filling")
	}
	options, err := p.PlanningOptions(context.Background(), result, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !options.Days[0].IsShort || len(options.Days[0].Candidates) == 0 || options.Days[1].Anchor != nil {
		t.Fatal("short/empty days did not offer cards")
	}
}
func TestShortDaySupplementRadiusQuotaAndPreservedChoices(t *testing.T) {
	p, view := completionFixture(t)
	ctx := context.Background()
	now := time.Now()
	result, err := p.Build(ctx, view, now)
	if err != nil {
		t.Fatal(err)
	}
	options, err := p.PlanningOptions(ctx, result, now)
	if err != nil {
		t.Fatal(err)
	}
	row := options.Days[0]
	if !row.IsShort || row.FillRatio >= .7 || row.ManualCount != 1 || row.RemainingManualChoices != 1 || row.Anchor == nil {
		t.Fatalf("wrong short-day policy: %+v", row)
	}
	ids := map[c.ID]bool{}
	for _, c := range row.Candidates {
		ids[c.Activity.ActivityID] = true
	}
	if !ids["activity-2"] || ids["activity-0"] || ids["activity-1"] || ids["activity-3"] || ids["activity-4"] {
		t.Fatalf("wrong suggestions: %+v", ids)
	}
	date := row.Date
	choice := c.Selection{ActivityID: "activity-2", PlaceID: "place-2", PreferredDate: &date}
	updated, err := p.AppendManualChoices(ctx, result, date, []c.Selection{choice}, now)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != result.Version+1 || len(updated.Days[0].Stops) != 2 || updated.Days[0].Stops[0].ActivityID != "activity-0" || updated.Days[0].Stops[1].ActivityID != "activity-2" || len(result.Days[0].Stops) != 1 {
		t.Fatal("append reordered or mutated the existing route")
	}
	if _, err := p.AppendManualChoices(ctx, updated, date, []c.Selection{{ActivityID: "activity-3", PlaceID: "place-3", PreferredDate: &date}}, now); err == nil {
		t.Fatal("supplement bypassed 2km radius")
	}
	if _, err := p.AppendManualChoices(ctx, result, date, []c.Selection{{ActivityID: "activity-4", PlaceID: "place-4", PreferredDate: &date}}, now); err == nil {
		t.Fatal("supplement bypassed 2km radius")
	}
}
func TestEmptyDaySuggestionsHaveNoStartAnchor(t *testing.T) {
	p, view := completionFixture(t)
	ctx := context.Background()
	now := time.Now()
	result, err := p.Build(ctx, view, now)
	if err != nil {
		t.Fatal(err)
	}
	result.Days[0].Stops = []c.Stop{}
	zero := 0.0
	result.Days[0].Totals.ElapsedDurationSec = &zero
	result.Input.Selections = []c.Selection{}
	options, err := p.PlanningOptions(ctx, result, now)
	if err != nil {
		t.Fatal(err)
	}
	row := options.Days[0]
	farFound := false
	for _, candidate := range row.Candidates {
		if candidate.Activity.ActivityID == "activity-4" {
			farFound = true
		}
	}
	if row.Anchor != nil || !row.IsShort || !farFound {
		t.Fatal("empty day was incorrectly restricted around its start")
	}
	date := row.Date
	if _, err := p.AppendManualChoices(ctx, result, date, []c.Selection{{ActivityID: "activity-2", PlaceID: "place-2", PreferredDate: &date}, {ActivityID: "activity-4", PlaceID: "place-4", PreferredDate: &date}}, now); err == nil {
		t.Fatal("second empty-day supplement ignored the first chosen anchor")
	}
	plan := result.Days[0]
	plan.Totals.ElapsedDurationSec = &row.AvailableDurationSec
	result.Days[0] = plan
	options, err = p.PlanningOptions(ctx, result, now)
	if err != nil {
		t.Fatal(err)
	}
	if options.Days[0].IsShort || len(options.Days[0].Candidates) != 0 {
		t.Fatal("full day offered supplemental cards")
	}
}
func TestDemoPlanningOptionsAndRouterOutage(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	input := sample(t)
	demo := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	options, err := demo.PlanningOptions(ctx, NewDraft("demo-options", input, now), now)
	if err != nil || len(options.Candidates) != 3 || len(options.Days) != 1 {
		t.Fatalf("demo cards unavailable: %v", err)
	}
	p, view := completionFixture(t)
	result, err := p.Build(ctx, view, now)
	if err != nil {
		t.Fatal(err)
	}
	p.Router = &testRouter{err: routing.ErrUnavailable}
	if _, err := p.PlanningOptions(ctx, result, now); !errors.Is(err, routing.ErrUnavailable) {
		t.Fatal("routing outage presented as no suitable cards", err)
	}
}

func TestManualChoicesBeyondTwoUseActualDayBudget(t *testing.T) {
	input := sample(t)
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	input.Days[0].DurationBudgetSec = 14400
	date := input.Days[0].Date
	input.Selections = []c.Selection{}
	for i := 0; i < 5; i++ {
		input.Selections = append(input.Selections, c.Selection{ActivityID: c.ID(fmt.Sprintf("activity-%d", i)), PlaceID: c.ID(fmt.Sprintf("place-%d", i)), PreferredDate: &date})
	}
	view := NewDraft("unlimited-five", input, time.Now())
	response := mlResponse(t, view, 5)
	for i := range response.Candidates {
		response.Candidates[i].Activity.Duration.DurationSec = 300
	}
	p := Planner{Router: &testRouter{}, Source: fixedSource{response: response}}
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Days[0].Stops) != 5 {
		t.Fatalf("expected all five fitting choices, got %d", len(result.Days[0].Stops))
	}
	view.Input.Days[0].DurationBudgetSec = 600
	result, err = p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Days[0].Stops) >= 5 {
		t.Fatal("time budget did not exclude overflowing choices")
	}
	if len(result.Input.Selections) != 5 {
		t.Fatal("overflow silently deleted user's choices")
	}
}

func TestRankedPrefixSkipsUnfitCandidateOnEmptyDays(t *testing.T) {
	input := secondDay(sample(t))
	policy := "ranked_prefix"
	input.PlanningPolicy = &policy
	input.Selections = []c.Selection{}
	for i := range input.Days {
		input.Days[i].DurationBudgetSec = 1200
	}
	view := NewDraft("ranked-empty-days", input, time.Now())
	response := mlResponse(t, view, 6)
	// The top candidate cannot fit even by itself. Lower-ranked candidates can.
	response.Candidates[0].Activity.Duration.DurationSec = 12000
	for i := 1; i < len(response.Candidates); i++ {
		response.Candidates[i].Activity.Duration.DurationSec = 300
	}
	p := Planner{Router: &testRouter{}, Source: fixedSource{response: response}}
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	seen := map[c.ID]bool{}
	for _, day := range result.Days {
		if len(day.Stops) == 0 {
			t.Fatal("unfit candidate closed an empty day")
		}
		if day.Feasibility == "infeasible" || *day.Totals.ElapsedDurationSec > 1200 {
			t.Fatal("ignored day budget")
		}
		for _, stop := range day.Stops {
			if stop.ActivityID == "activity-0" || seen[stop.ActivityID] {
				t.Fatal("scheduled impossible or duplicate activity")
			}
			seen[stop.ActivityID] = true
		}
	}
}

func TestAutoMinimumCoversEveryDayBeforeExtraStops(t *testing.T) {
	input := secondDay(sample(t))
	third := input.Days[1]
	third.Date = "2030-06-17"
	third.AvailableWindow = nil
	input.Days = append(input.Days, third)
	policy := "ranked_prefix"
	input.PlanningPolicy = &policy
	input.Selections = []c.Selection{}
	for i := range input.Days {
		input.Days[i].DurationBudgetSec = 7200
	}
	view := NewDraft("auto-minimum", input, time.Now())
	response := mlResponse(t, view, 8)
	p := Planner{Router: &testRouter{}, Source: fixedSource{response: response}}
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	moreThanTwo := false
	for _, day := range result.Days {
		if len(day.Stops) < 2 || day.Feasibility == "infeasible" {
			t.Fatal("did not cover all days")
		}
		moreThanTwo = moreThanTwo || len(day.Stops) > 2
	}
	if !moreThanTwo {
		t.Fatal("minimum became a maximum")
	}
	response.Candidates = response.Candidates[:3]
	p.Source = fixedSource{response: response}
	result, err = p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, day := range result.Days {
		if len(day.Stops) < 2 && day.Feasibility != "infeasible" {
			t.Fatal("silently accepted below-minimum auto day")
		}
	}
	found := false
	for _, w := range result.Warnings {
		found = found || w.Code == "AUTO_DAY_BELOW_MINIMUM"
	}
	if !found {
		t.Fatal("missing explanation for unmet auto minimum")
	}
}

func TestManualClustersCoverFiveDaysWithBalancedLoad(t *testing.T) {
	input := sample(t)
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	template := input.Days[0]
	input.Days = nil
	input.Selections = nil
	for i := 0; i < 5; i++ {
		day := template
		date := fmt.Sprintf("2030-06-%02d", 15+i)
		day.Date = c.ISODate(date)
		day.AvailableWindow = nil
		day.DurationBudgetSec = 21600
		day.StartPoint.Coordinates = routing.Position{44.005, 56.32}
		day.EndPoint = day.StartPoint
		input.Days = append(input.Days, day)
	}
	for i := 0; i < 10; i++ {
		input.Selections = append(input.Selections, c.Selection{ActivityID: c.ID(fmt.Sprintf("activity-%d", i)), PlaceID: c.ID(fmt.Sprintf("place-%d", i))})
	}
	view := NewDraft("balanced-five", input, time.Now())
	response := mlResponse(t, view, 10)
	for i := range response.Candidates {
		x := 44.0
		if i >= 6 {
			x = 44.01
		}
		response.Candidates[i].Place.Location.Coordinates = routing.Position{x + float64(i)*0.00001, 56.32}
		response.Candidates[i].Activity.Duration.DurationSec = 1200
	}
	p := Planner{Router: geographicRouter{}, Source: fixedSource{response: response}}
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	seen := map[c.ID]bool{}
	minTime, maxTime := math.Inf(1), 0.0
	for _, day := range result.Days {
		if len(day.Stops) != 2 {
			t.Fatalf("%s: expected two stops, got %d", day.Date, len(day.Stops))
		}
		group := -1
		for _, stop := range day.Stops {
			if seen[stop.ActivityID] {
				t.Fatal("duplicate")
			}
			seen[stop.ActivityID] = true
			var index int
			fmt.Sscanf(string(stop.ActivityID), "activity-%d", &index)
			next := 0
			if index >= 6 {
				next = 1
			}
			if group != -1 && group != next {
				t.Fatal("mixed neighborhoods")
			}
			group = next
		}
		elapsed := *day.Totals.ElapsedDurationSec
		minTime = math.Min(minTime, elapsed)
		maxTime = math.Max(maxTime, elapsed)
		if day.Feasibility == "infeasible" {
			t.Fatal("infeasible day")
		}
	}
	if len(seen) != 10 || maxTime-minTime > 120 {
		t.Fatal("unbalanced or missing choices")
	}
}

func TestManualBalanceUsesVisitDurationInsteadOfOnlyCount(t *testing.T) {
	input := secondDay(sample(t))
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	input.Selections = nil
	for i := 0; i < 8; i++ {
		input.Selections = append(input.Selections, c.Selection{ActivityID: c.ID(fmt.Sprintf("activity-%d", i)), PlaceID: c.ID(fmt.Sprintf("place-%d", i))})
	}
	view := NewDraft("balanced-duration", input, time.Now())
	response := mlResponse(t, view, 8)
	for i := range response.Candidates {
		response.Candidates[i].Place.Location.Coordinates = routing.Position{44.005, 56.32}
		response.Candidates[i].Activity.Duration.DurationSec = 600
	}
	response.Candidates[0].Activity.Duration.DurationSec = 3600
	p := Planner{Router: &testRouter{}, Source: fixedSource{response: response}}
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Days[0].Stops) == len(result.Days[1].Stops) {
		t.Fatal("balanced counts instead of time")
	}
	left := *result.Days[0].Totals.ElapsedDurationSec / dailyTimeBudget(input.Days[0])
	right := *result.Days[1].Totals.ElapsedDurationSec / dailyTimeBudget(input.Days[1])
	if math.Abs(left-right) > 0.08 {
		t.Fatalf("uneven utilization %.3f / %.3f", left, right)
	}
	total := 0
	for _, day := range result.Days {
		total += len(day.Stops)
	}
	if total != 8 {
		t.Fatal("lost choices")
	}
}

func TestDistantChoiceFitsWhenActualTravelTimeFits(t *testing.T) {
	input := secondDay(sample(t))
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	cap := 5000.0
	input.LoadLimits.MaxWalkDistanceMPerDay = &cap
	for i := range input.Days {
		input.Days[i].AvailableWindow = nil
		input.Days[i].DurationBudgetSec = 40000
		input.Days[i].StartPoint.Coordinates = routing.Position{44.0066, 56.3273}
		input.Days[i].EndPoint = input.Days[i].StartPoint
	}
	input.Selections = []c.Selection{{ActivityID: "activity-0", PlaceID: "place-0"}, {ActivityID: "activity-1", PlaceID: "place-1"}}
	view := NewDraft("distant-time", input, time.Now())
	response := mlResponse(t, view, 2)
	response.Candidates[0].Place.Location.Coordinates = routing.Position{44.007, 56.3273}
	response.Candidates[1].Place.Location.Coordinates = routing.Position{43.838947, 56.344366}
	p := Planner{Router: geographicRouter{}, Source: fixedSource{response: response}}
	result, err := p.Build(context.Background(), view, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	seen := map[c.ID]bool{}
	for _, day := range result.Days {
		for _, stop := range day.Stops {
			seen[stop.ActivityID] = true
		}
	}
	if !seen["activity-1"] {
		t.Fatal("distance cap rejected time-fitting choice")
	}
}
