package planner

import (
	"context"
	"encoding/json"
	"math"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"testing"
	"time"
)

type distanceRouter struct{}

func (distanceRouter) Route(_ context.Context, request routing.Request) (routing.Result, error) {
	dx := request.To.Coordinates[0] - request.From.Coordinates[0]
	dy := request.To.Coordinates[1] - request.From.Coordinates[1]
	distance := math.Hypot(dx, dy) * 100000
	return routing.Result{Mode: "walk", Status: "calculated", DistanceM: distance, TravelDurationSec: distance / 1.2, Geometry: routing.LineString{Type: "LineString", Coordinates: []routing.Position{request.From.Coordinates, request.To.Coordinates}}, RoutingDataVersion: "distance-test"}, nil
}

func TestShortenAndReturnPreserveMandatoryAndSnapshot(t *testing.T) {
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	input := sample(t)
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	view, err := p.Build(context.Background(), NewDraft("trip", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	view.Days[0].Stops[0].Mandatory = true
	before, _ := json.Marshal(view)
	date := view.Days[0].Date
	target := 1000.0
	shortened, err := p.Change(context.Background(), view, ChangeCommand{Kind: "shorten_day", Date: &date, TargetRemainingDurationSec: &target}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(shortened.Days[0].Stops) != 1 || !shortened.Days[0].Stops[0].Mandatory || *shortened.Days[0].Totals.ElapsedDurationSec > target {
		t.Fatalf("invalid shortened day: %+v", shortened.Days[0])
	}
	after, _ := json.Marshal(view)
	if string(before) != string(after) {
		t.Fatal("preview mutated original")
	}
	tiny := 60.0
	infeasible, err := p.Change(context.Background(), view, ChangeCommand{Kind: "return_to_hotel", Date: &date, HotelPoint: &view.Days[0].EndPoint, TargetRemainingDurationSec: &tiny}, nil, nil, now)
	if err != nil || infeasible.Days[0].Feasibility != "infeasible" || len(infeasible.Days[0].Stops) != 1 {
		t.Fatalf("mandatory stop hidden: %v", err)
	}
}

func TestMoveReorderReplaceAndInsert(t *testing.T) {
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	input := sample(t)
	second := input.Days[0]
	second.Date = "2030-06-16"
	second.AvailableWindow = &c.Interval{StartAt: "2030-06-16T10:00:00+03:00", EndAt: "2030-06-16T17:00:00+03:00"}
	input.Days = append(input.Days, second)
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	view, err := p.Build(context.Background(), NewDraft("trip", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	// Use one known day so these assertions are independent of cluster assignment.
	single := input
	single.Days = single.Days[:1]
	one, err := p.Build(context.Background(), NewDraft("one", single, now), now)
	if err != nil {
		t.Fatal(err)
	}
	date := one.Days[0].Date
	ids := []c.ID{}
	for index := len(one.Days[0].Stops) - 1; index >= 0; index-- {
		ids = append(ids, one.Days[0].Stops[index].StopID)
	}
	reordered, err := p.Change(context.Background(), one, ChangeCommand{Kind: "reorder_stops", Date: &date, StopIDS: ids}, nil, nil, now)
	if err != nil || reordered.Days[0].Stops[0].StopID != ids[0] {
		t.Fatalf("reorder: %v", err)
	}
	if _, err = p.Change(context.Background(), one, ChangeCommand{Kind: "reorder_stops", Date: &date, StopIDS: ids[:1]}, nil, nil, now); err == nil {
		t.Fatal("accepted incomplete order")
	}
	removed := one.Days[0].Stops[1]
	less, err := p.Change(context.Background(), one, ChangeCommand{Kind: "remove_stop", Date: &date, StopID: &removed.StopID}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	selection := c.Selection{PlaceID: removed.PlaceID, ActivityID: removed.ActivityID}
	added, err := p.Change(context.Background(), less, ChangeCommand{Kind: "add_activity", Date: &date, Selection: &selection}, nil, nil, now)
	if err != nil || len(added.Days[0].Stops) != 3 || added.Days[0].Feasibility == "infeasible" {
		t.Fatalf("insert: %v", err)
	}
	replaced, err := p.Change(context.Background(), less, ChangeCommand{Kind: "replace_stop", Date: &date, StopID: &less.Days[0].Stops[0].StopID, Selection: &selection}, nil, nil, now)
	if err != nil || len(replaced.Days[0].Stops) != 2 {
		t.Fatalf("replace: %v", err)
	}
	var from, to c.ISODate
	var id c.ID
	for _, day := range view.Days {
		if len(day.Stops) > 0 {
			from = day.Date
			id = day.Stops[0].StopID
			break
		}
	}
	for _, day := range view.Days {
		if day.Date != from {
			to = day.Date
			break
		}
	}
	moved, err := p.Change(context.Background(), view, ChangeCommand{Kind: "move_stop", Date: &from, TargetDate: &to, StopID: &id}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if moved.Version != view.Version+1 {
		t.Fatal("move incremented version twice")
	}
	found := false
	for _, day := range moved.Days {
		for _, stop := range day.Stops {
			if stop.StopID == id {
				found = true
				if day.Date != to {
					t.Fatal("not moved")
				}
			}
		}
	}
	if !found {
		t.Fatal("lost moved stop")
	}
}

func TestAddActivityUsesShortestFeasibleInsertion(t *testing.T) {
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	input := sample(t)
	p := Planner{Router: distanceRouter{}, Activities: DemoActivities()}
	view, err := p.Build(context.Background(), NewDraft("shortest-insert", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	removed := view.Days[0].Stops[1]
	date := view.Days[0].Date
	withoutMiddle, err := p.Change(context.Background(), view, ChangeCommand{Kind: "remove_stop", Date: &date, StopID: &removed.StopID}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	selection := c.Selection{PlaceID: removed.PlaceID, ActivityID: removed.ActivityID}
	added, err := p.Change(context.Background(), withoutMiddle, ChangeCommand{Kind: "add_activity", Date: &date, Selection: &selection}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := added.Days[0].Stops[1].StopID; got != removed.StopID {
		t.Fatalf("restaurant inserted at %s instead of shortest middle position", got)
	}
}

func TestActiveTimeCapKeepsHistoryAndChargesSpentTimeOnce(t *testing.T) {
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	input := sample(t)
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	view, err := p.Build(context.Background(), NewDraft("trip", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	date, point, start := view.Days[0].Date, view.Days[0].StartPoint, instant(now)
	active, err := p.Change(context.Background(), view, ChangeCommand{Kind: "start_day", Date: &date, Point: &point, StartAt: &start}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	first := active.Days[0].Stops[0]
	now, _ = parseInstant(*first.Timing.EstimatedDepartureAt)
	progressed, err := RecordProgress(active, c.ProgressRequest{ExpectedVersion: active.Version, Date: date, StopID: first.StopID, Status: "visited", ObservedAt: instant(now)}, now)
	if err != nil {
		t.Fatal(err)
	}
	walked := progressed.Days[0].Execution.ConsumedWalkDistanceM
	cap := 1500.0
	changed, err := p.Change(context.Background(), progressed, ChangeCommand{Kind: "shorten_day", Date: &date, TargetRemainingDurationSec: &cap}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if changed.Days[0].Stops[0].Progress != "visited" || changed.Days[0].Execution.ConsumedWalkDistanceM != walked || changed.Days[0].Totals.RemainingWalkDistanceM != nil {
		t.Fatal("history or walk accounting changed")
	}
	if *changed.Days[0].Totals.RemainingDurationSec > cap || changed.Days[0].Feasibility == "infeasible" {
		t.Fatal("remaining walk limit ignored")
	}
	if changed.Input.LoadLimits.MaxWalkDistanceMPerDay != nil {
		t.Fatal("temporary day cap changed family limits")
	}
}

func TestUnstartedTodayReplanRefreshesPastStart(t *testing.T) {
	zone := time.FixedZone("MSK", 10800)
	start := time.Date(2030, 6, 15, 10, 0, 0, 0, zone)
	input := sample(t)
	input.PlanningContext = "in_city"
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	view, err := p.Build(context.Background(), NewDraft("today-refresh", input, start), start)
	if err != nil {
		t.Fatal(err)
	}
	now := start.Add(time.Hour)
	date := view.Days[0].Date
	result, err := p.Change(context.Background(), view, ChangeCommand{Kind: "replan_day", Date: &date}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	updated, _ := parseInstant(result.Input.Days[0].AvailableWindow.StartAt)
	arrival, _ := parseInstant(*result.Days[0].Stops[0].Timing.EstimatedArrivalAt)
	if updated.Before(now) || arrival.Before(now) {
		t.Fatal("replan retained an arrival in the past")
	}
	if result.Input.Days[0].AvailableWindow.EndAt != view.Input.Days[0].AvailableWindow.EndAt {
		t.Fatal("replan extended the end time")
	}
	if view.Input.Days[0].AvailableWindow.StartAt != input.Days[0].AvailableWindow.StartAt {
		t.Fatal("original input was mutated")
	}
}
