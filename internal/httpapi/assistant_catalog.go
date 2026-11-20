package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strings"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

func (a *tripAPI) findAssistantActivities(ctx context.Context, view c.TripView, day c.DayPlan, intent assistant.Intent) ([]c.Candidate, []c.Evidence, []placeOption, error) {
	if a.planner.Source == nil {
		return nil, nil, nil, failure(503, "CATALOG_UNAVAILABLE", "Каталог рекомендаций не подключён.")
	}
	var parsed c.ParsedRequest
	if json.Unmarshal(intent.Preferences, &parsed) != nil || len(parsed.Claims) == 0 {
		return nil, nil, nil, failure(422, "NEED_REQUIRED", "Уточните интерес или категорию места.")
	}
	if parsed.NeedsClarification && parsed.ClarificationQuestion != nil {
		return nil, nil, nil, failure(422, "REQUEST_CLARIFICATION_REQUIRED", *parsed.ClarificationQuestion)
	}
	selected, err := a.planner.ForCatalog(view.CatalogVersion)
	if err != nil {
		return nil, nil, nil, err
	}
	source := selected.Source
	if httpSource, ok := source.(planner.HTTPSource); ok {
		httpSource.ParsedRequest = &parsed
		for _, d := range view.Days {
			for _, stop := range d.Stops {
				httpSource.Excluded = append(httpSource.Excluded, stop.ActivityID)
			}
		}
		source = httpSource
	}
	probe := view
	probe.Input.Selections = []c.Selection{}
	quotes := []string{}
	for _, raw := range parsed.Claims {
		var claim struct {
			Evidence string `json:"evidence"`
		}
		if json.Unmarshal(raw, &claim) != nil {
			return nil, nil, nil, assistant.ErrContract
		}
		quotes = append(quotes, claim.Evidence)
	}
	text := strings.Join(quotes, ", ")
	probe.Input.RequestText = &text
	response, err := source.Recommend(ctx, probe)
	if err != nil {
		return nil, nil, nil, err
	}
	if _, err = a.planner.WithCandidates(probe, response.Candidates, response.Evidence, a.now()); err != nil {
		return nil, nil, nil, err
	}
	if a.planner.Router == nil {
		return nil, nil, nil, routing.ErrUnavailable
	}
	origin := day.StartPoint
	if day.Execution != nil {
		origin = day.Execution.CurrentPoint
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
		return nil, nil, nil, err
	}
	candidates := []c.Candidate{}
	metrics := []placeOption{}
	for _, candidate := range response.Candidates {
		if slices.ContainsFunc(view.Days, func(d c.DayPlan) bool {
			return slices.ContainsFunc(d.Stops, func(s c.Stop) bool { return s.PlaceID == candidate.Place.PlaceID })
		}) {
			continue
		}
		point := candidate.Place.Location
		if candidate.Place.Entrance != nil {
			point = *candidate.Place.Entrance
		}
		walk, e := a.planner.Router.Route(ctx, routing.Request{From: origin, To: point, Mode: "walk", WalkingSpeedKPH: &speed})
		if errors.Is(e, routing.ErrNoRoute) {
			continue
		}
		if e != nil {
			return nil, nil, nil, e
		}
		onward, e := a.planner.Router.Route(ctx, routing.Request{From: point, To: next, Mode: "walk", WalkingSpeedKPH: &speed})
		if errors.Is(e, routing.ErrNoRoute) {
			continue
		}
		if e != nil {
			return nil, nil, nil, e
		}
		candidate.Place.DistanceM = &walk.DistanceM
		candidates = append(candidates, candidate)
		metrics = append(metrics, placeOption{PlaceID: candidate.Place.PlaceID, WalkDurationSec: walk.TravelDurationSec, DetourDurationSec: math.Max(0, walk.TravelDurationSec+onward.TravelDurationSec-base.TravelDurationSec)})
		if len(candidates) == 3 {
			break
		}
	}
	return candidates, response.Evidence, metrics, nil
}
