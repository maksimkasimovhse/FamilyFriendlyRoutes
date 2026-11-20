// Package mapdata reads published infrastructure from the catalog PostgreSQL database.
package mapdata

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

var ErrQuery = errors.New("invalid map query")
var Categories = []string{"playground", "park", "bench", "toilet", "pharmacy", "restaurant"}

type Query struct {
	Lon, Lat, RadiusM float64
	BBox              *[4]float64
	Categories        []string
	Limit, Offset     int
}

func bad(message string) error { return fmt.Errorf("%w: %s", ErrQuery, message) }
func number(s string) (float64, error) {
	n, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, bad("координаты и радиус должны быть конечными числами")
	}
	return n, nil
}
func Parse(v url.Values) (Query, error) {
	q := Query{Limit: 100, Categories: append([]string{}, Categories...)}
	allowed := []string{"lon", "lat", "radius_km", "bbox", "categories", "limit", "cursor", "date", "include_other"}
	for k, values := range v {
		if !slices.Contains(allowed, k) || len(values) != 1 && k != "categories" {
			return q, bad("неизвестный или повторный параметр " + k)
		}
	}
	if v.Has("bbox") {
		if v.Has("lon") || v.Has("lat") || v.Has("radius_km") {
			return q, bad("передайте bbox ИЛИ lon, lat, radius_km")
		}
		parts := strings.Split(v.Get("bbox"), ",")
		if len(parts) != 4 {
			return q, bad("bbox: minLon,minLat,maxLon,maxLat")
		}
		bounds := [4]float64{}
		for i, p := range parts {
			n, err := number(p)
			if err != nil {
				return q, err
			}
			bounds[i] = n
		}
		if bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -90 || bounds[3] > 90 || bounds[0] >= bounds[2] || bounds[1] >= bounds[3] || bounds[2]-bounds[0] > 1 || bounds[3]-bounds[1] > 1 {
			return q, bad("некорректный bbox; размер не более 1° по каждой оси")
		}
		q.BBox = &bounds
	} else {
		var err error
		if q.Lon, err = number(v.Get("lon")); err != nil {
			return q, err
		}
		if q.Lat, err = number(v.Get("lat")); err != nil {
			return q, err
		}
		if q.RadiusM, err = number(v.Get("radius_km")); err != nil {
			return q, err
		}
		if q.Lon < -180 || q.Lon > 180 || q.Lat < -90 || q.Lat > 90 || q.RadiusM <= 0 || q.RadiusM > 20 {
			return q, bad("lon: −180..180; lat: −90..90; radius_km: больше 0 и не больше 20")
		}
		q.RadiusM *= 1000
	}
	if v.Has("limit") {
		n, err := strconv.Atoi(v.Get("limit"))
		if err != nil || n < 1 || n > 1000 {
			return q, bad("limit: 1..1000")
		}
		q.Limit = n
	}
	if v.Has("date") {
		if _, err := time.Parse("2006-01-02", v.Get("date")); err != nil {
			return q, bad("date: YYYY-MM-DD")
		}
	}
	if v.Has("include_other") && v.Get("include_other") != "false" {
		return q, bad("include_other пока поддерживает только false")
	}
	if v.Has("categories") {
		q.Categories = []string{}
		for _, value := range v["categories"] {
			for _, kind := range strings.Split(value, ",") {
				if !slices.Contains(Categories, kind) || slices.Contains(q.Categories, kind) {
					return q, bad("неизвестная или повторная категория " + kind)
				}
				q.Categories = append(q.Categories, kind)
			}
		}
		slices.Sort(q.Categories)
	}
	if v.Has("cursor") {
		raw, err := base64.RawURLEncoding.DecodeString(v.Get("cursor"))
		var cursor struct {
			Offset int
			Query  string
		}
		if len(raw) > 256 || err != nil || json.Unmarshal(raw, &cursor) != nil || cursor.Query != q.fingerprint() || cursor.Offset < 1 || cursor.Offset > 100000 {
			return q, bad("cursor не соответствует запросу")
		}
		q.Offset = cursor.Offset
	}
	return q, nil
}
func (q Query) fingerprint() string {
	q.Offset = 0
	raw, _ := json.Marshal(q)
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}
func (q Query) Next(offset int) string {
	raw, _ := json.Marshal(struct {
		Offset int
		Query  string
	}{offset, q.fingerprint()})
	return base64.RawURLEncoding.EncodeToString(raw)
}
