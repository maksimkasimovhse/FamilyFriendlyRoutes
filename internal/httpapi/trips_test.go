package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

type dayRouter struct{}

func (dayRouter) Route(ctx context.Context, r routing.Request) (routing.Result, error) {
	return routing.Result{Mode: "walk", Status: "calculated", DistanceM: 100, TravelDurationSec: 60, Geometry: routing.LineString{Type: "LineString", Coordinates: []routing.Position{r.From.Coordinates, r.To.Coordinates}}, RoutingDataVersion: "test"}, nil
}

type browser struct {
	cookie *http.Cookie
	csrf   string
}

func request(handler http.Handler, b browser, method, path, body, key string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if b.cookie != nil {
		r.AddCookie(b.cookie)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-CSRF-Token", b.csrf)
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func bootstrap(t *testing.T, handler http.Handler) browser {
	t.Helper()
	w := request(handler, browser{}, "GET", "/api/v1/session", "", "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var s c.SessionResponse
	_ = json.Unmarshal(w.Body.Bytes(), &s)
	return browser{w.Result().Cookies()[0], s.CSRFToken}
}
func TestTripCreatePreviewApplyReplayAndRestart(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "state.json")
	store, _ := tripstore.Open(filename)
	p := planner.Planner{Router: dayRouter{}, Activities: planner.DemoActivities()}
	handler := TripHandler(store, p)
	b := bootstrap(t, handler)
	raw, err := os.ReadFile("../../examples/trip-one-day.json")
	if err != nil {
		t.Fatal(err)
	}
	created := request(handler, b, "POST", "/api/v1/trips", string(raw), "create-1")
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var trip c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &trip)
	path := "/api/v1/trips/" + string(trip.TripID)
	repeat := request(handler, b, "POST", "/api/v1/trips", string(raw), "create-1")
	if repeat.Code != 201 || repeat.Body.String() != created.Body.String() {
		t.Fatal("create replay changed resource")
	}
	conflictResponse := request(handler, b, "POST", "/api/v1/trips", string(raw)+" ", "create-1")
	if conflictResponse.Code != 409 {
		t.Fatal("idempotency key reused with another body")
	}
	previewResponse := request(handler, b, "POST", path+"/previews", `{"expected_version":1,"command":{"kind":"generate_plan"},"current_position":null,"observed_at":null}`, "")
	if previewResponse.Code != 201 {
		t.Fatal(previewResponse.Body.String())
	}
	var preview c.PlanPreview
	_ = json.Unmarshal(previewResponse.Body.Bytes(), &preview)
	current := request(handler, b, "GET", path, "", "")
	var draft c.TripView
	_ = json.Unmarshal(current.Body.Bytes(), &draft)
	if draft.Version != 1 || len(draft.Days) != 0 {
		t.Fatal("preview wrote trip")
	}
	applyPath := path + "/previews/" + string(preview.PreviewID) + "/apply"
	noAck := request(handler, b, "POST", applyPath, `{"expected_version":1,"acknowledged_warning_codes":[]}`, "apply-no-ack")
	if noAck.Code != 422 {
		t.Fatal("applied conditional plan without acknowledgement")
	}
	applyBody, _ := json.Marshal(c.ApplyRequest{ExpectedVersion: 1, AcknowledgedWarningCodes: preview.RequiredAcknowledgementCodes})
	applied := request(handler, b, "POST", applyPath, string(applyBody), "apply-1")
	if applied.Code != 200 {
		t.Fatal(applied.Body.String())
	}
	replay := request(handler, b, "POST", applyPath, string(applyBody), "apply-1")
	if replay.Code != 200 || replay.Body.String() != applied.Body.String() {
		t.Fatal("apply retry was not replayed")
	}
	stale := request(handler, b, "POST", applyPath, string(applyBody), "apply-2")
	if stale.Code != 409 {
		t.Fatal("stale version accepted")
	}
	outsider := bootstrap(t, handler)
	if w := request(handler, outsider, "GET", path, "", ""); w.Code != 404 {
		t.Fatal("cross-session read allowed")
	}
	badCSRF := b
	badCSRF.csrf = "wrong"
	if w := request(handler, badCSRF, "POST", path+"/previews", `{}`, ""); w.Code != 403 {
		t.Fatal("CSRF bypass")
	}
	reopened, err := tripstore.Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	restored := request(TripHandler(reopened, p), b, "GET", path, "", "")
	var final c.TripView
	_ = json.Unmarshal(restored.Body.Bytes(), &final)
	if restored.Code != 200 || final.Version != 2 || len(final.Days) != 1 || len(final.Days[0].Legs) != 4 {
		t.Fatal("restart lost plan")
	}
}
func TestExpiredAndInfeasiblePreviewCannotApply(t *testing.T) {
	store, _ := tripstore.Open(filepath.Join(t.TempDir(), "state.json"))
	handler := TripHandler(store, planner.Planner{Router: dayRouter{}, Activities: planner.DemoActivities()})
	b := bootstrap(t, handler)
	raw, _ := os.ReadFile("../../examples/trip-one-day.json")
	var input c.TripInput
	_ = json.Unmarshal(raw, &input)
	input.Days[0].DurationBudgetSec = 10
	raw, _ = json.Marshal(input)
	created := request(handler, b, "POST", "/api/v1/trips", string(raw), "c")
	var trip c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &trip)
	path := "/api/v1/trips/" + string(trip.TripID)
	w := request(handler, b, "POST", path+"/previews", `{"expected_version":1,"command":{"kind":"generate_plan"},"current_position":null,"observed_at":null}`, "")
	var preview c.PlanPreview
	_ = json.Unmarshal(w.Body.Bytes(), &preview)
	if w.Code != 201 || preview.CanApply {
		t.Fatal("infeasibility hidden")
	}
	applyBody, _ := json.Marshal(c.ApplyRequest{ExpectedVersion: 1, AcknowledgedWarningCodes: preview.RequiredAcknowledgementCodes})
	applyPath := path + "/previews/" + string(preview.PreviewID) + "/apply"
	if applied := request(handler, b, "POST", applyPath, string(applyBody), "a"); applied.Code != 422 {
		t.Fatal("applied impossible plan")
	}
	_ = store.Update(func(s *tripstore.State) error {
		p := s.Previews[string(preview.PreviewID)]
		p.View.ExpiresAt = c.Instant(time.Now().Add(-time.Minute).Format(time.RFC3339))
		s.Previews[string(preview.PreviewID)] = p
		return nil
	})
	if expired := request(handler, b, "POST", applyPath, string(applyBody), "b"); expired.Code != 410 {
		t.Fatal("expired preview accepted")
	}
}

func TestMultiDayPreviewCannotApplyWhenSecondDayIsInfeasible(t *testing.T) {
	store, _ := tripstore.Open(filepath.Join(t.TempDir(), "state.json"))
	handler := TripHandler(store, planner.Planner{Router: dayRouter{}, Activities: planner.DemoActivities()})
	browser := bootstrap(t, handler)
	raw, err := os.ReadFile("../../examples/trip-two-days.json")
	if err != nil {
		t.Fatal(err)
	}
	var input c.TripInput
	_ = json.Unmarshal(raw, &input)
	input.Days[1].DurationBudgetSec = 10
	date := input.Days[1].Date
	input.Selections = []c.Selection{{ActivityID: "demo-1", PlaceID: "demo-place-1", Mandatory: true, PreferredDate: &date}}
	raw, _ = json.Marshal(input)
	created := request(handler, browser, "POST", "/api/v1/trips", string(raw), "create-multi")
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var trip c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &trip)
	path := "/api/v1/trips/" + string(trip.TripID)
	response := request(handler, browser, "POST", path+"/previews", `{"expected_version":1,"command":{"kind":"generate_plan"},"current_position":null,"observed_at":null}`, "")
	var preview c.PlanPreview
	_ = json.Unmarshal(response.Body.Bytes(), &preview)
	if response.Code != 201 || len(preview.ProposedTrip.Days) != 2 || preview.ProposedTrip.Days[0].Feasibility == "infeasible" || preview.ProposedTrip.Days[1].Feasibility != "infeasible" || preview.CanApply || len(preview.Diff.ChangedDates) != 2 {
		t.Fatal(response.Body.String())
	}
	body, _ := json.Marshal(c.ApplyRequest{ExpectedVersion: 1, AcknowledgedWarningCodes: preview.RequiredAcknowledgementCodes})
	applied := request(handler, browser, "POST", path+"/previews/"+string(preview.PreviewID)+"/apply", string(body), "apply-multi")
	if applied.Code != 422 {
		t.Fatal(applied.Body.String())
	}
}
