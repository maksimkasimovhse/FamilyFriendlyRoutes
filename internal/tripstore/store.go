// Package tripstore provides a single-process development store. It is not a multi-instance database.
package tripstore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

type Session struct {
	CSRF      string    `json:"csrf"`
	ExpiresAt time.Time `json:"expires_at"`
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
	Sessions map[string]Session `json:"sessions"`
	Trips    map[string]Trip    `json:"trips"`
	Previews map[string]Preview `json:"previews"`
	Receipts map[string]Receipt `json:"receipts"`
}
type Store struct {
	mu       sync.Mutex
	filename string
	state    State
}

func Open(filename string) (*Store, error) {
	store := &Store{filename: filename, state: State{map[string]Session{}, map[string]Trip{}, map[string]Preview{}, map[string]Receipt{}}}
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
	return store, nil
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
	if err := fn(&next); err != nil {
		return err
	}
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
