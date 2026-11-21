package httpapi

import (
	"context"
	"net/http"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

func (a *tripAPI) planningOptions(w http.ResponseWriter, r *http.Request) {
	owner, err := a.owner(r, true)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var input c.PlanningOptionsRequest
	if err := readJSON(w, r, &input); err != nil {
		a.respondError(w, r, err)
		return
	}
	if input.ExpectedVersion < 1 {
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Передайте expected_version."))
		return
	}
	var view c.TripView
	err = a.store.Read(func(s tripstore.State) error {
		trip, ok := s.Trips[r.PathValue("trip_id")]
		if !ok || trip.Owner != owner {
			return failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
		}
		if trip.View.Version != input.ExpectedVersion {
			return conflict(trip.View.Version)
		}
		view = trip.View
		if input.PreviewID != nil {
			preview, ok := s.Previews[string(*input.PreviewID)]
			if !ok || preview.Owner != owner || preview.View.TripID != view.TripID {
				return failure(404, "PREVIEW_NOT_FOUND", "Вариант не найден.")
			}
			if preview.View.BaseVersion != input.ExpectedVersion {
				return conflict(trip.View.Version)
			}
			expires, _ := time.Parse(time.RFC3339Nano, string(preview.View.ExpiresAt))
			if !expires.After(a.now()) {
				return failure(410, "PREVIEW_EXPIRED", "Вариант устарел.")
			}
			view = preview.View.ProposedTrip
		}
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	p := a.planner
	if view.Status == "draft" && view.RecommendationSnapshot == nil {
		p, view, err = p.PrepareInitial(ctx, view, a.now())
		if err != nil {
			a.respondError(w, r, err)
			return
		}
	}
	_, hydrated, err := p.Hydrate(ctx, view)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	if input.PreviewID == nil && view.RecommendationSnapshot == nil {
		err = a.store.Update(func(s *tripstore.State) error {
			if _, err := a.liveSession(s, r, owner); err != nil {
				return err
			}
			trip, ok := s.Trips[string(view.TripID)]
			if !ok || trip.Owner != owner {
				return failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
			}
			if trip.View.Version != input.ExpectedVersion {
				return conflict(trip.View.Version)
			}
			if trip.View.RecommendationSnapshot == nil {
				trip.View.RecommendationSnapshot = hydrated.RecommendationSnapshot
				trip.View.Evidence = hydrated.Evidence
				s.Trips[string(view.TripID)] = trip
			} else {
				hydrated.RecommendationSnapshot = trip.View.RecommendationSnapshot
				hydrated.Evidence = trip.View.Evidence
			}
			return nil
		})
		if err != nil {
			a.respondError(w, r, err)
			return
		}
	}
	result, err := p.PlanningOptions(ctx, hydrated, a.now())
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	err = a.store.Read(func(s tripstore.State) error {
		if _, err := a.liveSession(&s, r, owner); err != nil {
			return err
		}
		trip := s.Trips[string(view.TripID)]
		if trip.View.Version != input.ExpectedVersion {
			return conflict(trip.View.Version)
		}
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	result.TripVersion = input.ExpectedVersion
	writeJSON(w, 200, result)
}
