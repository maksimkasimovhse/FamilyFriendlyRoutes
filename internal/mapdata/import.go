package mapdata

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Feature struct {
	Type     string `json:"type"`
	Geometry struct {
		Type        string    `json:"type"`
		Coordinates []float64 `json:"coordinates"`
	} `json:"geometry"`
	Properties struct {
		OSM            string            `json:"osm"`
		Kind           string            `json:"kind"`
		Name           string            `json:"name"`
		GeometrySource string            `json:"geometry_source"`
		Tags           map[string]string `json:"tags"`
	} `json:"properties"`
}
type Snapshot struct {
	Type      string    `json:"type"`
	CheckedAt time.Time `json:"checked_at"`
	Features  []Feature `json:"features"`
}

var osmID = regexp.MustCompile(`^(node|way|relation)/[1-9][0-9]*$`)
var slugs = map[string]string{"playground": "playgrounds", "park": "parks", "bench": "benches", "toilet": "toilets", "pharmacy": "pharmacies", "restaurant": "cafes"}
var titles = map[string]string{"playground": "Детская площадка", "park": "Парк", "bench": "Скамейка", "toilet": "Туалет", "pharmacy": "Аптека", "restaurant": "Кафе или ресторан"}

func ParseSnapshot(r io.Reader) (Snapshot, error) {
	var snapshot Snapshot
	decoder := json.NewDecoder(io.LimitReader(r, 32*1024*1024))
	if err := decoder.Decode(&snapshot); err != nil {
		return snapshot, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return snapshot, fmt.Errorf("expected one GeoJSON document")
	}
	if snapshot.Type != "FeatureCollection" || snapshot.CheckedAt.IsZero() || snapshot.CheckedAt.After(time.Now().Add(24*time.Hour)) || len(snapshot.Features) == 0 {
		return snapshot, fmt.Errorf("missing type, checked_at or features")
	}
	seen := map[string]bool{}
	for _, f := range snapshot.Features {
		if f.Type != "Feature" || f.Geometry.Type != "Point" || len(f.Geometry.Coordinates) != 2 || !osmID.MatchString(f.Properties.OSM) || slugs[f.Properties.Kind] == "" || seen[f.Properties.OSM] {
			return snapshot, fmt.Errorf("invalid/duplicate feature %q", f.Properties.OSM)
		}
		seen[f.Properties.OSM] = true
		p := f.Geometry.Coordinates
		if math.IsNaN(p[0]) || math.IsNaN(p[1]) || math.IsInf(p[0], 0) || math.IsInf(p[1], 0) || p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90 {
			return snapshot, fmt.Errorf("invalid coordinates for %s", f.Properties.OSM)
		}
	}
	return snapshot, nil
}

// Import is atomic and idempotent by (osm_infrastructure, OSM type/id).
// Reimport never changes editorial visibility flags and never guesses family amenities.
func Import(ctx context.Context, tx pgx.Tx, s Snapshot, version string) (int, error) {
	if _, err := tx.Exec(ctx, `INSERT INTO catalog_versions(version,note) VALUES($1,'OSM infrastructure snapshot') ON CONFLICT(version) DO NOTHING`, version); err != nil {
		return 0, err
	}
	count := 0
	for _, f := range s.Features {
		p := f.Properties
		if p.Tags["access"] == "private" || p.Tags["access"] == "no" {
			continue
		}
		title := strings.TrimSpace(p.Name)
		if title == "" {
			title = titles[p.Kind]
		}
		var id int
		err := tx.QueryRow(ctx, `INSERT INTO items(item_type,category_id,show_in_cards,title,source_dataset,source_id,catalog_version)
 SELECT item_type,category_id,false,$2,'osm_infrastructure',$3,$4 FROM categories WHERE slug=$1
 ON CONFLICT(source_dataset,source_id) DO UPDATE SET title=EXCLUDED.title,category_id=EXCLUDED.category_id,catalog_version=EXCLUDED.catalog_version,updated_at=now()
 RETURNING item_id`, slugs[p.Kind], title, p.OSM, version).Scan(&id)
		if err != nil {
			return count, fmt.Errorf("%s: category/items: %w", p.OSM, err)
		}
		address := strings.TrimSpace(p.Tags["addr:street"] + " " + p.Tags["addr:housenumber"])
		_, err = tx.Exec(ctx, `INSERT INTO item_location(item_id,location,address) VALUES($1,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,$4)
 ON CONFLICT(item_id) DO UPDATE SET location=EXCLUDED.location,address=EXCLUDED.address`, id, f.Geometry.Coordinates[0], f.Geometry.Coordinates[1], address)
		if err != nil {
			return count, err
		}
		raw, _ := json.Marshal(f)
		_, err = tx.Exec(ctx, `INSERT INTO item_raw(item_id,raw,source_file) VALUES($1,$2::jsonb,'osm-infrastructure.geojson') ON CONFLICT(item_id) DO UPDATE SET raw=EXCLUDED.raw,loaded_at=now()`, id, string(raw))
		if err != nil {
			return count, err
		}
		_, err = tx.Exec(ctx, `INSERT INTO item_map_sources(item_id,source_url,source_kind,checked_at,opening_hours_raw,access_raw,fee_raw)
 VALUES($1,$2,'osm',$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,'')) ON CONFLICT(item_id) DO UPDATE SET
 source_url=EXCLUDED.source_url,source_kind=EXCLUDED.source_kind,checked_at=EXCLUDED.checked_at,
 opening_hours_raw=EXCLUDED.opening_hours_raw,access_raw=EXCLUDED.access_raw,fee_raw=EXCLUDED.fee_raw`, id, "https://www.openstreetmap.org/"+p.OSM, s.CheckedAt, p.Tags["opening_hours"], p.Tags["access"], p.Tags["fee"])
		if err != nil {
			return count, err
		}
		// Remove only facts owned by this import. Official/manual facts take precedence.
		_, err = tx.Exec(ctx, `DELETE FROM item_facts WHERE item_id=$1 AND source='osm' AND fact_key IN ('toilet','seating','shelter','indoor')`, id)
		if err != nil {
			return count, err
		}
		facts := map[string]bool{}
		if p.Kind == "toilet" {
			facts["toilet"] = true
		}
		if p.Kind == "bench" {
			facts["seating"] = true
		}
		for _, key := range []string{"indoor", "shelter"} {
			if v := p.Tags[key]; v == "yes" || v == "no" {
				facts[key] = v == "yes"
			}
		}
		for key, value := range facts {
			raw, _ := json.Marshal(value)
			_, err = tx.Exec(ctx, `INSERT INTO item_facts(item_id,fact_key,value,source,evidence_ids,updated_at) VALUES($1,$2,$3::jsonb,'osm',$4,$5) ON CONFLICT(item_id,fact_key) DO NOTHING`, id, key, string(raw), []string{fmt.Sprintf("map-source-%d", id)}, s.CheckedAt)
			if err != nil {
				return count, err
			}
		}
		count++
	}
	return count, nil
}
