package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/mapdata"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

type assistantMessageRequest struct {
	ExpectedVersion int            `json:"expected_version"`
	Message         string         `json:"message"`
	Date            *c.ISODate     `json:"date,omitempty"`
	CurrentPosition *routing.Point `json:"current_position"`
	ObservedAt      *c.Instant     `json:"observed_at"`
	HotelPoint      *routing.Point `json:"hotel_point,omitempty"`
}
type placeOption struct {
	PlaceID           c.ID    `json:"place_id"`
	WalkDurationSec   float64 `json:"walk_duration_sec"`
	DetourDurationSec float64 `json:"detour_duration_sec"`
}
type assistantReply struct {
	Reply       string           `json:"reply"`
	Preview     *c.PlanPreview   `json:"preview"`
	Places      []c.Place        `json:"places"`
	Options     []placeOption    `json:"options"`
	Suggestions []string         `json:"suggestions"`
	Needs       []assistant.Need `json:"needs"`
	Mode        string           `json:"mode"`
}

func normalizeQuote(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }

func validateIntent(intent assistant.Intent, view c.TripView, memory assistant.Memory, message string) error {
	if !slices.Contains([]string{"clarify", "preferences", "find_places", "remove_stop", "shorten_day", "replan_day", "return_to_hotel", "add_activity", "replace_stop", "move_stop", "reorder_stops"}, intent.Action) {
		return assistant.ErrContract
	}
	if len(intent.Needs) > 10 || len(intent.StopIDS) > 50 {
		return assistant.ErrContract
	}
	dates := map[c.ISODate]bool{}
	stops := map[c.ID]bool{}
	children := map[c.ID]bool{}
	for _, child := range view.Input.Family.Children {
		children[child.ChildID] = true
	}
	for _, day := range view.Days {
		dates[day.Date] = true
		for _, s := range day.Stops {
			if s.Progress == "planned" {
				stops[s.StopID] = true
			}
		}
	}
	for _, date := range []*c.ISODate{intent.Date, intent.TargetDate} {
		if date != nil && !dates[*date] {
			return assistant.ErrContract
		}
	}
	if intent.StopID != nil && !stops[*intent.StopID] {
		return assistant.ErrContract
	}
	for _, id := range intent.StopIDS {
		if !stops[id] {
			return assistant.ErrContract
		}
	}
	if intent.PlaceID != nil && !slices.ContainsFunc(memory.Choices, func(candidate c.Candidate) bool { return candidate.Place.PlaceID == *intent.PlaceID }) {
		return assistant.ErrContract
	}
	sources := []string{message}
	for _, turn := range memory.History {
		sources = append(sources, turn.Message)
	}
	quoted := func(value string) bool {
		return value != "" && slices.ContainsFunc(sources, func(s string) bool { return strings.Contains(normalizeQuote(s), normalizeQuote(value)) })
	}
	for _, need := range intent.Needs {
		if !slices.Contains([]string{"rest", "food", "toilet", "shelter", "play", "less_walking", "return"}, need.Kind) || !slices.Contains([]string{"now", "soon", "unspecified"}, need.Urgency) || !quoted(need.Evidence) || need.ChildID != nil && !children[*need.ChildID] {
			return assistant.ErrContract
		}
	}
	if intent.DurationSec != nil && (math.IsNaN(*intent.DurationSec) || math.IsInf(*intent.DurationSec, 0) || *intent.DurationSec < 60 || *intent.DurationSec > 86400 || intent.DurationEvidence == nil || !quoted(*intent.DurationEvidence)) {
		return assistant.ErrContract
	}
	if intent.MaxWalkDistanceM != nil && (math.IsNaN(*intent.MaxWalkDistanceM) || math.IsInf(*intent.MaxWalkDistanceM, 0) || *intent.MaxWalkDistanceM < 0 || *intent.MaxWalkDistanceM > 100000 || intent.WalkEvidence == nil || !quoted(*intent.WalkEvidence)) {
		return assistant.ErrContract
	}
	if len(intent.Preferences) > 0 {
		var parsed c.ParsedRequest
		if json.Unmarshal(intent.Preferences, &parsed) != nil {
			return assistant.ErrContract
		}
		for _, raw := range parsed.Claims {
			var claim struct {
				Evidence string `json:"evidence"`
			}
			if json.Unmarshal(raw, &claim) != nil || !quoted(claim.Evidence) {
				return assistant.ErrContract
			}
		}
	}
	if intent.Action == "clarify" && (intent.Question == nil || len(*intent.Question) > 1200 || strings.TrimSpace(*intent.Question) == "") {
		return assistant.ErrContract
	}
	return nil
}

func (a *tripAPI) assistantMessage(w http.ResponseWriter, r *http.Request) {
	owner, err := a.owner(r, true)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		a.respondError(w, r, failure(415, "UNSUPPORTED_MEDIA_TYPE", "Используйте application/json."))
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 20000))
	if err != nil {
		a.respondError(w, r, failure(400, "INVALID_JSON", "Сообщение слишком большое."))
		return
	}
	var request assistantMessageRequest
	if err = strict(raw, &request); err != nil {
		a.respondError(w, r, err)
		return
	}
	request.Message = strings.TrimSpace(request.Message)
	if request.Message == "" || len([]rune(request.Message)) > 4000 {
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Сообщение: от 1 до 4000 символов."))
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if len(key) > 200 {
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Слишком длинный ключ."))
		return
	}
	receiptKey := owner + "|POST|" + r.URL.Path + "|" + key
	var view c.TripView
	var memory assistant.Memory
	var replay *tripstore.Receipt
	err = a.store.Read(func(s tripstore.State) error {
		if _, err := a.liveSession(&s, r, owner); err != nil {
			return err
		}
		trip, ok := s.Trips[r.PathValue("trip_id")]
		if !ok || trip.Owner != owner {
			return failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
		}
		if key != "" {
			if saved, ok := s.Receipts[receiptKey]; ok && saved.ExpiresAt.After(a.now()) {
				if saved.Hash != fmtHash(raw) {
					return failure(409, "IDEMPOTENCY_CONFLICT", "Ключ использован с другим сообщением.")
				}
				replay = &saved
				return nil
			}
		}
		if trip.View.Version != request.ExpectedVersion {
			return conflict(trip.View.Version)
		}
		view = trip.View
		memory = s.Assistant[string(view.TripID)]
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	if replay != nil {
		sendReply(w, tripReply{replay.Status, replay.Body, replay.Location})
		return
	}
	if a.assistant == nil {
		a.respondError(w, r, failure(503, "ASSISTANT_UNAVAILABLE", "Помощник не подключён. Используйте кнопки изменения маршрута."))
		return
	}
	if len(view.Days) == 0 {
		a.respondError(w, r, failure(422, "PLAN_REQUIRED", "Сначала сформируйте маршрут."))
		return
	}
	revision := memory.Revision
	if !memory.ExpiresAt.After(a.now()) || memory.TripVersion != view.Version {
		memory = assistant.Memory{Revision: revision}
	}
	date := view.Days[0].Date
	if request.Date != nil {
		date = *request.Date
	} else {
		for _, day := range view.Days {
			if day.Execution != nil || string(day.Date) == a.now().In(time.FixedZone("MSK", 10800)).Format("2006-01-02") {
				date = day.Date
			}
		}
	}
	var day *c.DayPlan
	for i := range view.Days {
		if view.Days[i].Date == date {
			day = &view.Days[i]
			break
		}
	}
	if day == nil {
		a.respondError(w, r, failure(422, "DAY_NOT_FOUND", "Выбранный день отсутствует."))
		return
	}
	if request.ObservedAt != nil {
		at, e := time.Parse(time.RFC3339Nano, string(*request.ObservedAt))
		if e != nil || at.After(a.now().Add(planner.ClockSkew)) || at.Before(a.now().Add(-5*time.Minute)) {
			a.respondError(w, r, failure(422, "INVALID_OBSERVED_AT", "Обновите время сообщения."))
			return
		}
	}
	choices := []map[string]any{}
	for index, candidate := range memory.Choices {
		choices = append(choices, map[string]any{"number": index + 1, "place_id": candidate.Place.PlaceID, "name": candidate.Place.Name, "activity_id": candidate.Activity.ActivityID})
	}
	days := []map[string]any{}
	for _, d := range view.Days {
		stops := []map[string]any{}
		for _, s := range d.Stops {
			stops = append(stops, map[string]any{"stop_id": s.StopID, "title": s.Title, "progress": s.Progress, "mandatory": s.Mandatory, "category": s.Category, "activity_id": s.ActivityID})
		}
		days = append(days, map[string]any{"date": d.Date, "stops": stops, "end_point": d.EndPoint, "execution": d.Execution, "totals": d.Totals})
	}
	if request.HotelPoint != nil && (routing.Request{From: *request.HotelPoint, To: *request.HotelPoint, Mode: "walk"}).Validate() != nil {
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Точка отеля вне области маршрутизации."))
		return
	}
	contextValue := map[string]any{"selected_date": date, "observed_at": a.now(), "family": view.Input.Family, "days": days, "history": memory.History, "choices": choices, "pending_stop_id": memory.PendingStopID, "hotel_point": request.HotelPoint}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	intent, err := a.assistant.Interpret(ctx, newID(), request.Message, contextValue)
	if err == nil {
		err = validateIntent(intent, view, memory, request.Message)
	}
	if err != nil {
		code, status, message := "ASSISTANT_UNAVAILABLE", 503, "Помощник временно недоступен. Повторите сообщение."
		if errors.Is(err, assistant.ErrContract) {
			code, status, message = "ASSISTANT_CONTRACT_ERROR", 502, "Не удалось надёжно разобрать просьбу. Уточните её."
		}
		a.respondError(w, r, failure(status, code, message))
		return
	}
	if intent.Date != nil {
		date = *intent.Date
		for i := range view.Days {
			if view.Days[i].Date == date {
				day = &view.Days[i]
				break
			}
		}
	}
	reply := assistantReply{Places: []c.Place{}, Options: []placeOption{}, Suggestions: []string{}, Needs: intent.Needs, Mode: "gigachat"}
	if reply.Needs == nil {
		reply.Needs = []assistant.Need{}
	}
	p := a.planner
	command := planner.ChangeCommand{Kind: intent.Action, Date: &date, StopID: intent.StopID}
	if intent.Action == "return_to_hotel" && request.HotelPoint == nil {
		question := "Укажите точку отеля. Конечная точка дня может быть другим местом."
		intent.Action = "clarify"
		intent.Question = &question
	}
	switch intent.Action {
	case "clarify":
		reply.Reply = *intent.Question
	case "preferences", "find_places":
		var found []c.Candidate
		var evidence []c.Evidence
		found, evidence, reply.Options, err = a.findAssistantPlaces(ctx, view, *day, intent)
		if err == nil {
			memory.Choices = found
			memory.Evidence = evidence
			memory.PendingStopID = intent.StopID
			memory.Date = date
			for index, candidate := range found {
				reply.Places = append(reply.Places, candidate.Place)
				reply.Suggestions = append(reply.Suggestions, fmt.Sprintf("Добавь вариант %d", index+1))
			}
			reply.Reply = "Нашёл варианты. Время подхода рассчитано по пешеходным путям; часы работы и доступность требуют проверки. Выберите место — подготовлю изменение маршрута."
			if len(found) == 0 {
				reply.Reply = "В доступном каталоге подходящих мест поблизости не нашлось. Можно сократить прогулку или вернуться к точке завершения дня."
				reply.Suggestions = []string{"Сократи прогулку", "Вернёмся к точке завершения дня"}
			}
		}
	default:
		switch intent.Action {
		case "shorten_day":
			target := intent.DurationSec
			if target == nil && intent.MaxWalkDistanceM == nil {
				remaining := 0.0
				if day.Totals.ElapsedDurationSec != nil {
					remaining = *day.Totals.ElapsedDurationSec
				}
				if day.Execution != nil {
					started, _ := time.Parse(time.RFC3339Nano, string(day.Execution.StartedAt))
					remaining -= math.Max(0, a.now().Sub(started).Seconds())
				}
				value := math.Max(60, remaining/2)
				target = &value
				reply.Reply = "Предлагаю сократить оставшееся время примерно вдвое; обязательные остановки сохранятся. "
			}
			command.TargetRemainingDurationSec = target
			command.TargetRemainingWalkDistanceM = intent.MaxWalkDistanceM
			command.StopID = nil
		case "return_to_hotel":
			reply.Reply = "Предлагаю вернуться в указанный отель"
			if request.HotelPoint.Label != nil {
				reply.Reply += " — «" + *request.HotelPoint.Label + "»"
			}
			reply.Reply += ". Обязательные остановки сохраняются. "
			command.HotelPoint = request.HotelPoint
			command.TargetRemainingDurationSec = intent.DurationSec
			command.TargetRemainingWalkDistanceM = intent.MaxWalkDistanceM
			command.StopID = nil
		case "replan_day":
			command.StopID = nil
		case "reorder_stops":
			command.StopIDS = intent.StopIDS
			command.StopID = nil
		case "move_stop":
			command.TargetDate = intent.TargetDate
		case "add_activity", "replace_stop":
			if memory.Date != date {
				err = failure(422, "CHOICES_STALE", "Заново найдите варианты для выбранного дня.")
				break
			}
			var candidate *c.Candidate
			for i := range memory.Choices {
				if intent.PlaceID != nil && memory.Choices[i].Place.PlaceID == *intent.PlaceID {
					candidate = &memory.Choices[i]
					break
				}
			}
			if candidate == nil {
				err = failure(422, "PLACE_SELECTION_REQUIRED", "Выберите один из найденных вариантов.")
				break
			}
			if command.StopID == nil && memory.PendingStopID != nil {
				command.Kind = "replace_stop"
				command.StopID = memory.PendingStopID
			}
			p, err = p.WithCandidates(view, []c.Candidate{*candidate}, memory.Evidence, a.now())
			if err != nil {
				break
			}
			command.Selection = &c.Selection{PlaceID: candidate.Place.PlaceID, ActivityID: candidate.Activity.ActivityID}
		}
		if err == nil {
			rawCommand, _ := json.Marshal(command)
			observed := request.ObservedAt
			if day.Execution == nil {
				observed = nil
			}
			previewRaw, _ := json.Marshal(c.PreviewRequest{ExpectedVersion: request.ExpectedVersion, Command: rawCommand, CurrentPosition: request.CurrentPosition, ObservedAt: observed})
			reply.Preview, err = a.prepareWithPlanner(r.WithContext(ctx), owner, previewRaw, p)
			if err == nil {
				if command.Kind == "add_activity" || command.Kind == "replace_stop" {
					reply.Preview.ProposedTrip.Evidence = mergeEvidence(reply.Preview.ProposedTrip.Evidence, memory.Evidence)
				}
				reply.Reply += previewExplanation(reply.Preview)
				reply.Suggestions = []string{"Нужен туалет", "Хотим поесть", "Найди место для отдыха"}
			}
		}
	}
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	memory.History = append(memory.History, assistant.Turn{Message: request.Message, Reply: reply.Reply})
	if len(memory.History) > 6 {
		memory.History = memory.History[len(memory.History)-6:]
	}
	memory.Revision = revision + 1
	memory.TripVersion = view.Version
	memory.ExpiresAt = a.now().Add(30 * time.Minute)
	resultRaw, err := json.Marshal(reply)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	err = a.store.Update(func(s *tripstore.State) error {
		if _, err := a.liveSession(s, r, owner); err != nil {
			return err
		}
		trip, ok := s.Trips[string(view.TripID)]
		if !ok || trip.Owner != owner {
			return failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
		}
		if key != "" {
			if saved, ok := s.Receipts[receiptKey]; ok && saved.ExpiresAt.After(a.now()) {
				if saved.Hash != fmtHash(raw) {
					return failure(409, "IDEMPOTENCY_CONFLICT", "Ключ использован с другим сообщением.")
				}
				resultRaw = saved.Body
				return nil
			}
		}
		if trip.View.Version != view.Version {
			return conflict(trip.View.Version)
		}
		if s.Assistant[string(view.TripID)].Revision != revision {
			return failure(409, "ASSISTANT_CONTEXT_CHANGED", "Пришло другое сообщение; повторите просьбу.")
		}
		s.Assistant[string(view.TripID)] = memory
		if reply.Preview != nil {
			s.Previews[string(reply.Preview.PreviewID)] = tripstore.Preview{Owner: owner, View: *reply.Preview}
		}
		if key != "" {
			s.Receipts[receiptKey] = tripstore.Receipt{Hash: fmtHash(raw), Status: 200, Body: resultRaw, ExpiresAt: a.now().Add(30 * time.Minute)}
		}
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	sendReply(w, tripReply{200, resultRaw, ""})
}

func mergeEvidence(old, extra []c.Evidence) []c.Evidence {
	for _, e := range extra {
		if !slices.ContainsFunc(old, func(v c.Evidence) bool { return v.EvidenceID == e.EvidenceID }) {
			old = append(old, e)
		}
	}
	return old
}
func previewExplanation(p *c.PlanPreview) string {
	if !p.CanApply {
		return "Вариант рассчитан, но нарушает ограничения времени, ходьбы или обязательных посещений. Применить его нельзя; уточните пожелание."
	}
	result := fmt.Sprintf("Подготовил вариант: убрано остановок — %d, добавлено — %d.", len(p.Diff.RemovedStopIDS), len(p.Diff.AddedStopIDS))
	if p.Diff.WalkDeltaSec != nil {
		delta := int(math.Round(*p.Diff.WalkDeltaSec / 60))
		if delta < 0 {
			result += fmt.Sprintf(" Ходьбы меньше на %d мин.", -delta)
		} else if delta > 0 {
			result += fmt.Sprintf(" Ходьбы больше на %d мин.", delta)
		}
	}
	return result + " Проверьте изменения и предупреждения перед применением."
}

func (a *tripAPI) findAssistantPlaces(ctx context.Context, view c.TripView, day c.DayPlan, intent assistant.Intent) ([]c.Candidate, []c.Evidence, []placeOption, error) {
	if len(intent.Needs) == 0 {
		return a.findAssistantActivities(ctx, view, day, intent)
	}
	if p, err := a.planner.ForCatalog(view.CatalogVersion); err == nil {
		if _, ok := p.Source.(planner.HTTPSource); ok {
			return a.findAssistantModelNeeds(ctx, view, day, intent)
		}
	}
	if a.places == nil {
		return nil, nil, nil, failure(503, "CATALOG_UNAVAILABLE", "Каталог мест рядом не подключён.")
	}
	categories := []string{}
	kind := "utility"
	duration := 600.0
	urgent := false
	shelter := false
	for _, need := range intent.Needs {
		urgent = urgent || need.Urgency == "now"
		switch need.Kind {
		case "food":
			categories = append(categories, "restaurant")
			kind = "meal"
			duration = 1800
		case "toilet":
			categories = append(categories, "toilet")
		case "rest", "less_walking":
			categories = append(categories, "bench")
			kind = "rest"
			duration = 900
		case "shelter":
			categories = append(categories, "restaurant", "bench")
			shelter = true
			kind = "rest"
			duration = 900
		case "play":
			categories = append(categories, "playground")
			kind = "visit"
			duration = 1200
		}
	}
	if len(categories) == 0 {
		return nil, nil, nil, failure(422, "NEED_REQUIRED", "Уточните, какое место найти: еда, туалет, отдых, укрытие или площадка.")
	}
	slices.Sort(categories)
	categories = slices.Compact(categories)
	origin := day.StartPoint
	if day.Execution != nil {
		origin = day.Execution.CurrentPoint
	}
	next := day.EndPoint
	for _, s := range day.Stops {
		if s.Progress == "planned" {
			next = s.Location
			break
		}
	}
	if a.planner.Router == nil {
		return nil, nil, nil, routing.ErrUnavailable
	}
	query := mapdata.Query{Lon: origin.Coordinates[0], Lat: origin.Coordinates[1], RadiusM: 1500, Categories: categories, Limit: 12}
	if !urgent {
		for _, leg := range day.Legs {
			if day.Execution != nil && slices.Contains(day.Execution.CompletedLegIDS, leg.LegID) {
				continue
			}
			if leg.Geometry != nil && len(leg.Geometry.Coordinates) > 1 {
				query.RouteLines = append(query.RouteLines, leg.Geometry.Coordinates)
			}
		}
		if len(query.RouteLines) > 0 {
			query.RadiusM = 250
		}
	}
	found, err := a.places.Search(ctx, query)
	if err != nil {
		return nil, nil, nil, failure(503, "CATALOG_UNAVAILABLE", "Поиск мест временно недоступен.")
	}
	speed := planner.WalkingSpeedKPH(view.Input.LoadLimits.Pace)
	baseline, err := a.planner.Router.Route(ctx, routing.Request{From: origin, To: next, Mode: "walk", WalkingSpeedKPH: &speed})
	if err != nil {
		return nil, nil, nil, err
	}
	type option struct {
		candidate c.Candidate
		metrics   placeOption
		cost      float64
	}
	options := []option{}
	for _, place := range found.Items {
		if slices.ContainsFunc(view.Days, func(d c.DayPlan) bool {
			return slices.ContainsFunc(d.Stops, func(s c.Stop) bool { return s.PlaceID == place.PlaceID })
		}) {
			continue
		}
		if shelter && !knownTrue(place.Shelter) && !knownTrue(place.Indoor) {
			continue
		}
		if place.AccessRaw != nil && slices.Contains([]string{"no", "private"}, *place.AccessRaw) {
			continue
		}
		point := place.Location
		if place.Entrance != nil {
			point = *place.Entrance
		}
		walk, e := a.planner.Router.Route(ctx, routing.Request{From: origin, To: point, Mode: "walk", WalkingSpeedKPH: &speed})
		if errors.Is(e, routing.ErrNoRoute) {
			continue
		}
		if e != nil {
			return nil, nil, nil, e
		}
		if intent.MaxWalkDistanceM != nil && walk.DistanceM > *intent.MaxWalkDistanceM {
			continue
		}
		onward, e := a.planner.Router.Route(ctx, routing.Request{From: point, To: next, Mode: "walk", WalkingSpeedKPH: &speed})
		if errors.Is(e, routing.ErrNoRoute) {
			continue
		}
		if e != nil {
			return nil, nil, nil, e
		}
		distance := walk.DistanceM
		place.DistanceM = &distance
		metrics := placeOption{PlaceID: place.PlaceID, WalkDurationSec: walk.TravelDurationSec, DetourDurationSec: math.Max(0, walk.TravelDurationSec+onward.TravelDurationSec-baseline.TravelDurationSec)}
		cost := metrics.DetourDurationSec
		if urgent {
			cost = metrics.WalkDurationSec
		}
		candidateKind, candidateDuration := kind, duration
		if slices.Contains(place.Categories, "restaurant") {
			candidateKind, candidateDuration = "meal", 1800
		} else if slices.Contains(place.Categories, "bench") {
			candidateKind, candidateDuration = "rest", 900
		} else if slices.Contains(place.Categories, "toilet") {
			candidateKind, candidateDuration = "utility", 600
		} else if slices.Contains(place.Categories, "playground") {
			candidateKind, candidateDuration = "visit", 1200
		}
		candidate, err := infrastructureCandidate(view, place, candidateKind, candidateDuration)
		if err != nil {
			return nil, nil, nil, err
		}
		options = append(options, option{candidate, metrics, cost})
	}
	sort.SliceStable(options, func(i, j int) bool { return options[i].cost < options[j].cost })
	candidates := []c.Candidate{}
	metrics := []placeOption{}
	for _, option := range options {
		if len(candidates) == 3 {
			break
		}
		candidates = append(candidates, option.candidate)
		metrics = append(metrics, option.metrics)
	}
	return candidates, found.Evidence, metrics, nil
}
func knownTrue(raw json.RawMessage) bool {
	var f struct {
		State string `json:"state"`
		Value *bool  `json:"value"`
	}
	return json.Unmarshal(raw, &f) == nil && f.State == "known" && f.Value != nil && *f.Value
}
func infrastructureCandidate(view c.TripView, place c.Place, kind string, duration float64) (c.Candidate, error) {
	unknown := map[string]any{"state": "unknown", "value": nil, "evidence_ids": []string{}}
	activity := map[string]any{"activity_id": "activity:map:" + string(place.PlaceID) + ":" + kind, "place_id": place.PlaceID, "title": place.Name, "kind": kind, "duration": map[string]any{"duration_sec": duration, "source": "estimated", "evidence_ids": []string{}}, "evidence_ids": []string{}}
	for _, key := range []string{"age_min_years", "age_max_years", "recommended_age_min_years", "recommended_age_max_years", "height_min_cm", "admission_rule", "booking_required"} {
		activity[key] = unknown
	}
	eligibility := []map[string]any{}
	interest := []map[string]any{}
	credit := []map[string]any{}
	for _, child := range view.Input.Family.Children {
		eligibility = append(eligibility, map[string]any{"child_id": child.ChildID, "status": "unknown", "reasons": []any{}})
		interest = append(interest, map[string]any{"child_id": child.ChildID, "value": nil})
		value := 0.0
		if kind == "visit" {
			value = 1 / float64(len(view.Input.Family.Children))
		}
		credit = append(credit, map[string]any{"child_id": child.ChildID, "value": value})
	}
	availability := []map[string]any{}
	for _, day := range view.Input.Days {
		availability = append(availability, map[string]any{"date": day.Date, "state": "unknown", "visit_windows": []any{}, "last_entry_at": nil, "occurrences": []any{}, "evidence_ids": []string{}})
	}
	warnings := []c.Warning{planner.Warning("OPENING_HOURS_UNKNOWN", "Время работы и доступность не подтверждены."), planner.Warning("ELIGIBILITY_UNKNOWN", "Условия посещения не подтверждены."), planner.Warning("DURATION_ESTIMATED", fmt.Sprintf("Время остановки оценено продуктовой политикой: %.0f минут.", duration/60))}
	raw, err := json.Marshal(map[string]any{"place": place, "activity": activity, "eligibility": eligibility, "availability": availability, "balance_credit": credit, "scores": map[string]any{"child_interest": interest, "child_age_fit": interest, "adult_interest": nil, "popularity": nil, "final_relevance": 0}, "is_top_place": false, "reasons": []any{}, "warnings": warnings})
	var candidate c.Candidate
	if err == nil {
		err = json.Unmarshal(raw, &candidate)
	}
	return candidate, err
}
