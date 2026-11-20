package mapdata

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	c "github.com/maksimkasimovhse/FamilyFriendlyRoutes/internal/contracts"
)

type Repository interface {
	Search(context.Context, Query) (c.MapResponse, error)
}
type Postgres struct{ Pool *pgxpool.Pool }

// Queries use the existing GiST geography index; distance is metres on the spheroid.
func (db Postgres) Search(ctx context.Context, q Query) (c.MapResponse, error) {
	result := c.MapResponse{Items: []c.Place{}, Evidence: []c.Evidence{}}
	// A consistent snapshot keeps version and rows in the same database view.
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
	if err != nil {
		return result, err
	}
	err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT version FROM catalog_versions ORDER BY created_at DESC,version DESC LIMIT 1),'empty')`).Scan(&result.CatalogVersion)
	if err != nil {
		return result, err
	}
	filter := `ST_DWithin(l.location,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$3)`
	distance := `ST_Distance(l.location,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)`
	args := []any{q.Lon, q.Lat, q.RadiusM, q.Categories, q.Limit + 1, q.Offset}
	categoryParam, limitParam, offsetParam := 4, 5, 6
	if q.Nearest {
		filter = `true`
		args = []any{q.Lon, q.Lat, q.Categories, q.Limit + 1, q.Offset}
		categoryParam, limitParam, offsetParam = 3, 4, 5
	}
	if q.BBox != nil {
		filter = `l.location && ST_MakeEnvelope($1,$2,$3,$7,4326)::geography AND ST_X(l.location::geometry) BETWEEN $1 AND $3 AND ST_Y(l.location::geometry) BETWEEN $2 AND $7`
		distance = `NULL::double precision`
		args = []any{q.BBox[0], q.BBox[1], q.BBox[2], q.Categories, q.Limit + 1, q.Offset, q.BBox[3]}
	}
	if len(q.RouteLines) > 0 {
		raw, err := json.Marshal(map[string]any{"type": "MultiLineString", "coordinates": q.RouteLines})
		if err != nil {
			return result, err
		}
		geometry := `ST_SetSRID(ST_GeomFromGeoJSON($1::text),4326)::geography`
		filter = `ST_DWithin(l.location,` + geometry + `,$2)`
		distance = `ST_Distance(l.location,` + geometry + `)`
		args = []any{string(raw), q.RadiusM, q.Categories, q.Limit + 1, q.Offset}
		categoryParam, limitParam, offsetParam = 3, 4, 5
	}
	rows, err := tx.Query(ctx, `WITH mapped AS (
 SELECT i.*, CASE c.slug WHEN 'playgrounds' THEN 'playground' WHEN 'parks' THEN 'park'
 WHEN 'benches' THEN 'bench' WHEN 'toilets' THEN 'toilet' WHEN 'pharmacies' THEN 'pharmacy'
 WHEN 'cafes' THEN 'restaurant' END AS api_category FROM items i JOIN categories c USING(category_id)
 WHERE i.is_published AND i.show_on_map)
 SELECT i.item_id,i.title,i.api_category,ST_X(l.location::geometry),ST_Y(l.location::geometry),
 ST_X(l.entrance::geometry),ST_Y(l.entrance::geometry),l.address,
 src.source_url,src.source_kind,src.checked_at,src.opening_hours_raw,src.access_raw,src.fee_raw,
 COALESCE((SELECT jsonb_object_agg(f.fact_key,f.value) FROM item_facts f WHERE f.item_id=i.item_id
   AND f.source=src.source_kind AND f.updated_at=src.checked_at AND f.fact_key IN ('indoor','toilet','shelter','seating','children_menu','small_portions','play_area')), '{}'::jsonb),
 `+distance+` AS distance_m
 FROM mapped i JOIN item_location l USING(item_id) LEFT JOIN item_map_sources src USING(item_id)
 WHERE i.api_category=ANY(`+fmt.Sprintf("$%d", categoryParam)+`::text[]) AND `+filter+`
 ORDER BY distance_m ASC NULLS LAST,i.item_id ASC LIMIT `+fmt.Sprintf("$%d OFFSET $%d", limitParam, offsetParam), args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var title, kind, address string
		var lon, lat float64
		var entranceLon, entranceLat, distanceM *float64
		var sourceURL, sourceKind, hours, access, fee *string
		var checked *time.Time
		var rawFacts []byte
		if err := rows.Scan(&id, &title, &kind, &lon, &lat, &entranceLon, &entranceLat, &address, &sourceURL, &sourceKind, &checked, &hours, &access, &fee, &rawFacts, &distanceM); err != nil {
			return result, err
		}
		if len(result.Items) == q.Limit {
			cursor := q.Next(q.Offset + q.Limit)
			result.NextCursor = &cursor
			break
		}
		p := c.Place{PlaceID: c.ID(strconv.Itoa(id)), Name: title, Location: c.Point{Coordinates: c.Position{lon, lat}}, Categories: []c.Category{c.Category(kind)}, DisplayClass: "neutral", DistanceM: distanceM, Address: &address, OpeningHoursRaw: hours, AccessRaw: access, FeeRaw: fee}
		if len(q.RouteLines) > 0 {
			p.DistanceM = nil
			p.DistanceToRouteM = distanceM
		}
		if entranceLon != nil && entranceLat != nil {
			p.Entrance = &c.Point{Coordinates: c.Position{*entranceLon, *entranceLat}}
		}
		if kind == "playground" {
			p.DisplayClass = "family"
		}
		var evidenceID c.ID
		if sourceURL != nil && sourceKind != nil && checked != nil {
			evidenceID = c.ID("map-source-" + strconv.Itoa(id))
			result.Evidence = append(result.Evidence, c.Evidence{EvidenceID: evidenceID, SourceURL: sourceURL, SourceKind: *sourceKind, CheckedAt: c.Instant(checked.UTC().Format(time.RFC3339))})
		}
		facts := map[string]json.RawMessage{}
		if err := json.Unmarshal(rawFacts, &facts); err != nil {
			return result, err
		}
		fact := func(key string) json.RawMessage {
			ids := []c.ID{}
			var value *bool
			if evidenceID != "" {
				_ = json.Unmarshal(facts[key], &value)
			}
			state := "unknown"
			if value != nil {
				state = "known"
				ids = append(ids, evidenceID)
			}
			raw, _ := json.Marshal(map[string]any{"state": state, "value": value, "evidence_ids": ids})
			return raw
		}
		p.Indoor, p.Toilet, p.Shelter, p.Seating = fact("indoor"), fact("toilet"), fact("shelter"), fact("seating")
		if kind == "restaurant" {
			// Construct the generated anonymous restaurant DTO without duplicating its type.
			raw, _ := json.Marshal(map[string]any{"restaurant": map[string]any{"children_menu": fact("children_menu"), "small_portions": fact("small_portions"), "play_area": fact("play_area"), "play_area_min_age": fact("unknown"), "play_area_max_age": fact("unknown"), "play_area_supervision": fact("unknown")}})
			var extra c.Place
			if err := json.Unmarshal(raw, &extra); err != nil {
				return result, err
			}
			p.Restaurant = extra.Restaurant
		}
		result.Items = append(result.Items, p)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}
