package httpapi

import (
	"context"
	"errors"
	"math"
	"slices"
	"sort"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

// Route estimates remain a backend responsibility, including when ML found the places.
func (a *tripAPI) nearbyOptions(ctx context.Context, view c.TripView, day c.DayPlan, origin c.Point,
	items []c.Candidate, urgent bool, maxWalk *float64) ([]c.Candidate, []placeOption, error) {
	if a.planner.Router == nil {
		return nil, nil, routing.ErrUnavailable
	}
	next := day.EndPoint
	for _, stop := range day.Stops {
		if stop.Progress == "planned" {
			next = stop.Location
			break
		}
	}
	speed := planner.WalkingSpeedKPH(view.Input.LoadLimits.Pace)
	base, err := a.planner.Router.Route(ctx, routing.Request{From: origin, To: next, Mode: "walk", WalkingSpeedKPH: &speed})
	if err != nil {
		return nil, nil, err
	}
	type option struct {
		candidate c.Candidate
		metric    placeOption
		cost      float64
	}
	options := []option{}
	seen := map[c.ID]bool{}
	for _, candidate := range items {
		pid := candidate.Place.PlaceID
		if seen[pid] || slices.ContainsFunc(view.Days, func(d c.DayPlan) bool {
			return slices.ContainsFunc(d.Stops, func(s c.Stop) bool { return s.PlaceID == pid })
		}) {
			continue
		}
		seen[pid] = true
		point := candidate.Place.Location
		if candidate.Place.Entrance != nil {
			point = *candidate.Place.Entrance
		}
		walk, e := a.planner.Router.Route(ctx, routing.Request{From: origin, To: point, Mode: "walk", WalkingSpeedKPH: &speed})
		if errors.Is(e, routing.ErrNoRoute) {
			continue
		}
		if e != nil {
			return nil, nil, e
		}
		if maxWalk != nil && walk.DistanceM > *maxWalk {
			continue
		}
		onward, e := a.planner.Router.Route(ctx, routing.Request{From: point, To: next, Mode: "walk", WalkingSpeedKPH: &speed})
		if errors.Is(e, routing.ErrNoRoute) {
			continue
		}
		if e != nil {
			return nil, nil, e
		}
		distance := walk.DistanceM
		candidate.Place.DistanceM = &distance
		metric := placeOption{PlaceID: pid, WalkDurationSec: walk.TravelDurationSec, DetourDurationSec: math.Max(0, walk.TravelDurationSec+onward.TravelDurationSec-base.TravelDurationSec)}
		cost := metric.DetourDurationSec
		if urgent {
			cost = metric.WalkDurationSec
		}
		options = append(options, option{candidate, metric, cost})
	}
	sort.SliceStable(options, func(i, j int) bool { return options[i].cost < options[j].cost })
	items = []c.Candidate{}
	metrics := []placeOption{}
	for _, o := range options {
		if len(items) == 3 {
			break
		}
		items = append(items, o.candidate)
		metrics = append(metrics, o.metric)
	}
	return items, metrics, nil
}

func (a *tripAPI) findAssistantModelNeeds(ctx context.Context, view c.TripView, day c.DayPlan, intent assistant.Intent) ([]c.Candidate, []c.Evidence, []placeOption, error) {
	origin := searchOrigin(view, day.Date)
	urgent := false
	purposes := []string{}
	for _, need := range intent.Needs {
		urgent = urgent || need.Urgency == "now"
		purpose := map[string]string{"food": "restaurant", "toilet": "toilet", "rest": "rest", "less_walking": "rest", "shelter": "rain", "play": "playground"}[need.Kind]
		if purpose != "" && !slices.Contains(purposes, purpose) {
			purposes = append(purposes, purpose)
		}
	}
	if len(purposes) == 0 {
		return nil, nil, nil, failure(422, "NEED_REQUIRED", "Уточните потребность для поиска места.")
	}
	scope := radiusScope(origin, 1500)
	if !urgent {
		scope = routeScope(view, day.Date, origin)
	}
	items := []c.Candidate{}
	evidence := []c.Evidence{}
	for _, purpose := range purposes {
		response, err := a.modelRecommendations(ctx, view, purpose, &day.Date, nil, nil, scope, &origin, nil, 12)
		if err != nil {
			return nil, nil, nil, err
		}
		items = append(items, response.Candidates...)
		evidence = mergeEvidence(evidence, response.Evidence)
	}
	candidates, metrics, err := a.nearbyOptions(ctx, view, day, origin, items, urgent, intent.MaxWalkDistanceM)
	return candidates, evidence, metrics, err
}
