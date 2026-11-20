package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

type Router interface {
	Route(context.Context, routing.Request) (routing.Result, error)
	Ready(context.Context) error
}

func Handler(router Router, token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "alive"}) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := router.Ready(ctx); err != nil {
			apiError(w, r, 503, "ROUTING_UNAVAILABLE", "Граф маршрутов ещё не готов.", true)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
	mux.HandleFunc("POST /internal/v1/routing/route", func(w http.ResponseWriter, r *http.Request) {
		if token != "" {
			provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
				apiError(w, r, 401, "SERVICE_AUTH_REQUIRED", "Нужен сервисный токен.", false)
				return
			}
		}
		if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
			apiError(w, r, 415, "UNSUPPORTED_MEDIA_TYPE", "Используйте application/json.", false)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var input routing.Request
		if err := decoder.Decode(&input); err != nil {
			apiError(w, r, 400, "INVALID_JSON", "Неверный формат запроса маршрута.", false)
			return
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			apiError(w, r, 400, "INVALID_JSON", "Ожидается один JSON-объект.", false)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		result, err := router.Route(ctx, input)
		if err != nil {
			switch {
			case errors.Is(err, routing.ErrInvalidInput):
				apiError(w, r, 422, "VALIDATION_ERROR", err.Error(), false)
			case errors.Is(err, routing.ErrNoRoute):
				apiError(w, r, 422, "NO_ROUTE", "Нет пути или подходящей точки сети в пределах 100 метров.", false)
			case errors.Is(err, routing.ErrUnavailable):
				apiError(w, r, 503, "ROUTING_UNAVAILABLE", "Движок маршрутизации недоступен.", true)
			default:
				apiError(w, r, 502, "ROUTING_CONTRACT_ERROR", "Некорректный ответ движка маршрутизации.", false)
			}
			return
		}
		writeJSON(w, 200, result)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var random [16]byte
		_, _ = rand.Read(random[:])
		id := hex.EncodeToString(random[:])
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func apiError(w http.ResponseWriter, r *http.Request, status int, code, message string, retry bool) {
	if retry {
		w.Header().Set("Retry-After", "5")
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "request_id": w.Header().Get("X-Request-ID"), "retryable": retry, "current_version": nil, "details": []any{}}})
}
