package httpapi

import (
	"net/http"
	"os"
	"strings"
)

// MediaHandler раздаёт картинки карточек из каталога dir по префиксу /media/.
// Имена файлов содержат sha256 содержимого, поэтому *.webp не меняются и кэшируются навсегда.
// Отдаются только .webp и manifest.json; список каталогов закрыт.
func MediaHandler(dir string) http.Handler {
	files := http.StripPrefix("/media/", http.FileServer(mediaFS{http.Dir(dir)}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasSuffix(r.URL.Path, ".webp") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

type mediaFS struct{ fs http.FileSystem }

func (m mediaFS) Open(name string) (http.File, error) {
	if !strings.HasSuffix(name, ".webp") && name != "/manifest.json" {
		return nil, os.ErrNotExist
	}
	return m.fs.Open(name)
}
