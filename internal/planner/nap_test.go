package planner

import (
	"context"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"math"
	"testing"
	"time"
)

func napFixture(t *testing.T) (Planner, c.TripInput, time.Time) {
	t.Helper()
	input := sample(t)
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	input.Days[0].DurationBudgetSec = 1800
	input.Days[0].Nap = &c.NapBreak{Window: c.Interval{StartAt: "2030-06-15T13:00:00+03:00", EndAt: "2030-06-15T15:00:00+03:00"}, Location: input.Days[0].StartPoint}
	input.Family.Nap = &c.NapPreference{StartTime: "13:00", EndTime: "15:00"}
	input.Selections = []c.Selection{{ActivityID: "demo-1", PlaceID: "demo-place-1"}, {ActivityID: "demo-2", PlaceID: "demo-place-2"}}
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	return Planner{Router: &testRouter{}, Activities: DemoActivities()}, input, now
}
func TestNapAnchorAndLatestStartUseRealLegsWithoutSpendingOutingBudget(t *testing.T) {
	p, input, now := napFixture(t)
	v, err := p.Build(context.Background(), NewDraft("nap", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	day := v.Days[0]
	if day.Nap == nil || len(day.Stops) != 3 || day.Feasibility == "infeasible" {
		t.Fatalf("invalid nap plan: %+v", day)
	}
	if *day.Totals.OutingDurationSec > 1800 || *day.Totals.ElapsedDurationSec <= 1800 || *day.Totals.NapDurationSec != 7200 {
		t.Fatal("nap consumed outing time or disappeared")
	}
	index := -1
	for i, s := range day.Stops {
		if stopKind(s) == "nap" {
			index = i
			if !s.Mandatory || s.Location.Coordinates != input.Days[0].Nap.Location.Coordinates {
				t.Fatal("unprotected/wrong lodging")
			}
			a, _ := parseInstant(*s.Timing.EstimatedArrivalAt)
			start, _ := parseInstant(input.Days[0].Nap.Window.StartAt)
			if a.After(start) {
				t.Fatal("late return")
			}
		}
	}
	if index != 1 {
		t.Fatalf("expected morning and afternoon activity around nap, got %d", index)
	}
	if !refMatches(day.Legs[index].To, day.Stops[index].StopID) || !refMatches(day.Legs[index+1].From, day.Stops[index].StopID) {
		t.Fatal("OSM return/exit disconnected from nap")
	}
	latest, _ := parseInstant(day.Nap.LatestStartAt)
	napAt, _ := parseInstant(input.Days[0].Nap.Window.StartAt)
	beforeSec := day.Stops[0].Duration.DurationSec + *day.Legs[0].TravelDurationSec + *day.Legs[1].TravelDurationSec
	expected := napAt.Add(-time.Duration(beforeSec * float64(time.Second)))
	if math.Abs(latest.Sub(expected).Seconds()) > 60 {
		t.Fatalf("latest start %s, expected around %s", latest, expected)
	}
	if len(input.Selections) != 2 || input.Days[0].AvailableWindow.StartAt != "2030-06-15T10:00:00+03:00" {
		t.Fatal("mutated input")
	}
}
func refMatches(raw c.StopRef, id c.ID) bool { return string(raw) == string(ref("stop", id)) }
func TestNapRepeatsOnlyOnEnabledDaysAndIsNotAnMLChoice(t *testing.T) {
	p, input, now := napFixture(t)
	input = secondDay(input)
	input.Days[1].Nap = nil
	input.Selections = nil
	for _, a := range DemoActivities() {
		input.Selections = append(input.Selections, c.Selection{ActivityID: a.ID, PlaceID: a.PlaceID})
	}
	v, err := p.Build(context.Background(), NewDraft("nap-days", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	naps := 0
	for _, d := range v.Days {
		for _, s := range d.Stops {
			if stopKind(s) == "nap" {
				naps++
				if d.Date != "2030-06-15" {
					t.Fatal("nap added to disabled day")
				}
			}
		}
	}
	if naps != 1 || len(v.Input.Selections) != 3 {
		t.Fatal("nap affected manual choices")
	}
}
func TestNapLatestStartRespectsMuseumClosing(t *testing.T) {
	_, input, now := napFixture(t)
	view := NewDraft("nap-hours", input, now)
	response := mlResponse(t, view, 2)
	response.Candidates[0].Activity.Duration.DurationSec = 600
	response.Candidates[1].Activity.Duration.DurationSec = 900
	for i := range input.Selections {
		input.Selections[i] = c.Selection{ActivityID: response.Candidates[i].Activity.ActivityID, PlaceID: response.Candidates[i].Place.PlaceID}
	}
	response.Candidates[0].Availability[0].State = "open"
	response.Candidates[0].Availability[0].VisitWindows = []c.Interval{{StartAt: "2030-06-15T10:00:00+03:00", EndAt: "2030-06-15T12:00:00+03:00"}}
	response.Candidates[1].Availability[0].State = "open"
	response.Candidates[1].Availability[0].VisitWindows = []c.Interval{{StartAt: "2030-06-15T15:00:00+03:00", EndAt: "2030-06-15T17:00:00+03:00"}}
	p := Planner{Router: &testRouter{}, Source: fixedSource{response: response}}
	view.Input = input
	v, err := p.Build(context.Background(), view, now)
	if err != nil {
		t.Fatal(err)
	}
	d := v.Days[0]
	if d.Feasibility == "infeasible" || len(d.Stops) != 3 {
		t.Fatalf("museum hours lost: %+v", d.Warnings)
	}
	latest, _ := parseInstant(d.Nap.LatestStartAt)
	if latest.Hour() != 11 || latest.Minute() < 48 || latest.Minute() > 49 {
		t.Fatalf("closing did not constrain start: %s", latest)
	}
}
func TestLateNapStartAndReplanAfterSleepPreserveHistoryAndOutingTime(t *testing.T) {
	p, input, now := napFixture(t)
	v, err := p.Build(context.Background(), NewDraft("late-nap", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	now = time.Date(2030, 6, 15, 12, 59, 0, 0, now.Location())
	date, point, start := v.Days[0].Date, v.Days[0].StartPoint, instant(now)
	active, err := p.Change(context.Background(), v, ChangeCommand{Kind: "start_day", Date: &date, Point: &point, StartAt: &start}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	d := active.Days[0]
	if d.Feasibility == "infeasible" || stopKind(d.Stops[0]) != "nap" {
		t.Fatalf("late start did not move visits after sleep: %+v", d.Warnings)
	}
	if !ActivePreviewFresh(d, active.Input.Days[0], now) {
		t.Fatal("sleep incorrectly exhausted outing budget")
	}
	early := time.Date(2030, 6, 15, 14, 59, 0, 0, now.Location())
	request := c.ProgressRequest{ExpectedVersion: active.Version, Date: date, StopID: d.Stops[0].StopID, Status: "visited", ObservedAt: instant(early)}
	if _, err = RecordProgress(active, request, early); err == nil {
		t.Fatal("nap marked finished early")
	}
	now = early.Add(time.Minute)
	request.ObservedAt = instant(now)
	progressed, err := RecordProgress(active, request, now)
	if err != nil {
		t.Fatal(err)
	}
	next, err := p.Change(context.Background(), progressed, ChangeCommand{Kind: "replan_day", Date: &date}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	d = next.Days[0]
	if d.Feasibility == "infeasible" || d.Stops[0].Progress != "visited" || *d.Totals.OutingDurationSec > 1800 || *d.Totals.NapDurationSec != 7200 {
		t.Fatalf("history/budget lost: %+v", d.Totals)
	}
	count := 0
	for _, s := range d.Stops {
		if stopKind(s) == "nap" {
			count++
		}
	}
	if count != 1 {
		t.Fatal("nap duplicated on replan")
	}
}
func TestNapValidation(t *testing.T) {
	_, input, _ := napFixture(t)
	input.Family.Nap.StartTime = "16:00"
	if Validate(input) == nil {
		t.Fatal("reversed preference accepted")
	}
	input.Family.Nap = nil
	input.Days[0].Nap.Window.EndAt = "2030-06-16T15:00:00+03:00"
	if Validate(input) == nil {
		t.Fatal("overnight nap accepted")
	}
}

func TestNapPrefersVisitsOnBothSidesWhenBothAreFeasible(t *testing.T) {
	p, input, now := napFixture(t)
	input.Days[0].DurationBudgetSec = 10800
	p.Router = geographicRouter{}
	p.Activities = append([]Activity{}, DemoActivities()[:2]...)
	for i := range p.Activities {
		p.Activities[i].Point = input.Days[0].StartPoint
		p.Activities[i].Point.Coordinates[0] += 0.01 + float64(i)*0.00001
	}
	view, err := p.Build(context.Background(), NewDraft("nap-both-sides", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	day := view.Days[0]
	if len(day.Stops) != 3 || stopKind(day.Stops[1]) != "nap" || day.Feasibility == "infeasible" {
		t.Fatal("one-sided route chosen although both sides fit")
	}
}
