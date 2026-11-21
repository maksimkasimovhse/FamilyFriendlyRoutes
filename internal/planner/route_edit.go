package planner

import (
	"strings"
	"unicode"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

// Supported text commands are deterministic; no model-generated venue or route
// is accepted without the same server-side Change validation and preview/apply.
func resolveRouteEdit(view c.TripView, cmd ChangeCommand) (ChangeCommand, error) {
	i, err := dayIndex(view, *cmd.Date)
	if err != nil {
		return ChangeCommand{}, err
	}
	text := strings.ToLower(strings.TrimSpace(*cmd.Text))
	base := ChangeCommand{Date: cmd.Date}
	contains := func(words ...string) bool {
		for _, word := range words {
			if strings.Contains(text, word) {
				return true
			}
		}
		return false
	}
	if contains("пересч", "опазд", "не успева", "обнови маршрут") {
		base.Kind = "replan_day"
		return base, nil
	}
	planned := []c.Stop{}
	for _, stop := range view.Days[i].Stops {
		if stop.Progress == "planned" {
			planned = append(planned, stop)
		}
	}
	if len(planned) == 0 {
		return base, stateError("NO_PLANNED_STOPS", "Все остановки уже завершены.")
	}
	var target *c.Stop
	if contains("сократ", "покороче", "короче", "последн") {
		target = &planned[len(planned)-1]
	} else if contains("убер", "убрат", "удал", "пропус", "не пойд") {
		if contains("следующ") {
			target = &planned[0]
		} else {
			words := strings.FieldsFunc(text, func(r rune) bool { return !unicode.IsLetter(r) })
			for index := range planned {
				title := strings.ToLower(planned[index].Title)
				match := strings.Contains(text, title)
				for _, word := range words {
					if len([]rune(word)) >= 4 && !strings.HasPrefix(word, "убер") && !strings.HasPrefix(word, "убрат") && !strings.HasPrefix(word, "удал") && !strings.HasPrefix(word, "пропус") && strings.Contains(title, word) {
						match = true
					}
				}
				if match {
					if target != nil {
						return base, stateError("AMBIGUOUS_STOP", "Подходят несколько остановок. Укажите полное название.")
					}
					target = &planned[index]
				}
			}
		}
	}
	if target == nil {
		return base, stateError("UNSUPPORTED_ROUTE_REQUEST", "Пока доступны команды: «убери <название>», «пропусти следующую», «сократи маршрут» и «пересчитай маршрут».")
	}
	base.Kind = "remove_stop"
	id := target.StopID
	base.StopID = &id
	return base, nil
}
