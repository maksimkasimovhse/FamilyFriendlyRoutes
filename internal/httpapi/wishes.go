package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"unicode/utf8"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/wishes"
)

const maxWishChars = 1500

// WishesHandler — POST /api/v1/wishes/recommendations: свободный текст → подобранные карточки (ИИ-чат).
// Ничего не сохраняет, поэтому без сессии; размер тела ограничен.
func WishesHandler(rec *wishes.Recommender) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var in wishes.Request
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "BAD_REQUEST", "message": "Некорректный запрос"}})
			return
		}
		if n := utf8.RuneCountInString(in.Text); n == 0 || n > maxWishChars {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]string{"code": "BAD_TEXT", "message": "Напишите пожелание (до 1500 знаков)"}})
			return
		}
		id := make([]byte, 8)
		_, _ = rand.Read(id)
		writeJSON(w, http.StatusOK, rec.Recommend(r.Context(), hex.EncodeToString(id), in))
	})
}
