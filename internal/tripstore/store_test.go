package tripstore

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

func TestStorePersistenceIsolationAndConcurrentUpdates(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "state.json")
	store, err := Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Update(func(s *State) error { s.Trips["trip"] = Trip{Owner: "owner", View: c.TripView{Version: 1}}; return nil }); err != nil {
		t.Fatal(err)
	}
	_ = store.Read(func(s State) error { delete(s.Trips, "trip"); return nil })
	sentinel := errors.New("abort")
	if err := store.Update(func(s *State) error { delete(s.Trips, "trip"); return sentinel }); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := store.Update(func(s *State) error { trip := s.Trips["trip"]; trip.View.Version++; s.Trips["trip"] = trip; return nil }); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	reopened, err := Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	_ = reopened.Read(func(s State) error {
		if s.Trips["trip"].View.Version != 11 {
			t.Fatal("lost update or failed persistence")
		}
		return nil
	})
}
