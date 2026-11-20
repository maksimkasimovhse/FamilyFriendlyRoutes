package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

type tripError struct {
	status        int
	code, message string
	current       *int
}

func (e *tripError) Error() string                   { return e.message }
func failure(status int, code, message string) error { return &tripError{status, code, message, nil} }
func conflict(current int) error {
	return &tripError{409, "VERSION_CONFLICT", "Обновите поездку перед повтором изменения.", &current}
}
func newID() string {
	var value [24]byte
	_, _ = rand.Read(value[:])
	return hex.EncodeToString(value[:])
}

type tripAPI struct {
	auth    *authGuard
	store   *tripstore.Store
	planner planner.Planner
	now     func() time.Time
}
type tripReply struct {
	status   int
	body     json.RawMessage
	location string
}

func jsonReply(status int, value any, location string) (tripReply, error) {
	raw, err := json.Marshal(value)
	return tripReply{status, raw, location}, err
}

func TripHandler(store *tripstore.Store, p planner.Planner) http.Handler {
	return tripHandler(store, p, func() time.Time { return time.Now().UTC() })
}
func tripHandler(store *tripstore.Store, p planner.Planner, now func() time.Time) http.Handler {
	api := &tripAPI{store: store, planner: p, now: now, auth: newAuthGuard()}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "alive"}) })
	mux.HandleFunc("GET /api/v1/session", api.session)
	mux.HandleFunc("POST /api/v1/auth/register", api.credentials)
	mux.HandleFunc("POST /api/v1/auth/login", api.credentials)
	mux.HandleFunc("POST /api/v1/auth/logout", api.logout)
	mux.HandleFunc("GET /api/v1/auth/me", api.me)
	mux.HandleFunc("GET /api/v1/profile/family", api.familyProfile)
	mux.HandleFunc("PUT /api/v1/profile/family", api.familyProfile)
	mux.HandleFunc("GET /api/v1/trips", api.listTrips)
	mux.HandleFunc("POST /api/v1/trips/from-profile", api.post)
	mux.HandleFunc("GET /api/v1/reference-data", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"interest_options": []map[string]string{{"id": "history", "label": "История"}, {"id": "science", "label": "Наука"}, {"id": "play", "label": "Игры"}}, "categories": []map[string]string{{"id": "landmark", "label": "Тестовые остановки"}}, "supported_city_ids": []string{"nizhny_novgorod"}, "supported_child_age": map[string]int{"min": 3, "max": 11}, "capabilities": map[string]bool{"taxi_suggestions": false, "weather_automation": false, "free_text": p.Source != nil}, "default_family_policy": planner.NewDraft("", c.TripInput{}, api.now()).Policy, "demo_activities": p.Activities, "implementation_stage": "multi_day_pool"})
	})
	mux.HandleFunc("POST /api/v1/trips", api.post)
	mux.HandleFunc("GET /api/v1/trips/{trip_id}", api.getTrip)
	mux.HandleFunc("POST /api/v1/trips/{trip_id}/previews", api.post)
	mux.HandleFunc("POST /api/v1/trips/{trip_id}/progress", api.post)
	mux.HandleFunc("GET /api/v1/trips/{trip_id}/previews/{preview_id}", api.getPreview)
	mux.HandleFunc("POST /api/v1/trips/{trip_id}/previews/{preview_id}/apply", api.post)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-ID", newID())
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}
func (a *tripAPI) respondError(w http.ResponseWriter, r *http.Request, err error) {
	var e *tripError
	var state *planner.StateError
	if !errors.As(err, &e) {
		switch {
		case errors.As(err, &state):
			e = &tripError{422, state.Code, state.Message, nil}
		case errors.Is(err, planner.ErrValidation):
			e = &tripError{422, "VALIDATION_ERROR", err.Error(), nil}
		case errors.Is(err, planner.ErrMLContract):
			e = &tripError{502, "ML_CONTRACT_ERROR", "Некорректный ответ рекомендательной системы.", nil}
		case errors.Is(err, planner.ErrMLUnavailable):
			e = &tripError{503, "ML_UNAVAILABLE", "Рекомендательная система недоступна.", nil}
		case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
			e = &tripError{503, "PLANNING_TIMEOUT", "Расчёт прерван или превысил доступное время.", nil}
		case errors.Is(err, routing.ErrNoRoute):
			e = &tripError{422, "NO_ROUTE", "Нет подходящего пути.", nil}
		case errors.Is(err, routing.ErrUnavailable):
			e = &tripError{503, "ROUTING_UNAVAILABLE", "Маршрутизатор недоступен.", nil}
		case errors.Is(err, routing.ErrInvalidResponse):
			e = &tripError{502, "ROUTING_CONTRACT_ERROR", "Некорректный ответ маршрутизатора.", nil}
		default:
			e = &tripError{503, "STORE_UNAVAILABLE", "Не удалось сохранить или прочитать данные.", nil}
		}
	}
	if e.status == 503 {
		w.Header().Set("Retry-After", "5")
	}
	writeJSON(w, e.status, map[string]any{"error": map[string]any{"code": e.code, "message": e.message, "request_id": w.Header().Get("X-Request-ID"), "retryable": e.status == 503, "current_version": e.current, "details": []any{}}})
}
func (a *tripAPI) session(w http.ResponseWriter, r *http.Request) {
	id := ""
	if cookie, err := r.Cookie("family_session"); err == nil {
		id = cookie.Value
	}
	var session tripstore.Session
	var result c.SessionResponse
	err := a.store.Update(func(s *tripstore.State) error {
		session = s.Sessions[id]
		_, userExists := s.Accounts[session.UserID]
		if session.CSRF == "" || !session.ExpiresAt.After(a.now()) || session.UserID != "" && !userExists {
			id = newID()
			session = tripstore.Session{CSRF: newID(), ExpiresAt: a.now().Add(24 * time.Hour)}
			s.Sessions[id] = session
		}
		result = sessionView(*s, session)
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	setSessionCookie(w, r, id, session)
	writeJSON(w, 200, result)
}
func (a *tripAPI) owner(r *http.Request, mutating bool) (string, error) {
	cookie, err := r.Cookie("family_session")
	if err != nil {
		return "", failure(401, "SESSION_REQUIRED", "Получите гостевую сессию.")
	}
	var session tripstore.Session
	if err := a.store.Read(func(s tripstore.State) error {
		session = s.Sessions[cookie.Value]
		if session.UserID != "" {
			if _, ok := s.Accounts[session.UserID]; !ok {
				return failure(401, "AUTH_REQUIRED", "Войдите в аккаунт.")
			}
		}
		return nil
	}); err != nil {
		return "", err
	}
	if session.CSRF == "" || !session.ExpiresAt.After(a.now()) {
		return "", failure(401, "SESSION_REQUIRED", "Сессия истекла.")
	}
	if mutating {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(session.CSRF)) != 1 {
			return "", failure(403, "CSRF_FAILED", "Некорректный CSRF-токен.")
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}
			if err != nil || u.Host != r.Host || u.Scheme != scheme || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
				return "", failure(403, "CSRF_FAILED", "Origin не соответствует backend.")
			}
		}
	}
	return principal(cookie.Value, session), nil
}
func (a *tripAPI) getTrip(w http.ResponseWriter, r *http.Request) {
	owner, err := a.owner(r, false)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var trip tripstore.Trip
	err = a.store.Read(func(s tripstore.State) error {
		var ok bool
		trip, ok = s.Trips[r.PathValue("trip_id")]
		if !ok || trip.Owner != owner {
			return failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
		}
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeJSON(w, 200, trip.View)
}
func (a *tripAPI) getPreview(w http.ResponseWriter, r *http.Request) {
	owner, err := a.owner(r, false)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var preview tripstore.Preview
	err = a.store.Read(func(s tripstore.State) error {
		var ok bool
		preview, ok = s.Previews[r.PathValue("preview_id")]
		if !ok || preview.Owner != owner || string(preview.View.TripID) != r.PathValue("trip_id") {
			return failure(404, "PREVIEW_NOT_FOUND", "Вариант не найден.")
		}
		expires, _ := time.Parse(time.RFC3339Nano, string(preview.View.ExpiresAt))
		if !expires.After(a.now()) {
			return failure(410, "PREVIEW_EXPIRED", "Вариант устарел.")
		}
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeJSON(w, 200, preview.View)
}
func strict(raw []byte, value any) error {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return failure(400, "INVALID_JSON", "Неверный JSON или неизвестные поля.")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return failure(400, "INVALID_JSON", "Ожидается один JSON-объект.")
	}
	return nil
}
func (a *tripAPI) post(w http.ResponseWriter, r *http.Request) {
	owner, err := a.owner(r, true)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		a.respondError(w, r, failure(415, "UNSUPPORTED_MEDIA_TYPE", "Используйте application/json."))
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256*1024))
	if err != nil {
		a.respondError(w, r, failure(400, "INVALID_JSON", "Запрос превышает допустимый размер."))
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if len(key) > 200 {
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Слишком длинный Idempotency-Key."))
		return
	}
	isProgress := strings.HasSuffix(r.URL.Path, "/progress")
	optional := r.PathValue("trip_id") != "" && r.PathValue("preview_id") == "" && !isProgress
	if key == "" && !optional {
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Нужен Idempotency-Key."))
		return
	}
	receiptKey := owner + "|POST|" + r.URL.Path + "|" + key
	hash := fmtHash(raw)
	var replay *tripReply
	if key != "" {
		err = a.store.Read(func(s tripstore.State) error {
			if saved, ok := s.Receipts[receiptKey]; ok && saved.ExpiresAt.After(a.now()) {
				if saved.Hash != hash {
					return failure(409, "IDEMPOTENCY_CONFLICT", "Этот ключ использован с другим телом.")
				}
				replay = &tripReply{saved.Status, saved.Body, saved.Location}
			}
			return nil
		})
		if err != nil {
			a.respondError(w, r, err)
			return
		}
		if replay != nil {
			sendReply(w, *replay)
			return
		}
	}
	var prepared *c.PlanPreview
	var create c.TripInput
	profileVersion := 0
	var apply c.ApplyRequest
	var progress c.ProgressRequest
	if r.PathValue("trip_id") == "" {
		if r.URL.Path == "/api/v1/trips/from-profile" {
			create, profileVersion, err = a.inputFromProfile(r, raw)
		} else if err = strict(raw, &create); err == nil {
			err = planner.Validate(create)
		}
	} else if isProgress {
		err = strict(raw, &progress)
	} else if r.PathValue("preview_id") == "" {
		prepared, err = a.prepare(r, owner, raw)
	} else {
		err = strict(raw, &apply)
	}
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var reply tripReply
	err = a.store.Update(func(s *tripstore.State) error {
		if _, err := a.liveSession(s, r, owner); err != nil {
			return err
		}
		if key != "" {
			if saved, ok := s.Receipts[receiptKey]; ok && saved.ExpiresAt.After(a.now()) {
				if saved.Hash != hash {
					return failure(409, "IDEMPOTENCY_CONFLICT", "Ключ использован с другим телом.")
				}
				reply = tripReply{saved.Status, saved.Body, saved.Location}
				return nil
			}
		}
		var err error
		switch {
		case r.PathValue("trip_id") == "":
			if profileVersion > 0 && s.FamilyProfiles[accountID(owner)].Version != profileVersion {
				return conflict(s.FamilyProfiles[accountID(owner)].Version)
			}
			id := newID()
			view := a.planner.Draft(c.ID(id), create, a.now())
			s.Trips[id] = tripstore.Trip{Owner: owner, View: view}
			reply, err = jsonReply(201, view, "/api/v1/trips/"+id)
		case isProgress:
			trip, ok := s.Trips[r.PathValue("trip_id")]
			if !ok || trip.Owner != owner {
				return failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
			}
			if trip.View.Version != progress.ExpectedVersion {
				return conflict(trip.View.Version)
			}
			updated, updateErr := planner.RecordProgress(trip.View, progress, a.now())
			if updateErr != nil {
				return updateErr
			}
			trip.View = updated
			s.Trips[r.PathValue("trip_id")] = trip
			reply, err = jsonReply(200, updated, "")
		case prepared != nil:
			trip, ok := s.Trips[r.PathValue("trip_id")]
			if !ok || trip.Owner != owner {
				return failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
			}
			if trip.View.Version != prepared.BaseVersion {
				return conflict(trip.View.Version)
			}
			s.Previews[string(prepared.PreviewID)] = tripstore.Preview{Owner: owner, View: *prepared}
			reply, err = jsonReply(201, *prepared, "/api/v1/trips/"+r.PathValue("trip_id")+"/previews/"+string(prepared.PreviewID))
		default:
			reply, err = a.apply(s, r, owner, apply)
		}
		if err != nil {
			return err
		}
		if key != "" {
			s.Receipts[receiptKey] = tripstore.Receipt{Hash: hash, Status: reply.status, Body: reply.body, Location: reply.location, ExpiresAt: a.now().Add(24 * time.Hour)}
		}
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	sendReply(w, reply)
}
func fmtHash(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func sendReply(w http.ResponseWriter, reply tripReply) {
	if reply.location != "" {
		w.Header().Set("Location", reply.location)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(reply.status)
	_, _ = w.Write(reply.body)
}
func (a *tripAPI) prepare(r *http.Request, owner string, raw []byte) (*c.PlanPreview, error) {
	var request c.PreviewRequest
	if err := strict(raw, &request); err != nil {
		return nil, err
	}
	var command planner.ChangeCommand
	if err := strict(request.Command, &command); err != nil {
		return nil, err
	}
	if err := command.Validate(); err != nil {
		return nil, err
	}
	var view c.TripView
	err := a.store.Read(func(s tripstore.State) error {
		trip, ok := s.Trips[r.PathValue("trip_id")]
		if !ok || trip.Owner != owner {
			return failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
		}
		if trip.View.Version != request.ExpectedVersion {
			return conflict(trip.View.Version)
		}
		view = trip.View
		return nil
	})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var proposed c.TripView
	if command.Kind == "generate_plan" {
		if request.CurrentPosition != nil || request.ObservedAt != nil {
			return nil, failure(422, "INVALID_COMMAND", "Для продолжения используйте replan_day.")
		}
		proposed, err = a.planner.Build(ctx, view, a.now())
	} else {
		proposed, err = a.planner.Change(ctx, view, command, request.CurrentPosition, request.ObservedAt, a.now())
	}
	if err != nil {
		return nil, err
	}
	preview := &c.PlanPreview{PreviewID: c.ID(newID()), TripID: view.TripID, BaseVersion: view.Version, CatalogVersion: view.CatalogVersion, CreatedAt: c.Instant(a.now().Format(time.RFC3339Nano)), ExpiresAt: c.Instant(a.now().Add(10 * time.Minute).Format(time.RFC3339Nano)), CanApply: true, RequiredAcknowledgementCodes: []string{}, ProposedTrip: proposed, Warnings: proposed.Warnings}
	if command.Date != nil {
		for _, day := range proposed.Days {
			if day.Date == *command.Date && day.Execution != nil {
				at, _ := time.Parse(time.RFC3339Nano, string(day.Execution.ObservedAt))
				preview.ExpiresAt = c.Instant(at.Add(planner.ActivePreviewLifetime).Format(time.RFC3339Nano))
			}
		}
	}
	stopCount := 0
	for _, day := range proposed.Days {
		if day.Feasibility == "infeasible" {
			preview.CanApply = false
		}
		stopCount += len(day.Stops)
	}
	if stopCount == 0 && command.Kind == "generate_plan" {
		preview.CanApply = false
	}
	for _, warning := range proposed.Warnings {
		critical := slices.Contains([]string{"DEMO_CATALOG", "SNAPPED_ENDPOINTS", "OPENING_HOURS_UNKNOWN", "ELIGIBILITY_UNKNOWN", "BOOKING_UNKNOWN", "START_TIME_UNKNOWN"}, warning.Code)
		if critical && !slices.Contains(preview.RequiredAcknowledgementCodes, warning.Code) {
			preview.RequiredAcknowledgementCodes = append(preview.RequiredAcknowledgementCodes, warning.Code)
		}
	}
	preview.Diff.AddedStopIDS = []c.ID{}
	preview.Diff.RemovedStopIDS = []c.ID{}
	preview.Diff.MovedStopIDS = []c.ID{}
	preview.Diff.ChangedDates = []c.ISODate{}
	for _, day := range proposed.Days {
		if command.Date == nil || day.Date == *command.Date {
			preview.Diff.ChangedDates = append(preview.Diff.ChangedDates, day.Date)
		}
	}
	preview.Diff.Explanations = []string{"Backend пересчитал план и проверил бюджет и реальные OSM-переходы."}
	if command.Kind != "generate_plan" {
		preview.Diff.Explanations = []string{"Подтверждённая история сохранена; пересчитана оставшаяся часть выбранного дня."}
	}
	old := map[c.ID]bool{}
	oldPositions := map[c.ID]string{}
	for _, day := range view.Days {
		for i, stop := range day.Stops {
			old[stop.StopID] = true
			oldPositions[stop.StopID] = string(day.Date) + "/" + string(stop.ActivityID)
			if i > 0 {
				oldPositions[stop.StopID] += "/" + string(day.Stops[i-1].StopID)
			}
		}
	}
	newStops := map[c.ID]bool{}
	for _, day := range proposed.Days {
		for i, stop := range day.Stops {
			newStops[stop.StopID] = true
			if !old[stop.StopID] {
				preview.Diff.AddedStopIDS = append(preview.Diff.AddedStopIDS, stop.StopID)
			} else {
				position := string(day.Date) + "/" + string(stop.ActivityID)
				if i > 0 {
					position += "/" + string(day.Stops[i-1].StopID)
				}
				if oldPositions[stop.StopID] != position {
					preview.Diff.MovedStopIDS = append(preview.Diff.MovedStopIDS, stop.StopID)
				}
			}
		}
	}
	for id := range old {
		if !newStops[id] {
			preview.Diff.RemovedStopIDS = append(preview.Diff.RemovedStopIDS, id)
		}
	}
	slices.Sort(preview.Diff.RemovedStopIDS)
	if command.Date != nil {
		for _, day := range proposed.Days {
			if day.Date != *command.Date {
				continue
			}
			for _, oldDay := range view.Days {
				if oldDay.Date == day.Date {
					if day.Totals.WalkDurationSec != nil && oldDay.Totals.WalkDurationSec != nil {
						delta := *day.Totals.WalkDurationSec - *oldDay.Totals.WalkDurationSec
						preview.Diff.WalkDeltaSec = &delta
					}
					if day.Totals.ElapsedDurationSec != nil && oldDay.Totals.ElapsedDurationSec != nil {
						delta := *day.Totals.ElapsedDurationSec - *oldDay.Totals.ElapsedDurationSec
						preview.Diff.ElapsedDeltaSec = &delta
					}
				}
			}
		}
	}
	return preview, nil
}
func (a *tripAPI) apply(s *tripstore.State, r *http.Request, owner string, request c.ApplyRequest) (tripReply, error) {
	trip, ok := s.Trips[r.PathValue("trip_id")]
	if !ok || trip.Owner != owner {
		return tripReply{}, failure(404, "TRIP_NOT_FOUND", "Поездка не найдена.")
	}
	preview, ok := s.Previews[r.PathValue("preview_id")]
	if !ok || preview.Owner != owner || preview.View.TripID != trip.View.TripID {
		return tripReply{}, failure(404, "PREVIEW_NOT_FOUND", "Вариант не найден.")
	}
	if request.ExpectedVersion != trip.View.Version || preview.View.BaseVersion != trip.View.Version {
		return tripReply{}, conflict(trip.View.Version)
	}
	expires, _ := time.Parse(time.RFC3339Nano, string(preview.View.ExpiresAt))
	if !expires.After(a.now()) {
		return tripReply{}, failure(410, "PREVIEW_EXPIRED", "Рассчитайте новый вариант.")
	}
	if preview.Applied || preview.View.CatalogVersion != trip.View.CatalogVersion {
		return tripReply{}, failure(409, "PREVIEW_STALE", "Вариант больше не актуален.")
	}
	if !preview.View.CanApply {
		return tripReply{}, failure(422, "PREVIEW_NOT_APPLICABLE", "Известные ограничения нарушены.")
	}
	for _, code := range preview.View.RequiredAcknowledgementCodes {
		if !slices.Contains(request.AcknowledgedWarningCodes, code) {
			return tripReply{}, failure(422, "ACKNOWLEDGEMENT_REQUIRED", "Подтвердите предупреждения о тестовых данных и подходах к сети.")
		}
	}
	for _, day := range preview.View.ProposedTrip.Days {
		if !slices.Contains(preview.View.Diff.ChangedDates, day.Date) {
			continue
		}
		if day.Execution != nil {
			for _, input := range preview.View.ProposedTrip.Input.Days {
				if input.Date == day.Date && !planner.ActivePreviewFresh(day, input, a.now()) {
					return tripReply{}, failure(409, "PREVIEW_STALE", "Время подтверждения изменило выполнимость дня; рассчитайте новый вариант.")
				}
			}
			continue
		}
		for _, stop := range day.Stops {
			if stop.Progress != "planned" {
				continue
			}
			if day.Presentation == "clock" && stop.Timing.EstimatedArrivalAt != nil {
				arrival, _ := time.Parse(time.RFC3339, string(*stop.Timing.EstimatedArrivalAt))
				if arrival.Before(a.now()) {
					return tripReply{}, failure(409, "PREVIEW_STALE", "Расчётное время первого посещения уже прошло.")
				}
			}
			break
		}
	}
	trip.View = preview.View.ProposedTrip
	trip.View.UpdatedAt = c.Instant(a.now().Format(time.RFC3339Nano))
	s.Trips[r.PathValue("trip_id")] = trip
	preview.Applied = true
	s.Previews[r.PathValue("preview_id")] = preview
	return jsonReply(200, trip.View, "")
}
