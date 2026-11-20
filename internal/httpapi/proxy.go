package httpapi

import (
	"crypto/tls"
	"net/http"
)

// TrustedProxyHTTPS is opt-in for an unpublished backend behind our nginx.
// nginx overwrites X-Forwarded-Proto on both its HTTP and HTTPS ingress ports.
// Never enable this wrapper on a backend directly reachable by clients.
func TrustedProxyHTTPS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") == "https" {
			r = r.Clone(r.Context())
			r.TLS = &tls.ConnectionState{}
		}
		next.ServeHTTP(w, r)
	})
}
