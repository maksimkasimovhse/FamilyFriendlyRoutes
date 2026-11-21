package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

// These POSTs are read-only: search never inserts stops or changes trip versions.
func (a *tripAPI) recommendationBody(w http.ResponseWriter, r *http.Request, value any) (string, error) {
	owner, err := a.owner(r, true)
	if err != nil {
		return "", err
	}
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		return "", failure(415, "UNSUPPORTED_MEDIA_TYPE", "Используйте application/json.")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256*1024))
	if err != nil {
		return "", failure(400, "INVALID_JSON", "Слишком большой запрос.")
	}
	return owner, strict(raw, value)
}

func (a *tripAPI) recommendationTrip(r *http.Request, owner string, version int) (c.TripView, error) {
	var view c.TripView
	err := a.store.Read(func(s tripstore.State) error {
		if _, err := a.liveSession(&s, r, owner); err != nil {
			return err
		}
		trip, ok := s.Trips[r.PathValue("trip_id")]
		if !ok || trip.Owner != owner {
			return failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
		}
		if trip.View.Version != version {
			return conflict(trip.View.Version)
		}
		view = trip.View
		return nil
	})
	return view, err
}

func inputDate(view c.TripView, date *c.ISODate) (*c.ISODate, error) {
	if date == nil {
		if len(view.Input.Days) != 1 {
			return nil, failure(422, "DATE_REQUIRED", "Выберите день поездки.")
		}
		value := view.Input.Days[0].Date
		return &value, nil
	}
	for _, day := range view.Input.Days {
		if day.Date == *date {
			return date, nil
		}
	}
	return nil, failure(422, "DAY_NOT_FOUND", "Дата отсутствует в поездке.")
}

func searchOrigin(view c.TripView, date c.ISODate) c.Point {
	for _, day := range view.Days {
		if day.Date == date && day.Execution != nil {
			return day.Execution.CurrentPoint
		}
	}
	for _, day := range view.Input.Days {
		if day.Date == date {
			return day.StartPoint
		}
	}
	return c.Point{}
}

func radiusScope(point c.Point, radius float64) *c.SpatialScope {
	return &c.SpatialScope{Center: &point, RadiusM: &radius}
}

func routeScope(view c.TripView, date c.ISODate, point c.Point) *c.SpatialScope {
	lines := []c.RouteLine{}
	for _, day := range view.Days {
		if day.Date != date {
			continue
		}
		for _, leg := range day.Legs {
			if day.Execution != nil && slices.Contains(day.Execution.CompletedLegIDS, leg.LegID) {
				continue
			}
			if leg.Geometry == nil || len(leg.Geometry.Coordinates) < 2 {
				continue
			}
			lines = append(lines, c.RouteLine{Type: "LineString", Coordinates: leg.Geometry.Coordinates})
		}
	}
	if len(lines) > 0 {
		width := 250.0
		return &c.SpatialScope{Routes: &lines, CorridorWidthM: &width}
	}
	return radiusScope(point, 1500)
}

// restaurantRouteScope searches a broader walkable corridor for a meal stop.
// Feasibility of the eventual detour is still checked when the user applies a preview.
func restaurantRouteScope(view c.TripView, date c.ISODate, point c.Point) *c.SpatialScope {
	scope := routeScope(view, date, point)
	if scope.Routes != nil {
		width := 600.0
		scope.CorridorWidthM = &width
	}
	return scope
}

func (a *tripAPI) modelRecommendations(ctx context.Context, view c.TripView, purpose string, date *c.ISODate,
	text *string, excluded []c.ID, scope *c.SpatialScope, origin *c.Point, filters *c.RestaurantFilters, limit int) (c.RecommendationResponse, error) {
	p, err := a.planner.ForCatalog(view.CatalogVersion)
	if err != nil {
		return c.RecommendationResponse{}, err
	}
	source, ok := p.Source.(planner.HTTPSource)
	if !ok {
		return c.RecommendationResponse{}, failure(503, "CATALOG_UNAVAILABLE", "HTTP-сервис рекомендаций не подключён.")
	}
	source.Purpose, source.CurrentDayDate, source.CurrentPoint = purpose, date, origin
	source.SpatialScope, source.RestaurantFilters, source.Limit = scope, filters, limit
	source.Excluded = append([]c.ID{}, excluded...)
	source.Visited = []c.ID{}
	for _, day := range view.Days {
		for _, stop := range day.Stops {
			if stop.Progress == "visited" || stop.Progress == "skipped" {
				source.Visited = append(source.Visited, stop.ActivityID)
			}
		}
	}
	probe := view
	probe.Input.Selections = []c.Selection{}
	probe.Input.RequestText = text
	response, err := source.Recommend(ctx, probe)
	if err != nil {
		return response, err
	}
	if err = p.ValidateRecommendations(probe, response); err != nil {
		return response, err
	}
	return response, nil
}

func (a *tripAPI) recommend(w http.ResponseWriter, r *http.Request) {
	var input c.PublicRecommendationRequest
	owner, err := a.recommendationBody(w, r, &input)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	if !slices.Contains([]string{"initial", "restaurant", "along_route"}, input.Purpose) || input.Limit < 1 || input.Limit > 50 || input.RequestText != nil && len([]rune(*input.RequestText)) > 4000 {
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Неверные параметры подбора."))
		return
	}
	view, err := a.recommendationTrip(r, owner, input.ExpectedVersion)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	date := input.Date
	var origin *c.Point
	var scope *c.SpatialScope
	if input.Purpose != "initial" || date != nil {
		date, err = inputDate(view, date)
		if err != nil {
			a.respondError(w, r, err)
			return
		}
		point := searchOrigin(view, *date)
		origin = &point
		if input.Purpose == "along_route" {
			scope = routeScope(view, *date, point)
		}
		if input.Purpose == "restaurant" {
			scope = restaurantRouteScope(view, *date, point)
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	response, err := a.modelRecommendations(ctx, view, input.Purpose, date, input.RequestText, input.ExcludeActivityIDS, scope, origin, input.RestaurantFilters, input.Limit)
	if err == nil {
		_, err = a.recommendationTrip(r, owner, input.ExpectedVersion)
	}
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeJSON(w, 200, c.PublicRecommendationResponse{TripID: view.TripID, TripVersion: view.Version, CatalogVersion: view.CatalogVersion,
		Candidates: response.Candidates, Evidence: response.Evidence, Warnings: response.Warnings, Status: response.Status})
}

func (a *tripAPI) need(w http.ResponseWriter, r *http.Request) {
	var input c.NeedRequest
	owner, err := a.recommendationBody(w, r, &input)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	view, err := a.recommendationTrip(r, owner, input.ExpectedVersion)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	date, err := inputDate(view, &input.Date)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var day *c.DayPlan
	for i := range view.Days {
		if view.Days[i].Date == *date {
			day = &view.Days[i]
			break
		}
	}
	if day == nil {
		a.respondError(w, r, failure(422, "PLAN_REQUIRED", "Сначала создайте план дня."))
		return
	}
	if (input.CurrentPosition == nil) != (input.ObservedAt == nil) {
		a.respondError(w, r, failure(422, "POSITION_REQUIRED", "Передайте точку и время её получения вместе."))
		return
	}
	origin := searchOrigin(view, *date)
	if input.CurrentPosition != nil {
		at, e := time.Parse(time.RFC3339Nano, string(*input.ObservedAt))
		if e != nil || at.After(a.now().Add(planner.ClockSkew)) || a.now().Sub(at) > 5*time.Minute {
			a.respondError(w, r, failure(422, "POSITION_STALE", "Обновите текущую точку и время."))
			return
		}
		origin = *input.CurrentPosition
	}
	if (routing.Request{From: origin, To: origin, Mode: "walk"}).Validate() != nil {
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Точка вне области маршрутизации."))
		return
	}
	response := c.NeedResponse{TripID: view.TripID, TripVersion: view.Version, Options: []c.NeedOption{}, Evidence: []c.Evidence{}, Warnings: []c.Warning{}}
	switch input.Need {
	case "hotel":
		if input.HotelPoint == nil {
			a.respondError(w, r, failure(422, "HOTEL_POINT_REQUIRED", "Укажите адрес или точку отеля; конечная точка дня не считается отелем."))
			return
		}
		if (routing.Request{From: *input.HotelPoint, To: *input.HotelPoint, Mode: "walk"}).Validate() != nil {
			a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Точка отеля вне области маршрутизации."))
			return
		}
	case "tired":
		target := 1800.0
		for _, inputDay := range view.Input.Days {
			if inputDay.Date == *date {
				target = inputDay.DurationBudgetSec / 2
			}
		}
		if day.Totals.RemainingDurationSec != nil {
			target = *day.Totals.RemainingDurationSec / 2
		}
		target = math.Max(60, target)
		response.Options = append(response.Options, needChange("shorten-day", "Сократить оставшийся день", map[string]any{"kind": "shorten_day", "date": *date, "target_remaining_duration_sec": target}))
	case "toilet", "rain", "playground":
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		found, e := a.modelRecommendations(ctx, view, input.Need, date, nil, nil, radiusScope(origin, 1500), &origin, nil, 12)
		if e != nil {
			a.respondError(w, r, e)
			return
		}
		response.Evidence, response.Warnings = found.Evidence, found.Warnings
		items, _, e := a.nearbyOptions(ctx, view, *day, origin, found.Candidates, true, nil)
		if e != nil {
			a.respondError(w, r, e)
			return
		}
		for _, candidate := range items {
			if len(response.Options) == 3 {
				break
			}
			response.Options = append(response.Options, needCandidate(candidate, *date))
		}
	default:
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Неизвестная потребность."))
		return
	}
	if input.Need == "hotel" {
		response.Options = []c.NeedOption{needChange("return-to-hotel", "Вернуться в указанный отель", map[string]any{"kind": "return_to_hotel", "date": *date, "hotel_point": *input.HotelPoint})}
	}
	if _, err = a.recommendationTrip(r, owner, input.ExpectedVersion); err != nil {
		a.respondError(w, r, err)
		return
	}
	writeJSON(w, 200, response)
}

func needChange(id, label string, command map[string]any) c.NeedOption {
	raw, _ := json.Marshal(map[string]any{"option_id": id, "kind": "plan_change", "label": label, "command": command, "preview_required": true})
	return raw
}

func needCandidate(candidate c.Candidate, date c.ISODate) c.NeedOption {
	raw, _ := json.Marshal(map[string]any{"option_id": candidate.Activity.ActivityID, "kind": "candidate", "candidate": candidate, "date": date, "preview_required": true})
	return raw
}
