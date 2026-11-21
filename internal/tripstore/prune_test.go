package tripstore

import (
	"testing"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

func TestPruneExpiredKeepsLiveData(t *testing.T) {
	now := time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC)
	past, future := now.Add(-2*time.Hour), now.Add(time.Hour)
	recent := now.Add(-5 * time.Minute) // просрочен недавно: ещё должен отвечать «устарел»
	st := State{
		Previews: map[string]Preview{
			"old":    {View: c.PlanPreview{ExpiresAt: c.Instant(past.Format(time.RFC3339Nano))}},
			"new":    {View: c.PlanPreview{ExpiresAt: c.Instant(future.Format(time.RFC3339Nano))}},
			"recent": {View: c.PlanPreview{ExpiresAt: c.Instant(recent.Format(time.RFC3339Nano))}},
		},
		Sessions: map[string]Session{"old": {ExpiresAt: past}, "new": {ExpiresAt: future}},
		Receipts: map[string]Receipt{"old": {ExpiresAt: past}, "new": {ExpiresAt: future}},
		Trips:    map[string]Trip{"t": {}},
	}
	pruneExpired(&st, now)
	if len(st.Previews) != 2 || st.Previews["recent"].View.ExpiresAt == "" || len(st.Sessions) != 1 || len(st.Receipts) != 1 || len(st.Trips) != 1 {
		t.Fatalf("pruned wrongly: previews=%d sessions=%d receipts=%d trips=%d", len(st.Previews), len(st.Sessions), len(st.Receipts), len(st.Trips))
	}
}
