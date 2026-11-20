package planner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

// This provider is explicitly for integration, not real venue recommendations.
type Activity struct {
	ID          c.ID          `json:"activity_id"`
	PlaceID     c.ID          `json:"place_id"`
	Title       string        `json:"title"`
	Point       routing.Point `json:"location"`
	DurationSec float64       `json:"duration_sec"`
	MinAge      int           `json:"age_min_years"`
	MaxAge      int           `json:"age_max_years"`
}

func DemoActivities() []Activity {
	return []Activity{
		{"demo-1", "demo-place-1", "DEMO: тестовая остановка 1", routing.Point{Coordinates: routing.Position{44.0095, 56.3286}}, 600, 3, 11},
		{"demo-2", "demo-place-2", "DEMO: тестовая остановка 2", routing.Point{Coordinates: routing.Position{44.0213, 56.3283}}, 900, 3, 11},
		{"demo-3", "demo-place-3", "DEMO: тестовая остановка 3", routing.Point{Coordinates: routing.Position{44.0430, 56.3220}}, 600, 3, 11},
	}
}

type Router interface {
	Route(context.Context, routing.Request) (routing.Result, error)
}
type Planner struct {
	Router     Router
	Activities []Activity
	Source     CandidateSource
	metadata   map[c.ID]c.Candidate
}

var ErrValidation = errors.New("trip validation failed")

func invalid(message string) error { return fmt.Errorf("%w: %s", ErrValidation, message) }
func Validate(input c.TripInput) error {
	if input.Selections == nil || input.Family.AdultInterestIDS == nil {
		return invalid("selections and adult_interest_ids must be arrays, not null")
	}
	if input.CityID != "nizhny_novgorod" || input.Timezone != "Europe/Moscow" {
		return invalid("city/timezone must be nizhny_novgorod / Europe/Moscow")
	}
	if input.PlanningContext != "before_arrival" && input.PlanningContext != "in_city" {
		return invalid("invalid planning_context")
	}
	if len(input.Days) < 1 || len(input.Days) > 14 {
		return invalid("trip must contain 1..14 days")
	}
	if len(input.Family.Children) < 1 || len(input.Family.Children) > 2 || input.Family.AdultCount < 1 {
		return invalid("demo supports 1..2 children and at least one adult")
	}
	ids := map[c.ID]bool{}
	for _, child := range input.Family.Children {
		if child.InterestIDS == nil {
			return invalid("interest_ids must be an array")
		}
		if child.ChildID == "" || ids[child.ChildID] || child.AgeYears < 3 || child.AgeYears > 11 {
			return invalid("child IDs must be unique; age 3..11")
		}
		ids[child.ChildID] = true
		if child.HeightCm != nil && (*child.HeightCm <= 0 || !finite(*child.HeightCm)) {
			return invalid("invalid height")
		}
	}
	input = resolveBudgetDefaults(input)
	if input.LoadLimits.MaxWalkDistanceMPerDay == nil {
		return invalid("cannot resolve family walking limit")
	}
	if reserve := input.LoadLimits.RestaurantWalkReserveMPerDay; !finite(*reserve) || *reserve < 0 || *reserve > *input.LoadLimits.MaxWalkDistanceMPerDay {
		return invalid("restaurant walking reserve must be finite and between 0 and the daily walking limit")
	}
	dates := map[c.ISODate]bool{}
	for _, day := range input.Days {
		if dates[day.Date] {
			return invalid("duplicate day date")
		}
		dates[day.Date] = true
		date, err := time.Parse("2006-01-02", string(day.Date))
		if err != nil {
			return invalid("invalid day date")
		}
		if day.DurationBudgetSec <= 0 || !finite(day.DurationBudgetSec) || day.DurationBudgetSec > 24*3600 || day.RestBudgetSec < 0 || !finite(day.RestBudgetSec) {
			return invalid("invalid duration budget")
		}
		if day.MealWindow != nil {
			return invalid("MEAL_WINDOW_NOT_IMPLEMENTED: demo day planner does not schedule meals yet")
		}
		if *day.MealCount < 0 || *day.MealCount > 10 {
			return invalid("meal_count must be between 0 and 10")
		}
		if _, ok := budgetDefaults.MealDurationSecByFormat[*day.MealFormat]; !ok {
			return invalid("invalid meal_format")
		}
		if !finite(*day.MealDurationSec) || *day.MealDurationSec < 0 || *day.MealDurationSec > 86400 {
			return invalid("invalid meal_duration_sec")
		}
		if day.RestBudgetSec > day.DurationBudgetSec {
			return invalid("rest budget exceeds day budget")
		}
		if input.LoadLimits.Pace != "relaxed" && input.LoadLimits.Pace != "standard" && input.LoadLimits.Pace != "intensive" {
			return invalid("invalid pace")
		}
		for _, v := range []*float64{input.LoadLimits.MaxWalkDistanceMPerDay, input.LoadLimits.MaxContinuousWalkDurationSec} {
			if v != nil && (!finite(*v) || *v < 0) {
				return invalid("invalid walking limit")
			}
		}
		probe := routing.Request{From: day.StartPoint, To: day.EndPoint, Mode: "walk"}
		if err := probe.Validate(); err != nil {
			return invalid(err.Error())
		}
		if day.AvailableWindow != nil {
			start, e1 := time.Parse(time.RFC3339, string(day.AvailableWindow.StartAt))
			end, e2 := time.Parse(time.RFC3339, string(day.AvailableWindow.EndAt))
			zone := time.FixedZone("Europe/Moscow", 3*3600)
			if e1 != nil || e2 != nil || !start.Before(end) || start.In(zone).Format("2006-01-02") != date.Format("2006-01-02") || end.In(zone).Format("2006-01-02") != date.Format("2006-01-02") {
				return invalid("window must be ordered and within the selected Moscow calendar day")
			}
		}
		if input.PlanningContext == "in_city" && day.AvailableWindow == nil {
			return invalid("available_window is required for in_city planning")
		}
	}
	selected := map[c.ID]bool{}
	for _, s := range input.Selections {
		if s.ActivityID == "" || s.PlaceID == "" || selected[s.ActivityID] {
			return invalid("invalid or duplicate selection")
		}
		selected[s.ActivityID] = true
		if s.PreferredDate != nil && !dates[*s.PreferredDate] {
			return invalid("selection date outside trip")
		}
	}
	return nil
}
func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func Warning(code, message string) c.Warning {
	return c.Warning{Code: code, Severity: "warning", Message: message, EvidenceIDS: []c.ID{}}
}
func NewDraft(id c.ID, input c.TripInput, now time.Time) c.TripView {
	input = resolveBudgetDefaults(input)
	view := c.TripView{TripID: id, Version: 1, UpdatedAt: c.Instant(now.Format(time.RFC3339Nano)), Status: "draft", Input: input, CatalogVersion: "demo-v1", Days: []c.DayPlan{}, Evidence: []c.Evidence{}, Warnings: []c.Warning{Warning("DEMO_CATALOG", "Тестовый каталог: названия, длительности и допуски не являются проверенными данными мест.")}}
	weights := []map[string]any{}
	for _, child := range input.Family.Children {
		weights = append(weights, map[string]any{"child_id": child.ChildID, "weight": 1 / float64(len(input.Family.Children))})
	}
	raw, _ := json.Marshal(map[string]any{"child_interest_weights": weights, "activity_balance": map[string]any{"mode": "equal_count_target", "scope": "trip", "shared_activity_credit": "split_equally"}, "adult_interest_weight": 0.2})
	_ = json.Unmarshal(raw, &view.Policy)
	_ = json.Unmarshal([]byte(`[]`), &view.FamilyBalance)
	return view
}
func ref(kind string, id c.ID) c.StopRef {
	value := map[string]any{"kind": kind}
	if id != "" {
		value["stop_id"] = id
	}
	raw, _ := json.Marshal(value)
	return c.StopRef(raw)
}
func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
func (p Planner) buildDay(ctx context.Context, view c.TripView, now time.Time) (c.TripView, error) {
	input := view.Input
	day := input.Days[0]
	available := map[c.ID]Activity{}
	for _, a := range p.Activities {
		available[a.ID] = a
	}
	selections := input.Selections
	chosen := []Activity{}
	mandatory := map[c.ID]bool{}
	for _, s := range selections {
		a, ok := available[s.ActivityID]
		if !ok || a.PlaceID != s.PlaceID {
			return c.TripView{}, invalid("UNKNOWN_ACTIVITY")
		}
		for _, child := range input.Family.Children {
			if child.AgeYears < a.MinAge || child.AgeYears > a.MaxAge {
				return c.TripView{}, invalid("AGE_RESTRICTION")
			}
		}
		chosen = append(chosen, a)
		mandatory[a.ID] = s.Mandatory
	}
	plan := c.DayPlan{Date: day.Date, Presentation: "relative", StartPoint: day.StartPoint, EndPoint: day.EndPoint, AvailableWindow: day.AvailableWindow, Feasibility: "conditional", Assumptions: []string{"Эвристическое распределение и порядок; глобальный оптимум не гарантирован.", "Время подходов к сети и актуальность проходов не проверены."}, Stops: []c.Stop{}, Legs: []c.Leg{}, Warnings: []c.Warning{Warning("DEMO_CATALOG", "Это интеграционный план, не проверенная туристическая рекомендация.")}}
	var clock time.Time
	if day.AvailableWindow != nil {
		clock, _ = time.Parse(time.RFC3339, string(day.AvailableWindow.StartAt))
	}
	if input.PlanningContext == "in_city" {
		plan.Presentation = "clock"
	}
	elapsed, walkDistance, walkTime := 0.0, 0.0, 0.0
	current := day.StartPoint
	previous := ref("day_start", "")
	speed := budgetDefaults.WalkingSpeedKPHByPace[input.LoadLimits.Pace]
	plan.Assumptions = append(plan.Assumptions, fmt.Sprintf("Тестовая скорость %.1f км/ч по темпу; не возрастная норма.", speed))
	plan.Warnings = append(plan.Warnings, Warning("SNAPPED_ENDPOINTS", "Подходы от исходных точек до сети не включены."), Warning("OPENING_HOURS_UNKNOWN", "В тестовом каталоге нет подтверждённых часов работы."))
	exceeds := func(leg routing.Result) {
		if max := input.LoadLimits.MaxContinuousWalkDurationSec; max != nil && leg.TravelDurationSec > *max {
			plan.Feasibility = "infeasible"
			plan.Warnings = append(plan.Warnings, Warning("WALK_SEGMENT_LIMIT", "Переход превышает лимит непрерывной ходьбы."))
		}
	}
	appendLeg := func(target routing.Point, to c.StopRef) error {
		result, err := p.Router.Route(ctx, routing.Request{From: current, To: target, Mode: "walk", WalkingSpeedKPH: &speed})
		if err != nil {
			return err
		}
		// Snapped approaches are not fabricated; itinerary remains conditional.
		d, t := result.DistanceM, result.TravelDurationSec
		geo := result.Geometry
		raw, _ := json.Marshal(geo)
		var geometry c.Leg
		_ = json.Unmarshal([]byte(`{"geometry":`+string(raw)+`}`), &geometry)
		version := result.RoutingDataVersion
		plan.Legs = append(plan.Legs, c.Leg{LegID: c.ID(fmt.Sprintf("leg-%s-%d", day.Date, len(plan.Legs)+1)), From: previous, To: to, Mode: "walk", Status: "calculated", DistanceM: &d, TravelDurationSec: &t, Geometry: geometry.Geometry, RoutingDataVersion: &version, Warnings: []c.Warning{Warning("SNAPPED_ENDPOINTS", "Подходы к точкам сети не включены.")}})
		elapsed += t
		walkTime += t
		walkDistance += d
		exceeds(result)
		current = target
		previous = to
		return nil
	}
	for _, a := range chosen {
		stopID := c.ID("stop-" + string(a.ID))
		if err := appendLeg(a.Point, ref("stop", stopID)); err != nil {
			return c.TripView{}, err
		}
		arrivalElapsed := elapsed
		stop := c.Stop{StopID: stopID, PlaceID: a.PlaceID, ActivityID: a.ID, Title: a.Title, Category: "landmark", Location: a.Point, Mandatory: mandatory[a.ID], Progress: "planned", Duration: c.DurationEstimate{DurationSec: a.DurationSec, Source: "estimated", EvidenceIDS: []c.ID{}}, Reasons: []c.Reason{}, Warnings: []c.Warning{Warning("DEMO_CATALOG", "Тестовая остановка, не проверенный объект.")}}
		kind := "visit"
		stop.ActivityKind = &kind
		if candidate, ok := p.metadata[a.ID]; ok {
			kind = candidate.Activity.Kind
			availability := append([]c.AvailabilityDay{}, candidate.Availability...)
			for i := range availability {
				availability[i].VisitWindows = nonNil(availability[i].VisitWindows)
				availability[i].Occurrences = nonNil(availability[i].Occurrences)
				availability[i].EvidenceIDS = nonNil(availability[i].EvidenceIDS)
			}
			stop.Availability = &availability
			stop.Duration = candidate.Activity.Duration
			stop.Reasons = candidate.Reasons
			stop.Warnings = append([]c.Warning{}, candidate.Warnings...)
			stop.BalanceCredit = candidate.BalanceCredit
			if len(candidate.Place.Categories) > 0 {
				stop.Category = candidate.Place.Categories[0]
			}
			var selection c.Selection
			for _, s := range selections {
				if s.ActivityID == a.ID {
					selection = s
					break
				}
			}
			wait, occurrence, ok := schedule(candidate, day, clock, elapsed, selection.OccurrenceID)
			if !ok {
				plan.Feasibility = "infeasible"
				plan.Warnings = append(plan.Warnings, Warning("AVAILABILITY_CONFLICT", "Посещение не помещается в часы работы или сеанс."))
			}
			elapsed += wait
			plan.Totals.WaitDurationSec = add(plan.Totals.WaitDurationSec, wait)
			stop.OccurrenceID = occurrence
			if occurrence != nil {
				for _, availability := range candidate.Availability {
					if availability.Date != day.Date {
						continue
					}
					for _, occ := range availability.Occurrences {
						if occ.OccurrenceID == *occurrence {
							interval := occ.Interval
							stop.Timing.FixedEventInterval = &interval
							start, _ := time.Parse(time.RFC3339, string(interval.StartAt))
							end, _ := time.Parse(time.RFC3339, string(interval.EndAt))
							a.DurationSec = end.Sub(start).Seconds()
							stop.Duration.DurationSec = a.DurationSec
						}
					}
				}
			}
		}
		if plan.Presentation == "clock" || stop.OccurrenceID != nil {
			arrival := c.Instant(clock.Add(time.Duration(arrivalElapsed * float64(time.Second))).Format(time.RFC3339))
			visitStart := c.Instant(clock.Add(time.Duration(elapsed * float64(time.Second))).Format(time.RFC3339))
			departure := c.Instant(clock.Add(time.Duration((elapsed + a.DurationSec) * float64(time.Second))).Format(time.RFC3339))
			stop.Timing.EstimatedArrivalAt = &arrival
			stop.Timing.EstimatedVisitStartAt = &visitStart
			stop.Timing.EstimatedDepartureAt = &departure
		}
		credits := []map[string]any{}
		for _, child := range input.Family.Children {
			credits = append(credits, map[string]any{"child_id": child.ChildID, "value": 1 / float64(len(input.Family.Children))})
		}
		if _, ok := p.metadata[a.ID]; !ok {
			raw, _ := json.Marshal(credits)
			_ = json.Unmarshal(raw, &stop.BalanceCredit)
		}
		elapsed += a.DurationSec
		activityKind := p.metadata[a.ID].Activity.Kind
		switch activityKind {
		case "meal":
			plan.Totals.MealDurationSec += a.DurationSec
		case "rest":
			plan.Totals.RestDurationSec += a.DurationSec
		default:
			plan.Totals.VisitDurationSec += a.DurationSec
		}
		plan.Stops = append(plan.Stops, stop)
	}
	if err := appendLeg(day.EndPoint, ref("day_end", "")); err != nil {
		return c.TripView{}, err
	}
	plan.Totals.WalkDistanceM = &walkDistance
	_, reserveM := walkingBudget(input.LoadLimits)
	totalM := *input.LoadLimits.MaxWalkDistanceMPerDay
	unscheduledMeals := math.Max(0, *day.MealDurationSec-plan.Totals.MealDurationSec)
	unscheduledRest := math.Max(0, day.RestBudgetSec-plan.Totals.RestDurationSec)
	plan.Totals.MealDurationSec += unscheduledMeals
	plan.Totals.RestDurationSec += unscheduledRest
	elapsed += unscheduledMeals + unscheduledRest
	if unscheduledMeals+unscheduledRest > 0 {
		plan.Warnings = append(plan.Warnings, Warning("UNSCHEDULED_BREAKS", "Время на еду/отдых учтено в бюджете; конкретные места и интервалы перерывов ещё не выбраны."))
	}
	waitSec := 0.0
	if plan.Totals.WaitDurationSec != nil {
		waitSec = *plan.Totals.WaitDurationSec
	}
	budget := dailyTimeBudget(day)
	budgetM, walkingSec, timeLimitedM := primaryWalkingBudget(totalM, speed, budget, plan.Totals.VisitDurationSec, plan.Totals.MealDurationSec, plan.Totals.RestDurationSec, waitSec, reserveM)
	plan.Totals.WalkBudgetM = &totalM
	plan.Totals.RestaurantWalkReserveM = &reserveM
	plan.Totals.PrimaryWalkBudgetM = &budgetM
	plan.Totals.WalkingTimeBudgetSec = &walkingSec
	plan.Totals.TimeLimitedWalkBudgetM = &timeLimitedM
	plan.Totals.WalkingSpeedKPH = &speed
	version := budgetDefaults.PolicyVersion
	plan.Totals.BudgetPolicyVersion = &version
	plan.Assumptions = append(plan.Assumptions, fmt.Sprintf("Бюджет max(0, min(M, V×T_ходьбы) − P) = %.0f м; M=%.0f м, P=%.0f м, V=%.1f км/ч. Параметры %s — продуктовые гипотезы, не возрастная медицинская норма.", budgetM, totalM, reserveM, speed, version))
	plan.Totals.WalkDurationSec = &walkTime
	zero := 0.0
	if plan.Totals.WaitDurationSec == nil {
		plan.Totals.WaitDurationSec = &zero
	}
	plan.Totals.ElapsedDurationSec = &elapsed
	if elapsed > budget {
		plan.Feasibility = "infeasible"
		plan.Warnings = append(plan.Warnings, Warning("DAY_BUDGET_EXCEEDED", "План не помещается в доступное время; обязательные точки не удалены."))
	}
	if walkDistance > budgetM {
		plan.Feasibility = "infeasible"
		plan.Warnings = append(plan.Warnings, Warning("WALK_DISTANCE_LIMIT", "Маршрут превышает бюджет max(0, min(M, V×T_ходьбы) − P)."))
	}
	// Recreate slices so preview does not mutate the original snapshot.
	view.Days = []c.DayPlan{plan}
	view.Warnings = append([]c.Warning{}, plan.Warnings...)
	view.Status = "planned"
	view.Version++
	view.UpdatedAt = c.Instant(now.Format(time.RFC3339Nano))
	weights, balance := []map[string]any{}, []map[string]any{}
	for _, child := range input.Family.Children {
		share := 1 / float64(len(input.Family.Children))
		weights = append(weights, map[string]any{"child_id": child.ChildID, "weight": share})
		balance = append(balance, map[string]any{"child_id": child.ChildID, "target_share": share, "planned_credit": float64(len(chosen)) * share, "achieved_share": share})
	}
	raw, _ := json.Marshal(weights)
	_ = json.Unmarshal(raw, &view.Policy.ChildInterestWeights)
	raw, _ = json.Marshal(balance)
	_ = json.Unmarshal(raw, &view.FamilyBalance)
	view.Policy.ActivityBalance.SharedActivityCredit = "split_equally"
	return view, nil
}
