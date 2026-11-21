package planner

import (
	"context"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

func TestAutomaticAgeAndMealDefaultsDoNotMutateInput(t *testing.T) {
	input := sample(t)
	input.LoadLimits.MaxWalkDistanceMPerDay = nil
	input.LoadLimits.RestaurantWalkReserveMPerDay = nil
	input.Days[0].MealDurationSec = nil
	input.Days[0].MealCount = nil
	input.Days[0].MealFormat = nil
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	view, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if view.Input.LoadLimits.MaxWalkDistanceMPerDay != nil || view.Days[0].Totals.MealDurationSec != 0 || *view.Days[0].Totals.WalkingSpeedKPH != 2.5 || *view.Days[0].Totals.BudgetPolicyVersion != "family-time-v3" {
		t.Fatal("incorrect resolved parameters")
	}
	if input.LoadLimits.MaxWalkDistanceMPerDay != nil || input.Days[0].MealDurationSec != nil || input.Days[0].MealCount != nil {
		t.Fatal("defaults mutated caller input")
	}
}

func TestMealCountFormatAndExplicitOverride(t *testing.T) {
	input := sample(t)
	input.Days[0].MealDurationSec = nil
	count, format := 2, "quick_service"
	input.Days[0].MealCount = &count
	input.Days[0].MealFormat = &format
	resolved := resolveBudgetDefaults(input)
	if *resolved.Days[0].MealDurationSec != 7200 {
		t.Fatal("meal count and format ignored")
	}
	override := 1800.0
	input.Days[0].MealDurationSec = &override
	if got := *resolveBudgetDefaults(input).Days[0].MealDurationSec; got != 1800 {
		t.Fatal("explicit meal override ignored")
	}
	count = 0
	input.Days[0].MealDurationSec = nil
	if got := *resolveBudgetDefaults(input).Days[0].MealDurationSec; got != 0 {
		t.Fatal("zero meals not supported")
	}
}

func TestLegacyMealAndRestReservesDoNotReduceVisits(t *testing.T) {
	input := sample(t)
	input.Days[0].DurationBudgetSec = 7200
	input.Days[0].MealDurationSec = nil
	p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
	short, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	format := "meal_with_play"
	input.Days[0].MealFormat = &format
	legacyMeal := 6300.0
	input.Days[0].MealDurationSec = &legacyMeal
	input.Days[0].RestBudgetSec = 1200
	long, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(short.Days[0].Stops) != 3 || len(long.Days[0].Stops) != 3 || *short.Days[0].Totals.ElapsedDurationSec != *long.Days[0].Totals.ElapsedDurationSec {
		t.Fatalf("invisible reservation affected plan: %d vs %d", len(short.Days[0].Stops), len(long.Days[0].Stops))
	}
}

func TestKnownMealAndRestStopsAreNotReservedTwice(t *testing.T) {
	input := sample(t)
	meal, rest := 900.0, 700.0
	input.Days[0].MealDurationSec = &meal
	input.Days[0].RestBudgetSec = rest
	activities := DemoActivities()[:2]
	metadata := map[c.ID]c.Candidate{}
	a, b := c.Candidate{}, c.Candidate{}
	a.Activity.Kind = "meal"
	b.Activity.Kind = "rest"
	metadata[activities[0].ID] = a
	metadata[activities[1].ID] = b
	input.Selections = []c.Selection{{PlaceID: activities[0].PlaceID, ActivityID: activities[0].ID}, {PlaceID: activities[1].PlaceID, ActivityID: activities[1].ID}}
	p := Planner{Router: &testRouter{}, Activities: activities, metadata: metadata}
	view, err := p.buildDay(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// Explicit meal=600 and rest=900; legacy reserves add no time.
	totals := view.Days[0].Totals
	if totals.VisitDurationSec != 0 || totals.MealDurationSec != 600 || totals.RestDurationSec != 900 || *totals.ElapsedDurationSec != 1680 {
		t.Fatalf("double-counted breaks: %+v", totals)
	}
}
