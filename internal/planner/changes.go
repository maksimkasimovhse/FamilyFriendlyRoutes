package planner

import (
	"context"
	"math"
	"slices"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

// WithCandidates accepts server-resolved catalog objects, never LLM-generated facts.
func (p Planner) WithCandidates(view c.TripView, candidates []c.Candidate, evidence []c.Evidence, now time.Time) (Planner, error) {
	response := c.RecommendationResponse{ContractVersion: "1.0", TripID: view.TripID, TripVersion: view.Version, CatalogVersion: view.CatalogVersion, ModelVersion: "assistant-catalog-v1", GeneratedAt: instant(now), Status: "complete", Candidates: candidates, Evidence: evidence, Warnings: []c.Warning{}}
	_, metadata, err := normalize(response, view)
	if err != nil {
		return p, err
	}
	copied := map[c.ID]c.Candidate{}
	for id, candidate := range p.metadata {
		copied[id] = candidate
	}
	for id, candidate := range metadata {
		copied[id] = candidate
	}
	p.metadata = copied
	return p, nil
}

func (p Planner) selectedCandidate(ctx context.Context, view c.TripView, selection c.Selection) (c.Candidate, []c.Evidence, error) {
	if selection.ActivityID == "" || selection.PlaceID == "" {
		return c.Candidate{}, nil, invalid("UNKNOWN_ACTIVITY")
	}
	if candidate, ok := p.metadata[selection.ActivityID]; ok && candidate.Place.PlaceID == selection.PlaceID {
		return candidate, nil, nil
	}
	if p.Source != nil {
		selected, err := p.ForCatalog(view.CatalogVersion)
		if err != nil {
			return c.Candidate{}, nil, err
		}
		probe := view
		probe.Input.Selections = []c.Selection{selection}
		probe.Input.RequestText = nil
		response, err := selected.Source.Recommend(ctx, probe)
		if err != nil {
			return c.Candidate{}, nil, err
		}
		_, metadata, err := normalize(response, probe)
		if err != nil {
			return c.Candidate{}, nil, err
		}
		if candidate, ok := metadata[selection.ActivityID]; ok && candidate.Place.PlaceID == selection.PlaceID {
			return candidate, response.Evidence, nil
		}
	}
	// Explicit synthetic catalog mode is still useful for integration tests.
	if view.CatalogVersion == "demo-v1" {
		for _, a := range p.Activities {
			if a.ID == selection.ActivityID && a.PlaceID == selection.PlaceID {
				return c.Candidate{Place: c.Place{PlaceID: a.PlaceID, Name: a.Title, Location: a.Point, Categories: []c.Category{"landmark"}}, Activity: c.Activity{ActivityID: a.ID, PlaceID: a.PlaceID, Title: a.Title, Kind: "visit", Duration: c.DurationEstimate{DurationSec: a.DurationSec, Source: "estimated", EvidenceIDS: []c.ID{}}}, Warnings: []c.Warning{Warning("DEMO_CATALOG", "Тестовая остановка.")}}, nil, nil
			}
		}
	}
	return c.Candidate{}, nil, stateError("UNKNOWN_ACTIVITY", "Место отсутствует в доступном каталоге.")
}

func (p Planner) insert(ctx context.Context, view c.TripView, i, j int, cmd ChangeCommand, position *routing.Point, observed *c.Instant, now time.Time) (c.TripView, error) {
	candidate, evidence, err := p.selectedCandidate(ctx, view, *cmd.Selection)
	if err != nil {
		return c.TripView{}, err
	}
	for _, day := range view.Days {
		for _, s := range day.Stops {
			if s.PlaceID == candidate.Place.PlaceID || s.ActivityID == candidate.Activity.ActivityID {
				return c.TripView{}, stateError("DUPLICATE_ACTIVITY", "Место уже присутствует в поездке.")
			}
		}
	}
	selection := cmd.Selection
	if selection.PreferredDate != nil && *selection.PreferredDate != view.Days[i].Date {
		return c.TripView{}, stateError("SELECTION_CONFLICT", "Дата выбранной активности не совпадает с днём.")
	}
	if p.metadata == nil {
		p.metadata = map[c.ID]c.Candidate{}
	} else {
		copied := map[c.ID]c.Candidate{}
		for id, candidate := range p.metadata {
			copied[id] = candidate
		}
		p.metadata = copied
	}
	p.metadata[candidate.Activity.ActivityID] = candidate
	if view.CatalogVersion == "demo-v1" && candidate.Availability == nil {
		delete(p.metadata, candidate.Activity.ActivityID)
	}
	stop := c.Stop{StopID: c.ID("stop-" + string(candidate.Activity.ActivityID)), PlaceID: candidate.Place.PlaceID, ActivityID: candidate.Activity.ActivityID, Title: candidate.Activity.Title, Location: candidate.Place.Location, Duration: candidate.Activity.Duration, Mandatory: selection.Mandatory, Progress: "planned", OccurrenceID: selection.OccurrenceID, Reasons: candidate.Reasons, Warnings: candidate.Warnings, BalanceCredit: candidate.BalanceCredit}
	kind := candidate.Activity.Kind
	stop.ActivityKind = &kind
	if candidate.Place.Entrance != nil {
		stop.Location = *candidate.Place.Entrance
	}
	if len(candidate.Place.Categories) > 0 {
		stop.Category = candidate.Place.Categories[0]
	}
	if view.CatalogVersion != "demo-v1" {
		availability := candidate.Availability
		stop.Availability = &availability
	}
	stops := view.Days[i].Stops
	at := 0
	for at < len(stops) && stops[at].Progress != "planned" {
		at++
	}
	if cmd.Kind == "replace_stop" {
		found := false
		for index, old := range stops {
			if old.StopID == *cmd.StopID {
				if old.Progress != "planned" {
					return c.TripView{}, stateError("HISTORY_IMMUTABLE", "История посещений сохранена.")
				}
				if old.Mandatory {
					return c.TripView{}, stateError("MANDATORY_STOP", "Обязательную остановку нельзя заменить.")
				}
				at = index
				stops = append(stops[:index:index], stops[index+1:]...)
				found = true
				break
			}
		}
		if !found {
			return c.TripView{}, stateError("STOP_NOT_FOUND", "Остановка не найдена.")
		}
	} else if cmd.AfterStopID != nil {
		found := false
		for index, old := range stops {
			if old.StopID == *cmd.AfterStopID && old.Progress == "planned" {
				at = index + 1
				found = true
				break
			}
		}
		if !found {
			return c.TripView{}, stateError("STOP_NOT_FOUND", "Следующая остановка не найдена.")
		}
	}
	next := append([]c.Stop{}, stops[:at]...)
	next = append(next, stop)
	next = append(next, stops[at:]...)
	view.Days[i].Stops = next
	for _, span := range evidence {
		if !slices.ContainsFunc(view.Evidence, func(old c.Evidence) bool { return old.EvidenceID == span.EvidenceID }) {
			view.Evidence = append(view.Evidence, span)
		}
	}
	return p.rebuildExistingDay(ctx, view, i, j, position, observed, now)
}

func (p Planner) shorten(ctx context.Context, view c.TripView, i, j int, cmd ChangeCommand, position *routing.Point, observed *c.Instant, now time.Time) (c.TripView, error) {
	if p.Router == nil {
		return c.TripView{}, routing.ErrUnavailable
	}
	p.Router = &routeCache{router: p.Router, values: map[routeKey]routing.Result{}}
	day := &view.Input.Days[j]
	at := now
	if observed != nil {
		var err error
		at, err = parseInstant(*observed)
		if err != nil {
			return c.TripView{}, err
		}
	}
	spent := 0.0
	if execution := view.Days[i].Execution; execution != nil {
		started, _ := parseInstant(execution.StartedAt)
		spent = math.Max(0, at.Sub(started).Seconds())
	}
	if cmd.TargetRemainingWalkDistanceM != nil {
		spentDistance := 0.0
		if execution := view.Days[i].Execution; execution != nil {
			spentDistance = execution.ConsumedWalkDistanceM
		}
		limit := math.Min(dailyWalkLimit(view.Input, *day), spentDistance+*cmd.TargetRemainingWalkDistanceM)
		day.MaxWalkDistanceM = &limit
	}
	if cmd.HotelPoint != nil {
		if err := (routing.Request{From: *cmd.HotelPoint, To: *cmd.HotelPoint, Mode: "walk"}).Validate(); err != nil {
			return c.TripView{}, invalid(err.Error())
		}
		day.EndPoint = *cmd.HotelPoint
	}
	if cmd.TargetRemainingDurationSec != nil {
		target := *cmd.TargetRemainingDurationSec
		day.DurationBudgetSec = math.Min(day.DurationBudgetSec, spent+target)
		if day.AvailableWindow != nil {
			start, _ := parseInstant(day.AvailableWindow.StartAt)
			end, _ := parseInstant(day.AvailableWindow.EndAt)
			origin := start
			if view.Days[i].Execution != nil {
				origin = at
			}
			shortened := origin.Add(time.Duration(target * float64(time.Second)))
			if shortened.Before(end) {
				day.AvailableWindow = &c.Interval{StartAt: day.AvailableWindow.StartAt, EndAt: instant(shortened)}
			}
		}
	}
	// Return preserves mandatory visits; all other future visits are explicitly removed.
	if cmd.Kind == "return_to_hotel" {
		stops := []c.Stop{}
		for _, s := range view.Days[i].Stops {
			if s.Progress != "planned" || s.Mandatory {
				stops = append(stops, s)
			}
		}
		view.Days[i].Stops = stops
	}
	for {
		trial, err := cloneView(view)
		if err != nil {
			return c.TripView{}, err
		}
		result, err := p.rebuildExistingDay(ctx, trial, i, j, position, observed, now)
		if err != nil {
			return c.TripView{}, err
		}
		if result.Days[i].Feasibility != "infeasible" || cmd.Kind == "return_to_hotel" {
			return result, nil
		}
		// Evaluate each removal using directed walking routes, not list position.
		best := -1
		bestCost := math.Inf(1)
		for index, stop := range view.Days[i].Stops {
			if stop.Progress != "planned" || stop.Mandatory {
				continue
			}
			probe, _ := cloneView(view)
			probe.Days[i].Stops = append(probe.Days[i].Stops[:index:index], probe.Days[i].Stops[index+1:]...)
			candidate, err := p.rebuildExistingDay(ctx, probe, i, j, position, observed, now)
			if err != nil {
				return c.TripView{}, err
			}
			cost := *candidate.Days[i].Totals.ElapsedDurationSec
			if candidate.Days[i].Feasibility != "infeasible" {
				cost -= 1e9
			}
			if cost < bestCost {
				best = index
				bestCost = cost
			}
		}
		if best < 0 {
			return result, nil
		}
		view.Days[i].Stops = append(view.Days[i].Stops[:best:best], view.Days[i].Stops[best+1:]...)
	}
}

func (p Planner) move(ctx context.Context, view c.TripView, i, j int, cmd ChangeCommand, position *routing.Point, observed *c.Instant, now time.Time) (c.TripView, error) {
	target, err := dayIndex(view, *cmd.TargetDate)
	if err != nil {
		return c.TripView{}, err
	}
	targetInput, err := inputDayIndex(view, *cmd.TargetDate)
	if err != nil {
		return c.TripView{}, err
	}
	if view.Days[target].Execution != nil {
		return c.TripView{}, stateError("DAY_ALREADY_STARTED", "Перенос возможен только в ещё не начатый день.")
	}
	if view.Days[i].Execution != nil && *cmd.TargetDate <= *cmd.Date {
		return c.TripView{}, stateError("DAY_NOT_ACTIVE", "Оставшиеся посещения начатого дня можно перенести только вперёд.")
	}
	found := -1
	var stop c.Stop
	for index, s := range view.Days[i].Stops {
		if s.StopID == *cmd.StopID {
			found = index
			stop = s
			break
		}
	}
	if found < 0 {
		return c.TripView{}, stateError("STOP_NOT_FOUND", "Остановка не найдена.")
	}
	if stop.Progress != "planned" {
		return c.TripView{}, stateError("HISTORY_IMMUTABLE", "Посещённую остановку нельзя перенести.")
	}
	view.Days[i].Stops = append(view.Days[i].Stops[:found:found], view.Days[i].Stops[found+1:]...)
	view.Days[target].Stops = append(view.Days[target].Stops, stop)
	for index, selection := range view.Input.Selections {
		if selection.ActivityID == stop.ActivityID {
			view.Input.Selections[index].PreferredDate = cmd.TargetDate
		}
	}
	base := view.Version
	result, err := p.rebuildExistingDay(ctx, view, i, j, position, observed, now)
	if err != nil {
		return c.TripView{}, err
	}
	result, err = p.rebuildExistingDay(ctx, result, target, targetInput, nil, nil, now)
	if err != nil {
		return c.TripView{}, err
	}
	result.Version = base + 1
	return result, nil
}
