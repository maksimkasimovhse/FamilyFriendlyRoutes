package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/mapdata"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

func RouteMapHandler(store *tripstore.Store, db mapdata.Repository) http.Handler {
	return routeMapHandler(store, db, func() time.Time { return time.Now().UTC() })
}
func routeMapHandler(store *tripstore.Store, db mapdata.Repository, now func() time.Time) http.Handler {
	a := &tripAPI{store: store, now: now}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-ID", newID())
		w.Header().Set("Cache-Control", "no-store")
		owner, err := a.owner(r, false)
		if err != nil {
			a.respondError(w, r, err)
			return
		}
		version, err := strconv.Atoi(r.URL.Query().Get("expected_version"))
		if err != nil || version < 1 {
			a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Передайте expected_version."))
			return
		}
		var view c.TripView
		err = store.Read(func(s tripstore.State) error {
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
		if err != nil {
			a.respondError(w, r, err)
			return
		}
		var day *c.DayPlan
		for i := range view.Days {
			if string(view.Days[i].Date) == r.URL.Query().Get("date") {
				day = &view.Days[i]
				break
			}
		}
		if day == nil {
			a.respondError(w, r, failure(404, "DAY_NOT_FOUND", "Сохранённый маршрут на эту дату не найден."))
			return
		}
		lines := [][]routing.Position{}
		for _, leg := range day.Legs {
			if leg.Geometry != nil && len(leg.Geometry.Coordinates) >= 2 {
				lines = append(lines, leg.Geometry.Coordinates)
			}
		}
		query, err := mapdata.ParseRoute(r.URL.Query(), lines)
		if err != nil {
			a.respondError(w, r, failure(422, "VALIDATION_ERROR", err.Error()))
			return
		}
		if db == nil {
			a.respondError(w, r, failure(503, "CATALOG_UNAVAILABLE", "База каталога не подключена."))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		result, err := db.Search(ctx, query)
		if err != nil {
			a.respondError(w, r, failure(503, "CATALOG_UNAVAILABLE", "Каталог временно недоступен."))
			return
		}
		// Do not return a corridor for a version which changed during the DB query.
		err = store.Read(func(s tripstore.State) error {
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
			return nil
		})
		if err != nil {
			a.respondError(w, r, err)
			return
		}
		result.RouteVersion = &version
		result.RouteDate = &day.Date
		writeJSON(w, 200, result)
	})
}
