package planner

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

const ClockSkew = time.Minute
const ActivePreviewLifetime = 30 * time.Second

type StateError struct{ Code, Message string }

func (e *StateError) Error() string         { return e.Message }
func stateError(code, message string) error { return &StateError{code, message} }

// Only commands implemented in this stage. Unknown fields are rejected by HTTP.
type ChangeCommand struct {
	Choices                      []c.Selection  `json:"choices,omitempty"`
	BasePreviewID                *c.ID          `json:"base_preview_id,omitempty"`
	Kind                         string         `json:"kind"`
	Date                         *c.ISODate     `json:"date,omitempty"`
	StopID                       *c.ID          `json:"stop_id,omitempty"`
	Point                        *routing.Point `json:"point,omitempty"`
	StartAt                      *c.Instant     `json:"start_at,omitempty"`
	Selection                    *c.Selection   `json:"selection,omitempty"`
	AfterStopID                  *c.ID          `json:"after_stop_id,omitempty"`
	TargetRemainingDurationSec   *float64       `json:"target_remaining_duration_sec,omitempty"`
	TargetRemainingWalkDistanceM *float64       `json:"target_remaining_walk_distance_m,omitempty"`
	HotelPoint                   *routing.Point `json:"hotel_point,omitempty"`
	TargetDate                   *c.ISODate     `json:"target_date,omitempty"`
	StopIDS                      []c.ID         `json:"stop_ids,omitempty"`
	Input                        *c.TripInput   `json:"input,omitempty"`
}

func (cmd ChangeCommand) Validate() error {
	allowed := map[string][]string{
		"append_manual_choices": {"kind", "date", "choices", "base_preview_id"},
		"generate_plan":         {"kind"}, "start_day": {"kind", "date", "point", "start_at"},
		"remove_stop": {"kind", "date", "stop_id"}, "replan_day": {"kind", "date"},
		"shorten_day":     {"kind", "date", "target_remaining_duration_sec", "target_remaining_walk_distance_m"},
		"return_to_hotel": {"kind", "date", "hotel_point", "target_remaining_duration_sec", "target_remaining_walk_distance_m"},
		"add_activity":    {"kind", "date", "selection", "after_stop_id"},
		"replace_stop":    {"kind", "date", "stop_id", "selection"},
		"move_stop":       {"kind", "date", "stop_id", "target_date"},
		"reorder_stops":   {"kind", "date", "stop_ids"}, "update_trip_input": {"kind", "input"},
	}
	fields, ok := allowed[cmd.Kind]
	if !ok {
		return stateError("COMMAND_NOT_IMPLEMENTED", "Команда пока не реализована.")
	}
	raw, _ := json.Marshal(cmd)
	var values map[string]json.RawMessage
	_ = json.Unmarshal(raw, &values)
	for key := range values {
		if !slices.Contains(fields, key) {
			return stateError("INVALID_COMMAND", "Неверный набор полей команды.")
		}
	}
	if cmd.TargetRemainingDurationSec != nil && (!finite(*cmd.TargetRemainingDurationSec) || *cmd.TargetRemainingDurationSec < 60 || *cmd.TargetRemainingDurationSec > 86400) {
		return stateError("INVALID_COMMAND", "Оставшееся время: от 60 до 86400 секунд.")
	}
	valid := false
	if cmd.TargetRemainingWalkDistanceM != nil && (!finite(*cmd.TargetRemainingWalkDistanceM) || *cmd.TargetRemainingWalkDistanceM < 0 || *cmd.TargetRemainingWalkDistanceM > 100000) {
		return stateError("INVALID_COMMAND", "Некорректный оставшийся лимит ходьбы.")
	}
	switch cmd.Kind {
	case "append_manual_choices":
		valid = cmd.Date != nil && len(cmd.Choices) > 0 && len(cmd.Choices) <= budgetDefaults.CompletionPolicy.ManualLimitPerDay && cmd.StopID == nil && cmd.Point == nil && cmd.StartAt == nil
	case "generate_plan":
		valid = cmd.Date == nil && cmd.StopID == nil && cmd.Point == nil && cmd.StartAt == nil
	case "start_day":
		valid = cmd.Date != nil && cmd.Point != nil && cmd.StartAt != nil && cmd.StopID == nil
	case "remove_stop":
		valid = cmd.Date != nil && cmd.StopID != nil && cmd.Point == nil && cmd.StartAt == nil
	case "replan_day":
		valid = cmd.Date != nil && cmd.StopID == nil && cmd.Point == nil && cmd.StartAt == nil
	case "shorten_day":
		valid = cmd.Date != nil && (cmd.TargetRemainingDurationSec != nil || cmd.TargetRemainingWalkDistanceM != nil)
	case "return_to_hotel":
		valid = cmd.Date != nil && cmd.HotelPoint != nil
	case "add_activity":
		valid = cmd.Date != nil && cmd.Selection != nil
	case "replace_stop":
		valid = cmd.Date != nil && cmd.StopID != nil && cmd.Selection != nil
	case "move_stop":
		valid = cmd.Date != nil && cmd.StopID != nil && cmd.TargetDate != nil && *cmd.Date != *cmd.TargetDate
	case "reorder_stops":
		valid = cmd.Date != nil && len(cmd.StopIDS) > 0
	case "update_trip_input":
		valid = cmd.Input != nil
	default:
		return stateError("COMMAND_NOT_IMPLEMENTED", "Команда пока не реализована.")
	}
	if !valid {
		return stateError("INVALID_COMMAND", "Неверный набор полей команды.")
	}
	return nil
}

func cloneView(view c.TripView) (c.TripView, error) {
	raw, err := json.Marshal(view)
	if err != nil {
		return c.TripView{}, err
	}
	var copied c.TripView
	err = json.Unmarshal(raw, &copied)
	return copied, err
}
func dayIndex(view c.TripView, date c.ISODate) (int, error) {
	for i, day := range view.Days {
		if day.Date == date {
			return i, nil
		}
	}
	return 0, stateError("DAY_NOT_FOUND", "День не найден в сохранённом плане.")
}
func inputDayIndex(view c.TripView, date c.ISODate) (int, error) {
	for i, day := range view.Input.Days {
		if day.Date == date {
			return i, nil
		}
	}
	return 0, stateError("DAY_NOT_FOUND", "Параметры дня не найдены.")
}
func instant(t time.Time) c.Instant { return c.Instant(t.Format(time.RFC3339Nano)) }
func parseInstant(value c.Instant) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, string(value))
	if err != nil {
		return time.Time{}, stateError("INVALID_OBSERVED_AT", "Некорректное время.")
	}
	return t, nil
}
func nextPlanned(day c.DayPlan) int {
	for i, s := range day.Stops {
		if s.Progress == "planned" {
			return i
		}
	}
	return -1
}
func stopKind(stop c.Stop) string {
	if stop.ActivityKind != nil {
		return *stop.ActivityKind
	}
	return "visit"
}
func activeDay(view c.TripView, index int) error {
	if view.Days[index].Execution == nil {
		return stateError("DAY_NOT_STARTED", "Сначала подтвердите старт дня.")
	}
	for i, day := range view.Days {
		if i != index && day.Execution != nil && day.Date > view.Days[index].Date {
			return stateError("DAY_NOT_ACTIVE", "Этот день уже завершён началом следующего дня.")
		}
	}
	return nil
}

// Progress records confirmation of the planned path; it is not a GPS track.
// It does not recalculate geometry or silently reorder the remaining stops.
func RecordProgress(view c.TripView, request c.ProgressRequest, now time.Time) (c.TripView, error) {
	copied, err := cloneView(view)
	if err != nil {
		return c.TripView{}, err
	}
	view = copied
	i, err := dayIndex(view, request.Date)
	if err != nil {
		return c.TripView{}, err
	}
	if err = activeDay(view, i); err != nil {
		return c.TripView{}, err
	}
	day := &view.Days[i]
	execution := day.Execution
	if execution.NeedsReplan {
		return c.TripView{}, stateError("REPLAN_REQUIRED", "Сначала примените пересчёт оставшегося пути.")
	}
	if request.Status != "visited" && request.Status != "skipped" {
		return c.TripView{}, stateError("INVALID_PROGRESS", "Допустимы visited и skipped.")
	}
	at, err := parseInstant(request.ObservedAt)
	if err != nil {
		return c.TripView{}, err
	}
	previous, _ := parseInstant(execution.ObservedAt)
	if at.Before(previous) || at.After(now.Add(ClockSkew)) {
		return c.TripView{}, stateError("INVALID_OBSERVED_AT", "Время отметки раньше последнего подтверждения или находится в будущем.")
	}
	index := nextPlanned(*day)
	if index < 0 || day.Stops[index].StopID != request.StopID {
		return c.TripView{}, stateError("PROGRESS_ORDER", "Можно отметить только следующую запланированную остановку; прошлые отметки неизменяемы.")
	}
	stop := &day.Stops[index]
	if request.Status == "skipped" && stop.Mandatory {
		return c.TripView{}, stateError("MANDATORY_STOP", "Обязательную остановку нельзя пропустить.")
	}
	if request.Status == "visited" {
		var leg *c.Leg
		for j := range day.Legs {
			var target struct {
				Kind   string `json:"kind"`
				StopID c.ID   `json:"stop_id"`
			}
			if json.Unmarshal(day.Legs[j].To, &target) == nil && target.Kind == "stop" && target.StopID == stop.StopID && !slices.Contains(execution.CompletedLegIDS, day.Legs[j].LegID) {
				leg = &day.Legs[j]
				break
			}
		}
		if leg == nil || leg.DistanceM == nil || leg.TravelDurationSec == nil || leg.Status != "calculated" {
			return c.TripView{}, stateError("REPLAN_REQUIRED", "Нет рассчитанного перехода к следующей точке.")
		}
		execution.CompletedLegIDS = append(execution.CompletedLegIDS, leg.LegID)
		execution.ConsumedWalkDistanceM += *leg.DistanceM
		execution.ConsumedWalkDurationSec += *leg.TravelDurationSec
		switch stopKind(*stop) {
		case "meal":
			execution.ConsumedMealDurationSec += stop.Duration.DurationSec
		case "rest":
			execution.ConsumedRestDurationSec += stop.Duration.DurationSec
		default:
			execution.ConsumedVisitDurationSec += stop.Duration.DurationSec
		}
		if stop.Timing.EstimatedArrivalAt != nil && stop.Timing.EstimatedVisitStartAt != nil {
			arrival, _ := parseInstant(*stop.Timing.EstimatedArrivalAt)
			start, _ := parseInstant(*stop.Timing.EstimatedVisitStartAt)
			execution.ConsumedWaitDurationSec += math.Max(0, start.Sub(arrival).Seconds())
		}
		execution.CurrentPoint = stop.Location
	} else {
		execution.NeedsReplan = true
	}
	stop.Progress = request.Status
	observed := request.ObservedAt
	stop.ProgressObservedAt = &observed
	execution.ObservedAt = observed
	started, _ := parseInstant(execution.StartedAt)
	execution.ElapsedDurationSec = math.Max(0, at.Sub(started).Seconds())
	j, err := inputDayIndex(view, request.Date)
	if err != nil {
		return c.TripView{}, err
	}
	distanceLeft := math.Max(0, dailyWalkLimit(view.Input, view.Input.Days[j])-execution.ConsumedWalkDistanceM)
	timeLeft := math.Max(0, dailyTimeBudget(view.Input.Days[j])-execution.ElapsedDurationSec)
	day.Totals.RemainingWalkDistanceM = &distanceLeft
	day.Totals.RemainingDurationSec = &timeLeft
	view.Status = "active"
	view.Version++
	view.UpdatedAt = instant(now)
	refreshBalance(&view)
	return view, nil
}

func (p Planner) Change(ctx context.Context, view c.TripView, cmd ChangeCommand, position *routing.Point, observed *c.Instant, now time.Time) (c.TripView, error) {
	if err := cmd.Validate(); err != nil {
		return c.TripView{}, err
	}
	copied, err := cloneView(view)
	if err != nil {
		return c.TripView{}, err
	}
	view = copied
	view.Input = resolveBudgetDefaults(view.Input)
	if cmd.Kind == "update_trip_input" {
		if position != nil || observed != nil {
			return c.TripView{}, stateError("INVALID_COMMAND", "Позиция неприменима к замене параметров.")
		}
		for _, day := range view.Days {
			if day.Execution != nil {
				return c.TripView{}, stateError("ACTIVE_TRIP", "Для начатой поездки используйте команды изменения дня.")
			}
		}
		view.Input = *cmd.Input
		return p.Build(ctx, view, now)
	}
	if cmd.Date == nil {
		return c.TripView{}, stateError("INVALID_COMMAND", "Нужна дата дня.")
	}
	i, err := dayIndex(view, *cmd.Date)
	if err != nil {
		return c.TripView{}, err
	}
	j, err := inputDayIndex(view, *cmd.Date)
	if err != nil {
		return c.TripView{}, err
	}
	if cmd.Kind == "start_day" {
		if position != nil || observed != nil {
			return c.TripView{}, stateError("INVALID_COMMAND", "Для старта используйте point и start_at внутри команды.")
		}
		if view.Days[i].Execution != nil {
			return c.TripView{}, stateError("DAY_ALREADY_STARTED", "Старт дня уже сохранён.")
		}
		for _, day := range view.Days {
			if day.Execution != nil && (day.Date >= *cmd.Date || nextPlanned(day) >= 0) {
				return c.TripView{}, stateError("ANOTHER_DAY_ACTIVE", "Сначала завершите активности предыдущего дня.")
			}
		}
		start, err := parseInstant(*cmd.StartAt)
		if err != nil {
			return c.TripView{}, err
		}
		if start.After(now.Add(ClockSkew)) || start.In(time.FixedZone("Europe/Moscow", 10800)).Format("2006-01-02") != string(*cmd.Date) {
			return c.TripView{}, stateError("INVALID_START_TIME", "Старт должен относиться к выбранной дате и не находиться в будущем.")
		}
		if err = (routing.Request{From: *cmd.Point, To: *cmd.Point, Mode: "walk"}).Validate(); err != nil {
			return c.TripView{}, invalid(err.Error())
		}
		day := &view.Input.Days[j]
		end := start.Add(time.Duration(day.DurationBudgetSec * float64(time.Second)))
		if day.AvailableWindow != nil {
			end, _ = parseInstant(day.AvailableWindow.EndAt)
			oldStart, _ := parseInstant(day.AvailableWindow.StartAt)
			if start.Before(oldStart) {
				return c.TripView{}, stateError("INVALID_START_TIME", "Старт раньше доступного окна дня.")
			}
		}
		if !end.After(start) {
			return c.TripView{}, stateError("DAY_FINISHED", "Доступное время дня уже закончилось.")
		}
		day.StartPoint = *cmd.Point
		day.AvailableWindow = &c.Interval{StartAt: *cmd.StartAt, EndAt: instant(end)}
		day.DurationBudgetSec = math.Min(day.DurationBudgetSec, end.Sub(start).Seconds())
		view.Days[i].StartPoint = *cmd.Point
		view.Days[i].AvailableWindow = day.AvailableWindow
		view.Days[i].Execution = &c.DayExecution{StartedAt: *cmd.StartAt, ObservedAt: *cmd.StartAt, CurrentPoint: *cmd.Point, CompletedLegIDS: []c.ID{}}
		at := now
		if at.Before(start) {
			at = start
		}
		value := instant(at)
		observed = &value
	} else if view.Days[i].Execution != nil {
		if err = activeDay(view, i); err != nil {
			return c.TripView{}, err
		}
	} else if position != nil || observed != nil {
		return c.TripView{}, stateError("DAY_NOT_STARTED", "Текущая позиция применима после старта дня.")
	}
	if cmd.Kind == "shorten_day" || cmd.Kind == "return_to_hotel" {
		return p.shorten(ctx, view, i, j, cmd, position, observed, now)
	}
	if cmd.Kind == "add_activity" || cmd.Kind == "replace_stop" {
		return p.insert(ctx, view, i, j, cmd, position, observed, now)
	}
	if cmd.Kind == "move_stop" {
		return p.move(ctx, view, i, j, cmd, position, observed, now)
	}
	if cmd.Kind == "reorder_stops" {
		ordered, history := []c.Stop{}, []c.Stop{}
		remaining := map[c.ID]c.Stop{}
		for _, stop := range view.Days[i].Stops {
			if stop.Progress == "planned" {
				remaining[stop.StopID] = stop
			} else {
				history = append(history, stop)
			}
		}
		for _, id := range cmd.StopIDS {
			stop, ok := remaining[id]
			if !ok {
				return c.TripView{}, stateError("INVALID_COMMAND", "Порядок должен содержать все оставшиеся остановки ровно один раз.")
			}
			ordered = append(ordered, stop)
			delete(remaining, id)
		}
		if len(remaining) != 0 {
			return c.TripView{}, stateError("INVALID_COMMAND", "В порядке пропущены остановки.")
		}
		view.Days[i].Stops = append(history, ordered...)
	}
	if cmd.Kind == "remove_stop" {
		found := false
		stops := []c.Stop{}
		for _, stop := range view.Days[i].Stops {
			if stop.StopID != *cmd.StopID {
				stops = append(stops, stop)
				continue
			}
			found = true
			if stop.Progress != "planned" {
				return c.TripView{}, stateError("HISTORY_IMMUTABLE", "Посещённые и пропущенные остановки нельзя удалить.")
			}
			if stop.Mandatory {
				return c.TripView{}, stateError("MANDATORY_STOP", "Обязательную остановку нельзя удалить этой командой.")
			}
		}
		if !found {
			return c.TripView{}, stateError("STOP_NOT_FOUND", "Остановка не найдена в выбранном дне.")
		}
		view.Days[i].Stops = stops
	}
	return p.rebuildExistingDay(ctx, view, i, j, position, observed, now)
}

func (p Planner) rebuildExistingDay(ctx context.Context, view c.TripView, index, inputIndex int, position *routing.Point, observed *c.Instant, now time.Time) (c.TripView, error) {
	// Keep provider-level warnings (e.g. partial ML results), while replacing
	// obsolete warnings belonging to a previously calculated day.
	dayWarnings := map[string]bool{}
	for _, oldDay := range view.Days {
		for _, warning := range oldDay.Warnings {
			raw, _ := json.Marshal(warning)
			dayWarnings[string(raw)] = true
		}
	}
	providerWarnings := []c.Warning{}
	for _, warning := range view.Warnings {
		raw, _ := json.Marshal(warning)
		if warning.Code != "BALANCE_TARGET_UNMET" && !dayWarnings[string(raw)] {
			providerWarnings = append(providerWarnings, warning)
		}
	}
	original := view.Days[index]
	day := view.Input.Days[inputIndex]
	input := view.Input
	remaining := []c.Selection{}
	history := []c.Stop{}
	historicalLegs := []c.Leg{}
	local := Planner{Router: p.Router, Activities: []Activity{}, metadata: map[c.ID]c.Candidate{}}
	for _, stop := range original.Stops {
		if stop.Progress != "planned" {
			history = append(history, stop)
			continue
		}
		remaining = append(remaining, c.Selection{PlaceID: stop.PlaceID, ActivityID: stop.ActivityID, OccurrenceID: stop.OccurrenceID, Mandatory: stop.Mandatory})
		local.Activities = append(local.Activities, Activity{ID: stop.ActivityID, PlaceID: stop.PlaceID, Title: stop.Title, Point: stop.Location, DurationSec: stop.Duration.DurationSec, MinAge: 3, MaxAge: 11})
		if stop.Availability == nil && view.CatalogVersion != "demo-v1" {
			return c.TripView{}, stateError("CATALOG_SNAPSHOT_REQUIRED", "Обновите исходный план: в нём нет сохранённых данных доступности для пересчёта.")
		}
		if stop.Availability != nil {
			candidate := c.Candidate{Place: c.Place{PlaceID: stop.PlaceID, Location: stop.Location, Categories: []c.Category{stop.Category}}, Activity: c.Activity{ActivityID: stop.ActivityID, PlaceID: stop.PlaceID, Title: stop.Title, Kind: stopKind(stop), Duration: stop.Duration}, Availability: *stop.Availability, BalanceCredit: stop.BalanceCredit, Reasons: stop.Reasons, Warnings: stop.Warnings}
			local.metadata[stop.ActivityID] = candidate
		}
		if candidate, ok := p.metadata[stop.ActivityID]; ok {
			local.metadata[stop.ActivityID] = candidate
		}
	}
	execution := original.Execution
	spentTime, spentDistance := 0.0, 0.0
	if execution != nil {
		if position != nil && position.Coordinates != execution.CurrentPoint.Coordinates {
			return c.TripView{}, stateError("UNACCOUNTED_MOVEMENT", "Для новой позиции нужен учёт пройденного пути; сейчас пересчёт поддерживает последнюю подтверждённую точку.")
		}
		at := now
		if observed != nil {
			var err error
			at, err = parseInstant(*observed)
			if err != nil {
				return c.TripView{}, err
			}
		}
		previous, _ := parseInstant(execution.ObservedAt)
		if observed == nil && at.Before(previous) {
			at = previous
		}
		if at.Before(previous) || at.After(now.Add(ClockSkew)) {
			return c.TripView{}, stateError("INVALID_OBSERVED_AT", "Некорректное время пересчёта.")
		}
		started, _ := parseInstant(execution.StartedAt)
		spentTime = math.Max(0, at.Sub(started).Seconds())
		spentDistance = execution.ConsumedWalkDistanceM
		total := dailyTimeBudget(day)
		timeLeft := math.Max(0, total-spentTime)
		distanceLeft := math.Max(0, dailyWalkLimit(input, day)-spentDistance)
		if timeLeft == 0 {
			return c.TripView{}, stateError("DAY_FINISHED", "Доступное время дня исчерпано.")
		}
		end := at.Add(time.Duration(timeLeft * float64(time.Second)))
		day.StartPoint = execution.CurrentPoint
		day.DurationBudgetSec = timeLeft
		day.AvailableWindow = &c.Interval{StartAt: instant(at), EndAt: instant(end)}
		mealLeft := math.Max(0, *day.MealDurationSec-execution.ConsumedMealDurationSec)
		day.MealDurationSec = &mealLeft
		day.RestBudgetSec = math.Max(0, day.RestBudgetSec-execution.ConsumedRestDurationSec)
		input.LoadLimits.MaxWalkDistanceMPerDay = &distanceLeft
		input.PlanningContext = "in_city"
		execution.ObservedAt = instant(at)
		execution.ElapsedDurationSec = spentTime
		execution.NeedsReplan = false
		for _, leg := range original.Legs {
			if slices.Contains(execution.CompletedLegIDS, leg.LegID) {
				historicalLegs = append(historicalLegs, leg)
			}
		}
	}
	input.Days = []c.DayInput{day}
	input.Selections = remaining
	temp := view
	temp.Input = input
	result, err := local.buildDay(ctx, temp, now)
	if err != nil {
		return c.TripView{}, err
	}
	plan := result.Days[0]
	if view.CatalogVersion != "demo-v1" {
		warnings := []c.Warning{}
		for _, warning := range plan.Warnings {
			if warning.Code != "DEMO_CATALOG" && warning.Code != "OPENING_HOURS_UNKNOWN" {
				warnings = append(warnings, warning)
			}
		}
		for _, stop := range plan.Stops {
			warnings = append(warnings, stop.Warnings...)
		}
		plan.Warnings = warnings
	}
	// Use a separate ID namespace for recalculated legs; confirmed history is frozen.
	for i := range plan.Legs {
		plan.Legs[i].LegID = c.ID(fmt.Sprintf("leg-%s-v%d-%d", day.Date, view.Version+1, i+1))
	}
	if execution != nil {
		if len(historicalLegs) > 0 && len(plan.Legs) > 0 {
			plan.Legs[0].From = historicalLegs[len(historicalLegs)-1].To
		}
		plan.StartPoint = original.StartPoint
		plan.AvailableWindow = original.AvailableWindow
		if original.AvailableWindow != nil && view.Input.Days[inputIndex].AvailableWindow != nil {
			window := *original.AvailableWindow
			end, _ := parseInstant(view.Input.Days[inputIndex].AvailableWindow.EndAt)
			originalEnd, _ := parseInstant(window.EndAt)
			if end.Before(originalEnd) {
				window.EndAt = instant(end)
			}
			plan.AvailableWindow = &window
		}
		plan.Execution = execution
		plan.Stops = append(history, plan.Stops...)
		plan.Legs = append(historicalLegs, plan.Legs...)
		plan.Totals.WalkDistanceM = add(plan.Totals.WalkDistanceM, spentDistance)
		plan.Totals.WalkDurationSec = add(plan.Totals.WalkDurationSec, execution.ConsumedWalkDurationSec)
		plan.Totals.VisitDurationSec += execution.ConsumedVisitDurationSec
		plan.Totals.MealDurationSec += execution.ConsumedMealDurationSec
		plan.Totals.RestDurationSec += execution.ConsumedRestDurationSec
		plan.Totals.WaitDurationSec = add(plan.Totals.WaitDurationSec, execution.ConsumedWaitDurationSec)
		plan.Totals.ElapsedDurationSec = add(plan.Totals.ElapsedDurationSec, spentTime)
		dayLimit := dailyWalkLimit(view.Input, view.Input.Days[inputIndex])
		plan.Totals.WalkBudgetM = &dayLimit
		distanceLeft := math.Max(0, dayLimit-spentDistance)
		timeLeft := math.Max(0, dailyTimeBudget(view.Input.Days[inputIndex])-spentTime)
		plan.Totals.RemainingWalkDistanceM = &distanceLeft
		plan.Totals.RemainingDurationSec = &timeLeft
		plan.Assumptions = append(plan.Assumptions, "Пройденные сегменты сохранены; километры подтверждённых переходов оценены по OSM, время уже прошедшей части — по отметкам пользователя.")
		if position == nil {
			plan.Warnings = append(plan.Warnings, Warning("LAST_CONFIRMED_POSITION", "Оставшийся путь рассчитан от последней подтверждённой точки, без GPS-трека."))
		}
	}
	view.Days[index] = plan
	view.Version++
	view.UpdatedAt = instant(now)
	if execution != nil {
		view.Status = "active"
	}
	view.Warnings = providerWarnings
	for _, day := range view.Days {
		view.Warnings = append(view.Warnings, day.Warnings...)
	}
	refreshBalance(&view)
	return view, nil
}

func refreshBalance(view *c.TripView) {
	warnings := []c.Warning{}
	for _, warning := range view.Warnings {
		if warning.Code != "BALANCE_TARGET_UNMET" {
			warnings = append(warnings, warning)
		}
	}
	view.Warnings = warnings
	credits := map[c.ID]float64{}
	total := 0.0
	for _, day := range view.Days {
		for _, stop := range day.Stops {
			if stop.Progress == "skipped" {
				continue
			}
			for _, credit := range stop.BalanceCredit {
				credits[credit.ChildID] += credit.Value
				total += credit.Value
			}
		}
	}
	rows := []map[string]any{}
	for _, child := range view.Input.Family.Children {
		target := 1 / float64(len(view.Input.Family.Children))
		var share *float64
		if total > 0 {
			value := credits[child.ChildID] / total
			share = &value
			if math.Abs(value-target) > 0.000001 {
				view.Warnings = append(view.Warnings, Warning("BALANCE_TARGET_UNMET", "Количество активностей не обеспечивает равный баланс детей."))
			}
		}
		rows = append(rows, map[string]any{"child_id": child.ChildID, "target_share": target, "planned_credit": credits[child.ChildID], "achieved_share": share})
	}
	raw, _ := json.Marshal(rows)
	_ = json.Unmarshal(raw, &view.FamilyBalance)
}

// Apply never silently recalculates a shown preview. Reject it if elapsed review
// time makes a known deadline invalid; the client can request a fresh preview.
func ActivePreviewFresh(day c.DayPlan, input c.DayInput, now time.Time) bool {
	if day.Execution == nil {
		return true
	}
	asOf, err := parseInstant(day.Execution.ObservedAt)
	if err != nil {
		return false
	}
	delay := math.Max(0, now.Sub(asOf).Seconds())
	if now.After(asOf.Add(ActivePreviewLifetime)) {
		return false
	}
	if day.Totals.ElapsedDurationSec == nil || *day.Totals.ElapsedDurationSec+delay > dailyTimeBudget(input) {
		return false
	}
	for _, stop := range day.Stops {
		if stop.Progress != "planned" {
			continue
		}
		if stop.Timing.FixedEventInterval != nil && stop.Timing.EstimatedArrivalAt != nil {
			arrival, _ := parseInstant(*stop.Timing.EstimatedArrivalAt)
			start, _ := parseInstant(stop.Timing.FixedEventInterval.StartAt)
			if arrival.Add(time.Duration(delay * float64(time.Second))).After(start) {
				return false
			}
		}
		if stop.Availability == nil || stop.Timing.EstimatedVisitStartAt == nil || stop.Timing.EstimatedDepartureAt == nil {
			continue
		}
		start, _ := parseInstant(*stop.Timing.EstimatedVisitStartAt)
		end, _ := parseInstant(*stop.Timing.EstimatedDepartureAt)
		// A fixed session retains its own interval; only reaching its start can go stale.
		if stop.OccurrenceID == nil {
			start = start.Add(time.Duration(delay * float64(time.Second)))
			end = end.Add(time.Duration(delay * float64(time.Second)))
		}
		for _, availability := range *stop.Availability {
			if availability.Date != day.Date || availability.State != "open" {
				continue
			}
			if availability.LastEntryAt != nil {
				last, _ := parseInstant(*availability.LastEntryAt)
				if start.After(last) {
					return false
				}
			}
			if len(availability.VisitWindows) > 0 {
				fits := false
				for _, window := range availability.VisitWindows {
					from, _ := parseInstant(window.StartAt)
					to, _ := parseInstant(window.EndAt)
					if !start.Before(from) && !end.After(to) {
						fits = true
						break
					}
				}
				if !fits {
					return false
				}
			}
		}
	}
	return true
}
