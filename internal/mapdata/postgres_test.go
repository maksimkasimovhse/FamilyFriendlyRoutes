package mapdata_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/httpapi"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/mapdata"
	"github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/routing"
)

func TestPostGISRadiusBBoxImportAndHTTP(t *testing.T) {
	dsn := os.Getenv("MAP_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set MAP_TEST_DATABASE_URL to a migrated PostGIS database")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal("cannot connect to test database")
	}
	defer conn.Close(ctx)
	schema := fmt.Sprintf("map_test_%d", time.Now().UnixNano())
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid test database config")
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, file := range []string{"00002_dictionaries.sql", "00003_items.sql", "00004_location_hours.sql", "00007_tags_facts.sql", "00009_seed_dictionaries.sql", "00010_map_infrastructure.sql"} {
		raw, err := os.ReadFile(filepath.Join("../../db/migrations", file))
		if err != nil {
			t.Fatal(err)
		}
		up := strings.Split(string(raw), "-- +goose Down")[0]
		if _, err := pool.Exec(ctx, up); err != nil {
			t.Fatalf("migration %s: %v", file, err)
		}
	}
	raw := `{"type":"FeatureCollection","checked_at":"2026-11-20T00:00:00Z","features":[
 {"type":"Feature","geometry":{"type":"Point","coordinates":[44,56]},"properties":{"osm":"node/1","kind":"toilet","name":"Near WC","tags":{"fee":"yes","opening_hours":"24/7"}}},
 {"type":"Feature","geometry":{"type":"Point","coordinates":[44.001,56]},"properties":{"osm":"node/2","kind":"bench","name":"Bench"}},
 {"type":"Feature","geometry":{"type":"Point","coordinates":[44.1,56]},"properties":{"osm":"node/3","kind":"pharmacy","name":"Far pharmacy"}},
 {"type":"Feature","geometry":{"type":"Point","coordinates":[44,56]},"properties":{"osm":"node/4","kind":"playground","tags":{"access":"private"}}}
 ]}`
	snapshot, err := mapdata.ParseSnapshot(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	var firstID int
	for i := 0; i < 2; i++ {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		count, err := mapdata.Import(ctx, tx, snapshot, "test-map-v1")
		if err != nil {
			tx.Rollback(ctx)
			t.Fatal(err)
		}
		if count != 3 {
			t.Fatal("private object imported")
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		var id, n int
		if err := pool.QueryRow(ctx, "SELECT min(item_id),count(*) FROM items").Scan(&id, &n); err != nil {
			t.Fatal(err)
		}
		if n != 3 || i == 1 && id != firstID {
			t.Fatal("import not idempotent")
		}
		firstID = id
	}
	handler := httpapi.MapHandler(mapdata.Postgres{Pool: pool})
	get := func(query string, want int) c.MapResponse {
		t.Helper()
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/map/places?"+query, nil))
		if w.Code != want {
			t.Fatalf("HTTP want %d got %d: %s", want, w.Code, w.Body.String())
		}
		var response c.MapResponse
		if want == 200 {
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
		}
		return response
	}
	query := "lon=44&lat=56&radius_km=1&limit=1"
	first := get(query, 200)
	if len(first.Items) != 1 || first.Items[0].Name != "Near WC" || first.Items[0].DistanceM == nil || *first.Items[0].DistanceM != 0 || first.NextCursor == nil || len(first.Evidence) != 1 {
		t.Fatalf("unexpected radius result: %+v", first)
	}
	if !strings.Contains(string(first.Items[0].Toilet), `"known"`) || !strings.Contains(string(first.Items[0].Indoor), `"unknown"`) || *first.Items[0].FeeRaw != "yes" {
		t.Fatal("facts or raw source metadata lost")
	}
	second := get(query+"&cursor="+*first.NextCursor, 200)
	if len(second.Items) != 1 || second.Items[0].Name != "Bench" || second.NextCursor != nil {
		t.Fatal("pagination broken")
	}
	get("lon=44&lat=56&radius_km=2&limit=1&cursor="+*first.NextCursor, 422)
	filtered := get("lon=44&lat=56&radius_km=20&categories=pharmacy", 200)
	if len(filtered.Items) != 1 || filtered.Items[0].Name != "Far pharmacy" {
		t.Fatal("radius/category filter broken")
	}
	nearest := get("lon=44&lat=56&nearest=true&categories=pharmacy&limit=3", 200)
	if len(nearest.Items) != 1 || nearest.Items[0].Name != "Far pharmacy" || nearest.Items[0].DistanceM == nil || *nearest.Items[0].DistanceM <= 1000 {
		t.Fatal("nearest search incorrectly cut off far results")
	}
	empty := get("lon=40&lat=50&radius_km=1", 200)
	if len(empty.Items) != 0 || empty.Items == nil || empty.Evidence == nil {
		t.Fatal("empty arrays not preserved")
	}
	bbox := get("bbox=43.999,55.999,44.01,56.001", 200)
	if len(bbox.Items) != 2 || bbox.Items[0].DistanceM != nil {
		t.Fatal("bbox filter broken")
	}
	if _, err := pool.Exec(ctx, "UPDATE items SET show_on_map=false WHERE title='Bench'"); err != nil {
		t.Fatal(err)
	}
	if len(get("lon=44&lat=56&radius_km=1", 200).Items) != 1 {
		t.Fatal("hidden object leaked")
	}
	w := httptest.NewRecorder()
	httpapi.MapHandler(nil).ServeHTTP(w, httptest.NewRequest("GET", "/?lon=44&lat=56&radius_km=1", nil))
	if w.Code != 503 {
		t.Fatal("missing database must not silently return fake data")
	}
	// A long meridian leg: an object in its middle must be found even when
	// several kilometres from both vertices; 124 m is inside and 126 m outside.
	for name, offset := range map[string]float64{"Middle": 0, "Inside124": 124, "Outside126": 126} {
		var id int
		err := pool.QueryRow(ctx, `INSERT INTO items(item_type,category_id,show_in_cards,title,source_dataset,source_id,catalog_version)
 VALUES('map_object',32,false,$1,'route_test',$1,'test-map-v1') RETURNING item_id`, name).Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO item_location(item_id,location,address) VALUES($1,ST_Project(ST_SetSRID(ST_MakePoint(44,56.05),4326)::geography,$2::double precision,pi()/2),'')`, id, offset); err != nil {
			t.Fatal(err)
		}
	}
	values, _ := url.ParseQuery("date=2030-06-15&expected_version=2&categories=toilet")
	q, err := mapdata.ParseRoute(values, [][]routing.Position{{{44, 56}, {44, 56.1}}})
	if err != nil {
		t.Fatal(err)
	}
	response, err := (mapdata.Postgres{Pool: pool}).Search(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, p := range response.Items {
		names[p.Name] = true
		if p.DistanceM != nil || p.DistanceToRouteM == nil || *p.DistanceToRouteM > 125 {
			t.Fatal("route distance missing or outside corridor")
		}
	}
	if !names["Middle"] || !names["Inside124"] || names["Outside126"] {
		t.Fatalf("incorrect corridor: %+v", names)
	}
	// Independent legs must not introduce a fictitious connector through Middle.
	q, err = mapdata.ParseRoute(values, [][]routing.Position{{{44, 56}, {44, 56.01}}, {{44, 56.09}, {44, 56.1}}})
	if err != nil {
		t.Fatal(err)
	}
	response, err = (mapdata.Postgres{Pool: pool}).Search(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range response.Items {
		if p.Name == "Middle" || p.Name == "Inside124" {
			t.Fatal("disconnected legs created a false straight connector")
		}
	}
}
