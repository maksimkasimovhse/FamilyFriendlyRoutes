#!/usr/bin/env bash
# Restore only the existing Go API + web path, without depending on LLM startup.
set -Eeuo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
nginx_config=""
if [[ $# -gt 0 ]]; then
  if [[ $# != 2 || "$1" != "--nginx-config" ]]; then
    printf 'Usage: %s [--nginx-config /path/to/existing/site.conf]\n' "$0" >&2
    exit 2
  fi
  nginx_config="$2"
  if [[ "${nginx_config}" == auto ]]; then
    nginx_config="$(sudo nginx -T 2>/dev/null | python3 -c '
import re,sys
parts=re.split(r"(?m)^# configuration file (.+):\n",sys.stdin.read())
paths=[parts[i] for i in range(1,len(parts),2) if all(marker in parts[i+1] for marker in ("/parser/health","/model/health","family-friendly-routes"))]
if len(paths)!=1: raise SystemExit("Cannot uniquely identify the existing Family Routes nginx config; provide its path explicitly")
print(paths[0])
')"
  fi
  nginx_config="$(readlink -f "${nginx_config}")"
  [[ -f "${nginx_config}" ]] || { printf 'Existing nginx config required\n' >&2; exit 2; }
  if sudo grep -Eq 'ssl_certificate|listen[^;]*443' "${nginx_config}"; then
    printf 'This is a TLS virtual host; preserve its TLS settings and apply the /api/ upstream change manually.\n' >&2
    exit 2
  fi
fi

docker compose --project-directory "${repo_dir}" config --quiet
docker compose --project-directory "${repo_dir}" build backend model-service mock-api
docker compose --project-directory "${repo_dir}" up -d backend model-service mock-api web

# A 200 from an unrelated Python /health is not evidence that the Go API works.
api_ready=false
for attempt in {1..30}; do
  if python3 - <<'PY'
import json, urllib.request
try:
    with urllib.request.urlopen('http://127.0.0.1:8083/healthz', timeout=3) as r:
        assert r.headers.get('X-Family-Routes-Service') == 'backend'
        assert json.load(r)['status'] == 'alive'
    with urllib.request.urlopen('http://127.0.0.1:8000/api/v1/reference-data', timeout=3) as r:
        data = json.load(r)
        assert 'capabilities' in data and 'supported_city_ids' in data
except Exception:
    raise SystemExit(1)
PY
  then api_ready=true; break; fi
  sleep 2
done
if [[ "${api_ready}" != true ]]; then
  docker compose --project-directory "${repo_dir}" ps backend model-service web mock-api
  printf 'Go backend/web API verification failed; nginx was not changed.\n' >&2
  exit 1
fi

if [[ -n "${nginx_config}" ]]; then
  backup="${nginx_config}.before-backend-fix.$(date -u +%Y%m%dT%H%M%SZ)"
  sudo cp -p "${nginx_config}" "${backup}"
  if ! sudo install -m 0644 "${repo_dir}/ops/nginx/family-routes.conf" "${nginx_config}" \
    || ! sudo nginx -t \
    || ! sudo systemctl reload nginx; then
    sudo cp -p "${backup}" "${nginx_config}"
    printf 'Nginx installation, validation or reload failed; original config restored.\n' >&2
    exit 1
  fi
  python3 - <<'PY'
import json, urllib.request
with urllib.request.urlopen('http://127.0.0.1/api/v1/reference-data', timeout=5) as r:
    assert 'capabilities' in json.load(r)
print('Public nginx /api/ is served by Go backend.')
PY
fi
printf 'Go backend :8083 and web /api/ are working. Existing data and volumes preserved.\n'
