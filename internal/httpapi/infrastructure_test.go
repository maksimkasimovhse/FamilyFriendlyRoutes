package httpapi

import (
	"context"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
)

func TestInfrastructurePreviewApplyOwnershipAndStaleVersion(t *testing.T) {
	h := newActiveHarness(t)
	view := h.read(t)
	placeID := c.ID("pharmacy-123")
	p := planner.Planner{Router: h.router, Activities: planner.DemoActivities(), Infrastructure: func(_ context.Context, id c.ID) (c.Place, error) {
		if id != placeID {
			t.Fatal("unexpected lookup")
		}
		return c.Place{PlaceID: id, Name: "Аптека", Categories: []c.Category{"pharmacy"}, Location: view.Days[0].StartPoint}, nil
	}}
	h.handler = tripHandler(h.store, p, func() time.Time { return h.now })
	command := map[string]any{"kind": "insert_infrastructure_stop", "date": view.Days[0].Date, "place_id": placeID}
	preview := h.preview(t, view, command, 201)
	if h.read(t).Version != view.Version {
		t.Fatal("preview silently changed the saved trip")
	}
	outsider := bootstrap(t, h.handler)
	if w := request(h.handler, outsider, "POST", h.path+"/previews", body(t, map[string]any{"expected_version": view.Version, "command": command, "current_position": nil, "observed_at": nil}), ""); w.Code != 404 {
		t.Fatal("another owner can alter the route")
	}
	if !preview.CanApply {
		t.Fatal("fixture urgent stop should fit")
	}
	saved := h.apply(t, preview, 200, "urgent-apply")
	if saved.Days[0].Stops[0].PlaceID != placeID {
		t.Fatal("chosen infrastructure did not persist")
	}
	h.preview(t, view, command, 409)
}
