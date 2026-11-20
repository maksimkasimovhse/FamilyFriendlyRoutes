#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="${FAMILY_ROUTES_REPO:-/home/votter/FamilyFriendlyRoutes}"
branch="${FAMILY_ROUTES_BRANCH:-main}"
state_dir="${FAMILY_ROUTES_STATE_DIR:-/home/votter/.local/state/family-routes}"
state_file="${state_dir}/deployed-${branch}"
lock_file="${FAMILY_ROUTES_LOCK_FILE:-/tmp/family-routes-deploy.lock}"
docker_config="${FAMILY_ROUTES_DOCKER_CONFIG:-${state_dir}/docker}"
health_attempts="${FAMILY_ROUTES_HEALTH_ATTEMPTS:-480}"
health_interval="${FAMILY_ROUTES_HEALTH_INTERVAL:-2}"

mkdir -p "${state_dir}" "${docker_config}"
export DOCKER_CONFIG="${docker_config}"
export COMPOSE_BAKE=false
exec 9>"${lock_file}"
flock -n 9 || exit 0

git -C "${repo_dir}" fetch --quiet origin \
  "+refs/heads/${branch}:refs/remotes/origin/${branch}"
target_commit="$(git -C "${repo_dir}" rev-parse "origin/${branch}")"
deployed_commit="$(test -f "${state_file}" && cat "${state_file}" || true)"

if [[ "${target_commit}" == "${deployed_commit}" ]]; then
  exit 0
fi

# The updater may be installed before the deployment PR reaches main. Keep the
# currently running containers until main contains a deployable Compose file.
if ! git -C "${repo_dir}" cat-file -e "${target_commit}:compose.yaml" 2>/dev/null; then
  printf 'Skipping %s: compose.yaml is not present on origin/%s\n' "${target_commit}" "${branch}"
  printf '%s\n' "${target_commit}" > "${state_file}"
  exit 0
fi

git -C "${repo_dir}" switch --force-create "${branch}" "origin/${branch}"
git -C "${repo_dir}" reset --hard "${target_commit}"

if [[ -f "${repo_dir}/.env.example" && ! -f "${repo_dir}/.env" ]]; then
  database_password="$(openssl rand -hex 24)"
  umask 077
  sed "s/change-me/${database_password}/g" \
    "${repo_dir}/.env.example" > "${repo_dir}/.env"
  printf 'Created %s/.env with a generated database password\n' "${repo_dir}"
fi

routing_lock="${repo_dir}/infra/routing/osm-source.lock.json"
routing_file="${repo_dir}/data/routing/nizhny-novgorod.osm.pbf"
if [[ -f "${routing_lock}" ]]; then
  readarray -t routing_source < <(python3 - "${routing_lock}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    lock = json.load(source)
print(lock["source_url"])
print(lock["sha256"])
PY
  )
  routing_url="${routing_source[0]}"
  routing_sha256="${routing_source[1]}"

  if [[ ! -f "${routing_file}" ]] \
    || ! printf '%s  %s\n' "${routing_sha256}" "${routing_file}" | sha256sum --check --status; then
    mkdir -p "$(dirname "${routing_file}")"
    routing_download="$(mktemp "${routing_file}.download.XXXXXX")"
    trap 'rm -f "${routing_download:-}"' EXIT
    printf 'Downloading routing data pinned by %s\n' "${routing_lock}"
    curl --fail --location --retry 3 --output "${routing_download}" "${routing_url}"
    printf '%s  %s\n' "${routing_sha256}" "${routing_download}" | sha256sum --check --status
    mv "${routing_download}" "${routing_file}"
    trap - EXIT
  fi
fi

docker compose --project-directory "${repo_dir}" config --quiet
docker compose --project-directory "${repo_dir}" up -d --build --remove-orphans

readarray -t expected_services < <(
  docker compose --project-directory "${repo_dir}" config --format json \
    | python3 -c 'import json, sys; data=json.load(sys.stdin); print("\n".join(name for name, service in data["services"].items() if not service.get("profiles")))'
)

deployment_ready=false
for attempt in $(seq 1 "${health_attempts}"); do
  all_ready=true
  for service in "${expected_services[@]}"; do
    container_id="$(docker compose --project-directory "${repo_dir}" ps -q "${service}")"
    if [[ -z "${container_id}" ]]; then
      all_ready=false
      break
    fi
    container_state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_id}")"
    if [[ "${container_state}" != "running healthy" && "${container_state}" != "running none" ]]; then
      all_ready=false
      break
    fi
  done

  if [[ "${all_ready}" == true && ${#expected_services[@]} -gt 0 ]]; then
    deployment_ready=true
    break
  fi
  sleep "${health_interval}"
done

if [[ "${deployment_ready}" == true ]]; then
  if docker compose --project-directory "${repo_dir}" config --services | grep --quiet --line-regexp migrate; then
    docker compose --project-directory "${repo_dir}" --profile tools run --rm migrate
  fi
  printf '%s\n' "${target_commit}" > "${state_file}"
  printf 'Deployed origin/%s at %s\n' "${branch}" "${target_commit}"
  exit 0
fi

docker compose --project-directory "${repo_dir}" ps
docker compose --project-directory "${repo_dir}" logs --no-color --tail=100
printf 'Deployment health check failed for %s\n' "${target_commit}" >&2
exit 1
