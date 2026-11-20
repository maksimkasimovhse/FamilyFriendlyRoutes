package planner

import (
	"context"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

type forbiddenSource struct{}

func (forbiddenSource) CatalogVersion() string { return "snapshot-v1" }
func (forbiddenSource) Recommend(context.Context, c.TripView) (c.RecommendationResponse, error) {
	panic("active replan must not call ML")
}

func TestActiveReplanUsesSavedAvailabilityAndDoesNotCallML(t *testing.T) {
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	input := sample(t)
	view := NewDraft("trip", input, now)
	view.CatalogVersion = "snapshot-v1"
	response := mlResponse(t, view, 1)
	response.Candidates[0].Availability[0].State = "open"
	response.Candidates[0].Availability[0].VisitWindows = []c.Interval{{StartAt: "2030-06-15T11:00:00+03:00", EndAt: "2030-06-15T12:00:00+03:00"}}
	p := Planner{Router: &testRouter{}, Source: fixedSource{response}}
	planned, err := p.Build(context.Background(), view, now)
	if err != nil {
		t.Fatal(err)
	}
	if planned.Days[0].Stops[0].Availability == nil {
		t.Fatal("availability snapshot not persisted")
	}
	planned.Warnings = append(planned.Warnings, Warning("ML_PARTIAL", "Часть исходных данных недоступна."))
	p.Source = forbiddenSource{}
	date, point, start := input.Days[0].Date, input.Days[0].StartPoint, instant(now)
	active, err := p.Change(context.Background(), planned, ChangeCommand{Kind: "start_day", Date: &date, Point: &point, StartAt: &start}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if string(*active.Days[0].Stops[0].Timing.EstimatedVisitStartAt) != "2030-06-15T11:00:00+03:00" {
		t.Fatal("lost opening window")
	}
	for _, warning := range active.Warnings {
		if warning.Code == "DEMO_CATALOG" || warning.Code == "OPENING_HOURS_UNKNOWN" {
			t.Fatal("real catalog mislabeled as demo")
		}
	}
	found := false
	for _, warning := range active.Warnings {
		if warning.Code == "ML_PARTIAL" {
			found = true
		}
	}
	if !found {
		t.Fatal("active replan lost provider-level warning")
	}
	now = now.Add(55 * time.Minute)
	replanned, err := p.Change(context.Background(), active, ChangeCommand{Kind: "replan_day", Date: &date}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if *replanned.Days[0].Totals.WaitDurationSec != 240 || replanned.Days[0].Execution.ElapsedDurationSec != 3300 {
		t.Fatal("waiting and spent time were charged twice")
	}
	now = now.Add(time.Hour)
	late, err := p.Change(context.Background(), replanned, ChangeCommand{Kind: "replan_day", Date: &date}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if late.Days[0].Feasibility != "infeasible" {
		t.Fatal("replan ignored saved closing time")
	}
}

func TestActivePreviewChecksDeadlineWhileUserReviews(t *testing.T) {
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	day := c.DayPlan{Execution: &c.DayExecution{ObservedAt: instant(now)}}
	duration := 3600.0
	day.Totals.ElapsedDurationSec = &duration
	input := c.DayInput{DurationBudgetSec: 3600}
	if !ActivePreviewFresh(day, input, now) || ActivePreviewFresh(day, input, now.Add(time.Second)) {
		t.Fatal("review delay did not invalidate exhausted time budget")
	}
}
