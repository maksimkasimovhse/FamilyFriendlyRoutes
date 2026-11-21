package httpapi

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

func TestLiveActiveDayProgressAndRemoval(t *testing.T) {
	if os.Getenv("LIVE_OSM_TEST") != "1" {
		t.Skip("set LIVE_OSM_TEST=1 with prepared Valhalla")
	}
	manifest, err := routing.LoadManifest("../../data/routing/source-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	router, err := routing.NewClient("http://127.0.0.1:8002", manifest.RoutingDataVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := newActiveHarnessWithRouter(t, router)
	started := h.start(t)
	if len(started.Days[0].Stops) != 3 {
		t.Fatalf("need three demo stops, got %d", len(started.Days[0].Stops))
	}
	h.now = h.now.Add(90 * time.Minute)
	visited := h.progress(t, started, started.Days[0].Stops[0], "visited", "live-visited", 200)
	historicalStop := visited.Days[0].Stops[0]
	historicalLeg := visited.Days[0].Legs[0]
	removed := visited.Days[0].Stops[1].StopID
	preview := h.preview(t, visited, map[string]any{"kind": "remove_stop", "date": visited.Days[0].Date, "stop_id": removed}, 201)
	if got := h.read(t); got.Version != visited.Version || len(got.Days[0].Stops) != 3 {
		t.Fatal("live preview wrote trip")
	}
	final := h.apply(t, preview, 200, "live-apply-remove")
	day := final.Days[0]
	if len(day.Stops) != 2 || !reflect.DeepEqual(day.Stops[0], historicalStop) || !reflect.DeepEqual(day.Legs[0], historicalLeg) {
		t.Fatal("live history changed")
	}
	if day.Execution.ConsumedWalkDistanceM != *historicalLeg.DistanceM || day.Execution.ElapsedDurationSec != 5400 || day.Totals.RemainingWalkDistanceM != nil || *day.Totals.RemainingDurationSec != 16200 {
		t.Fatal("live budget was reset")
	}
	for _, leg := range day.Legs {
		if leg.Geometry == nil || leg.RoutingDataVersion == nil || *leg.RoutingDataVersion != manifest.RoutingDataVersion {
			t.Fatal("missing real OSM geometry")
		}
	}
	report := map[string]any{"checked_at": time.Now().UTC().Format(time.RFC3339), "passed": true, "catalog": "synthetic_demo", "routing_data_version": manifest.RoutingDataVersion, "version": final.Version, "stops_before": 3, "stops_after": len(day.Stops), "history_unchanged": true, "spent_walk_distance_m": day.Execution.ConsumedWalkDistanceM, "spent_elapsed_sec": day.Execution.ElapsedDurationSec, "remaining_walk_distance_m": day.Totals.RemainingWalkDistanceM, "remaining_duration_sec": day.Totals.RemainingDurationSec, "total_walk_distance_m": day.Totals.WalkDistanceM, "walk_delta_sec": preview.Diff.WalkDeltaSec, "elapsed_delta_sec": preview.Diff.ElapsedDeltaSec}
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll("../../data/backend", 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile("../../data/backend/live-active-report.json", append(raw, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	t.Log(string(raw))
}
