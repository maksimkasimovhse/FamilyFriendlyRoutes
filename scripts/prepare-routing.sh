#!/usr/bin/env bash
# Linux/macOS-версия scripts/prepare-routing.ps1: скачивает OSM-выгрузку
# Нижегородской области и пишет data/routing/source-manifest.json того же формата.
# Запуск: bash scripts/prepare-routing.sh [--refresh]
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
data_dir="$repo_root/data/routing"
base_url='https://download.openstreetmap.fr/extracts/russia/volga_federal_district'
source_url="$base_url/nizhny_novgorod_oblast-latest.osm.pbf"
pbf="$data_dir/nizhny-novgorod.osm.pbf"
manifest="$data_dir/source-manifest.json"
mkdir -p "$data_dir"

if [[ -f "$pbf" && -f "$manifest" && "${1:-}" != "--refresh" ]]; then
  expected=$(sed -n 's/.*"sha256": *"\([a-f0-9]\{64\}\)".*/\1/p' "$manifest")
  actual=$(sha256sum "$pbf" | cut -d' ' -f1)
  [[ "$expected" == "$actual" ]] || { echo 'Existing PBF checksum does not match manifest. Use --refresh.' >&2; exit 1; }
  echo "Verified existing OSM snapshot: osm-nizhny-$actual"
  exit 0
fi

partial="$pbf.partial"
echo 'Downloading Nizhny Novgorod oblast OSM extract (approximately 75 MB)...'
curl --fail --location --silent --show-error --max-time 600 -o "$partial" "$source_url"
expected_md5=$(curl --fail --silent --max-time 30 "$base_url/nizhny_novgorod_oblast.osm.pbf.md5" | grep -o -E '[a-fA-F0-9]{32}' | head -1 | tr 'A-F' 'a-f')
[[ -n "$expected_md5" ]] || { echo 'Provider returned no valid MD5 checksum.' >&2; exit 1; }
actual_md5=$(md5sum "$partial" | cut -d' ' -f1)
[[ "$actual_md5" == "$expected_md5" ]] || { echo 'Provider checksum mismatch; retry later.' >&2; exit 1; }
sha=$(sha256sum "$partial" | cut -d' ' -f1)
state=$(curl --fail --silent --max-time 30 "$base_url/nizhny_novgorod_oblast.state.txt" | tr -d '\r' | sed 's/\\/\\\\/g; s/"/\\"/g' | paste -sd'|' | sed 's/|/\\n/g')
mv -f "$partial" "$pbf"
cat > "$manifest" <<EOF
{
  "source_url": "$source_url",
  "downloaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "provider_state": "$state",
  "md5": "$actual_md5",
  "sha256": "$sha",
  "size_bytes": $(stat -c %s "$pbf"),
  "routing_data_version": "osm-nizhny-$sha",
  "attribution": "© OpenStreetMap contributors",
  "license_url": "https://www.openstreetmap.org/copyright"
}
EOF
echo "Verified and saved OSM snapshot: osm-nizhny-$sha"
