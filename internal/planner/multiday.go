package planner

import (
	"context"
	"errors"
	"math"
	"sort"
	"strings"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

const CandidateLimit = 50

// ML supplies a ranked pool, never day assignments or route geometry.
type CandidateSource interface {
	CatalogVersion() string
	Recommend(context.Context, c.TripView) (c.RecommendationResponse, error)
}

func (p Planner) Draft(id c.ID, input c.TripInput, now time.Time) c.TripView {
	view := NewDraft(id, input, now)
	if p.Source != nil {
		view.CatalogVersion = p.Source.CatalogVersion()
		view.Warnings = []c.Warning{}
	}
	return view
}

// cache is scoped to one calculation and preserves directed OSM results.
type routeKey struct {
	From, To routing.Position
	Speed    float64
}
type routeCache struct {
	router Router
	values map[routeKey]routing.Result
}

func (r *routeCache) Route(ctx context.Context, request routing.Request) (routing.Result, error) {
	if err := ctx.Err(); err != nil {
		return routing.Result{}, err
	}
	key := routeKey{request.From.Coordinates, request.To.Coordinates, *request.WalkingSpeedKPH}
	if result, ok := r.values[key]; ok {
		return result, nil
	}
	result, err := r.router.Route(ctx, request)
	if err == nil {
		r.values[key] = result
	}
	return result, err
}

// Geographic proximity only chooses which insertion to try first. Acceptance
// always uses directed OSM legs, including the return to the day's end point.
func proximity(a, b routing.Point) float64 {
	lat := (a.Coordinates[1] + b.Coordinates[1]) * math.Pi / 360
	return math.Hypot((a.Coordinates[0]-b.Coordinates[0])*math.Cos(lat), a.Coordinates[1]-b.Coordinates[1])
}

func (p Planner) Build(ctx context.Context, view c.TripView, now time.Time) (c.TripView, error) {
	if err := Validate(view.Input); err != nil {
		return c.TripView{}, err
	}
	if p.Router == nil {
		return c.TripView{}, routing.ErrUnavailable
	}
	warnings := []c.Warning{}
	if p.Source != nil {
		if view.CatalogVersion != p.Source.CatalogVersion() {
			return c.TripView{}, ErrMLContract
		}
		response, err := p.Source.Recommend(ctx, view)
		if err != nil {
			return c.TripView{}, err
		}
		activities, metadata, err := normalize(response, view)
		if err != nil {
			return c.TripView{}, err
		}
		p.Activities, p.metadata = activities, metadata
		view.Evidence = append([]c.Evidence{}, response.Evidence...)
		warnings = append(warnings, response.Warnings...)
	} else if view.Input.RequestText != nil && strings.TrimSpace(*view.Input.RequestText) != "" {
		return c.TripView{}, invalid("FREE_TEXT_NOT_IMPLEMENTED: ML is not connected")
	}
	if len(p.Activities) > CandidateLimit {
		return c.TripView{}, invalid("candidate pool exceeds 50 places")
	}
	available := map[c.ID]Activity{}
	places := map[c.ID]bool{}
	for _, a := range p.Activities {
		if a.ID == "" || a.PlaceID == "" || available[a.ID].ID != "" || places[a.PlaceID] || !finite(a.DurationSec) || a.DurationSec <= 0 {
			return c.TripView{}, invalid("invalid or duplicate candidate")
		}
		if err := (routing.Request{From: a.Point, To: a.Point, Mode: "walk"}).Validate(); err != nil {
			return c.TripView{}, invalid("candidate outside routing area")
		}
		available[a.ID] = a
		places[a.PlaceID] = true
	}
	selections := append([]c.Selection{}, view.Input.Selections...)
	selected := map[c.ID]bool{}
	for _, s := range selections {
		selected[s.ActivityID] = true
	}
	for _, a := range p.Activities {
		if !selected[a.ID] {
			selections = append(selections, c.Selection{ActivityID: a.ID, PlaceID: a.PlaceID})
		}
	}
	// Required user selections precede ML-ranked optional choices.
	sort.SliceStable(selections, func(i, j int) bool { return selections[i].Mandatory && !selections[j].Mandatory })
	for _, s := range selections {
		a, ok := available[s.ActivityID]
		if !ok || a.PlaceID != s.PlaceID {
			return c.TripView{}, invalid("UNKNOWN_ACTIVITY: selected place must be present in the candidate pool")
		}
		for _, child := range view.Input.Family.Children {
			if child.AgeYears < a.MinAge || child.AgeYears > a.MaxAge {
				return c.TripView{}, invalid("AGE_RESTRICTION")
			}
		}
		if s.OccurrenceID != nil && p.Source == nil {
			return c.TripView{}, invalid("FIXED_EVENTS_NOT_IMPLEMENTED: demo catalog has no sessions")
		}
	}
	p.Router = &routeCache{router: p.Router, values: map[routeKey]routing.Result{}}
	days := append([]c.DayInput{}, view.Input.Days...)
	sort.Slice(days, func(i, j int) bool { return days[i].Date < days[j].Date })
	plans := make([]c.DayPlan, len(days))
	assignments := make([][]c.Selection, len(days))
	build := func(i int, choices []c.Selection) (c.DayPlan, error) {
		trial := view
		trial.Input = view.Input
		trial.Input.Days = []c.DayInput{days[i]}
		trial.Input.Selections = choices
		result, err := p.buildDay(ctx, trial, now)
		if err != nil {
			return c.DayPlan{}, err
		}
		plan := result.Days[0]
		if p.Source != nil {
			filtered := []c.Warning{}
			for _, w := range plan.Warnings {
				if w.Code != "DEMO_CATALOG" && w.Code != "OPENING_HOURS_UNKNOWN" {
					filtered = append(filtered, w)
				}
			}
			for _, s := range plan.Stops {
				filtered = append(filtered, s.Warnings...)
			}
			plan.Warnings = filtered
		}
		return plan, nil
	}
	for i := range days {
		plan, err := build(i, []c.Selection{})
		if err != nil {
			return c.TripView{}, err
		}
		plans[i] = plan
		assignments[i] = []c.Selection{}
	}
	for _, s := range selections {
		if err := ctx.Err(); err != nil {
			return c.TripView{}, err
		}
		a := available[s.ActivityID]
		type option struct {
			day, position int
			distance      float64
		}
		options := []option{}
		for i, day := range days {
			if s.PreferredDate != nil && day.Date != *s.PreferredDate {
				continue
			}
			best := option{day: i, distance: math.Inf(1)}
			for pos := 0; pos <= len(assignments[i]); pos++ {
				from, to := day.StartPoint, day.EndPoint
				if pos > 0 {
					from = available[assignments[i][pos-1].ActivityID].Point
				}
				if pos < len(assignments[i]) {
					to = available[assignments[i][pos].ActivityID].Point
				}
				delta := proximity(from, a.Point) + proximity(a.Point, to) - proximity(from, to)
				if delta < best.distance {
					best.position = pos
					best.distance = delta
				}
			}
			options = append(options, best)
		}
		sort.SliceStable(options, func(i, j int) bool { return options[i].distance < options[j].distance })
		accepted := false
		var fallback *c.DayPlan
		var fallbackChoices []c.Selection
		fallbackDay := 0
		for _, o := range options {
			choices := append([]c.Selection{}, assignments[o.day][:o.position]...)
			choices = append(choices, s)
			choices = append(choices, assignments[o.day][o.position:]...)
			plan, err := build(o.day, choices)
			if errors.Is(err, routing.ErrNoRoute) {
				continue
			}
			if err != nil {
				return c.TripView{}, err
			}
			if fallback == nil {
				fallback = &plan
				fallbackChoices = choices
				fallbackDay = o.day
			}
			if plan.Feasibility != "infeasible" {
				assignments[o.day] = choices
				plans[o.day] = plan
				accepted = true
				break
			}
		}
		if !accepted {
			if s.Mandatory {
				if fallback == nil {
					return c.TripView{}, routing.ErrNoRoute
				}
				assignments[fallbackDay] = fallbackChoices
				plans[fallbackDay] = *fallback
			} else {
				w := Warning("CANDIDATE_NOT_SCHEDULED", "Место не включено: не найден выполнимый вариант вставки в дни поездки.")
				id := s.ActivityID
				w.ActivityID = &id
				warnings = append(warnings, w)
			}
		}
	}
	view.Days = plans
	totalStops := 0
	for _, plan := range plans {
		warnings = append(warnings, plan.Warnings...)
		totalStops += len(plan.Stops)
	}
	if totalStops == 0 {
		warnings = append(warnings, Warning("NO_SCHEDULED_ACTIVITIES", "Не удалось включить ни одной активности."))
	}
	view.Warnings = warnings
	view.Status = "planned"
	view.Version++
	view.UpdatedAt = c.Instant(now.Format(time.RFC3339Nano))
	view.FamilyBalance = nil
	totalCredit := 0.0
	credits := map[c.ID]float64{}
	for _, plan := range plans {
		for _, stop := range plan.Stops {
			for _, credit := range stop.BalanceCredit {
				credits[credit.ChildID] += credit.Value
				totalCredit += credit.Value
			}
		}
	}
	for _, child := range view.Input.Family.Children {
		row := struct {
			ChildID       c.ID     `json:"child_id"`
			TargetShare   float64  `json:"target_share"`
			PlannedCredit float64  `json:"planned_credit"`
			AchievedShare *float64 `json:"achieved_share"`
		}{ChildID: child.ChildID, TargetShare: 1 / float64(len(view.Input.Family.Children)), PlannedCredit: credits[child.ChildID]}
		if totalCredit > 0 {
			share := credits[child.ChildID] / totalCredit
			row.AchievedShare = &share
			if math.Abs(share-row.TargetShare) > 0.000001 {
				warnings = append(warnings, Warning("BALANCE_TARGET_UNMET", "Фактическое количество активностей не обеспечивает равный баланс детей."))
			}
		}
		view.FamilyBalance = append(view.FamilyBalance, row)
	}
	view.Warnings = warnings
	return view, nil
}

func add(value *float64, delta float64) *float64 {
	result := delta
	if value != nil {
		result += *value
	}
	return &result
}

func schedule(candidate c.Candidate, day c.DayInput, clock time.Time, elapsed float64, requested *c.ID) (float64, *c.ID, bool) {
	for _, availability := range candidate.Availability {
		if availability.Date != day.Date {
			continue
		}
		if availability.State == "closed" {
			return 0, nil, false
		}
		if availability.State == "unknown" {
			return 0, nil, candidate.Activity.Kind != "session" && requested == nil
		}
		// Without a start time, known hours cannot be verified against travel time.
		if clock.IsZero() {
			return 0, nil, candidate.Activity.Kind != "session" && requested == nil
		}
		arrival := clock.Add(time.Duration(elapsed * float64(time.Second)))
		duration := time.Duration(candidate.Activity.Duration.DurationSec * float64(time.Second))
		if candidate.Activity.Kind == "session" || requested != nil {
			var best time.Time
			var id c.ID
			for _, occ := range availability.Occurrences {
				start, _ := time.Parse(time.RFC3339, string(occ.Interval.StartAt))
				end, _ := time.Parse(time.RFC3339, string(occ.Interval.EndAt))
				if (requested == nil || *requested == occ.OccurrenceID) && occ.BookingStatus != "sold_out" && !arrival.After(start) && start.Before(end) && (best.IsZero() || start.Before(best)) {
					best = start
					id = occ.OccurrenceID
				}
			}
			if best.IsZero() {
				return 0, nil, false
			}
			return best.Sub(arrival).Seconds(), &id, true
		}
		best := math.Inf(1)
		for _, window := range availability.VisitWindows {
			start, _ := time.Parse(time.RFC3339, string(window.StartAt))
			end, _ := time.Parse(time.RFC3339, string(window.EndAt))
			if arrival.After(start) {
				start = arrival
			}
			if availability.LastEntryAt != nil {
				last, _ := time.Parse(time.RFC3339, string(*availability.LastEntryAt))
				if start.After(last) {
					continue
				}
			}
			if !start.Add(duration).After(end) {
				best = math.Min(best, start.Sub(arrival).Seconds())
			}
		}
		if math.IsInf(best, 1) {
			return 0, nil, false
		}
		return best, nil, true
	}
	return 0, nil, false
}
