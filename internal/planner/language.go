package planner

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"math"
	"strings"
	"time"
)

func (p Planner) understandInitial(ctx context.Context, view c.TripView, now time.Time) (c.TripView, Planner, []c.Warning, error) {
	original := view
	copied, err := cloneView(view)
	if err != nil {
		return view, p, nil, err
	}
	view = copied
	days := []map[string]any{}
	for _, day := range view.Input.Days {
		days = append(days, map[string]any{"date": day.Date, "stops": []any{}, "duration_budget_sec": day.DurationBudgetSec, "available_window": day.AvailableWindow})
	}
	intent, err := p.Interpreter.Interpret(ctx, fmt.Sprintf("initial-%s-%d", view.TripID, view.Version), *view.Input.RequestText, map[string]any{"initial": true, "family": view.Input.Family, "days": days, "choices": []any{}, "history": []any{}})
	if err != nil {
		return original, p, nil, err
	}
	var parsed c.ParsedRequest
	if json.Unmarshal(intent.Preferences, &parsed) != nil {
		return original, p, nil, assistant.ErrContract
	}
	if intent.Action == "clarify" || parsed.NeedsClarification {
		question := "Уточните пожелание к поездке."
		if intent.Question != nil {
			question = *intent.Question
		} else if parsed.ClarificationQuestion != nil {
			question = *parsed.ClarificationQuestion
		}
		return original, p, nil, stateError("REQUEST_CLARIFICATION_REQUIRED", question)
	}
	source := strings.Join(strings.Fields(strings.ToLower(*view.Input.RequestText)), " ")
	if intent.Action != "preferences" {
		return original, p, nil, assistant.ErrContract
	}
	for _, raw := range parsed.Claims {
		var claim struct {
			Evidence string `json:"evidence"`
		}
		if json.Unmarshal(raw, &claim) != nil || claim.Evidence == "" || !strings.Contains(source, strings.Join(strings.Fields(strings.ToLower(claim.Evidence)), " ")) {
			return original, p, nil, assistant.ErrContract
		}
	}
	warnings := []c.Warning{}
	if intent.DurationSec != nil {
		if math.IsNaN(*intent.DurationSec) || math.IsInf(*intent.DurationSec, 0) || *intent.DurationSec < 60 || *intent.DurationSec > 86400 || intent.DurationEvidence == nil || !strings.Contains(source, strings.ToLower(*intent.DurationEvidence)) {
			return original, p, nil, assistant.ErrContract
		}
		if len(view.Input.Days) > 1 && intent.Date == nil {
			return original, p, nil, stateError("REQUEST_CLARIFICATION_REQUIRED", "Для какого дня ограничить время прогулки?")
		}
		matched := false
		for index, day := range view.Input.Days {
			if intent.Date != nil && day.Date != *intent.Date {
				continue
			}
			matched = true
			view.Input.Days[index].DurationBudgetSec = math.Min(day.DurationBudgetSec, *intent.DurationSec)
		}
		if !matched {
			return original, p, nil, assistant.ErrContract
		}
		warnings = append(warnings, Warning("REQUEST_TIME_LIMIT", fmt.Sprintf("Явно указанное в пожелании время ограничивает план: %.0f минут.", *intent.DurationSec/60)))
	}
	for _, need := range intent.Needs {
		if need.Evidence == "" || !strings.Contains(source, strings.Join(strings.Fields(strings.ToLower(need.Evidence)), " ")) {
			return original, p, nil, assistant.ErrContract
		}
		warnings = append(warnings, Warning("REQUEST_NEED", fmt.Sprintf("Потребность из пожелания: «%s». Конкретное место перерыва можно выбрать через помощника.", need.Evidence)))
	}
	if intent.MaxWalkDistanceM != nil {
		limit := *intent.MaxWalkDistanceM
		if !finite(limit) || limit < 0 || limit > 100000 || intent.WalkEvidence == nil || !strings.Contains(source, strings.Join(strings.Fields(strings.ToLower(*intent.WalkEvidence)), " ")) {
			return original, p, nil, assistant.ErrContract
		}
		matched := false
		for index, day := range view.Input.Days {
			if intent.Date != nil && day.Date != *intent.Date {
				continue
			}
			matched = true
			value := math.Min(dailyWalkLimit(view.Input, day), limit)
			view.Input.Days[index].MaxWalkDistanceM = &value
		}
		if !matched {
			return original, p, nil, assistant.ErrContract
		}
		warnings = append(warnings, Warning("REQUEST_WALK_LIMIT", fmt.Sprintf("Явный лимит ходьбы из пожелания: %.0f метров на выбранный день.", limit)))
	}
	// A parsed request travels with this calculation only, rather than shared mutable state.
	if source, ok := p.Source.(HTTPSource); ok {
		source.ParsedRequest = &parsed
		p.Source = source
	}
	return view, p, warnings, nil
}
