package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/mapdata"
)

// Public, read-only catalog search. No family data is exposed, no session is needed.
func MapHandler(db mapdata.Repository) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-ID", newID())
		w.Header().Set("Cache-Control", "no-store")
		api := &tripAPI{}
		if r.Method != "GET" {
			w.Header().Set("Allow", "GET")
			api.respondError(w, r, failure(405, "METHOD_NOT_ALLOWED", "Используйте GET."))
			return
		}
		q, err := mapdata.Parse(r.URL.Query())
		if err != nil {
			api.respondError(w, r, failure(422, "VALIDATION_ERROR", err.Error()))
			return
		}
		if db == nil {
			api.respondError(w, r, failure(503, "CATALOG_UNAVAILABLE", "База каталога не подключена."))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		result, err := db.Search(ctx, q)
		if err != nil {
			api.respondError(w, r, failure(503, "CATALOG_UNAVAILABLE", "Каталог временно недоступен."))
			return
		}
		writeJSON(w, 200, result)
	})
}
