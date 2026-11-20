package httpapi

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

type fakeRouter struct {
	calls int
	err   error
}

func (f *fakeRouter) Route(context.Context, routing.Request) (routing.Result, error) {
	f.calls++
	return routing.Result{}, f.err
}
func (f *fakeRouter) Ready(context.Context) error { return f.err }
func TestHTTPAuthStrictJSONAndFailureStatus(t *testing.T) {
	tests := []struct {
		name, token, body string
		err               error
		status, calls     int
	}{
		{"unauthenticated", "", `{}`, nil, 401, 0},
		{"unknown field", "secret", `{"mode":"walk","surprise":true}`, nil, 400, 0},
		{"two bodies", "secret", `{} {}`, nil, 400, 0},
		{"invalid input", "secret", `{}`, routing.ErrInvalidInput, 422, 1},
		{"no route", "secret", `{}`, routing.ErrNoRoute, 422, 1},
		{"unavailable", "secret", `{}`, routing.ErrUnavailable, 503, 1},
		{"malformed response", "secret", `{}`, errors.New("bad upstream"), 502, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			router := &fakeRouter{err: tc.err}
			handler := Handler(router, "secret")
			req := httptest.NewRequest("POST", "/internal/v1/routing/route", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != tc.status || router.calls != tc.calls {
				t.Fatalf("status %d calls %d", recorder.Code, router.calls)
			}
			if recorder.Header().Get("X-Request-ID") == "" || !strings.Contains(recorder.Body.String(), `"request_id"`) {
				t.Fatal("missing error correlation")
			}
		})
	}
}
