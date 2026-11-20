package planner

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"time"

	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

var ErrMLContract = errors.New("ML_CONTRACT_ERROR")
var ErrMLUnavailable = errors.New("ML_UNAVAILABLE")

type HTTPSource struct {
	Endpoint, Version, Token string
	Client                   *http.Client
	ParsedRequest            *c.ParsedRequest
	Excluded                 []c.ID
	Visited                  []c.ID
}

func (s HTTPSource) CatalogVersion() string { return s.Version }
func (s HTTPSource) Recommend(ctx context.Context, view c.TripView) (c.RecommendationResponse, error) {
	var result c.RecommendationResponse
	endpoint, err := url.Parse(s.Endpoint)
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.User != nil || s.Version == "" {
		return result, fmt.Errorf("%w: invalid ML configuration", ErrMLUnavailable)
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return result, ErrMLUnavailable
	}
	id := c.ID(hex.EncodeToString(nonce[:]))
	request := c.RecommendationRequest{ContractVersion: "1.0", RequestID: id, TripID: view.TripID, TripVersion: view.Version, CatalogVersion: view.CatalogVersion, Purpose: "initial", Profile: view.Input.Family, Policy: view.Policy, LoadLimits: view.Input.LoadLimits, Days: view.Input.Days, Selections: view.Input.Selections, VisitedActivityIDS: []c.ID{}, ExcludedActivityIDS: []c.ID{}, RequestText: view.Input.RequestText, Limit: CandidateLimit}
	request.ParsedRequest = s.ParsedRequest
	if s.Excluded != nil {
		request.ExcludedActivityIDS = s.Excluded
	}
	if s.Visited != nil {
		request.VisitedActivityIDS = s.Visited
	}
	raw, err := json.Marshal(request)
	if err != nil {
		return result, ErrMLContract
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.Endpoint, bytes.NewReader(raw))
	if err != nil {
		return result, ErrMLUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	if s.Token != "" {
		req.Header.Set("Authorization", "Bearer "+s.Token)
	}
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(req)
	if err != nil {
		return result, ErrMLUnavailable
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024+1))
	if err != nil || len(body) > 4*1024*1024 {
		return result, ErrMLContract
	}
	if response.StatusCode != 200 {
		if response.StatusCode == http.StatusConflict {
			return result, ErrMLContract
		}
		if response.StatusCode == http.StatusUnprocessableEntity {
			var failure struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if json.Unmarshal(body, &failure) == nil {
				switch failure.Error.Code {
				case "UNKNOWN_ACTIVITY", "SELECTION_CONFLICT", "HARD_CONSTRAINT_VIOLATION", "REQUEST_CLARIFICATION_REQUIRED":
					return result, stateError(failure.Error.Code, "Выбранные активности отсутствуют или конфликтуют с условиями поездки.")
				}
			}
			return result, ErrMLContract
		}
		return result, ErrMLUnavailable
	}
	if json.Unmarshal(body, &result) != nil {
		return result, ErrMLContract
	}
	if result.RequestID != id {
		return result, ErrMLContract
	}
	return result, nil
}

type fact struct {
	State    string          `json:"state"`
	Value    json.RawMessage `json:"value"`
	Evidence []c.ID          `json:"evidence_ids"`
}

func readFact(raw json.RawMessage) (fact, error) {
	var f fact
	if json.Unmarshal(raw, &f) != nil || (f.State != "known" && f.State != "unknown") || len(f.Value) == 0 || f.Evidence == nil || (f.State == "known" && (string(f.Value) == "null" || len(f.Evidence) == 0)) || (f.State == "unknown" && string(f.Value) != "null") {
		return f, ErrMLContract
	}
	return f, nil
}
func numberFact(raw json.RawMessage) (*float64, error) {
	f, err := readFact(raw)
	if err != nil {
		return nil, err
	}
	if f.State == "unknown" {
		return nil, nil
	}
	var value float64
	if json.Unmarshal(f.Value, &value) != nil || !finite(value) || value < 0 {
		return nil, ErrMLContract
	}
	return &value, nil
}
func normalize(response c.RecommendationResponse, view c.TripView) ([]Activity, map[c.ID]c.Candidate, error) {
	bad := func() ([]Activity, map[c.ID]c.Candidate, error) { return nil, nil, ErrMLContract }
	if response.ContractVersion != "1.0" || response.TripID != view.TripID || response.TripVersion != view.Version || response.CatalogVersion != view.CatalogVersion || response.ModelVersion == "" || response.Candidates == nil || len(response.Candidates) > CandidateLimit {
		return bad()
	}
	if _, err := time.Parse(time.RFC3339, string(response.GeneratedAt)); err != nil {
		return bad()
	}
	if response.Status != "complete" && response.Status != "partial" && response.Status != "no_candidates" {
		return bad()
	}
	if (response.Status == "no_candidates") != (len(response.Candidates) == 0) && response.Status != "partial" {
		return bad()
	}
	if response.Status == "partial" && len(response.Warnings) == 0 {
		return bad()
	}
	candidates := append([]c.Candidate{}, response.Candidates...)
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].Scores.FinalRelevance > candidates[j].Scores.FinalRelevance })
	activities := []Activity{}
	metadata := map[c.ID]c.Candidate{}
	places := map[c.ID]bool{}
	for _, candidate := range candidates {
		a := candidate.Activity
		if candidate.Reasons == nil || candidate.Warnings == nil || a.Duration.EvidenceIDS == nil || (a.Duration.Source != "official" && a.Duration.Source != "estimated" && a.Duration.Source != "user") {
			return bad()
		}
		point := candidate.Place.Location
		if err := (routing.Request{From: point, To: point, Mode: "walk"}).Validate(); err != nil {
			return bad()
		}
		if candidate.Place.Entrance != nil {
			point = *candidate.Place.Entrance
			if err := (routing.Request{From: point, To: point, Mode: "walk"}).Validate(); err != nil {
				return bad()
			}
		}
		if a.ActivityID == "" || candidate.Place.PlaceID == "" || a.PlaceID != candidate.Place.PlaceID || metadata[a.ActivityID].Activity.ActivityID != "" || places[a.PlaceID] || a.Title == "" || !finite(a.Duration.DurationSec) || a.Duration.DurationSec <= 0 || a.Duration.DurationSec > 86400 {
			return bad()
		}
		if a.Kind != "visit" && a.Kind != "session" && a.Kind != "meal" && a.Kind != "rest" && a.Kind != "utility" {
			return bad()
		}
		places[a.PlaceID] = true
		min, err := numberFact(a.AgeMinYears)
		if err != nil {
			return bad()
		}
		max, err := numberFact(a.AgeMaxYears)
		if err != nil {
			return bad()
		}
		height, err := numberFact(a.HeightMinCm)
		if err != nil {
			return bad()
		}
		if min != nil && max != nil && *min > *max {
			return bad()
		}
		admission, err := readFact(a.AdmissionRule)
		if err != nil {
			return bad()
		}
		var rule string
		if admission.State == "known" {
			if json.Unmarshal(admission.Value, &rule) != nil || (rule != "allowed" && rule != "adult_required" && rule != "forbidden") {
				return bad()
			}
		}
		children := map[c.ID]bool{}
		for _, child := range view.Input.Family.Children {
			children[child.ChildID] = true
		}
		eligible := map[c.ID]string{}
		for _, e := range candidate.Eligibility {
			if !children[e.ChildID] || eligible[e.ChildID] != "" || (e.Status != "eligible" && e.Status != "ineligible" && e.Status != "unknown") {
				return bad()
			}
			eligible[e.ChildID] = e.Status
		}
		if len(eligible) != len(children) {
			return bad()
		}
		blocked := rule == "forbidden"
		unknown := min == nil || max == nil || admission.State == "unknown"
		for _, child := range view.Input.Family.Children {
			if eligible[child.ChildID] == "ineligible" || min != nil && float64(child.AgeYears) < *min || max != nil && float64(child.AgeYears) > *max || height != nil && child.HeightCm != nil && *child.HeightCm < *height {
				blocked = true
			}
			if eligible[child.ChildID] == "unknown" || height != nil && child.HeightCm == nil {
				unknown = true
			}
		}
		if blocked {
			return bad()
		} // ML must filter known hard exclusions, not soften them.
		if unknown {
			candidate.Warnings = append(candidate.Warnings, Warning("ELIGIBILITY_UNKNOWN", "Часть условий допуска ребёнка не подтверждена."))
		}
		for _, score := range []float64{candidate.Scores.FinalRelevance, candidate.Scores.AdultInterest, candidate.Scores.Popularity} {
			if !finite(score) || score < 0 || score > 1 {
				return bad()
			}
		}
		interest := map[c.ID]bool{}
		for _, score := range candidate.Scores.ChildInterest {
			if !children[score.ChildID] || interest[score.ChildID] || !finite(score.Value) || score.Value < 0 || score.Value > 1 {
				return bad()
			}
			interest[score.ChildID] = true
		}
		if len(interest) != len(children) {
			return bad()
		}
		credit := 0.0
		credited := map[c.ID]bool{}
		for _, row := range candidate.BalanceCredit {
			if !children[row.ChildID] || credited[row.ChildID] || !finite(row.Value) || row.Value < 0 || row.Value > 1 {
				return bad()
			}
			credited[row.ChildID] = true
			credit += row.Value
		}
		target := 1.0
		if a.Kind == "meal" || a.Kind == "rest" || a.Kind == "utility" {
			target = 0
		}
		if len(credited) != len(children) || math.Abs(credit-target) > 0.000001 {
			return bad()
		}
		dates := map[c.ISODate]bool{}
		for _, availability := range candidate.Availability {
			if dates[availability.Date] {
				return bad()
			}
			dates[availability.Date] = true
			if availability.State != "open" && availability.State != "closed" && availability.State != "unknown" {
				return bad()
			}
			if availability.State == "unknown" {
				candidate.Warnings = append(candidate.Warnings, Warning("OPENING_HOURS_UNKNOWN", "Часы работы не подтверждены."))
			}
			if availability.State == "open" && len(availability.VisitWindows) == 0 && len(availability.Occurrences) == 0 {
				return bad()
			}
			intervals := append([]c.Interval{}, availability.VisitWindows...)
			ids := map[c.ID]bool{}
			for _, occ := range availability.Occurrences {
				if occ.OccurrenceID == "" || ids[occ.OccurrenceID] || (occ.BookingStatus != "available" && occ.BookingStatus != "sold_out" && occ.BookingStatus != "unknown") {
					return bad()
				}
				ids[occ.OccurrenceID] = true
				intervals = append(intervals, occ.Interval)
				if occ.BookingStatus == "unknown" {
					candidate.Warnings = append(candidate.Warnings, Warning("BOOKING_UNKNOWN", "Наличие мест на сеанс не подтверждено."))
				}
			}
			for _, window := range intervals {
				start, e1 := time.Parse(time.RFC3339, string(window.StartAt))
				end, e2 := time.Parse(time.RFC3339, string(window.EndAt))
				zone := time.FixedZone("Europe/Moscow", 10800)
				if e1 != nil || e2 != nil || !start.Before(end) || start.In(zone).Format("2006-01-02") != string(availability.Date) || end.In(zone).Format("2006-01-02") != string(availability.Date) {
					return bad()
				}
			}
			if availability.LastEntryAt != nil {
				if _, err := time.Parse(time.RFC3339, string(*availability.LastEntryAt)); err != nil {
					return bad()
				}
			}
		}
		for _, day := range view.Input.Days {
			if !dates[day.Date] {
				return bad()
			}
			if day.AvailableWindow == nil {
				candidate.Warnings = append(candidate.Warnings, Warning("START_TIME_UNKNOWN", "Без времени начала нельзя проверить попадание в часы работы."))
			}
		}
		activities = append(activities, Activity{ID: a.ActivityID, PlaceID: a.PlaceID, Title: a.Title, Point: point, DurationSec: a.Duration.DurationSec, MinAge: 3, MaxAge: 11})
		for i := range candidate.Warnings {
			if candidate.Warnings[i].ActivityID == nil {
				id := a.ActivityID
				candidate.Warnings[i].ActivityID = &id
			}
		}
		metadata[a.ActivityID] = candidate
	}
	return activities, metadata, nil
}
