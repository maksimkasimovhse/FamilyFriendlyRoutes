package planner

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
)

type initialInterpreter struct {
	intent assistant.Intent
	calls  *int
}

func (p initialInterpreter) Interpret(context.Context, string, string, any) (assistant.Intent, error) {
	if p.calls != nil {
		*p.calls++
	}
	return p.intent, nil
}
func TestInitialUnderstandingAppliesExplicitTimeWithoutChangingProfile(t *testing.T) {
	input := sample(t)
	text := "Хотим животных, на прогулку один час"
	input.RequestText = &text
	now := time.Now()
	view := NewDraft("trip", input, now)
	before, _ := json.Marshal(view)
	duration := 3600.0
	evidence := "один час"
	intent := assistant.Intent{Action: "preferences", DurationSec: &duration, DurationEvidence: &evidence, Preferences: json.RawMessage(`{"taxonomy_version":"1.0","claims":[{"kind":"interest","value":"animals","polarity":"prefer","evidence":"Хотим животных"}],"needs_clarification":false,"clarification_question":null,"unsupported_requests":[]}`)}
	p := Planner{Interpreter: initialInterpreter{intent: intent}, Source: HTTPSource{}}
	understood, source, warnings, err := p.understandInitial(context.Background(), view, now)
	if err != nil {
		t.Fatal(err)
	}
	if understood.Input.Days[0].DurationBudgetSec != 3600 || source.Source.(HTTPSource).ParsedRequest == nil || len(warnings) == 0 {
		t.Fatal("understanding was not passed to planning and ranking")
	}
	after, _ := json.Marshal(view)
	if string(before) != string(after) {
		t.Fatal("initial understanding mutated saved trip")
	}
	if understood.Input.Family.Children[0].AgeYears != view.Input.Family.Children[0].AgeYears {
		t.Fatal("changed child profile")
	}
	intent.DurationEvidence = func() *string { s := "полчаса"; return &s }()
	p.Interpreter = initialInterpreter{intent: intent}
	if _, _, _, err := p.understandInitial(context.Background(), view, now); err == nil {
		t.Fatal("invented time evidence accepted")
	}
}
