package planner

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

// Legacy distance caps and restaurant reserves are accepted for compatibility,
// but can neither truncate a day nor make it infeasible.
func TestLegacyDistanceCapsDoNotLimitCapacity(t *testing.T) {
	for _, cap := range []float64{0, 1, 400, 100000} {
		input := sample(t)
		reserve := 100.0
		input.LoadLimits.MaxWalkDistanceMPerDay = &cap
		input.LoadLimits.RestaurantWalkReserveMPerDay = &reserve
		input.Days[0].MaxWalkDistanceM = &cap
		p := Planner{Router: &testRouter{}, Activities: DemoActivities()}
		result, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
		if err != nil {
			t.Fatal(err)
		}
		day := result.Days[0]
		if len(day.Stops) != 3 || day.Feasibility == "infeasible" || *day.Totals.WalkDistanceM != 400 {
			t.Fatalf("legacy cap affected time plan: %+v", day.Totals)
		}
		if day.Totals.WalkBudgetM != nil || day.Totals.PrimaryWalkBudgetM != nil || result.Input.LoadLimits.MaxWalkDistanceMPerDay != nil || result.Input.Days[0].MaxWalkDistanceM != nil {
			t.Fatal("distance budget still advertised")
		}
	}
}

func TestActualTravelTimeDeterminesFitNotDistanceConvertedToTime(t *testing.T) {
	input := sample(t)
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	input.Selections = []c.Selection{{ActivityID: "demo-1", PlaceID: "demo-place-1"}}
	input.Days[0].DurationBudgetSec = 1800
	activities := DemoActivities()[:1]
	activities[0].DurationSec = 600
	p := Planner{Router: timeOnlyRouter{}, Activities: activities}
	result, err := p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Days[0].Stops) != 1 || *result.Days[0].Totals.ElapsedDurationSec != 1800 || *result.Days[0].Totals.WalkDistanceM != 40000 {
		t.Fatal("time-fitting choice rejected by distance")
	}
	input.Days[0].DurationBudgetSec = 1799
	result, err = p.Build(context.Background(), NewDraft("trip", input, time.Now()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Days[0].Stops) != 0 {
		t.Fatal("time overflow accepted")
	}
}

type timeOnlyRouter struct{}

func (timeOnlyRouter) Route(ctx context.Context, request routing.Request) (routing.Result, error) {
	r, err := (&testRouter{}).Route(ctx, request)
	r.DistanceM = 20000
	r.TravelDurationSec = 600
	return r, err
}

func TestLegacyDistanceValidation(t *testing.T) {
	for _, value := range []float64{-1, math.NaN(), math.Inf(1)} {
		input := sample(t)
		input.LoadLimits.MaxWalkDistanceMPerDay = &value
		if !errors.Is(Validate(input), ErrValidation) {
			t.Fatal("invalid numeric legacy input accepted")
		}
	}
}
