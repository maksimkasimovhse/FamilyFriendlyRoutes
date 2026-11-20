// Package catalog читает CSV-наборы мест и загружает их в PostgreSQL.
package catalog

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Row — одна запись набора данных.
type Row struct {
	ID          string
	Title       string
	Category    string
	Description string
	Address     string
	Lon, Lat    float64
	Raw         map[string]string // строка CSV целиком, сохраняется в item_raw
}

var requiredColumns = []string{"id", "address", "coordinate", "description", "title", "category"}

var pointRe = regexp.MustCompile(`^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$`)

// ParsePoint разбирает WKT вида "POINT (lon lat)".
func ParsePoint(s string) (lon, lat float64, err error) {
	m := pointRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, 0, fmt.Errorf("координата %q не в формате POINT (lon lat)", s)
	}
	lon, _ = strconv.ParseFloat(m[1], 64)
	lat, _ = strconv.ParseFloat(m[2], 64)
	if math.IsNaN(lon) || math.IsNaN(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90 {
		return 0, 0, fmt.Errorf("координата %q вне допустимого диапазона", s)
	}
	return lon, lat, nil
}

// ParseCSV читает набор с заголовком. Ошибка в любой строке прерывает разбор:
// частично загруженный каталог хуже отказа с понятным сообщением.
func ParseCSV(r io.Reader) ([]Row, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	reader := csv.NewReader(bytes.NewReader(raw))
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("заголовок CSV: %w", err)
	}
	index := map[string]int{}
	for i, name := range header {
		index[strings.TrimSpace(name)] = i
	}
	for _, name := range requiredColumns {
		if _, ok := index[name]; !ok {
			return nil, fmt.Errorf("в CSV нет колонки %q", name)
		}
	}
	var rows []Row
	seen := map[string]bool{}
	for line := 2; ; line++ {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("запись %d: %w", line, err)
		}
		if len(record) != len(header) {
			return nil, fmt.Errorf("запись %d: %d полей, ожидалось %d", line, len(record), len(header))
		}
		get := func(name string) string { return strings.TrimSpace(record[index[name]]) }
		row := Row{
			ID: get("id"), Title: get("title"), Category: get("category"),
			Description: get("description"), Address: get("address"),
			Raw: map[string]string{},
		}
		for i, name := range header {
			row.Raw[strings.TrimSpace(name)] = record[i]
		}
		for _, f := range []struct{ name, value string }{
			{"id", row.ID}, {"title", row.Title}, {"category", row.Category},
			{"description", row.Description}, {"address", row.Address},
		} {
			if f.value == "" {
				return nil, fmt.Errorf("запись %d (id=%s): пустое поле %q", line, row.ID, f.name)
			}
		}
		if seen[row.ID] {
			return nil, fmt.Errorf("запись %d: повторяющийся id %s", line, row.ID)
		}
		seen[row.ID] = true
		if row.Lon, row.Lat, err = ParsePoint(get("coordinate")); err != nil {
			return nil, fmt.Errorf("запись %d (id=%s): %w", line, row.ID, err)
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, errors.New("в CSV нет данных")
	}
	return rows, nil
}
