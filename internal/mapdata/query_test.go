package mapdata

import (
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"net/url"
	"strings"
	"testing"
)

func TestQueryValidationAndCursor(t *testing.T) {
	for _, query := range []string{
		"", "lon=44&lat=56", "lon=NaN&lat=56&radius_km=1", "lon=44&lat=Infinity&radius_km=1",
		"lon=181&lat=56&radius_km=1", "lon=44&lat=56&radius_km=0", "lon=44&lat=56&radius_km=21",
		"bbox=44,56,43,57", "bbox=44,56,46,57", "bbox=44,56,45,57&radius_km=1",
		"lon=44&lat=56&radius_km=1&categories=unknown", "lon=44&lat=56&radius_km=1&limit=1001",
		"lon=44&lat=56&radius_km=1&lon=45", "lon=44&lat=56&radius_km=1&cursor=garbage",
	} {
		v, _ := url.ParseQuery(query)
		if _, err := Parse(v); err == nil {
			t.Errorf("accepted %s", query)
		}
	}
	v, _ := url.ParseQuery("lon=44&lat=56&radius_km=2&categories=toilet,pharmacy&limit=10")
	q, err := Parse(v)
	if err != nil || q.RadiusM != 2000 || q.Categories[0] != "pharmacy" {
		t.Fatal(q, err)
	}
	v.Set("cursor", q.Next(10))
	next, err := Parse(v)
	if err != nil || next.Offset != 10 {
		t.Fatal("cursor cannot be continued", err)
	}
	v.Set("radius_km", "3")
	if _, err := Parse(v); err == nil {
		t.Fatal("cursor accepted different search")
	}
}
func TestRouteCorridorQueryAndCursor(t *testing.T) {
	lines := [][]routing.Position{{{44, 56}, {44.1, 56}}}
	v, _ := url.ParseQuery("date=2030-06-15&expected_version=2&limit=1")
	q, err := ParseRoute(v, lines)
	if err != nil || q.RadiusM != 250 || q.RouteVersion != 2 {
		t.Fatal(q, err)
	}
	v.Set("cursor", q.Next(1))
	if next, err := ParseRoute(v, lines); err != nil || next.Offset != 1 {
		t.Fatal("route cursor failed", err)
	}
	if _, err := ParseRoute(v, [][]routing.Position{{{44, 56}, {44.2, 56}}}); err == nil {
		t.Fatal("cursor accepted another geometry")
	}
	v.Del("cursor")
	v.Set("lon", "44")
	if _, err := ParseRoute(v, lines); err == nil {
		t.Fatal("route query accepted GPS centre")
	}
	v.Del("lon")
	v.Set("buffer_m", "0")
	if _, err := ParseRoute(v, lines); err == nil {
		t.Fatal("zero corridor accepted")
	}
	if _, err := ParseRoute(v, nil); err == nil {
		t.Fatal("empty route accepted")
	}
}

func TestSnapshotValidation(t *testing.T) {
	valid := `{"type":"FeatureCollection","checked_at":"2026-11-20T00:00:00Z","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[44,56]},"properties":{"osm":"node/1","kind":"toilet","name":null}}]}`
	if _, err := ParseSnapshot(strings.NewReader(valid)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{strings.Replace(valid, "node/1", "garbage", 1), strings.Replace(valid, "[44,56]", "[181,56]", 1), strings.Replace(valid, `"kind":"toilet"`, `"kind":"fake"`, 1), valid + " {}", `{"type":"FeatureCollection","features":[]}`} {
		if _, err := ParseSnapshot(strings.NewReader(raw)); err == nil {
			t.Fatal("invalid snapshot accepted")
		}
	}
}
