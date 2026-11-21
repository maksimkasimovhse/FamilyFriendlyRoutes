package planner

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

// Hydrate validates and snapshots the same ranked pool used by both the cards
// and route calculation. It never interprets a static frontend card ID as an ML ID.
func (p Planner) Hydrate(ctx context.Context, view c.TripView) (Planner, c.TripView, error) {
	selected, sourceErr := p.ForCatalog(view.CatalogVersion)
	if sourceErr != nil {
		return p, view, sourceErr
	}
	p = selected
	if p.Source != nil && view.CatalogVersion != p.Source.CatalogVersion() {
		return p, view, ErrMLContract
	}
	var response c.RecommendationResponse
	var err error
	if view.RecommendationSnapshot != nil {
		response = *view.RecommendationSnapshot
		response.TripVersion = view.Version
	} else if p.Source != nil {
		response, err = p.Source.Recommend(ctx, view)
	} else {
		response, err = p.demoRecommendations(view)
	}
	if err != nil {
		return p, view, err
	}
	activities, metadata, err := normalize(response, view)
	if err != nil {
		return p, view, err
	}
	sort.SliceStable(response.Candidates, func(i, j int) bool {
		return response.Candidates[i].Scores.FinalRelevance > response.Candidates[j].Scores.FinalRelevance
	})
	p.Activities, p.metadata = activities, metadata
	view.RecommendationSnapshot = &response
	view.Evidence = append([]c.Evidence{}, response.Evidence...)
	p.Router = &routeCache{router: p.Router, values: map[routeKey]routing.Result{}}
	return p, view, nil
}
func (p Planner) demoRecommendations(view c.TripView) (c.RecommendationResponse, error) {
	unknown := map[string]any{"state": "unknown", "value": nil, "evidence_ids": []string{}}
	known := func(value any) map[string]any {
		return map[string]any{"state": "known", "value": value, "evidence_ids": []string{"demo-catalog"}}
	}
	now := c.Instant(time.Now().UTC().Format(time.RFC3339))
	r := c.RecommendationResponse{ContractVersion: "1.0", RequestID: "demo", TripID: view.TripID, TripVersion: view.Version, CatalogVersion: view.CatalogVersion, ModelVersion: "synthetic-demo", GeneratedAt: now, Status: "complete", Candidates: []c.Candidate{}, Rejected: []struct {
		ActivityID c.ID       `json:"activity_id"`
		Reasons    []c.Reason `json:"reasons"`
	}{}, Evidence: []c.Evidence{{EvidenceID: "demo-catalog", SourceKind: "manual", CheckedAt: now}}, Warnings: []c.Warning{Warning("DEMO_CATALOG", "Синтетические карточки для интеграции, не реальные рекомендации.")}}
	// Use JSON for the anonymous generated child/availability structures.
	for i, a := range p.Activities {
		eligibility, interest, credit := []any{}, []any{}, []any{}
		for _, child := range view.Input.Family.Children {
			eligibility = append(eligibility, map[string]any{"child_id": child.ChildID, "status": "eligible", "reasons": []any{}})
			interest = append(interest, map[string]any{"child_id": child.ChildID, "value": .5})
			credit = append(credit, map[string]any{"child_id": child.ChildID, "value": 1 / float64(len(view.Input.Family.Children))})
		}
		availability := []any{}
		for _, d := range view.Input.Days {
			availability = append(availability, map[string]any{"date": d.Date, "state": "unknown", "visit_windows": []any{}, "occurrences": []any{}, "last_entry_at": nil})
		}
		payload := map[string]any{
			"place":        map[string]any{"place_id": a.PlaceID, "name": a.Title, "location": a.Point, "entrance": nil, "categories": []string{"landmark"}, "display_class": "neutral", "indoor": unknown, "toilet": unknown, "shelter": unknown, "seating": unknown, "restaurant": nil},
			"activity":     map[string]any{"activity_id": a.ID, "place_id": a.PlaceID, "title": a.Title, "kind": "visit", "age_min_years": known(a.MinAge), "age_max_years": known(a.MaxAge), "height_min_cm": unknown, "admission_rule": unknown, "booking_required": unknown, "recommended_age_min_years": unknown, "recommended_age_max_years": unknown, "evidence_ids": []string{"demo-catalog"}, "duration": map[string]any{"duration_sec": a.DurationSec, "source": "estimated", "evidence_ids": []string{"demo-catalog"}}},
			"availability": availability, "eligibility": eligibility, "scores": map[string]any{"final_relevance": 1 - float64(i)/CandidateLimit, "child_interest": interest, "adult_interest": .5, "popularity": .5}, "balance_credit": credit, "is_top_place": false, "reasons": []any{}, "warnings": []any{},
		}
		raw, _ := json.Marshal(payload)
		var candidate c.Candidate
		if err := json.Unmarshal(raw, &candidate); err != nil {
			return r, err
		}
		r.Candidates = append(r.Candidates, candidate)
	}
	if len(r.Candidates) == 0 {
		r.Status = "no_candidates"
	}
	return r, nil
}
func manualCount(view c.TripView, date c.ISODate) int {
	n := 0
	for _, s := range view.Input.Selections {
		if s.PreferredDate != nil && *s.PreferredDate == date {
			n++
		} else if s.PreferredDate == nil {
			for _, d := range view.Days {
				if d.Date == date {
					for _, stop := range d.Stops {
						if stop.ActivityID == s.ActivityID {
							n++
						}
					}
				}
			}
		}
	}
	return n
}
func lastActivity(plan c.DayPlan) *routing.Point {
	for i := len(plan.Stops) - 1; i >= 0; i-- {
		s := plan.Stops[i]
		if s.Progress != "removed" && s.Progress != "skipped" {
			point := s.Location
			return &point
		}
	}
	return nil
}

// crowFlightM — расстояние по прямой, м: нижняя граница пешего пути, поэтому по ней можно только отсеивать заведомо недостижимое.
func crowFlightM(a, b routing.Point) float64 {
	lat1, lat2 := a.Coordinates[1]*math.Pi/180, b.Coordinates[1]*math.Pi/180
	x := math.Sin((lat2 - lat1) / 2)
	y := math.Sin((b.Coordinates[0] - a.Coordinates[0]) * math.Pi / 360)
	h := x*x + math.Cos(lat1)*math.Cos(lat2)*y*y
	return 6371008.8 * 2 * math.Asin(math.Sqrt(math.Min(1, h)))
}

// reachableAlone: помещается ли место в день, если в дне больше ничего нет. Берётся прямая «старт → место → финиш»
// против лимита ходьбы (по возрасту детей или заданного) и времени (скорость × время дня за вычетом посещения).
// Прямая короче любого реального пути, поэтому отсеиваются только места, которые точно не поместятся.
func reachableAlone(input c.TripInput, day c.DayInput, point routing.Point, stayDurationSec float64) bool {
	if input.LoadLimits.MaxWalkDistanceMPerDay == nil {
		return true
	}
	limit, _ := walkingBudget(input.LoadLimits)
	if speed := budgetDefaults.WalkingSpeedKPHByPace[input.LoadLimits.Pace]; speed > 0 {
		left := dailyTimeBudget(day) - stayDurationSec
		if left <= 0 {
			return false
		}
		limit = math.Min(limit, speed*1000/3600*left)
	}
	return crowFlightM(day.StartPoint, point)+crowFlightM(point, day.EndPoint) <= limit
}

func withinSupplementRadius(anchor *routing.Point, point routing.Point) bool {
	if anchor == nil {
		return true
	} // Empty day: all ranked candidates, no start-point restriction.
	a, b := anchor.Coordinates, point.Coordinates
	lat1, lat2 := a[1]*math.Pi/180, b[1]*math.Pi/180
	x := math.Sin((lat2 - lat1) / 2)
	y := math.Sin((b[0] - a[0]) * math.Pi / 360)
	h := x*x + math.Cos(lat1)*math.Cos(lat2)*y*y
	return 6371008.8*2*math.Asin(math.Sqrt(math.Min(1, h))) <= budgetDefaults.CompletionPolicy.SupplementRadiusM
}
func (p Planner) appendDay(ctx context.Context, view c.TripView, index int, choices []c.Selection, now time.Time) (c.DayPlan, error) {
	day := view.Days[index]
	var inputDay c.DayInput
	for _, d := range view.Input.Days {
		if d.Date == day.Date {
			inputDay = d
		}
	}
	existing := []c.Selection{}
	for _, stop := range day.Stops {
		if stop.Progress != "removed" && stop.Progress != "skipped" {
			existing = append(existing, c.Selection{ActivityID: stop.ActivityID, PlaceID: stop.PlaceID, Mandatory: stop.Mandatory, OccurrenceID: stop.OccurrenceID})
		}
	}
	existing = append(existing, choices...)
	trial := view
	trial.Input = view.Input
	trial.Input.Days = []c.DayInput{inputDay}
	trial.Input.Selections = existing
	result, err := p.buildDay(ctx, trial, now)
	if err != nil {
		return c.DayPlan{}, err
	}
	plan := result.Days[0]
	if p.Source != nil {
		warnings := []c.Warning{}
		for _, w := range plan.Warnings {
			if w.Code != "DEMO_CATALOG" && w.Code != "OPENING_HOURS_UNKNOWN" {
				warnings = append(warnings, w)
			}
		}
		for _, stop := range plan.Stops {
			warnings = append(warnings, stop.Warnings...)
		}
		plan.Warnings = warnings
	}
	return plan, nil
}

func (p Planner) PlanningOptions(ctx context.Context, view c.TripView, now time.Time) (c.PlanningOptions, error) {
	var err error
	p, view, err = p.Hydrate(ctx, view)
	if err != nil {
		return c.PlanningOptions{}, err
	}
	result := c.PlanningOptions{TripID: view.TripID, TripVersion: view.Version, Policy: budgetDefaults.CompletionPolicy, Candidates: view.RecommendationSnapshot.Candidates, Evidence: view.Evidence, Days: []c.DayPlanningOptions{}}
	used := map[c.ID]bool{}
	anyActive := false
	for _, d := range view.Days {
		if d.Execution != nil {
			anyActive = true
		}
		for _, stop := range d.Stops {
			used[stop.PlaceID] = true
		}
	}
	for _, s := range view.Input.Selections {
		used[s.PlaceID] = true
	}
	points := map[c.ID]routing.Point{}
	for _, a := range p.Activities {
		points[a.ID] = a.Point
	}
	for _, inputDay := range view.Input.Days {
		row := c.DayPlanningOptions{Date: inputDay.Date, AvailableDurationSec: dailyTimeBudget(inputDay), Candidates: []c.Candidate{}, ManualCount: manualCount(view, inputDay.Date)}
		row.RemainingManualChoices = max(0, result.Policy.ManualLimitPerDay-row.ManualCount)
		row.RemainingManualChoices = min(row.RemainingManualChoices, max(0, len(view.Input.Days)*result.Policy.ManualLimitPerDay-len(view.Input.Selections)))
		index := -1
		for i, d := range view.Days {
			if d.Date == inputDay.Date {
				index = i
				row.Anchor = lastActivity(d)
				if d.Totals.ElapsedDurationSec != nil {
					row.PlannedDurationSec = *d.Totals.ElapsedDurationSec
				}
				break
			}
		}
		if row.AvailableDurationSec > 0 {
			row.FillRatio = row.PlannedDurationSec / row.AvailableDurationSec
		}
		row.IsShort = row.FillRatio < result.Policy.ShortDayRatio
		active := anyActive
		if active {
			row.RemainingManualChoices = 0
		}
		if index < 0 || row.IsShort && row.RemainingManualChoices > 0 && !active {
			for _, candidate := range result.Candidates {
				id := candidate.Activity.ActivityID
				if used[candidate.Place.PlaceID] || !p.candidateOpenOnDate(id, inputDay.Date, nil) || !withinSupplementRadius(row.Anchor, points[id]) {
					continue
				}
				// Ещё нет плана: места, до которых заведомо не дойти за день, в подбор не предлагаем,
				// иначе выбранное молча выпадет из маршрута и он окажется пустым.
				if index < 0 && !reachableAlone(resolveBudgetDefaults(view.Input), inputDay, points[id], candidate.Activity.Duration.DurationSec) {
					continue
				}
				if index >= 0 {
					selection := c.Selection{ActivityID: id, PlaceID: candidate.Place.PlaceID, PreferredDate: &row.Date}
					plan, err := p.appendDay(ctx, view, index, []c.Selection{selection}, now)
					if err != nil {
						if ctx.Err() != nil {
							return result, ctx.Err()
						}
						if !errors.Is(err, routing.ErrNoRoute) && !errors.Is(err, ErrValidation) {
							return result, err
						}
						continue
					}
					if plan.Feasibility == "infeasible" {
						continue
					}
				}
				row.Candidates = append(row.Candidates, candidate)
			}
		}
		result.Days = append(result.Days, row)
	}
	return result, nil
}

func (p Planner) AppendManualChoices(ctx context.Context, view c.TripView, date c.ISODate, choices []c.Selection, now time.Time) (c.TripView, error) {
	copy, err := cloneView(view)
	if err != nil {
		return view, err
	}
	view = copy
	p, view, err = p.Hydrate(ctx, view)
	if err != nil {
		return view, err
	}
	index, err := dayIndex(view, date)
	if err != nil {
		return view, err
	}
	for _, day := range view.Days {
		if day.Execution != nil {
			return view, stateError("ACTIVE_TRIP", "Дополнение карточками пока доступно до начала прогулки.")
		}
	}
	if len(choices) < 1 || len(choices)+manualCount(view, date) > budgetDefaults.CompletionPolicy.ManualLimitPerDay || len(view.Input.Selections)+len(choices) > len(view.Input.Days)*budgetDefaults.CompletionPolicy.ManualLimitPerDay {
		return view, stateError("MANUAL_LIMIT", "Слишком много мест выбрано вручную.")
	}
	var input c.DayInput
	for _, d := range view.Input.Days {
		if d.Date == date {
			input = d
		}
	}
	planned := 0.0
	if v := view.Days[index].Totals.ElapsedDurationSec; v != nil {
		planned = *v
	}
	if planned >= dailyTimeBudget(input)*budgetDefaults.CompletionPolicy.ShortDayRatio {
		return view, stateError("DAY_NOT_SHORT", "День уже заполнен не менее чем на 70%.")
	}
	used := map[c.ID]bool{}
	for _, d := range view.Days {
		for _, s := range d.Stops {
			used[s.PlaceID] = true
		}
	}
	for _, s := range view.Input.Selections {
		used[s.PlaceID] = true
	}
	available := map[c.ID]Activity{}
	for _, a := range p.Activities {
		available[a.ID] = a
	}
	anchor := lastActivity(view.Days[index])
	for i, s := range choices {
		a, ok := available[s.ActivityID]
		if !ok || a.PlaceID != s.PlaceID || used[s.PlaceID] || s.Mandatory || s.PreferredDate == nil || *s.PreferredDate != date {
			return view, invalid("invalid or duplicate supplemental choice")
		}
		if !withinSupplementRadius(anchor, a.Point) || !p.candidateOpenOnDate(a.ID, date, s.OccurrenceID) {
			return view, invalid("supplemental choice outside 2km or unavailable on date")
		}
		used[s.PlaceID] = true
		choices[i].PreferredDate = &date
		if anchor == nil {
			point := a.Point
			anchor = &point
		}
	}
	plan, err := p.appendDay(ctx, view, index, choices, now)
	if err != nil {
		return view, err
	}
	if plan.Feasibility == "infeasible" {
		return view, stateError("DAY_CAPACITY", "Дополнение не помещается в бюджет дня; выберите меньше мест.")
	}
	view.Days[index] = plan
	view.Input.Selections = append(view.Input.Selections, choices...)
	view.Version++
	view.UpdatedAt = c.Instant(now.Format(time.RFC3339Nano))
	view.Warnings = []c.Warning{}
	for _, day := range view.Days {
		view.Warnings = append(view.Warnings, day.Warnings...)
	}
	return view, nil
}
