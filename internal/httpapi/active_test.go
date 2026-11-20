package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

type activeRouter struct {
	err      error
	delegate planner.Router
}

func (r *activeRouter) Route(ctx context.Context, req routing.Request) (routing.Result, error) {
	if r.err != nil {
		return routing.Result{}, r.err
	}
	if r.delegate != nil {
		return r.delegate.Route(ctx, req)
	}
	return dayRouter{}.Route(ctx, req)
}

type activeHarness struct {
	handler        http.Handler
	browser        browser
	store          *tripstore.Store
	path, filename string
	now            time.Time
	router         *activeRouter
}

func body(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
func (h *activeHarness) read(t *testing.T) c.TripView {
	t.Helper()
	w := request(h.handler, h.browser, "GET", h.path, "", "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var view c.TripView
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	return view
}
func (h *activeHarness) preview(t *testing.T, view c.TripView, command any, status int) c.PlanPreview {
	t.Helper()
	payload := map[string]any{"expected_version": view.Version, "command": command, "current_position": nil, "observed_at": nil}
	w := request(h.handler, h.browser, "POST", h.path+"/previews", body(t, payload), "")
	if w.Code != status {
		t.Fatalf("preview: want %d got %d: %s", status, w.Code, w.Body.String())
	}
	var result c.PlanPreview
	if status == 201 {
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return result
}
func (h *activeHarness) apply(t *testing.T, preview c.PlanPreview, status int, key string) c.TripView {
	t.Helper()
	w := request(h.handler, h.browser, "POST", h.path+"/previews/"+string(preview.PreviewID)+"/apply", body(t, c.ApplyRequest{ExpectedVersion: preview.BaseVersion, AcknowledgedWarningCodes: preview.RequiredAcknowledgementCodes}), key)
	if w.Code != status {
		t.Fatalf("apply: want %d got %d: %s", status, w.Code, w.Body.String())
	}
	var view c.TripView
	if status == 200 {
		_ = json.Unmarshal(w.Body.Bytes(), &view)
	}
	return view
}
func (h *activeHarness) progress(t *testing.T, view c.TripView, stop c.Stop, status, key string, expected int) c.TripView {
	t.Helper()
	payload := c.ProgressRequest{ExpectedVersion: view.Version, Date: view.Days[0].Date, StopID: stop.StopID, Status: status, ObservedAt: c.Instant(h.now.Format(time.RFC3339))}
	w := request(h.handler, h.browser, "POST", h.path+"/progress", body(t, payload), key)
	if w.Code != expected {
		t.Fatalf("progress: want %d got %d: %s", expected, w.Code, w.Body.String())
	}
	var result c.TripView
	if expected == 200 {
		_ = json.Unmarshal(w.Body.Bytes(), &result)
	}
	return result
}
func newActiveHarness(t *testing.T) *activeHarness {
	return newActiveHarnessWithRouter(t, nil)
}
func newActiveHarnessWithRouter(t *testing.T, delegate planner.Router) *activeHarness {
	t.Helper()
	h := &activeHarness{filename: filepath.Join(t.TempDir(), "state.json"), now: time.Date(2030, 6, 15, 10, 0, 0, 0, time.FixedZone("MSK", 10800)), router: &activeRouter{}}
	h.router.delegate = delegate
	var err error
	h.store, err = tripstore.Open(h.filename)
	if err != nil {
		t.Fatal(err)
	}
	h.handler = tripHandler(h.store, planner.Planner{Router: h.router, Activities: planner.DemoActivities()}, func() time.Time { return h.now })
	h.browser = bootstrap(t, h.handler)
	raw, err := os.ReadFile("../../examples/trip-one-day.json")
	if err != nil {
		t.Fatal(err)
	}
	var input c.TripInput
	_ = json.Unmarshal(raw, &input)
	zero := 0.0
	input.Days[0].MealDurationSec = &zero
	if delegate != nil {
		limit, segment := 10000.0, 7200.0
		input.LoadLimits.MaxWalkDistanceMPerDay = &limit
		input.LoadLimits.MaxContinuousWalkDurationSec = &segment
	}
	second := input.Days[0]
	second.Date = "2030-06-16"
	second.AvailableWindow = &c.Interval{StartAt: "2030-06-16T10:00:00+03:00", EndAt: "2030-06-16T17:00:00+03:00"}
	input.Days = append(input.Days, second)
	created := request(h.handler, h.browser, "POST", "/api/v1/trips", body(t, input), "create-active")
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var draft c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &draft)
	h.path = "/api/v1/trips/" + string(draft.TripID)
	initial := h.preview(t, draft, map[string]any{"kind": "generate_plan"}, 201)
	h.apply(t, initial, 200, "apply-generated")
	return h
}
func (h *activeHarness) start(t *testing.T) c.TripView {
	t.Helper()
	view := h.read(t)
	preview := h.preview(t, view, map[string]any{"kind": "start_day", "date": view.Days[0].Date, "point": view.Days[0].StartPoint, "start_at": h.now.Format(time.RFC3339)}, 201)
	unchanged := h.read(t)
	if unchanged.Status != "planned" || unchanged.Days[0].Execution != nil {
		t.Fatal("start preview wrote execution state")
	}
	result := h.apply(t, preview, 200, "apply-start")
	if result.Status != "active" || result.Days[0].Execution == nil || result.Days[0].Presentation != "clock" || result.Days[1].Presentation != "relative" {
		t.Fatal("incorrect day activation")
	}
	return result
}

func TestActiveDayProgressRemovePreviewApplyAndRestart(t *testing.T) {
	h := newActiveHarness(t)
	started := h.start(t)
	if len(started.Days[0].Stops) != 3 {
		t.Fatal("need three fixture stops")
	}
	unrelated := started.Days[1]
	stale := h.preview(t, started, map[string]any{"kind": "replan_day", "date": started.Days[0].Date}, 201)
	h.now = h.now.Add(15 * time.Minute)
	visited := h.progress(t, started, started.Days[0].Stops[0], "visited", "visited-1", 200)
	if visited.Version != 4 || visited.Days[0].Execution.ConsumedWalkDistanceM != 100 || visited.Days[0].Execution.ElapsedDurationSec != 900 || !reflect.DeepEqual(visited.Days[0].Legs, started.Days[0].Legs) {
		t.Fatal("progress rewrote route or lost consumed budget")
	}
	replay := h.progress(t, started, started.Days[0].Stops[0], "visited", "visited-1", 200)
	if replay.Version != 4 || replay.Days[0].Execution.ConsumedWalkDistanceM != 100 {
		t.Fatal("progress retry counted walking twice")
	}
	h.apply(t, stale, 409, "stale-after-progress")
	savedStop := visited.Days[0].Stops[0]
	savedLeg := visited.Days[0].Legs[0]
	removed := visited.Days[0].Stops[1].StopID
	preview := h.preview(t, visited, map[string]any{"kind": "remove_stop", "date": visited.Days[0].Date, "stop_id": removed}, 201)
	if got := h.read(t); got.Version != 4 || len(got.Days[0].Stops) != 3 {
		t.Fatal("removal preview changed saved state")
	}
	if !reflect.DeepEqual(preview.Diff.RemovedStopIDS, []c.ID{removed}) || len(preview.Diff.ChangedDates) != 1 {
		t.Fatal("incorrect removal diff")
	}
	final := h.apply(t, preview, 200, "apply-removal")
	day := final.Days[0]
	if final.Version != 5 || len(day.Stops) != 2 || len(day.Legs) != 3 || !reflect.DeepEqual(day.Stops[0], savedStop) || !reflect.DeepEqual(day.Legs[0], savedLeg) || !reflect.DeepEqual(final.Days[1], unrelated) {
		t.Fatal("history or other day was modified")
	}
	if *day.Totals.RemainingWalkDistanceM != 2400 || *day.Totals.RemainingDurationSec != 20700 || *day.Totals.WalkDistanceM != 300 {
		t.Fatalf("remaining budget restarted: %+v", day.Totals)
	}
	if *day.Totals.ElapsedDurationSec != 900+120+day.Stops[1].Duration.DurationSec {
		t.Fatal("spent time lost or counted twice")
	}
	ids := map[c.ID]bool{}
	for _, leg := range day.Legs {
		if ids[leg.LegID] {
			t.Fatal("duplicate history/remaining leg ID")
		}
		ids[leg.LegID] = true
	}
	// Reopen the store and verify the completed prefix survives a restart.
	reopened, err := tripstore.Open(h.filename)
	if err != nil {
		t.Fatal(err)
	}
	h.store = reopened
	h.handler = tripHandler(reopened, planner.Planner{Router: h.router, Activities: planner.DemoActivities()}, func() time.Time { return h.now })
	if restored := h.read(t); !reflect.DeepEqual(restored, final) {
		t.Fatal("restart lost execution state")
	}
	// Another replan must debit the original budget once, not the previous remainder.
	h.now = h.now.Add(5 * time.Minute)
	next := h.preview(t, final, map[string]any{"kind": "replan_day", "date": day.Date}, 201)
	if *next.ProposedTrip.Days[0].Totals.RemainingDurationSec != 20400 || *next.ProposedTrip.Days[0].Totals.RemainingWalkDistanceM != 2400 {
		t.Fatal("repeated replan double-counted progress")
	}
}

func TestActiveDayGuardsAndDependencyFailureDoNotWrite(t *testing.T) {
	h := newActiveHarness(t)
	view := h.start(t)
	h.progress(t, view, view.Days[0].Stops[1], "visited", "out-of-order", 422)
	future := h.now.Add(2 * time.Minute)
	original := h.now
	h.now = future
	payload := c.ProgressRequest{ExpectedVersion: view.Version, Date: view.Days[0].Date, StopID: view.Days[0].Stops[0].StopID, Status: "visited", ObservedAt: c.Instant(future.Format(time.RFC3339))}
	h.now = original
	if w := request(h.handler, h.browser, "POST", h.path+"/progress", body(t, payload), "future"); w.Code != 422 {
		t.Fatal("future progress accepted")
	}
	h.now = h.now.Add(2 * time.Minute)
	view = h.progress(t, view, view.Days[0].Stops[0], "visited", "visit", 200)
	h.preview(t, view, map[string]any{"kind": "remove_stop", "date": view.Days[0].Date, "stop_id": view.Days[0].Stops[0].StopID}, 422)
	h.preview(t, view, map[string]any{"kind": "generate_plan"}, 422)
	h.router.err = routing.ErrUnavailable
	h.preview(t, view, map[string]any{"kind": "remove_stop", "date": view.Days[0].Date, "stop_id": view.Days[0].Stops[1].StopID}, 503)
	if got := h.read(t); !reflect.DeepEqual(got, view) {
		t.Fatal("failed command changed saved trip")
	}
	h.router.err = nil
	// Unknown position must not silently reset the walked-distance counter.
	point := view.Days[0].Execution.CurrentPoint
	point.Coordinates[0] += 0.001
	custom := map[string]any{"expected_version": view.Version, "command": map[string]any{"kind": "replan_day", "date": view.Days[0].Date}, "current_position": point, "observed_at": h.now.Format(time.RFC3339)}
	if w := request(h.handler, h.browser, "POST", h.path+"/previews", body(t, custom), ""); w.Code != 422 {
		t.Fatal("unaccounted movement accepted")
	}
	outsider := bootstrap(t, h.handler)
	if w := request(h.handler, outsider, "POST", h.path+"/progress", body(t, payload), "other-owner"); w.Code != 404 {
		t.Fatal("cross-session progress allowed")
	}
}

func TestSkippedStopNeedsReplanAndMandatoryStopCannotBeRemoved(t *testing.T) {
	h := newActiveHarness(t)
	view := h.start(t)
	h.now = h.now.Add(time.Minute)
	skipped := h.progress(t, view, view.Days[0].Stops[0], "skipped", "skip", 200)
	if !skipped.Days[0].Execution.NeedsReplan || skipped.Days[0].Execution.ConsumedWalkDistanceM != 0 || skipped.Days[0].Execution.CurrentPoint.Coordinates != view.Days[0].StartPoint.Coordinates {
		t.Fatal("skip invented completed movement")
	}
	h.progress(t, skipped, skipped.Days[0].Stops[1], "visited", "before-replan", 422)
	preview := h.preview(t, skipped, map[string]any{"kind": "replan_day", "date": skipped.Days[0].Date}, 201)
	changed := h.apply(t, preview, 200, "apply-skip-replan")
	if changed.Days[0].Execution.NeedsReplan || changed.Days[0].Stops[0].Progress != "skipped" {
		t.Fatal("skip history lost")
	}
	h.now = h.now.Add(2 * time.Minute)
	visited := h.progress(t, changed, changed.Days[0].Stops[1], "visited", "after-replan", 200)
	if visited.Days[0].Execution.ConsumedWalkDistanceM != 100 {
		t.Fatal("wrong recalculated first leg")
	}
	// Mark the last remaining stop mandatory in the fixture to exercise the guards.
	err := h.store.Update(func(s *tripstore.State) error {
		trip := s.Trips[string(visited.TripID)]
		trip.View.Days[0].Stops[2].Mandatory = true
		s.Trips[string(visited.TripID)] = trip
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	mandatory := h.read(t)
	h.preview(t, mandatory, map[string]any{"kind": "remove_stop", "date": mandatory.Days[0].Date, "stop_id": mandatory.Days[0].Stops[2].StopID}, 422)
	h.progress(t, mandatory, mandatory.Days[0].Stops[2], "skipped", "mandatory-skip", 422)
}

func TestActivePreviewExpiresAndProgressRequiresIdempotency(t *testing.T) {
	h := newActiveHarness(t)
	view := h.start(t)
	payload := c.ProgressRequest{ExpectedVersion: view.Version, Date: view.Days[0].Date, StopID: view.Days[0].Stops[0].StopID, Status: "visited", ObservedAt: c.Instant(h.now.Format(time.RFC3339))}
	if w := request(h.handler, h.browser, "POST", h.path+"/progress", body(t, payload), ""); w.Code != 422 {
		t.Fatal("progress without idempotency key accepted")
	}
	preview := h.preview(t, view, map[string]any{"kind": "remove_stop", "date": view.Days[0].Date, "stop_id": view.Days[0].Stops[1].StopID}, 201)
	h.now = h.now.Add(31 * time.Second)
	h.apply(t, preview, 410, "expired-active")
	if h.read(t).Version != view.Version {
		t.Fatal("expired active preview was saved")
	}
}

func TestStartDayConfirmsActualStartAndPreservesDeadline(t *testing.T) {
	h := newActiveHarness(t)
	view := h.read(t)
	point := view.Days[0].StartPoint
	point.Coordinates[0] += 0.001
	future := h.now.Add(2 * time.Minute)
	h.preview(t, view, map[string]any{"kind": "start_day", "date": view.Days[0].Date, "point": point, "start_at": future.Format(time.RFC3339)}, 422)
	h.now = h.now.Add(time.Hour)
	preview := h.preview(t, view, map[string]any{"kind": "start_day", "date": view.Days[0].Date, "point": point, "start_at": h.now.Format(time.RFC3339)}, 201)
	changed := h.apply(t, preview, 200, "late-start")
	if changed.Days[0].StartPoint.Coordinates != point.Coordinates || changed.Input.Days[0].StartPoint.Coordinates != point.Coordinates || changed.Input.Days[0].AvailableWindow.EndAt != view.Input.Days[0].AvailableWindow.EndAt || changed.Days[0].Execution.StartedAt != c.Instant(h.now.Format(time.RFC3339)) {
		t.Fatal("start confirmation ignored point/time or changed deadline")
	}
	h.preview(t, changed, map[string]any{"kind": "start_day", "date": view.Days[0].Date, "point": point, "start_at": h.now.Format(time.RFC3339)}, 422)
}

type samePointRouter struct{}

func (samePointRouter) Route(ctx context.Context, r routing.Request) (routing.Result, error) {
	result, err := dayRouter{}.Route(ctx, r)
	if r.From.Coordinates == r.To.Coordinates {
		result.DistanceM = 0
		result.TravelDurationSec = 0
	}
	return result, err
}
func TestActiveApplyAtFirstStopDoesNotTreatRoundedArrivalAsStale(t *testing.T) {
	h := newActiveHarness(t)
	view := h.read(t)
	h.router.delegate = samePointRouter{}
	point := view.Days[0].Stops[0].Location
	preview := h.preview(t, view, map[string]any{"kind": "start_day", "date": view.Days[0].Date, "point": point, "start_at": h.now.Format(time.RFC3339)}, 201)
	h.now = h.now.Add(500 * time.Millisecond)
	if got := h.apply(t, preview, 200, "same-location-start"); got.Status != "active" {
		t.Fatal("could not start at first venue")
	}
}
