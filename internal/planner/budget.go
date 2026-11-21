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
	CompletionPolicy             c.CompletionPolicy `json:"completion_policy"`
	PolicyVersion                string             `json:"policy_version"`
	DailyWalkLimitMByAge         map[int]float64    `json:"daily_walk_limit_m_by_age"`
	WalkingSpeedKPHByPace        map[string]float64 `json:"walking_speed_kph_by_pace"`
	DefaultMealCount             int                `json:"default_meal_count"`
	DefaultMealFormat            string             `json:"default_meal_format"`
	MealDurationSecByFormat      map[string]float64 `json:"meal_duration_sec_by_format"`
	RestaurantWalkReserveMPerDay float64            `json:"restaurant_walk_reserve_m_per_day"`
}

var budgetDefaults = loadBudgetParameters()

// WalkingSpeedKPH uses the same product policy in search previews and day plans.
func WalkingSpeedKPH(pace string) float64 { return budgetDefaults.WalkingSpeedKPHByPace[pace] }

func loadBudgetParameters() budgetParameters {
	var parameters budgetParameters
	if err := json.Unmarshal(defaultsJSON, &parameters); err != nil {
		panic(err)
	}
	if parameters.PolicyVersion == "" || parameters.DefaultMealCount < 0 || parameters.DefaultMealCount > 10 || !finite(parameters.RestaurantWalkReserveMPerDay) || parameters.RestaurantWalkReserveMPerDay < 0 {
		panic("invalid planning defaults")
	}
	if parameters.CompletionPolicy.ManualLimitPerDay != 2 || parameters.CompletionPolicy.ShortDayRatio <= 0 || parameters.CompletionPolicy.ShortDayRatio > 1 || parameters.CompletionPolicy.SupplementRadiusM <= 0 {
		panic("invalid completion policy")
	}
	for age := 3; age <= 11; age++ {
		if v := parameters.DailyWalkLimitMByAge[age]; !finite(v) || v <= 0 {
			panic("invalid age walking default")
		}
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
	if input.LoadLimits.MaxWalkDistanceMPerDay == nil && len(input.Family.Children) > 0 {
		limit := math.Inf(1)
		for _, child := range input.Family.Children {
			value, ok := budgetDefaults.DailyWalkLimitMByAge[child.AgeYears]
			if !ok {
				return input
			}
			limit = math.Min(limit, value)
		}
		input.LoadLimits.MaxWalkDistanceMPerDay = &limit
	}
	if input.LoadLimits.RestaurantWalkReserveMPerDay == nil {
		value := budgetDefaults.RestaurantWalkReserveMPerDay
		input.LoadLimits.RestaurantWalkReserveMPerDay = &value
	}
	input.Days = append([]c.DayInput{}, input.Days...)
	for i := range input.Days {
		day := &input.Days[i]
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

func dailyWalkLimit(input c.TripInput, day c.DayInput) float64 {
	limit := *input.LoadLimits.MaxWalkDistanceMPerDay
	if day.MaxWalkDistanceM != nil {
		limit = math.Min(limit, *day.MaxWalkDistanceM)
	}
	return limit
}

// Inputs/outputs use meters and seconds. P is deducted once, after the min.
func primaryWalkingBudget(limitM, speedKPH, daySec, visitsSec, mealsSec, restSec, waitSec, reserveM float64) (primaryM, walkSec, timeLimitedM float64) {
	walkSec = math.Max(0, daySec-visitsSec-mealsSec-restSec-waitSec)
	timeLimitedM = speedKPH * 1000 * walkSec / 3600
	primaryM = math.Max(0, math.Min(limitM, timeLimitedM)-reserveM)
	return
}
