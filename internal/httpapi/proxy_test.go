package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

func TestTrustedProxyHTTPSPreservesHostAndSecureCookie(t *testing.T) {
	for _, proto := range []string{"https", "http", "", "https,http"} {
		t.Run(proto, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://phone.test:8443/api/v1/session", nil)
			r.Header.Set("X-Forwarded-Proto", proto)
			w := httptest.NewRecorder()
			TrustedProxyHTTPS(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.Host != "phone.test:8443" {
					t.Fatal("proxy changed original host")
				}
				setSessionCookie(w, request, "test", tripstore.Session{ExpiresAt: time.Now().Add(time.Hour)})
			})).ServeHTTP(w, r)
			if cookies := w.Result().Cookies(); len(cookies) != 1 || cookies[0].Secure != (proto == "https") {
				t.Fatal("incorrect Secure flag for forwarded protocol")
			}
			if r.TLS != nil {
				t.Fatal("middleware mutated the original request")
			}
		})
	}
}
