// Package tripstore provides a single-process development store. It is not a multi-instance database.
package tripstore

import (
	"encoding/json"
	"errors"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/assistant"
	"os"
	"path/filepath"
	"sync"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

type Session struct {
	UserID    string    `json:"user_id,omitempty"`
	CSRF      string    `json:"csrf"`
	ExpiresAt time.Time `json:"expires_at"`
}
type Account struct {
	UserID       string    `json:"user_id"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"password_hash"`
	CreatedAt    time.Time `json:"created_at"`
}
type Trip struct {
	Owner string     `json:"owner"`
	View  c.TripView `json:"view"`
}
type Preview struct {
	Owner   string        `json:"owner"`
	Applied bool          `json:"applied"`
	View    c.PlanPreview `json:"view"`
}
type Receipt struct {
	Hash      string          `json:"hash"`
	Status    int             `json:"status"`
	Body      json.RawMessage `json:"body"`
	Location  string          `json:"location"`
	ExpiresAt time.Time       `json:"expires_at"`
}
type State struct {
	Accounts       map[string]Account                `json:"accounts"`
	FamilyProfiles map[string]c.FamilyOnboardingView `json:"family_profiles"`
	Sessions       map[string]Session                `json:"sessions"`
	Trips          map[string]Trip                   `json:"trips"`
	Previews       map[string]Preview                `json:"previews"`
	Receipts       map[string]Receipt                `json:"receipts"`
	Assistant      map[string]assistant.Memory       `json:"assistant"`
}
type Store struct {
	mu       sync.Mutex
	filename string
	state    State
}

func Open(filename string) (*Store, error) {
	store := &Store{filename: filename, state: State{Accounts: map[string]Account{}, FamilyProfiles: map[string]c.FamilyOnboardingView{}, Sessions: map[string]Session{}, Trips: map[string]Trip{}, Previews: map[string]Preview{}, Receipts: map[string]Receipt{}}}
	raw, err := os.ReadFile(filename)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &store.state); err != nil {
		return nil, err
	}
	if store.state.Sessions == nil || store.state.Trips == nil || store.state.Previews == nil || store.state.Receipts == nil {
		return nil, errors.New("invalid development store")
	}
	// Older stores contain guest trips only. Preserve them when adding accounts.
	if store.state.Accounts == nil {
		store.state.Accounts = map[string]Account{}
	}
	if store.state.FamilyProfiles == nil {
		store.state.FamilyProfiles = map[string]c.FamilyOnboardingView{}
	}
	pruneExpired(&store.state, time.Now())
	return store, nil
}

// pruneExpired удаляет то, что уже нельзя использовать: варианты плана, просроченные больше часа назад (живут 10 минут;
// час оставляем, чтобы сервер ещё отвечал «вариант устарел», а не «не найден»), просроченные сессии и квитанции повторных запросов. Без этого файл растёт (каждый вариант хранит весь пул кандидатов),
// а каждое чтение копирует всё состояние, и приложение замедляется.
const previewGrace = time.Hour

func pruneExpired(state *State, now time.Time) {
	for id, p := range state.Previews {
		if expires, err := time.Parse(time.RFC3339Nano, string(p.View.ExpiresAt)); err == nil && expires.Add(previewGrace).Before(now) {
			delete(state.Previews, id)
		}
	}
	for id, v := range state.Sessions {
		if !v.ExpiresAt.IsZero() && v.ExpiresAt.Before(now) {
			delete(state.Sessions, id)
		}
	}
	for id, r := range state.Receipts {
		if !r.ExpiresAt.IsZero() && r.ExpiresAt.Before(now) {
			delete(state.Receipts, id)
		}
	}
}

func clone(state State) (State, error) {
	raw, err := json.Marshal(state)
	if err != nil {
		return State{}, err
	}
	var copied State
	err = json.Unmarshal(raw, &copied)
	return copied, err
}

// Read passes a detached snapshot; callers cannot mutate the stored state.
func (s *Store) Read(fn func(State) error) error {
	s.mu.Lock()
	snapshot, err := clone(s.state)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return fn(snapshot)
}

// Update writes a complete snapshot before publishing it in memory; failed callbacks never save.
func (s *Store) Update(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next, err := clone(s.state)
	if err != nil {
		return err
	}
	if next.Assistant == nil {
		next.Assistant = map[string]assistant.Memory{}
	}
	if err := fn(&next); err != nil {
		return err
	}
	pruneExpired(&next, time.Now())
	raw, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.filename), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(s.filename), "trip-state-*.tmp")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if _, err := temp.Write(raw); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, s.filename); err != nil {
		return err
	}
	s.state = next
	return nil
}
