package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/password"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

const testPassword = "family password 12345"

func authRequest(t *testing.T, h http.Handler, b browser, action, email, pw string, want int) (browser, c.SessionResponse) {
	t.Helper()
	w := request(h, b, "POST", "/api/v1/auth/"+action, body(t, c.AuthCredentials{Email: email, Password: pw}), "")
	if w.Code != want {
		t.Fatalf("%s want %d got %d: %s", action, want, w.Code, w.Body.String())
	}
	var result c.SessionResponse
	if want == 200 || want == 201 {
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		cookies := w.Result().Cookies()
		if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Value == b.cookie.Value || result.CSRFToken == b.csrf {
			t.Fatal("session was not safely rotated")
		}
		b = browser{cookies[0], result.CSRFToken}
	}
	return b, result
}
func testProfile(t *testing.T, h *activeHarness) c.FamilyOnboardingInput {
	t.Helper()
	view := h.read(t)
	return c.FamilyOnboardingInput{ExpectedVersion: 0, Family: view.Input.Family, LoadLimits: view.Input.LoadLimits}
}
func saveProfile(t *testing.T, h *activeHarness, input c.FamilyOnboardingInput, want int) c.FamilyOnboardingView {
	t.Helper()
	w := request(h.handler, h.browser, "PUT", "/api/v1/profile/family", body(t, input), "")
	if w.Code != want {
		t.Fatalf("profile want %d got %d: %s", want, w.Code, w.Body.String())
	}
	var out c.FamilyOnboardingView
	if want == 200 || want == 201 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
	}
	return out
}
func TestAccountLifecycleGuestAdoptionAndRestart(t *testing.T) {
	h := newActiveHarness(t)
	guest := h.browser
	profile := testProfile(t, h)
	b, result := authRequest(t, h.handler, guest, "register", "  FAMILY@EXAMPLE.COM  ", testPassword, 201)
	h.browser = b
	if !result.Authenticated || result.OnboardingCompleted || result.User == nil || result.User.Email != "family@example.com" {
		t.Fatal("incorrect account response")
	}
	if w := request(h.handler, guest, "GET", h.path, "", ""); w.Code != 401 {
		t.Fatal("old guest session still active")
	}
	if h.read(t).TripID == "" {
		t.Fatal("guest trip lost")
	}
	if w := request(h.handler, b, "GET", "/api/v1/profile/family", "", ""); w.Code != 404 {
		t.Fatal("empty onboarding should be 404")
	}
	saved := saveProfile(t, h, profile, 201)
	if saved.Version != 1 {
		t.Fatal("initial profile version")
	}
	if w := request(h.handler, b, "GET", "/api/v1/auth/me", "", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"onboarding_completed":true`) || strings.Contains(w.Body.String(), "password") {
		t.Fatal(w.Body.String())
	}
	stateRaw, err := os.ReadFile(h.filename)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stateRaw), testPassword) {
		t.Fatal("plaintext password persisted")
	}
	if err := h.store.Read(func(s tripstore.State) error {
		if len(s.Accounts) != 1 {
			t.Fatal("account missing")
		}
		for _, u := range s.Accounts {
			if !password.Verify(u.PasswordHash, testPassword) {
				t.Fatal("invalid stored hash")
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	logout := request(h.handler, b, "POST", "/api/v1/auth/logout", "", "")
	if logout.Code != 200 {
		t.Fatal(logout.Body.String())
	}
	var loggedOut c.SessionResponse
	_ = json.Unmarshal(logout.Body.Bytes(), &loggedOut)
	if loggedOut.Authenticated || loggedOut.User != nil || loggedOut.OnboardingCompleted {
		t.Fatal("logout exposed account")
	}
	newGuest := browser{logout.Result().Cookies()[0], loggedOut.CSRFToken}
	if w := request(h.handler, b, "GET", h.path, "", ""); w.Code != 401 {
		t.Fatal("logged out session still active")
	}
	if w := request(h.handler, newGuest, "GET", h.path, "", ""); w.Code != 404 {
		t.Fatal("account trip leaked to logout guest")
	}
	h.store, err = tripstore.Open(h.filename)
	if err != nil {
		t.Fatal(err)
	}
	h.handler = tripHandler(h.store, planner.Planner{Router: h.router, Activities: planner.DemoActivities()}, func() time.Time { return h.now })
	_, _ = authRequest(t, h.handler, newGuest, "login", "family@example.com", "incorrect password 123", 401)
	_, _ = authRequest(t, h.handler, newGuest, "login", "missing@example.com", "incorrect password 123", 401)
	h.browser, result = authRequest(t, h.handler, newGuest, "login", "family@example.com", testPassword, 200)
	if !result.OnboardingCompleted {
		t.Fatal("profile not restored after restart")
	}
	h.read(t)
	if w := request(h.handler, h.browser, "GET", "/api/v1/trips", "", ""); w.Code != 200 || !strings.Contains(w.Body.String(), string(h.read(t).TripID)) {
		t.Fatal("trip list missing own trip")
	}
	other, _ := authRequest(t, h.handler, bootstrap(t, h.handler), "register", "other@example.com", testPassword, 201)
	for _, path := range []string{h.path, h.path + "/previews/" + "unknown"} {
		if w := request(h.handler, other, "GET", path, "", ""); w.Code != 404 {
			t.Fatalf("other account accessed %s: %s", path, w.Body.String())
		}
	}
	if w := request(h.handler, other, "GET", "/api/v1/profile/family", "", ""); w.Code != 404 {
		t.Fatal("another family's profile leaked")
	}
}

func TestProfileValidationVersionAndTripSnapshot(t *testing.T) {
	h := newActiveHarness(t)
	input := testProfile(t, h)
	h.browser, _ = authRequest(t, h.handler, h.browser, "register", "snapshot@example.com", testPassword, 201)
	var tripInput c.TripInput
	data, err := os.ReadFile("../../examples/trip-one-day.json")
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(data, &tripInput)
	create := c.TripFromProfileRequest{ExpectedProfileVersion: 1, CityID: tripInput.CityID, Timezone: tripInput.Timezone, PlanningContext: tripInput.PlanningContext, Days: tripInput.Days, Selections: tripInput.Selections}
	if w := request(h.handler, h.browser, "POST", "/api/v1/trips/from-profile", body(t, create), "profile-create"); w.Code != 422 {
		t.Fatal("created trip without onboarding")
	}
	bad := input
	bad.Family.Children = append(bad.Family.Children[:0:0], input.Family.Children...)
	bad.Family.Children[0].AgeYears = 2
	saveProfile(t, h, bad, 422)
	bad = input
	negative := -1.0
	bad.LoadLimits.RestaurantWalkReserveMPerDay = &negative
	saveProfile(t, h, bad, 422)
	wishes := "Любим интерактивные музеи"
	input.Wishes = &wishes
	profile := saveProfile(t, h, input, 201)
	saveProfile(t, h, input, 409)
	create.ExpectedProfileVersion = 2
	if w := request(h.handler, h.browser, "POST", "/api/v1/trips/from-profile", body(t, create), "profile-create"); w.Code != 409 {
		t.Fatal("stale profile version accepted")
	}
	create.ExpectedProfileVersion = 1
	w := request(h.handler, h.browser, "POST", "/api/v1/trips/from-profile", body(t, create), "profile-create")
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var trip c.TripView
	_ = json.Unmarshal(w.Body.Bytes(), &trip)
	if trip.Input.Family.Children[0].AgeYears != profile.Family.Children[0].AgeYears || trip.Input.RequestText == nil || *trip.Input.RequestText != wishes {
		t.Fatal("profile not applied to trip")
	}
	input.ExpectedVersion = 1
	input.Family.Children[0].AgeYears = 11
	saveProfile(t, h, input, 200)
	w2 := request(h.handler, h.browser, "POST", "/api/v1/trips/from-profile", body(t, create), "profile-create")
	if w2.Code != 201 || w2.Body.String() != w.Body.String() {
		t.Fatal("idempotency replay changed after profile update")
	}
	view := request(h.handler, h.browser, "GET", "/api/v1/trips/"+string(trip.TripID), "", "")
	if view.Body.String() != strings.TrimSpace(w.Body.String()) && strings.TrimSpace(view.Body.String()) != strings.TrimSpace(w.Body.String()) {
		t.Fatal("saved trip changed after profile update")
	}
	create.ExpectedProfileVersion = 2
	empty := ""
	create.RequestText = &empty
	if w := request(h.handler, h.browser, "POST", "/api/v1/trips/from-profile", body(t, create), "profile-create-2"); w.Code != 201 || !strings.Contains(w.Body.String(), `"request_text":""`) {
		t.Fatal("explicit trip wishes not respected")
	}
}

func TestAuthenticationCSRFValidationAndThrottle(t *testing.T) {
	h := newActiveHarness(t)
	credentials := body(t, c.AuthCredentials{Email: "csrf@example.com", Password: testPassword})
	for _, b := range []browser{{}, {cookie: h.browser.cookie, csrf: "wrong"}} {
		w := request(h.handler, b, "POST", "/api/v1/auth/register", credentials, "")
		if w.Code != 401 && w.Code != 403 {
			t.Fatal("auth accepted missing session/CSRF")
		}
	}
	r := httptest.NewRequest("POST", "/api/v1/auth/register", strings.NewReader(credentials))
	r.AddCookie(h.browser.cookie)
	r.Header.Set("X-CSRF-Token", h.browser.csrf)
	r.Header.Set("Origin", "https://evil.example")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin auth accepted")
	}
	for _, raw := range []string{`null`, `{"email":"x@example.com","password":"short"}`, `{"email":"X <x@example.com>","password":"family password 12345"}`, `{"email":"x@example.com","password":"family password 12345","user_id":"admin"}`} {
		w := request(h.handler, h.browser, "POST", "/api/v1/auth/register", raw, "")
		if w.Code != 400 && w.Code != 422 {
			t.Fatalf("invalid request accepted: %s", w.Body.String())
		}
	}
	if w := request(h.handler, h.browser, "GET", "/api/v1/auth/me", "", ""); w.Code != 401 {
		t.Fatal("guest appears authenticated")
	}
	if w := request(h.handler, h.browser, "PUT", "/api/v1/profile/family", `{}`, ""); w.Code != 401 {
		t.Fatal("guest saved family profile")
	}
	h.browser, _ = authRequest(t, h.handler, h.browser, "register", "csrf@example.com", testPassword, 201)
	_, _ = authRequest(t, h.handler, h.browser, "login", "csrf@example.com", testPassword, 409)
	guest := bootstrap(t, h.handler)
	_, _ = authRequest(t, h.handler, guest, "register", "CSRF@example.com", testPassword, 409)
	guard := newAuthGuard()
	for i := 0; i < 10; i++ {
		if !guard.allow("email:x", 10, h.now) {
			t.Fatal("early throttling")
		}
	}
	if guard.allow("email:x", 10, h.now) || !guard.allow("email:x", 10, h.now.Add(16*time.Minute)) {
		t.Fatal("throttle window incorrect")
	}
	// HTTP throttle short-circuits KDF work; spoofed X-Forwarded-For is ignored.
	for i := 0; i < 31; i++ {
		r := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(body(t, c.AuthCredentials{Email: "nobody@example.com", Password: testPassword})))
		r.AddCookie(guest.cookie)
		r.Header.Set("X-CSRF-Token", guest.csrf)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", string(rune('a'+i)))
		w := httptest.NewRecorder()
		h.handler.ServeHTTP(w, r)
		if i >= 10 && (w.Code != 429 || w.Header().Get("Retry-After") == "") {
			t.Fatal("login not throttled")
		}
	}
}

func TestGuestIdempotencyAndPreviewSurviveLogin(t *testing.T) {
	h := newActiveHarness(t)
	fixture, err := os.ReadFile("../../examples/trip-one-day.json")
	if err != nil {
		t.Fatal(err)
	}
	before := request(h.handler, h.browser, "POST", "/api/v1/trips", string(fixture), "guest-create")
	if before.Code != 201 {
		t.Fatal(before.Body.String())
	}
	trip := h.read(t)
	p := h.preview(t, trip, map[string]any{"kind": "replan_day", "date": trip.Days[0].Date}, 201)
	h.browser, _ = authRequest(t, h.handler, h.browser, "register", "preview@example.com", testPassword, 201)
	after := request(h.handler, h.browser, "POST", "/api/v1/trips", string(fixture), "guest-create")
	if after.Code != 201 || before.Body.String() != after.Body.String() {
		t.Fatal("guest idempotency receipt not adopted")
	}
	h.apply(t, p, 200, "adopted-preview")
	if w := request(h.handler, h.browser, "GET", h.path+"/previews/"+string(p.PreviewID), "", ""); w.Code != 200 {
		t.Fatal("guest preview not adopted")
	}
}

func TestExpiredAccountSessionAndProfileCSRF(t *testing.T) {
	h := newActiveHarness(t)
	profile := testProfile(t, h)
	h.browser, _ = authRequest(t, h.handler, h.browser, "register", "expiry@example.com", testPassword, 201)
	bad := h.browser
	bad.csrf = "wrong"
	if w := request(h.handler, bad, "PUT", "/api/v1/profile/family", body(t, profile), ""); w.Code != 403 {
		t.Fatal("profile write accepted wrong CSRF")
	}
	if w := request(h.handler, bad, "POST", "/api/v1/auth/logout", "", ""); w.Code != 403 {
		t.Fatal("logout accepted wrong CSRF")
	}
	previous := h.browser
	h.now = h.now.Add(25 * time.Hour)
	if w := request(h.handler, previous, "GET", h.path, "", ""); w.Code != 401 {
		t.Fatal("expired account still has access")
	}
	guest := bootstrap(t, h.handler)
	if guest.cookie.Value == previous.cookie.Value {
		t.Fatal("expired session reused")
	}
	if w := request(h.handler, guest, "GET", h.path, "", ""); w.Code != 404 {
		t.Fatal("expired account exposed as guest")
	}
	h.browser, _ = authRequest(t, h.handler, guest, "login", "expiry@example.com", testPassword, 200)
	h.read(t)
}
