package planner

import (
	"context"
	"errors"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"testing"
	"time"
)

type versionSource struct {
	version string
	calls   int
	t       *testing.T
}

func (s *versionSource) CatalogVersion() string { return s.version }
func (s *versionSource) Recommend(_ context.Context, view c.TripView) (c.RecommendationResponse, error) {
	s.calls++
	if view.CatalogVersion != s.version {
		s.t.Fatal("wrong provider for saved catalog")
	}
	return mlResponse(s.t, view, 1), nil
}
func TestCatalogSelectionPreservesOldAndNewTrips(t *testing.T) {
	legacy := &versionSource{version: "mock-ml-v1", t: t}
	city := &versionSource{version: "city-osm-v2", t: t}
	p := Planner{Router: &testRouter{}, Source: CatalogSources{Default: legacy, Versions: map[string]CandidateSource{city.version: city}}}
	now := time.Now()
	var savedLegacy c.TripView
	draft := p.Draft("new", sample(t), now)
	if draft.CatalogVersion != legacy.version {
		t.Fatal("new drafts silently switched catalog")
	}
	for _, version := range []string{legacy.version, city.version} {
		view := p.Draft(c.ID(version), sample(t), now)
		view.CatalogVersion = version
		planned, err := p.Build(context.Background(), view, now)
		if err != nil {
			t.Fatal(err)
		}
		if planned.CatalogVersion != version || len(planned.Days[0].Stops) != 1 {
			t.Fatal("saved trip catalog or IDs changed")
		}
		if version == legacy.version {
			savedLegacy = planned
		}
	}
	if legacy.calls != 1 || city.calls != 1 {
		t.Fatal("wrong provider selected")
	}
	unknown := draft
	unknown.CatalogVersion = "missing"
	if _, err := p.Build(context.Background(), unknown, now); !errors.Is(err, ErrMLContract) {
		t.Fatal("unknown catalog silently migrated")
	}
	// Recalculating saved stops does not need the original provider at all.
	p.Source = CatalogSources{Default: city}
	date := savedLegacy.Days[0].Date
	if _, err := p.Change(context.Background(), savedLegacy, ChangeCommand{Kind: "replan_day", Date: &date}, nil, nil, now); err != nil {
		t.Fatalf("snapshot replan depends on provider registry: %v", err)
	}
	if legacy.calls != 1 || city.calls != 1 {
		t.Fatal("snapshot replan called a recommendation provider")
	}
}

func TestChangedTripInputRefreshesRecommendationSnapshot(t *testing.T) {
	source := &versionSource{version: "city-enriched-v3", t: t}
	p := Planner{Router: &testRouter{}, Source: source}
	now := time.Now()
	view, err := p.Build(context.Background(), p.Draft("refresh", sample(t), now), now)
	if err != nil {
		t.Fatal(err)
	}
	if view.RecommendationSnapshot == nil || source.calls != 1 {
		t.Fatal("missing initial snapshot")
	}
	changed := view.Input
	changed.Family.AdultInterestIDS = []string{"science"}
	updated, err := p.Change(context.Background(), view, ChangeCommand{Kind: "update_trip_input", Input: &changed}, nil, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if source.calls != 2 || updated.RecommendationSnapshot == nil {
		t.Fatal("changed profile reused stale recommendations")
	}
}
