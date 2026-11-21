package planner

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

// Stop duration defaults are estimates; client coordinates and durations are not trusted.
var infrastructureDuration = map[c.Category]float64{"pharmacy": 900, "toilet": 600, "restaurant": 2700, "bench": 600, "park": 900, "playground": 1200}

func (p Planner) insertInfrastructure(ctx context.Context, view c.TripView, cmd ChangeCommand, position *routing.Point, observed *c.Instant, now time.Time) (c.TripView, error) {
	if p.Infrastructure == nil {
		return c.TripView{}, stateError("INFRASTRUCTURE_UNAVAILABLE", "Каталог инфраструктуры не подключён.")
	}
	i, err := dayIndex(view, *cmd.Date)
	if err != nil {
		return c.TripView{}, err
	}
	j, err := inputDayIndex(view, *cmd.Date)
	if err != nil {
		return c.TripView{}, err
	}
	if view.Days[i].Execution != nil {
		if err := activeDay(view, i); err != nil {
			return c.TripView{}, err
		}
	}
	place, err := p.Infrastructure(ctx, *cmd.PlaceID)
	if err != nil {
		return c.TripView{}, err
	}
	if place.PlaceID != *cmd.PlaceID || len(place.Categories) == 0 {
		return c.TripView{}, invalid("Неверный объект инфраструктуры.")
	}
	kind := place.Categories[0]
	duration, ok := infrastructureDuration[kind]
	if !ok {
		return c.TripView{}, invalid("Объект не относится к инфраструктуре.")
	}
	for _, stop := range view.Days[i].Stops {
		if stop.PlaceID == place.PlaceID && stop.Progress == "planned" {
			return c.TripView{}, stateError("PLACE_ALREADY_PLANNED", "Это место уже есть в маршруте дня.")
		}
	}
	point := place.Location
	if place.Entrance != nil {
		point = *place.Entrance
	}
	if err := (routing.Request{From: point, To: point, Mode: "walk"}).Validate(); err != nil {
		return c.TripView{}, invalid(err.Error())
	}
	if position != nil {
		if err := (routing.Request{From: *position, To: *position, Mode: "walk"}).Validate(); err != nil {
			return c.TripView{}, invalid(err.Error())
		}
		if view.Days[i].Execution != nil {
			if err := p.accountUrgentMovement(ctx, &view, i, *position, observed, now); err != nil {
				return c.TripView{}, err
			}
		} else {
			view.Input.Days[j].StartPoint = *position
			view.Days[i].StartPoint = *position
		}
	}
	if view.Days[i].Execution == nil {
		observed = nil
	}
	id := c.ID(fmt.Sprintf("infra-%s-%s-v%d", *cmd.Date, place.PlaceID, view.Version+1))
	estimate := c.DurationEstimate{DurationSec: duration, Source: "estimated", EvidenceIDS: []c.ID{}}
	availability := []c.AvailabilityDay{{Date: *cmd.Date, State: "unknown"}}
	activityKind := "visit"
	stop := c.Stop{StopID: c.ID("stop-" + string(id)), ActivityID: id, PlaceID: place.PlaceID, Title: place.Name, Category: kind, Location: point, Progress: "planned", Duration: estimate, ActivityKind: &activityKind, Availability: &availability,
		Reasons: []c.Reason{}, Warnings: []c.Warning{Warning("INFRASTRUCTURE_HOURS_UNKNOWN", "Часы работы и доступность срочного захода не подтверждены."), Warning("INFRASTRUCTURE_DURATION_ESTIMATED", fmt.Sprintf("Время захода оценено в %.0f мин; его можно завершить раньше.", duration/60))}}
	idx := nextPlanned(view.Days[i])
	if idx < 0 {
		idx = len(view.Days[i].Stops)
	}
	stops := append([]c.Stop{}, view.Days[i].Stops[:idx]...)
	stops = append(stops, stop)
	stops = append(stops, view.Days[i].Stops[idx:]...)
	view.Days[i].Stops = stops
	// Reuse the reserved meal/rest time rather than charging the same pause twice.
	if kind == "restaurant" {
		value := math.Max(0, *view.Input.Days[j].MealDurationSec-duration)
		view.Input.Days[j].MealDurationSec = &value
	}
	if kind == "bench" {
		view.Input.Days[j].RestBudgetSec = math.Max(0, view.Input.Days[j].RestBudgetSec-duration)
	}
	return p.rebuildExistingDay(ctx, view, i, j, nil, observed, now)
}

// GPS is a new anchor, not a track. Account the OSM estimate from the last
// confirmed point separately, retain its geometry, and make the assumption visible.
func (p Planner) accountUrgentMovement(ctx context.Context, view *c.TripView, index int, point routing.Point, observed *c.Instant, now time.Time) error {
	day := &view.Days[index]
	execution := day.Execution
	if observed == nil {
		return stateError("INVALID_OBSERVED_AT", "Для текущей геопозиции нужно время наблюдения.")
	}
	at, err := parseInstant(*observed)
	if err != nil {
		return err
	}
	previous, _ := parseInstant(execution.ObservedAt)
	if at.Before(previous) || at.After(now.Add(ClockSkew)) {
		return stateError("INVALID_OBSERVED_AT", "Некорректное время геопозиции.")
	}
	if point.Coordinates == execution.CurrentPoint.Coordinates {
		return nil
	}
	speed := budgetDefaults.WalkingSpeedKPHByPace[view.Input.LoadLimits.Pace]
	result, err := p.Router.Route(ctx, routing.Request{From: execution.CurrentPoint, To: point, Mode: "walk", WalkingSpeedKPH: &speed})
	if err != nil {
		return err
	}
	from, _ := json.Marshal(map[string]any{"kind": "current_position", "point": execution.CurrentPoint})
	to, _ := json.Marshal(map[string]any{"kind": "current_position", "point": point})
	var leg c.Leg
	raw, _ := json.Marshal(map[string]any{"geometry": result.Geometry})
	_ = json.Unmarshal(raw, &leg)
	leg.LegID = c.ID(fmt.Sprintf("leg-gps-%s-v%d", day.Date, view.Version+1))
	leg.From = from
	leg.To = to
	leg.Mode = "walk"
	leg.Status = "calculated"
	leg.DistanceM = &result.DistanceM
	leg.TravelDurationSec = &result.TravelDurationSec
	leg.RoutingDataVersion = &result.RoutingDataVersion
	leg.Warnings = []c.Warning{Warning("GPS_MOVEMENT_ESTIMATED", "Путь от последней подтверждённой позиции до GPS оценён по OSM; фактический трек неизвестен.")}
	day.Legs = append(day.Legs, leg)
	execution.CompletedLegIDS = append(execution.CompletedLegIDS, leg.LegID)
	execution.ConsumedWalkDistanceM += result.DistanceM
	execution.ConsumedWalkDurationSec += result.TravelDurationSec
	execution.CurrentPoint = point
	view.Warnings = append(view.Warnings, leg.Warnings...)
	return nil
}
