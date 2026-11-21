#!/usr/bin/env python3
"""Read-only checks required before marking a deployment successful."""
import argparse
import json
import urllib.request


def check(base, model_url):
    def get(url):
        with urllib.request.urlopen(url, timeout=15) as response:
            return json.load(response)
    reference = get(base.rstrip('/') + '/api/v1/reference-data')
    assert reference['capabilities']['assistant'], 'Assistant endpoint is not configured'
    assert reference['capabilities']['llm_understanding'], 'Initial needs parsing is not configured'
    assert reference['capabilities']['recommendations'], 'Real catalog is not configured'
    catalog = get(base.rstrip('/') + '/api/v1/map/places?lon=44&lat=56.32&radius_km=1&limit=1')
    assert isinstance(catalog['items'], list), 'Catalog query failed'
    assert catalog['items'], 'Infrastructure snapshot has not been imported'
    ready = get(model_url.rstrip('/') + '/ready')
    assert ready['catalog_version'] == 'city-enriched-v3' and ready['catalog_records'] > 0
    print(json.dumps({'api': 'ok', 'infrastructure': 'ok', 'model': 'ready', 'catalog_records': ready['catalog_records']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base_url', nargs='?', default='http://127.0.0.1:8000')
    parser.add_argument('--model-url', default='http://127.0.0.1:8082')
    args = parser.parse_args()
    check(args.base_url, args.model_url)
