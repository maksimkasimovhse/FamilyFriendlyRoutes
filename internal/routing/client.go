package routing

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

type Position [2]float64 // [longitude, latitude], WGS84

func (p *Position) UnmarshalJSON(data []byte) error {
	var coordinates []float64
	if err := json.Unmarshal(data, &coordinates); err != nil {
		return err
	}
	if len(coordinates) != 2 || !finite(coordinates[0]) || !finite(coordinates[1]) {
		return errors.New("position must contain exactly two finite numbers")
	}
	*p = Position{coordinates[0], coordinates[1]}
	return nil
}

type Point struct {
	Coordinates Position `json:"coordinates"`
	Label       *string  `json:"label"`
}
type LineString struct {
	Type        string     `json:"type"`
	Coordinates []Position `json:"coordinates"`
}
type Request struct {
	From            Point    `json:"from"`
	To              Point    `json:"to"`
	Mode            string   `json:"mode"`
	WalkingSpeedKPH *float64 `json:"walking_speed_kph,omitempty"`
}
type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type Result struct {
	Mode               string     `json:"mode"`
	Status             string     `json:"status"`
	DistanceM          float64    `json:"distance_m"`
	TravelDurationSec  float64    `json:"travel_duration_sec"`
	Geometry           LineString `json:"geometry"`
	RoutingDataVersion string     `json:"routing_data_version"`
	EngineVersion      string     `json:"engine_version"`
	SnappedFrom        Position   `json:"snapped_from"`
	SnappedTo          Position   `json:"snapped_to"`
	WalkingSpeedKPH    *float64   `json:"walking_speed_kph"`
	Warnings           []Warning  `json:"warnings"`
}

var (
	ErrInvalidInput    = errors.New("invalid routing input")
	ErrNoRoute         = errors.New("no route")
	ErrUnavailable     = errors.New("routing engine unavailable")
	ErrInvalidResponse = errors.New("invalid routing engine response")
)

const EngineVersion = "valhalla-scripted@sha256:693617873d42f24d9023eaa9aa002dccd832c9629c9ce8b60eb4ff30547215e1"

// Pilot bounding box includes Nizhny Novgorod and approaches, not an administrative border.
func validPosition(p Position) bool {
	return finite(p[0]) && finite(p[1]) && p[0] >= 43.5 && p[0] <= 44.4 && p[1] >= 56.05 && p[1] <= 56.6
}
func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func (r Request) Validate() error {
	if !validPosition(r.From.Coordinates) || !validPosition(r.To.Coordinates) {
		return fmt.Errorf("%w: points must be [longitude, latitude] inside pilot bounds [43.5,56.05,44.4,56.6]", ErrInvalidInput)
	}
	if r.Mode != "walk" && r.Mode != "car" {
		return fmt.Errorf("%w: mode must be walk or car", ErrInvalidInput)
	}
	if r.WalkingSpeedKPH != nil && (r.Mode != "walk" || !finite(*r.WalkingSpeedKPH) || *r.WalkingSpeedKPH < 0.5 || *r.WalkingSpeedKPH > 8) {
		return fmt.Errorf("%w: walking_speed_kph is allowed for walk only, range 0.5..8", ErrInvalidInput)
	}
	return nil
}

type Client struct {
	baseURL     string
	dataVersion string
	httpClient  *http.Client
}

func NewClient(baseURL, dataVersion string, httpClient *http.Client) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil || u == nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("invalid Valhalla base URL")
	}
	if dataVersion == "" {
		return nil, errors.New("routing data version is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{strings.TrimRight(baseURL, "/"), dataVersion, httpClient}, nil
}

type location struct {
	Lat          float64 `json:"lat"`
	Lon          float64 `json:"lon"`
	Radius       int     `json:"radius"`
	SearchCutoff int     `json:"search_cutoff"`
}
type engineRequest struct {
	Locations      []location                    `json:"locations"`
	Costing        string                        `json:"costing"`
	Format         string                        `json:"format"`
	ShapeFormat    string                        `json:"shape_format"`
	DirectionsType string                        `json:"directions_type"`
	CostingOptions map[string]map[string]float64 `json:"costing_options,omitempty"`
}
type engineResponse struct {
	Code      string `json:"code"`
	ErrorCode int    `json:"error_code"`
	Routes    []struct {
		Distance *float64   `json:"distance"`
		Duration *float64   `json:"duration"`
		Geometry LineString `json:"geometry"`
	} `json:"routes"`
	Waypoints []struct {
		Location Position `json:"location"`
	} `json:"waypoints"`
}

func (c *Client) Route(ctx context.Context, r Request) (Result, error) {
	if err := r.Validate(); err != nil {
		return Result{}, err
	}
	costing := "pedestrian"
	if r.Mode == "car" {
		costing = "auto"
	}
	payload := engineRequest{Locations: []location{{r.From.Coordinates[1], r.From.Coordinates[0], 100, 100}, {r.To.Coordinates[1], r.To.Coordinates[0], 100, 100}}, Costing: costing, Format: "osrm", ShapeFormat: "geojson", DirectionsType: "none"}
	if r.WalkingSpeedKPH != nil {
		payload.CostingOptions = map[string]map[string]float64{"pedestrian": {"walking_speed": *r.WalkingSpeedKPH}}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/route", bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024+1))
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if len(raw) > 8*1024*1024 {
		return Result{}, fmt.Errorf("%w: response too large", ErrInvalidResponse)
	}
	var parsed engineResponse
	decodeErr := json.Unmarshal(raw, &parsed)
	if resp.StatusCode >= 500 {
		return Result{}, fmt.Errorf("%w: upstream status %d", ErrUnavailable, resp.StatusCode)
	}
	if decodeErr != nil {
		return Result{}, fmt.Errorf("%w: non-JSON response", ErrInvalidResponse)
	}
	if parsed.Code == "NoRoute" || parsed.Code == "NoSegment" || parsed.ErrorCode == 442 || parsed.ErrorCode == 171 {
		return Result{}, ErrNoRoute
	}
	if resp.StatusCode != http.StatusOK || parsed.Code != "Ok" {
		return Result{}, fmt.Errorf("%w: status %d, code %q", ErrInvalidResponse, resp.StatusCode, parsed.Code)
	}
	if len(parsed.Routes) == 0 || len(parsed.Waypoints) != 2 {
		return Result{}, fmt.Errorf("%w: missing routes or waypoints", ErrInvalidResponse)
	}
	route := parsed.Routes[0]
	if route.Geometry.Type != "LineString" || len(route.Geometry.Coordinates) < 2 || route.Distance == nil || route.Duration == nil || !finite(*route.Distance) || !finite(*route.Duration) || *route.Distance < 0 || *route.Duration < 0 {
		return Result{}, fmt.Errorf("%w: malformed geometry or totals", ErrInvalidResponse)
	}
	for _, p := range route.Geometry.Coordinates {
		if !finite(p[0]) || !finite(p[1]) || p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90 {
			return Result{}, fmt.Errorf("%w: invalid coordinate", ErrInvalidResponse)
		}
	}
	for idx, p := range []Position{r.From.Coordinates, r.To.Coordinates} {
		if haversine(p, parsed.Waypoints[idx].Location) > 105 {
			return Result{}, fmt.Errorf("%w: endpoint cannot be snapped within 100 metres", ErrNoRoute)
		}
	}
	warnings := []Warning{{"ESTIMATED_TRAVEL_TIME", "Время движения расчётное; остановки и отдых не включены."}, {"SNAPPED_ENDPOINTS", "Путь начинается и заканчивается на доступной сети; подход от исходных координат отдельно не рассчитан."}}
	if r.Mode == "car" {
		warnings = append(warnings, Warning{"NO_LIVE_TRAFFIC", "Нет текущих пробок, подачи и посадки такси. Это не вызов автомобиля."})
	}
	return Result{r.Mode, "calculated", *route.Distance, *route.Duration, route.Geometry, c.dataVersion, EngineVersion, parsed.Waypoints[0].Location, parsed.Waypoints[1].Location, r.WalkingSpeedKPH, warnings}, nil
}
func (c *Client) Ready(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/status", nil)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%w: status %d", ErrUnavailable, resp.StatusCode)
	}
	var status struct {
		TilesetLastModified int64    `json:"tileset_last_modified"`
		AvailableActions    []string `json:"available_actions"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&status); err != nil || status.TilesetLastModified <= 0 || !slices.Contains(status.AvailableActions, "route") {
		return fmt.Errorf("%w: no routing tiles", ErrUnavailable)
	}
	return nil
}
func haversine(a, b Position) float64 {
	const rad = math.Pi / 180
	lat := (b[1] - a[1]) * rad
	lon := (b[0] - a[0]) * rad
	v := math.Sin(lat/2)*math.Sin(lat/2) + math.Cos(a[1]*rad)*math.Cos(b[1]*rad)*math.Sin(lon/2)*math.Sin(lon/2)
	return 6371000 * 2 * math.Asin(math.Sqrt(math.Min(1, v)))
}
