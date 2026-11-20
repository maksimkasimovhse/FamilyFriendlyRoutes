#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="${FAMILY_ROUTES_REPO:-/home/votter/FamilyFriendlyRoutes}"
branch="${FAMILY_ROUTES_BRANCH:-main}"
state_dir="${FAMILY_ROUTES_STATE_DIR:-/home/votter/.local/state/family-routes}"
state_file="${state_dir}/deployed-${branch}"
lock_file="${FAMILY_ROUTES_LOCK_FILE:-/tmp/family-routes-deploy.lock}"

mkdir -p "${state_dir}"
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

docker compose --project-directory "${repo_dir}" config --quiet
docker compose --project-directory "${repo_dir}" up -d --build --remove-orphans

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:8081/health >/dev/null \
    && curl --fail --silent --show-error http://127.0.0.1:8082/health >/dev/null; then
    printf '%s\n' "${target_commit}" > "${state_file}"
    printf 'Deployed origin/%s at %s\n' "${branch}" "${target_commit}"
    exit 0
  fi
  sleep 2
done

docker compose --project-directory "${repo_dir}" ps
docker compose --project-directory "${repo_dir}" logs --no-color --tail=100
printf 'Deployment health check failed for %s\n' "${target_commit}" >&2
exit 1
