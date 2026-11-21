package httpapi

import (
	"io"
	"net"
	"net/http"
	"net/mail"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/password"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/planner"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/tripstore"
)

type authBucket struct {
	until time.Time
	count int
}
type authGuard struct {
	mu      sync.Mutex
	buckets map[string]authBucket
	work    chan struct{}
}

func newAuthGuard() *authGuard {
	return &authGuard{buckets: map[string]authBucket{}, work: make(chan struct{}, 2)}
}
func (g *authGuard) allow(key string, limit int, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	for k, b := range g.buckets {
		if !b.until.After(now) {
			delete(g.buckets, k)
		}
	}
	b := g.buckets[key]
	if b.until.IsZero() {
		if len(g.buckets) >= 10000 {
			return false
		}
		b.until = now.Add(15 * time.Minute)
	}
	if b.count >= limit {
		return false
	}
	b.count++
	g.buckets[key] = b
	return true
}
func principal(id string, session tripstore.Session) string {
	if session.UserID != "" {
		return "account:" + session.UserID
	}
	return id
}

// liveSession is also called inside write transactions to reject a session
// invalidated while hashing a password or calculating a route.
func (a *tripAPI) liveSession(s *tripstore.State, r *http.Request, owner string) (tripstore.Session, error) {
	cookie, err := r.Cookie("family_session")
	if err != nil {
		return tripstore.Session{}, failure(401, "SESSION_REQUIRED", "Получите сессию.")
	}
	session, ok := s.Sessions[cookie.Value]
	if !ok || session.CSRF == "" || !session.ExpiresAt.After(a.now()) || principal(cookie.Value, session) != owner {
		return tripstore.Session{}, failure(401, "SESSION_REQUIRED", "Сессия истекла.")
	}
	if session.UserID != "" {
		if _, ok := s.Accounts[session.UserID]; !ok {
			return tripstore.Session{}, failure(401, "AUTH_REQUIRED", "Войдите в аккаунт.")
		}
	}
	return session, nil
}
func (a *tripAPI) accountOwner(r *http.Request, mutate bool) (string, error) {
	owner, err := a.owner(r, mutate)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(owner, "account:") {
		return "", failure(401, "AUTH_REQUIRED", "Войдите в аккаунт.")
	}
	return owner, nil
}
func accountID(owner string) string { return strings.TrimPrefix(owner, "account:") }
func sessionView(s tripstore.State, session tripstore.Session) c.SessionResponse {
	v := c.SessionResponse{CSRFToken: session.CSRF}
	if user, ok := s.Accounts[session.UserID]; ok && session.UserID != "" {
		v.Authenticated = true
		v.User = &c.AuthUser{UserID: c.ID(user.UserID), Email: user.Email, CreatedAt: c.Instant(user.CreatedAt.Format(time.RFC3339Nano))}
		_, v.OnboardingCompleted = s.FamilyProfiles[user.UserID]
	}
	return v
}
func setSessionCookie(w http.ResponseWriter, r *http.Request, id string, session tripstore.Session) {
	http.SetCookie(w, &http.Cookie{Name: "family_session", Value: id, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: r.TLS != nil, Expires: session.ExpiresAt})
}
func readJSON(w http.ResponseWriter, r *http.Request, value any) error {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		return failure(415, "UNSUPPORTED_MEDIA_TYPE", "Используйте application/json.")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16*1024))
	if err != nil {
		return failure(400, "INVALID_JSON", "Запрос превышает допустимый размер.")
	}
	if strings.TrimSpace(string(raw)) == "null" {
		return failure(400, "INVALID_JSON", "Ожидается JSON-объект.")
	}
	return strict(raw, value)
}
func normalizedEmail(value string) (string, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	p, err := mail.ParseAddress(value)
	if err != nil || len(value) > 254 || p.Name != "" || p.Address != value {
		return "", false
	}
	pieces := strings.Split(value, "@")
	if len(pieces) != 2 || !strings.Contains(pieces[1], ".") {
		return "", false
	}
	return value, true
}
func (a *tripAPI) credentials(w http.ResponseWriter, r *http.Request) {
	owner, err := a.owner(r, true)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	if strings.HasPrefix(owner, "account:") {
		a.respondError(w, r, failure(409, "ALREADY_AUTHENTICATED", "Сначала выйдите из текущего аккаунта."))
		return
	}
	var input c.AuthCredentials
	if err := readJSON(w, r, &input); err != nil {
		a.respondError(w, r, err)
		return
	}
	email, ok := normalizedEmail(input.Email)
	if !ok || !password.Valid(input.Password) {
		a.respondError(w, r, failure(422, "VALIDATION_ERROR", "Укажите корректную почту и пароль длиной 15–128 символов (не только пробелы)."))
		return
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	register := strings.HasSuffix(r.URL.Path, "/register")
	limit := 30
	if register {
		limit = 10
	}
	if !a.auth.allow(r.URL.Path+":ip:"+ip, limit, a.now()) || !a.auth.allow(r.URL.Path+":email:"+email, 10, a.now()) {
		w.Header().Set("Retry-After", "900")
		a.respondError(w, r, failure(429, "RATE_LIMITED", "Слишком много попыток. Повторите позже."))
		return
	}
	select {
	case a.auth.work <- struct{}{}:
		defer func() { <-a.auth.work }()
	default:
		w.Header().Set("Retry-After", "2")
		a.respondError(w, r, failure(429, "RATE_LIMITED", "Повторите через несколько секунд."))
		return
	}
	var account tripstore.Account
	err = a.store.Read(func(s tripstore.State) error {
		for _, u := range s.Accounts {
			if u.Email == email {
				account = u
				break
			}
		}
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	if register {
		hash, err := password.Hash(input.Password)
		if err != nil {
			a.respondError(w, r, err)
			return
		}
		if account.UserID != "" {
			a.respondError(w, r, failure(409, "EMAIL_EXISTS", "Эта почта уже зарегистрирована."))
			return
		}
		account = tripstore.Account{UserID: newID(), Email: email, PasswordHash: hash, CreatedAt: a.now()}
	} else {
		hash := account.PasswordHash
		if account.UserID == "" {
			hash = password.Dummy
		}
		valid := password.Verify(hash, input.Password)
		if !valid || account.UserID == "" {
			a.respondError(w, r, failure(401, "INVALID_CREDENTIALS", "Неверная почта или пароль."))
			return
		}
	}
	id := newID()
	session := tripstore.Session{UserID: account.UserID, CSRF: newID(), ExpiresAt: a.now().Add(24 * time.Hour)}
	var result c.SessionResponse
	err = a.store.Update(func(s *tripstore.State) error {
		old, err := a.liveSession(s, r, owner)
		if err != nil {
			return err
		}
		if old.UserID != "" {
			return failure(409, "ALREADY_AUTHENTICATED", "Сначала выйдите из аккаунта.")
		}
		if register {
			for _, u := range s.Accounts {
				if u.Email == email {
					return failure(409, "EMAIL_EXISTS", "Эта почта уже зарегистрирована.")
				}
			}
			s.Accounts[account.UserID] = account
		}
		// Adopt only this guest's records, atomically with session rotation.
		newOwner := principal(id, session)
		for k, t := range s.Trips {
			if t.Owner == owner {
				t.Owner = newOwner
				s.Trips[k] = t
			}
		}
		for k, p := range s.Previews {
			if p.Owner == owner {
				p.Owner = newOwner
				s.Previews[k] = p
			}
		}
		for k, receipt := range s.Receipts {
			if strings.HasPrefix(k, owner+"|POST|") {
				next := newOwner + strings.TrimPrefix(k, owner)
				if _, exists := s.Receipts[next]; !exists {
					s.Receipts[next] = receipt
				}
				delete(s.Receipts, k)
			}
		}
		cookie, _ := r.Cookie("family_session")
		delete(s.Sessions, cookie.Value)
		s.Sessions[id] = session
		result = sessionView(*s, session)
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	setSessionCookie(w, r, id, session)
	status := 200
	if register {
		status = 201
	}
	writeJSON(w, status, result)
}
func (a *tripAPI) logout(w http.ResponseWriter, r *http.Request) {
	owner, err := a.owner(r, true)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	id := newID()
	session := tripstore.Session{CSRF: newID(), ExpiresAt: a.now().Add(24 * time.Hour)}
	err = a.store.Update(func(s *tripstore.State) error {
		if _, err := a.liveSession(s, r, owner); err != nil {
			return err
		}
		cookie, _ := r.Cookie("family_session")
		delete(s.Sessions, cookie.Value)
		s.Sessions[id] = session
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	setSessionCookie(w, r, id, session)
	writeJSON(w, 200, c.SessionResponse{CSRFToken: session.CSRF})
}
func (a *tripAPI) me(w http.ResponseWriter, r *http.Request) {
	owner, err := a.accountOwner(r, false)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var result c.SessionResponse
	err = a.store.Read(func(s tripstore.State) error {
		session, err := a.liveSession(&s, r, owner)
		if err == nil {
			result = sessionView(s, session)
		}
		return err
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeJSON(w, 200, result)
}
func (a *tripAPI) familyProfile(w http.ResponseWriter, r *http.Request) {
	owner, err := a.accountOwner(r, r.Method == "PUT")
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	userID := accountID(owner)
	var result c.FamilyOnboardingView
	status := 200
	if r.Method == "GET" {
		err = a.store.Read(func(s tripstore.State) error {
			if _, err := a.liveSession(&s, r, owner); err != nil {
				return err
			}
			var ok bool
			result, ok = s.FamilyProfiles[userID]
			if !ok {
				return failure(404, "PROFILE_NOT_FOUND", "Заполните анкету семьи.")
			}
			return nil
		})
	} else {
		var input c.FamilyOnboardingInput
		if err = readJSON(w, r, &input); err == nil {
			err = planner.ValidateFamily(input.Family, input.LoadLimits)
		}
		if err == nil && (input.ExpectedVersion < 0 || input.Wishes != nil && (!utf8.ValidString(*input.Wishes) || utf8.RuneCountInString(*input.Wishes) > 2000)) {
			err = failure(422, "VALIDATION_ERROR", "Некорректная версия или пожелания длиннее 2000 символов.")
		}
		if err == nil {
			err = a.store.Update(func(s *tripstore.State) error {
				if _, err := a.liveSession(s, r, owner); err != nil {
					return err
				}
				previous := s.FamilyProfiles[userID]
				if previous.Version != input.ExpectedVersion {
					return conflict(previous.Version)
				}
				if previous.Version == 0 {
					status = 201
				}
				result = c.FamilyOnboardingView{Version: previous.Version + 1, UpdatedAt: c.Instant(a.now().Format(time.RFC3339Nano)), Family: input.Family, LoadLimits: input.LoadLimits, Wishes: input.Wishes}
				s.FamilyProfiles[userID] = result
				return nil
			})
		}
	}
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeJSON(w, status, result)
}

// Строка списка поездок: сводка плюс краткие итоги по дням, чтобы карточки в профиле не запрашивали каждую поездку отдельно.
type tripListItem struct {
	c.TripSummary
	Days []tripDaySummary `json:"days"`
}
type tripDaySummary struct {
	Date    c.ISODate `json:"date"`
	Stops   int       `json:"stops"`
	Visited int       `json:"visited"`
	WalkedM float64   `json:"walked_m"`
}

func (a *tripAPI) listTrips(w http.ResponseWriter, r *http.Request) {
	owner, err := a.owner(r, false)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	result := struct {
		Items []tripListItem `json:"items"`
	}{Items: []tripListItem{}}
	err = a.store.Read(func(s tripstore.State) error {
		if _, err := a.liveSession(&s, r, owner); err != nil {
			return err
		}
		for _, t := range s.Trips {
			if t.Owner == owner {
				item := tripListItem{TripSummary: c.TripSummary{TripID: t.View.TripID, Version: t.View.Version, UpdatedAt: t.View.UpdatedAt, Status: t.View.Status, CityID: t.View.Input.CityID}, Days: []tripDaySummary{}}
				for _, d := range t.View.Days {
					day := tripDaySummary{Date: d.Date}
					for _, stop := range d.Stops {
						if stop.Progress == "removed" {
							continue
						}
						day.Stops++
						if stop.Progress == "visited" {
							day.Visited++
						}
					}
					if d.Execution != nil {
						day.WalkedM = d.Execution.ConsumedWalkDistanceM
					}
					item.Days = append(item.Days, day)
				}
				result.Items = append(result.Items, item)
			}
		}
		return nil
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	sort.Slice(result.Items, func(i, j int) bool {
		if result.Items[i].UpdatedAt == result.Items[j].UpdatedAt {
			return result.Items[i].TripID < result.Items[j].TripID
		}
		ti, _ := time.Parse(time.RFC3339Nano, string(result.Items[i].UpdatedAt))
		tj, _ := time.Parse(time.RFC3339Nano, string(result.Items[j].UpdatedAt))
		return ti.After(tj)
	})
	writeJSON(w, 200, result)
}

func (a *tripAPI) inputFromProfile(r *http.Request, raw []byte) (c.TripInput, int, error) {
	var request c.TripFromProfileRequest
	if err := strict(raw, &request); err != nil {
		return c.TripInput{}, 0, err
	}
	owner, err := a.accountOwner(r, true)
	if err != nil {
		return c.TripInput{}, 0, err
	}
	var profile c.FamilyOnboardingView
	err = a.store.Read(func(s tripstore.State) error {
		var ok bool
		profile, ok = s.FamilyProfiles[accountID(owner)]
		if !ok {
			return failure(422, "ONBOARDING_REQUIRED", "Сначала заполните анкету семьи.")
		}
		if profile.Version != request.ExpectedProfileVersion {
			return conflict(profile.Version)
		}
		return nil
	})
	if err != nil {
		return c.TripInput{}, 0, err
	}
	wishes := request.RequestText
	if wishes == nil {
		wishes = profile.Wishes
	}
	input := c.TripInput{CityID: request.CityID, Timezone: request.Timezone, PlanningContext: request.PlanningContext, Days: request.Days, Selections: request.Selections, RequestText: wishes, Family: profile.Family, LoadLimits: profile.LoadLimits, PlanningPolicy: request.PlanningPolicy}
	return input, profile.Version, planner.Validate(input)
}
