package routing

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"regexp"
)

// Manifest tracks the input PBF, not an assertion of real-world data completeness.
type Manifest struct {
	SourceURL          string `json:"source_url"`
	DownloadedAt       string `json:"downloaded_at"`
	ProviderState      string `json:"provider_state"`
	SHA256             string `json:"sha256"`
	RoutingDataVersion string `json:"routing_data_version"`
}

func LoadManifest(filename string) (Manifest, error) {
	raw, err := os.ReadFile(filename)
	if err != nil {
		return Manifest{}, err
	}
	var manifest Manifest
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), &manifest); err != nil {
		return Manifest{}, err
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(manifest.SHA256) || manifest.RoutingDataVersion != "osm-nizhny-"+manifest.SHA256 {
		return Manifest{}, errors.New("manifest has no valid routing data version")
	}
	return manifest, nil
}
