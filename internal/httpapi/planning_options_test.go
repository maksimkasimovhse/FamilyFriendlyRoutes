package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
)

type optionSource struct{ calls int }

func (*optionSource) CatalogVersion() string { return "completion-test" }
func (s *optionSource) Recommend(_ context.Context, v c.TripView) (c.RecommendationResponse, error) {
	s.calls++
	unknown := map[string]any{"state": "unknown", "value": nil, "evidence_ids": []string{}}
	r := c.RecommendationResponse{ContractVersion: "1.0", TripID: v.TripID, TripVersion: v.Version, CatalogVersion: v.CatalogVersion, ModelVersion: "options-test", GeneratedAt: c.Instant(time.Now().Format(time.RFC3339)), Status: "complete", Candidates: []c.Candidate{}, Evidence: []c.Evidence{}, Warnings: []c.Warning{}}
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("option-%d", i)
		duration := 300
		if i == 0 {
			duration = 3000
		}
		eligibility, interests, credits := []any{}, []any{}, []any{}
		for _, child := range v.Input.Family.Children {
			eligibility = append(eligibility, map[string]any{"child_id": child.ChildID, "status": "eligible", "reasons": []any{}})
			interests = append(interests, map[string]any{"child_id": child.ChildID, "value": .8})
			credits = append(credits, map[string]any{"child_id": child.ChildID, "value": 1 / float64(len(v.Input.Family.Children))})
		}
		availability := []any{}
		for _, day := range v.Input.Days {
			availability = append(availability, map[string]any{"date": day.Date, "state": "unknown", "visit_windows": []any{}, "last_entry_at": nil, "occurrences": []any{}})
		}
		point := map[string]any{"coordinates": []float64{44.02 + float64(i)*.05, 56.32}, "label": nil}
		payload := map[string]any{
			"place":        map[string]any{"place_id": id, "name": id, "location": point, "entrance": nil, "categories": []string{"landmark"}, "display_class": "neutral", "indoor": unknown, "toilet": unknown, "shelter": unknown, "seating": unknown, "restaurant": nil},
			"activity":     map[string]any{"activity_id": id, "place_id": id, "title": id, "kind": "visit", "age_min_years": unknown, "age_max_years": unknown, "height_min_cm": unknown, "admission_rule": unknown, "duration": map[string]any{"duration_sec": duration, "source": "estimated", "evidence_ids": []string{}}},
			"availability": availability, "eligibility": eligibility, "scores": map[string]any{"final_relevance": 1 - float64(i)/10, "adult_interest": .5, "popularity": .5, "child_interest": interests}, "balance_credit": credits, "is_top_place": false, "reasons": []any{}, "warnings": []any{},
		}
		raw, _ := json.Marshal(payload)
		var candidate c.Candidate
		if err := json.Unmarshal(raw, &candidate); err != nil {
			return r, err
		}
		r.Candidates = append(r.Candidates, candidate)
	}
	return r, nil
}

func TestPlanningOptionsPreviewSupplementApplyAndAccess(t *testing.T) {
	h := newActiveHarness(t)
	input := h.read(t).Input
	input.Days = input.Days[:1]
	input.Days[0].DurationBudgetSec = 1800
	input.Selections = []c.Selection{}
	policy := "manual_choices"
	input.PlanningPolicy = &policy
	source := &optionSource{}
	h.handler = tripHandler(h.store, planner.Planner{Router: dayRouter{}, Source: source}, func() time.Time { return h.now })
	created := request(h.handler, h.browser, "POST", "/api/v1/trips", body(t, input), "options-trip")
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var trip c.TripView
	_ = json.Unmarshal(created.Body.Bytes(), &trip)
	h.path = "/api/v1/trips/" + string(trip.TripID)
	options := request(h.handler, h.browser, "POST", h.path+"/planning-options", `{"expected_version":1}`, "")
	if options.Code != 200 {
		t.Fatal(options.Body.String())
	}
	var cards c.PlanningOptions
	_ = json.Unmarshal(options.Body.Bytes(), &cards)
	if len(cards.Candidates) != 3 || cards.Policy.ManualLimitPerDay != 0 || cards.Days[0].Anchor != nil || !cards.Days[0].IsShort {
		t.Fatal("wrong initial cards/policy")
	}
	outsider := bootstrap(t, h.handler)
	if w := request(h.handler, outsider, "POST", h.path+"/planning-options", `{"expected_version":1}`, ""); w.Code != 404 {
		t.Fatal("cards leaked to another session")
	}
	bad := h.browser
	bad.csrf = "wrong"
	if w := request(h.handler, bad, "POST", h.path+"/planning-options", `{"expected_version":1}`, ""); w.Code != 403 {
		t.Fatal("cards accepted invalid CSRF")
	}
	initial := h.preview(t, trip, map[string]any{"kind": "generate_plan"}, 201)
	if len(initial.ProposedTrip.Days[0].Stops) != 0 || initial.CanApply {
		t.Fatal("manual mode with no selected cards must remain empty until the user adds cards")
	}
	options = request(h.handler, h.browser, "POST", h.path+"/planning-options", body(t, c.PlanningOptionsRequest{ExpectedVersion: 1, PreviewID: &initial.PreviewID}), "")
	if options.Code != 200 {
		t.Fatal(options.Body.String())
	}
	_ = json.Unmarshal(options.Body.Bytes(), &cards)
	if len(cards.Days[0].Candidates) != 2 || cards.Days[0].Anchor != nil || source.calls != 1 {
		t.Fatal("empty-day options narrowed to start or fetched a different pool")
	}
	date := input.Days[0].Date
	choices := []c.Selection{{ActivityID: "option-2", PlaceID: "option-2", PreferredDate: &date}}
	added := h.preview(t, trip, map[string]any{"kind": "append_manual_choices", "date": date, "choices": choices, "base_preview_id": initial.PreviewID}, 201)
	if !added.CanApply || added.BaseVersion != 1 || added.ProposedTrip.Version != 2 || added.ProposedTrip.Days[0].Stops[0].ActivityID != "option-2" {
		t.Fatal("supplement not attached to selected preview")
	}
	unchanged := h.read(t)
	if unchanged.Version != 1 || len(unchanged.Days) != 0 {
		t.Fatal("preview saved changes prematurely")
	}
	saved := h.apply(t, added, 200, "apply-options")
	if saved.Version != 2 || len(saved.Input.Selections) != 1 || *saved.Input.Selections[0].PreferredDate != date {
		t.Fatal("manual choice not persisted")
	}
	if w := request(h.handler, h.browser, "POST", h.path+"/planning-options", `{"expected_version":1}`, ""); w.Code != 409 {
		t.Fatal("old version cards accepted")
	}
	input.Selections = append(choices, choices[0], choices[0])
	if w := request(h.handler, h.browser, "POST", "/api/v1/trips", body(t, input), "too-many-manual"); w.Code != 422 {
		t.Fatal("HTTP accepted duplicate manual choices")
	}
}

// Card count must not reject the trip before the planner checks actual duration.
func TestCreateTripAcceptsManualChoicesWithoutDailyCountLimit(t *testing.T) {
	for _, pinned := range []bool{false, true} {
		t.Run(fmt.Sprintf("preferred_date=%t", pinned), func(t *testing.T) {
			h := newActiveHarness(t)
			input := h.read(t).Input
			policy := "manual_choices"
			input.PlanningPolicy = &policy
			input.Selections = []c.Selection{}
			for i := 0; i < 12; i++ {
				choice := c.Selection{ActivityID: c.ID(fmt.Sprintf("chosen-%d", i)), PlaceID: c.ID(fmt.Sprintf("place-%d", i))}
				if pinned {
					choice.PreferredDate = &input.Days[0].Date
				}
				input.Selections = append(input.Selections, choice)
			}
			result := request(h.handler, h.browser, "POST", "/api/v1/trips", body(t, input), "unlimited-cards")
			if result.Code != 201 {
				t.Fatalf("12 cards rejected before route calculation: %s", result.Body.String())
			}
			var trip c.TripView
			if err := json.Unmarshal(result.Body.Bytes(), &trip); err != nil {
				t.Fatal(err)
			}
			if len(trip.Input.Selections) != 12 {
				t.Fatal("selected cards were silently truncated")
			}
		})
	}
}
