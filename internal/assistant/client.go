// Package assistant translates language into bounded intents; it never applies a trip.
package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"io"
	"net/http"
	"time"
)

var ErrUnavailable = errors.New("assistant unavailable")
var ErrContract = errors.New("assistant contract invalid")

type Need struct {
	Kind     string `json:"kind"`
	ChildID  *c.ID  `json:"child_id"`
	Urgency  string `json:"urgency"`
	Evidence string `json:"evidence"`
}
type Intent struct {
	Action           string          `json:"action"`
	Date             *c.ISODate      `json:"date"`
	TargetDate       *c.ISODate      `json:"target_date"`
	StopID           *c.ID           `json:"stop_id"`
	PlaceID          *c.ID           `json:"place_id"`
	StopIDS          []c.ID          `json:"stop_ids"`
	DurationSec      *float64        `json:"duration_sec"`
	DurationEvidence *string         `json:"duration_evidence"`
	MaxWalkDistanceM *float64        `json:"max_walk_distance_m"`
	WalkEvidence     *string         `json:"walk_evidence"`
	Question         *string         `json:"question"`
	Needs            []Need          `json:"needs"`
	Preferences      json.RawMessage `json:"preferences"`
}
type Turn struct {
	Message string `json:"message"`
	Reply   string `json:"reply"`
}
type Memory struct {
	Revision      int           `json:"revision"`
	TripVersion   int           `json:"trip_version"`
	ExpiresAt     time.Time     `json:"expires_at"`
	History       []Turn        `json:"history"`
	Choices       []c.Candidate `json:"choices"`
	Evidence      []c.Evidence  `json:"evidence"`
	PendingStopID *c.ID         `json:"pending_stop_id"`
	Date          c.ISODate     `json:"date"`
}
type Interpreter interface {
	Interpret(context.Context, string, string, any) (Intent, error)
}
type HTTPInterpreter struct {
	Endpoint, Token string
	Client          *http.Client
}

func (s HTTPInterpreter) Interpret(ctx context.Context, id, message string, contextValue any) (Intent, error) {
	var result struct {
		ContractVersion string `json:"contract_version"`
		RequestID       string `json:"request_id"`
		Intent          Intent `json:"intent"`
	}
	raw, err := json.Marshal(map[string]any{"contract_version": "1.0", "request_id": id, "message": message, "context": contextValue})
	if err != nil {
		return Intent{}, ErrContract
	}
	req, err := http.NewRequestWithContext(ctx, "POST", s.Endpoint, bytes.NewReader(raw))
	if err != nil {
		return Intent{}, ErrUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	if s.Token != "" {
		req.Header.Set("Authorization", "Bearer "+s.Token)
	}
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 28 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(req)
	if err != nil {
		return Intent{}, ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		if response.StatusCode == 502 || response.StatusCode == 422 {
			return Intent{}, ErrContract
		}
		return Intent{}, ErrUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(body) > 65536 || json.Unmarshal(body, &result) != nil || result.ContractVersion != "1.0" || result.RequestID != id {
		return Intent{}, ErrContract
	}
	return result.Intent, nil
}
