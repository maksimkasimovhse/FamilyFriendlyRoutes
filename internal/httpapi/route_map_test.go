package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/mapdata"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

type routeRepository struct {
	query mapdata.Query
	after func()
}

func (s *routeRepository) Search(_ context.Context, q mapdata.Query) (c.MapResponse, error) {
	s.query = q
	if s.after != nil {
		s.after()
	}
	return c.MapResponse{CatalogVersion: "test", Items: []c.Place{}, Evidence: []c.Evidence{}}, nil
}
func TestRoutePlacesOwnershipVersionAndGeometry(t *testing.T) {
	h := newActiveHarness(t)
	view := h.read(t)
	repo := &routeRepository{}
	mux := http.NewServeMux()
	mux.Handle("GET /api/v1/trips/{trip_id}/map/places", routeMapHandler(h.store, repo, func() time.Time { return h.now }))
	path := h.path + "/map/places?date=2030-06-15&expected_version=2"
	w := request(mux, h.browser, "GET", path, "", "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result c.MapResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.RouteVersion == nil || *result.RouteVersion != view.Version || result.RouteDate == nil || *result.RouteDate != view.Days[0].Date || repo.query.RadiusM != 125 || len(repo.query.RouteLines) != len(view.Days[0].Legs) {
		t.Fatal("route metadata/geometry lost")
	}
	for i, line := range repo.query.RouteLines {
		if len(line) != len(view.Days[0].Legs[i].Geometry.Coordinates) {
			t.Fatal("route geometry was simplified")
		}
	}
	for _, tc := range []struct {
		b    browser
		path string
		want int
	}{
		{browser{}, path, 401},
		{bootstrap(t, h.handler), path, 404},
		{h.browser, strings.Replace(path, "expected_version=2", "expected_version=1", 1), 409},
		{h.browser, path + "&lon=44&lat=56&radius_km=2", 422},
		{h.browser, strings.Replace(path, "2030-06-15", "2030-06-17", 1), 404},
	} {
		if w := request(mux, tc.b, "GET", tc.path, "", ""); w.Code != tc.want {
			t.Fatalf("want %d got %d: %s", tc.want, w.Code, w.Body.String())
		}
	}
	repo.after = func() {
		if err := h.store.Update(func(s *tripstore.State) error {
			trip := s.Trips[string(view.TripID)]
			trip.View.Version++
			s.Trips[string(view.TripID)] = trip
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if w := request(mux, h.browser, "GET", path, "", ""); w.Code != 409 {
		t.Fatal("returned old corridor after route changed")
	}
}
