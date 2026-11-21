package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/mapdata"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
)

type intentFunc func(context.Context, string, string, any) (assistant.Intent, error)

func (f intentFunc) Interpret(ctx context.Context, id, message string, value any) (assistant.Intent, error) {
	return f(ctx, id, message, value)
}

type assistantPlaces struct{}

func (assistantPlaces) Search(context.Context, mapdata.Query) (c.MapResponse, error) {
	unknown := json.RawMessage(`{"state":"unknown","value":null,"evidence_ids":[]}`)
	return c.MapResponse{CatalogVersion: "map-v1", Evidence: []c.Evidence{}, Items: []c.Place{{PlaceID: "cafe-1", Name: "Кафе", Location: c.Point{Coordinates: c.Position{44.01, 56.325}}, Categories: []c.Category{"restaurant"}, DisplayClass: "neutral", Indoor: unknown, Toilet: unknown, Shelter: unknown, Seating: unknown}}}, nil
}
func assistantSend(t *testing.T, h *activeHarness, view c.TripView, message, key string, status int) assistantReply {
	t.Helper()
	w := request(h.handler, h.browser, "POST", h.path+"/assistant/messages", body(t, map[string]any{"expected_version": view.Version, "date": view.Days[0].Date, "message": message, "current_position": nil, "observed_at": nil}), key)
	if w.Code != status {
		t.Fatalf("assistant got %d: %s", w.Code, w.Body.String())
	}
	var reply assistantReply
	if status == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil {
			t.Fatal(err)
		}
	}
	return reply
}
func TestAssistantFoodChoicePreviewApplyAndIsolation(t *testing.T) {
	h := newActiveHarness(t)
	view := h.start(t)
	calls := 0
	interpreter := intentFunc(func(ctx context.Context, id, message string, value any) (assistant.Intent, error) {
		calls++
		contextValue := value.(map[string]any)
		if message == "Хотим поесть" {
			return assistant.Intent{Action: "find_places", Needs: []assistant.Need{{Kind: "food", Urgency: "now", Evidence: message}}}, nil
		}
		if len(contextValue["history"].([]assistant.Turn)) != 1 || len(contextValue["choices"].([]map[string]any)) != 1 {
			t.Fatal("lost conversation context")
		}
		placeID := c.ID("cafe-1")
		return assistant.Intent{Action: "add_activity", PlaceID: &placeID}, nil
	})
	h.handler = tripHandlerWithAssistant(h.store, planner.Planner{Router: h.router, Activities: planner.DemoActivities()}, func() time.Time { return h.now }, interpreter, assistantPlaces{})
	found := assistantSend(t, h, view, "Хотим поесть", "food", 200)
	if len(found.Places) != 1 || found.Preview != nil || len(found.Options) != 1 {
		t.Fatalf("bad places response %+v", found)
	}
	assistantSend(t, h, view, "Хотим поесть", "food", 200)
	if calls != 1 {
		t.Fatal("idempotent replay called LLM")
	}
	reply := assistantSend(t, h, view, "Давай первый", "choose", 200)
	if reply.Preview == nil || !reply.Preview.CanApply {
		t.Fatalf("bad preview: %+v", reply)
	}
	if h.read(t).Version != view.Version {
		t.Fatal("assistant changed trip without apply")
	}
	saved := h.apply(t, *reply.Preview, 200, "apply-cafe")
	if len(saved.Days[0].Stops) != len(view.Days[0].Stops)+1 {
		t.Fatal("cafe was not inserted")
	}
	if saved.Days[0].Totals.MealDurationSec != 1800 {
		t.Fatal("meal time not counted")
	}
	other := bootstrap(t, h.handler)
	w := request(h.handler, other, "POST", h.path+"/assistant/messages", body(t, map[string]any{"expected_version": saved.Version, "message": "Привет"}), "")
	if w.Code != 404 {
		t.Fatal("other owner accessed assistant")
	}
}

func TestAssistantFailureStaleVersionAndInvalidIntentPreserveTrip(t *testing.T) {
	h := newActiveHarness(t)
	view := h.read(t)
	h.handler = tripHandlerWithAssistant(h.store, planner.Planner{Router: h.router}, func() time.Time { return h.now }, intentFunc(func(context.Context, string, string, any) (assistant.Intent, error) {
		return assistant.Intent{}, assistant.ErrUnavailable
	}), nil)
	assistantSend(t, h, view, "Сократи", "", 503)
	h.handler = tripHandlerWithAssistant(h.store, planner.Planner{Router: h.router}, func() time.Time { return h.now }, intentFunc(func(context.Context, string, string, any) (assistant.Intent, error) {
		id := c.ID("invented")
		return assistant.Intent{Action: "remove_stop", StopID: &id}, nil
	}), nil)
	assistantSend(t, h, view, "Убери", "", 502)
	stale := view
	stale.Version--
	assistantSend(t, h, stale, "Убери", "", 409)
	if h.read(t).Version != view.Version {
		t.Fatal("failed assistant changed trip")
	}
}

func TestAssistantShortenRequiresAcknowledgementsAndProtectsHistory(t *testing.T) {
	h := newActiveHarness(t)
	view := h.start(t)
	h.handler = tripHandlerWithAssistant(h.store, planner.Planner{Router: h.router}, func() time.Time { return h.now }, intentFunc(func(context.Context, string, string, any) (assistant.Intent, error) {
		return assistant.Intent{Action: "shorten_day", Needs: []assistant.Need{{Kind: "rest", Urgency: "now", Evidence: "Ребёнок устал"}}}, nil
	}), nil)
	reply := assistantSend(t, h, view, "Ребёнок устал", "tired", 200)
	if reply.Preview == nil || len(reply.Preview.Diff.RemovedStopIDS) == 0 || !strings.Contains(reply.Reply, "вдвое") {
		t.Fatalf("not shortened: %+v", reply)
	}
	w := request(h.handler, h.browser, "POST", h.path+"/previews/"+string(reply.Preview.PreviewID)+"/apply", body(t, c.ApplyRequest{ExpectedVersion: view.Version, AcknowledgedWarningCodes: []string{}}), "no-ack")
	if w.Code != 422 {
		t.Fatal("missing acknowledgements accepted")
	}
	bad := httptest.NewRequest("POST", h.path+"/assistant/messages", strings.NewReader(`{}`))
	bad.AddCookie(h.browser.cookie)
	out := httptest.NewRecorder()
	h.handler.ServeHTTP(out, bad)
	if out.Code != 403 {
		t.Fatal("missing CSRF accepted")
	}
}
