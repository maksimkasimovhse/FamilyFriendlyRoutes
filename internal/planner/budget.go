package planner

import (
	_ "embed"
	"encoding/json"
	"math"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

//go:embed planning_defaults.json
var defaultsJSON []byte

type budgetParameters struct {
	MinAutoStopsPerDay      int                `json:"min_auto_stops_per_day"`
	CompletionPolicy        c.CompletionPolicy `json:"completion_policy"`
	PolicyVersion           string             `json:"policy_version"`
	WalkingSpeedKPHByPace   map[string]float64 `json:"walking_speed_kph_by_pace"`
	DefaultMealCount        int                `json:"default_meal_count"`
	DefaultMealFormat       string             `json:"default_meal_format"`
	MealDurationSecByFormat map[string]float64 `json:"meal_duration_sec_by_format"`
}

var budgetDefaults = loadBudgetParameters()

// WalkingSpeedKPH uses the same product policy in search previews and day plans.
func WalkingSpeedKPH(pace string) float64 { return budgetDefaults.WalkingSpeedKPHByPace[pace] }

func loadBudgetParameters() budgetParameters {
	var parameters budgetParameters
	if err := json.Unmarshal(defaultsJSON, &parameters); err != nil {
		panic(err)
	}
	if parameters.MinAutoStopsPerDay < 1 || parameters.MinAutoStopsPerDay > CandidateLimit || parameters.PolicyVersion == "" || parameters.DefaultMealCount < 0 || parameters.DefaultMealCount > 10 {
		panic("invalid planning defaults")
	}
	if parameters.CompletionPolicy.ManualLimitPerDay != 0 || parameters.CompletionPolicy.ShortDayRatio <= 0 || parameters.CompletionPolicy.ShortDayRatio > 1 || parameters.CompletionPolicy.SupplementRadiusM <= 0 {
		panic("invalid completion policy")
	}
	for _, pace := range []string{"relaxed", "standard", "intensive"} {
		v := parameters.WalkingSpeedKPHByPace[pace]
		if !finite(v) || v < 0.5 || v > 8 {
			panic("invalid walking speed default")
		}
	}
	for _, format := range []string{"quick_service", "table_service", "meal_with_play"} {
		v, ok := parameters.MealDurationSecByFormat[format]
		if !ok || !finite(v) || v < 0 || v > 86400 {
			panic("invalid meal duration default")
		}
	}
	if _, ok := parameters.MealDurationSecByFormat[parameters.DefaultMealFormat]; !ok {
		panic("invalid default meal format")
	}
	return parameters
}

// Resolve on copies: defaults must not mutate an input or a saved preview base.
func resolveBudgetDefaults(input c.TripInput) c.TripInput {
	// Deprecated distance caps must not constrain new or previously saved trips.
	input.LoadLimits.MaxWalkDistanceMPerDay = nil
	input.LoadLimits.MaxContinuousWalkDurationSec = nil
	input.LoadLimits.RestaurantWalkReserveMPerDay = nil
	input.Days = append([]c.DayInput{}, input.Days...)
	for i := range input.Days {
		day := &input.Days[i]
		day.MaxWalkDistanceM = nil
		if day.MealCount == nil {
			value := budgetDefaults.DefaultMealCount
			day.MealCount = &value
		}
		if day.MealFormat == nil {
			value := budgetDefaults.DefaultMealFormat
			day.MealFormat = &value
		}
		if day.MealDurationSec == nil {
			value := float64(*day.MealCount) * budgetDefaults.MealDurationSecByFormat[*day.MealFormat]
			day.MealDurationSec = &value
		}
	}
	return input
}

func dailyTimeBudget(day c.DayInput) float64 {
	budget := day.DurationBudgetSec
	if day.AvailableWindow != nil {
		start, _ := time.Parse(time.RFC3339, string(day.AvailableWindow.StartAt))
		end, _ := time.Parse(time.RFC3339, string(day.AvailableWindow.EndAt))
		budget = math.Min(budget, end.Sub(start).Seconds())
	}
	return budget
}
