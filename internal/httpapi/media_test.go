package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestMediaHandler(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "ab", "cd"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"ab/cd/x_card.webp": "webp", "manifest.json": "{}", "secret.txt": "no", "ab/cd/note.txt": "no"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := MediaHandler(dir)
	get := func(method, path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
		return w
	}
	if w := get("GET", "/media/ab/cd/x_card.webp"); w.Code != 200 || w.Body.String() != "webp" || w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("webp: %d %q %v", w.Code, w.Body.String(), w.Header())
	}
	if w := get("GET", "/media/manifest.json"); w.Code != 200 || w.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("manifest: %d %v", w.Code, w.Header())
	}
	for _, path := range []string{"/media/secret.txt", "/media/ab/cd/note.txt", "/media/", "/media/ab/", "/media/../go.mod", "/media/ab/cd/missing.webp"} {
		if w := get("GET", path); w.Code != http.StatusNotFound && w.Code != http.StatusMovedPermanently {
			t.Errorf("%s: ожидалось 404, получено %d", path, w.Code)
		}
	}
	if w := get("POST", "/media/ab/cd/x_card.webp"); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", w.Code)
	}
}
