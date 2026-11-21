package planner

import (
	"context"
	"reflect"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

func TestUrgentInfrastructureFirstPreservesOtherDaysAndInput(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	input := secondDay(sample(t))
	view := NewDraft("urgent", input, now)
	p := Planner{Router: &testRouter{}, Activities: DemoActivities(), Infrastructure: func(_ context.Context, id c.ID) (c.Place, error) {
		return c.Place{PlaceID: id, Name: "Аптека у Кремля", Categories: []c.Category{"pharmacy"}, Location: routing.Point{Coordinates: routing.Position{44.01, 56.32}}}, nil
	}}
	view, err := p.Build(ctx, view, now)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := cloneView(view)
	id := c.ID("123")
	date := view.Days[0].Date
	updated, err := p.Change(ctx, view, ChangeCommand{Kind: "insert_infrastructure_stop", Date: &date, PlaceID: &id}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Days[0].Stops[0].PlaceID != id || updated.Days[0].Stops[0].Duration.DurationSec != 900 {
		t.Fatal("urgent object must be the next stop with a server-side duration")
	}
	if !reflect.DeepEqual(updated.Days[1], before.Days[1]) || !reflect.DeepEqual(view, before) {
		t.Fatal("another day or the source view was mutated")
	}
	if len(updated.Days[0].Stops) != len(before.Days[0].Stops)+1 {
		t.Fatal("existing stops were dropped")
	}
	_, err = p.Change(ctx, updated, ChangeCommand{Kind: "insert_infrastructure_stop", Date: &date, PlaceID: &id}, nil, nil, now)
	if err == nil {
		t.Fatal("duplicate infrastructure stop accepted")
	}
}

func TestUrgentActiveGPSAccountsMovementAndPreservesHistory(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800))
	input := sample(t)
	p := Planner{Router: &testRouter{}, Activities: DemoActivities(), Infrastructure: func(_ context.Context, id c.ID) (c.Place, error) {
		return c.Place{PlaceID: id, Name: "Туалет", Categories: []c.Category{"toilet"}, Location: input.Days[0].StartPoint}, nil
	}}
	view, err := p.Build(ctx, NewDraft("urgent-active", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	date, point, start := input.Days[0].Date, input.Days[0].StartPoint, instant(now)
	view, err = p.Change(ctx, view, ChangeCommand{Kind: "start_day", Date: &date, Point: &point, StartAt: &start}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(10 * time.Minute)
	view, err = RecordProgress(view, c.ProgressRequest{ExpectedVersion: view.Version, Date: date, StopID: view.Days[0].Stops[0].StopID, Status: "visited", ObservedAt: instant(now)}, now)
	if err != nil {
		t.Fatal(err)
	}
	history := view.Days[0].Stops[0]
	spent := view.Days[0].Execution.ConsumedWalkDistanceM
	gps := routing.Point{Coordinates: routing.Position{44.014, 56.322}}
	id := c.ID("wc")
	at := instant(now.Add(time.Minute))
	updated, err := p.Change(ctx, view, ChangeCommand{Kind: "insert_infrastructure_stop", Date: &date, PlaceID: &id}, &gps, &at, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(updated.Days[0].Stops[0], history) || updated.Days[0].Stops[1].PlaceID != id {
		t.Fatal("visited stop changed or urgent stop not next")
	}
	if updated.Days[0].Execution.CurrentPoint.Coordinates != gps.Coordinates || updated.Days[0].Execution.ConsumedWalkDistanceM <= spent {
		t.Fatal("movement to GPS not accounted")
	}
	if len(updated.Days[0].Execution.CompletedLegIDS) != 2 {
		t.Fatal("confirmed leg history or GPS leg missing")
	}
}

func TestTextRouteEditUsesPreviewCommandsAndRejectsUnknownRequests(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	input := sample(t)
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	view, err := p.Build(ctx, NewDraft("text-edit", input, now), now)
	if err != nil {
		t.Fatal(err)
	}
	date := view.Days[0].Date
	text := "убери последнюю точку"
	updated, err := p.Change(ctx, view, ChangeCommand{Kind: "edit_route", Date: &date, Text: &text}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.Days[0].Stops) != len(view.Days[0].Stops)-1 {
		t.Fatal("text command did not remove the last stop")
	}
	text = "придумай несуществующий музей"
	if _, err := p.Change(ctx, view, ChangeCommand{Kind: "edit_route", Date: &date, Text: &text}, nil, nil, now); err == nil {
		t.Fatal("unsupported request silently accepted")
	}
}
