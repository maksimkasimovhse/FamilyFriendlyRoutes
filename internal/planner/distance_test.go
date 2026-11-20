package planner

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

func TestRestaurantReserveChangesClusteringBudget(t *testing.T) {
	input := sample(t)
	limit, reserve := 400.0, 100.0
	input.LoadLimits.MaxWalkDistanceMPerDay = &limit
	input.LoadLimits.RestaurantWalkReserveMPerDay = &reserve
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	result, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	day := result.Days[0]
	// Each fake directed leg is 100m. Two stops and return consume exactly 300m.
	if len(day.Stops) != 2 || *day.Totals.WalkDistanceM != 300 || *day.Totals.WalkBudgetM != 400 || *day.Totals.RestaurantWalkReserveM != 100 || *day.Totals.PrimaryWalkBudgetM != 300 {
		t.Fatalf("incorrect m-p budget: %+v", day.Totals)
	}
	if result.Input.LoadLimits.RestaurantWalkReserveMPerDay == nil || *result.Input.LoadLimits.RestaurantWalkReserveMPerDay != 100 {
		t.Fatal("reserve lost")
	}
	input.LoadLimits.RestaurantWalkReserveMPerDay = nil
	without, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(without.Days[0].Stops) != 3 || *without.Days[0].Totals.WalkDistanceM != 400 {
		t.Fatal("omitted reserve should mean zero")
	}
}

func TestClusteringUsesVisitDurationAndDailyTimeBudget(t *testing.T) {
	input := secondDay(sample(t))
	limit := 300.0
	input.LoadLimits.MaxWalkDistanceMPerDay = &limit
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	first, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for i := range input.Days {
		input.Days[i].DurationBudgetSec = 1
	}
	changed := append([]Activity{}, p.Activities...)
	for i := range changed {
		changed[i].DurationSec = 10000
	}
	p.Activities = changed
	second, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ids := func(view c.TripView) [][]c.ID {
		result := [][]c.ID{}
		for _, day := range view.Days {
			row := []c.ID{}
			for _, stop := range day.Stops {
				row = append(row, stop.ActivityID)
			}
			result = append(result, row)
		}
		return result
	}
	if reflect.DeepEqual(ids(first), ids(second)) {
		t.Fatal("combined budget ignored visit duration and available time")
	}
	for _, day := range second.Days {
		if day.Feasibility != "infeasible" {
			t.Fatal("final time validation was skipped")
		}
	}
}

func TestMandatoryStopCannotConsumeRestaurantReserveSilently(t *testing.T) {
	input := sample(t)
	limit, reserve := 400.0, 250.0
	input.LoadLimits.MaxWalkDistanceMPerDay = &limit
	input.LoadLimits.RestaurantWalkReserveMPerDay = &reserve
	input.Selections = []c.Selection{{PlaceID: "demo-place-1", ActivityID: "demo-1", Mandatory: true}}
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()[:1]}
	view, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Days[0].Stops) != 1 || view.Days[0].Feasibility != "infeasible" || *view.Days[0].Totals.WalkDistanceM != 200 {
		t.Fatal("required stop hid reserved-distance violation")
	}
}

func TestWalkingBudgetValidation(t *testing.T) {
	for name, value := range map[string]float64{"negative": -1, "over_limit": 10001, "nan": math.NaN(), "inf": math.Inf(1)} {
		t.Run(name, func(t *testing.T) {
			input := sample(t)
			input.LoadLimits.RestaurantWalkReserveMPerDay = &value
			if !errors.Is(Validate(input), ErrValidation) {
				t.Fatal("invalid reserve accepted")
			}
		})
	}
	input := sample(t)
	input.LoadLimits.MaxWalkDistanceMPerDay = nil
	if err := Validate(input); err != nil {
		t.Fatal("missing walking limit should use age defaults", err)
	}
	limit := 10000.0
	input.LoadLimits.MaxWalkDistanceMPerDay = &limit
	input.LoadLimits.RestaurantWalkReserveMPerDay = &limit
	if err := Validate(input); err != nil {
		t.Fatal("zero remaining distance should be allowed", err)
	}
}
