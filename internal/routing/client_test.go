package routing

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func sampleRequest() Request {
	return Request{From: Point{Coordinates: Position{44.0059, 56.3269}}, To: Point{Coordinates: Position{44.0095, 56.3286}}, Mode: "walk"}
}
func validResponse() any {
	return map[string]any{"code": "Ok", "routes": []any{map[string]any{"distance": 320.5, "duration": 265.2, "geometry": LineString{"LineString", []Position{{44.0059, 56.3269}, {44.0095, 56.3286}}}}}, "waypoints": []any{map[string]any{"location": Position{44.0059, 56.3269}}, map[string]any{"location": Position{44.0095, 56.3286}}}}
}
func TestRouteProfilesAndUnits(t *testing.T) {
	for _, mode := range []string{"walk", "car"} {
		t.Run(mode, func(t *testing.T) {
			var payload engineRequest
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/route" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				_ = json.NewEncoder(w).Encode(validResponse())
			}))
			defer server.Close()
			client, _ := NewClient(server.URL, "test-snapshot", server.Client())
			input := sampleRequest()
			input.Mode = mode
			speed := 3.5
			if mode == "walk" {
				input.WalkingSpeedKPH = &speed
			}
			result, err := client.Route(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			expected := "pedestrian"
			if mode == "car" {
				expected = "auto"
			}
			if payload.Costing != expected || payload.Format != "osrm" || payload.ShapeFormat != "geojson" {
				t.Fatalf("wrong engine profile: %+v", payload)
			}
			if payload.Locations[0].Lon != 44.0059 || payload.Locations[0].Lat != 56.3269 {
				t.Fatal("coordinate order changed")
			}
			if mode == "walk" && payload.CostingOptions["pedestrian"]["walking_speed"] != 3.5 {
				t.Fatal("walking speed lost")
			}
			if result.DistanceM != 320.5 || result.TravelDurationSec != 265.2 || result.RoutingDataVersion != "test-snapshot" {
				t.Fatal("units or version changed")
			}
			if mode == "car" && result.WalkingSpeedKPH != nil {
				t.Fatal("walking option leaked to car")
			}
		})
	}
}
func TestRouteFailureDoesNotInventGeometry(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		body     string
		expected error
	}{
		{"no route", 400, `{"code":"NoRoute"}`, ErrNoRoute},
		{"unsnappable", 400, `{"error_code":171}`, ErrNoRoute},
		{"upstream unavailable", 503, `unavailable`, ErrUnavailable},
		{"bad json", 200, `not-json`, ErrInvalidResponse},
		{"empty route", 200, `{"code":"Ok","routes":[],"waypoints":[]}`, ErrInvalidResponse},
		{"invalid upstream arguments", 400, `{"error_code":125}`, ErrInvalidResponse},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client, _ := NewClient(server.URL, "test-snapshot", server.Client())
			result, err := client.Route(context.Background(), sampleRequest())
			if !errors.Is(err, tc.expected) {
				t.Fatalf("got %v want %v", err, tc.expected)
			}
			if len(result.Geometry.Coordinates) > 0 || result.Status == "calculated" {
				t.Fatal("invented success after failure")
			}
		})
	}
}
func TestValidationBeforeUpstream(t *testing.T) {
	client, _ := NewClient("http://127.0.0.1:1", "test-snapshot", nil)
	input := sampleRequest()
	input.From.Coordinates = Position{56.3269, 44.0059}
	if _, err := client.Route(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	speed := 0.0
	input = sampleRequest()
	input.WalkingSpeedKPH = &speed
	if _, err := client.Route(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	input = sampleRequest()
	input.Mode = "stroller"
	if _, err := client.Route(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
}
func TestRejectFarSnappingAndWrongGeometry(t *testing.T) {
	for _, bad := range []string{"snap", "geometry", "missing_totals"} {
		t.Run(bad, func(t *testing.T) {
			response := validResponse().(map[string]any)
			if bad == "snap" {
				response["waypoints"] = []any{map[string]any{"location": Position{44.1, 56.4}}, map[string]any{"location": Position{44.0095, 56.3286}}}
			} else if bad == "geometry" {
				response["routes"] = []any{map[string]any{"distance": 1, "duration": 1, "geometry": map[string]any{"type": "Point", "coordinates": []any{}}}}
			} else {
				response["routes"] = []any{map[string]any{"geometry": LineString{"LineString", []Position{{44.0059, 56.3269}, {44.0095, 56.3286}}}}}
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(response) }))
			defer server.Close()
			client, _ := NewClient(server.URL, "test", server.Client())
			_, err := client.Route(context.Background(), sampleRequest())
			expected := ErrNoRoute
			if bad != "snap" {
				expected = ErrInvalidResponse
			}
			if !errors.Is(err, expected) {
				t.Fatal(err)
			}
		})
	}
}
func TestReadyAndCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"has_tiles":false}`)) }))
	defer server.Close()
	client, _ := NewClient(server.URL, "test", server.Client())
	if err := client.Ready(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	<-ctx.Done()
	if _, err := client.Route(ctx, sampleRequest()); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
}

func TestPositionRequiresExactlyTwoCoordinates(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `[44]`, `[44,56,1]`, `"44,56"`} {
		var p Position
		if err := json.Unmarshal([]byte(raw), &p); err == nil {
			t.Fatalf("accepted invalid position %s", raw)
		}
	}
	var p Position
	if err := json.Unmarshal([]byte(`[44.0059,56.3269]`), &p); err != nil || p[0] != 44.0059 || p[1] != 56.3269 {
		t.Fatalf("invalid decode: %v %v", p, err)
	}
}

func TestReadinessUsesActualStatusResponse(t *testing.T) {
	for _, tc := range []struct {
		body  string
		ready bool
	}{
		{`{"version":"3.9.3","tileset_last_modified":1795162487,"available_actions":["route","status"]}`, true},
		{`{"tileset_last_modified":0,"available_actions":["route"]}`, false},
		{`{"tileset_last_modified":1795162487,"available_actions":["status"]}`, false},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(tc.body)) }))
		client, _ := NewClient(server.URL, "test", server.Client())
		err := client.Ready(context.Background())
		server.Close()
		if (err == nil) != tc.ready {
			t.Fatalf("status %s got error %v", tc.body, err)
		}
	}
}
