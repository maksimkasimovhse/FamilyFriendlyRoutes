#!/usr/bin/env python3
"""Read-only deployment audit. Prints counts and paths, never credentials or records.

Run on the Docker host: python3 scripts/audit_runtime_data.py
An absent file is reported separately from an existing empty store.
"""
from __future__ import annotations

import argparse
import json
import posixpath
import subprocess
from pathlib import Path, PurePosixPath


DEMO_EMAILS = ("masha@example.com", "petya@example.com")
STATE_COLLECTIONS = ("accounts", "family_profiles", "trips", "sessions", "previews", "receipts")
TABLES = ("catalog_versions", "items", "item_location", "item_content", "item_images", "item_facts", "item_map_sources")


def summarize_state(path: Path) -> dict:
    report = {"path": str(path), "exists": path.exists()}
    if not path.is_file():
        return report
    try:
        raw = path.read_bytes()
        state = json.loads(raw)
        if not isinstance(state, dict) or any(not isinstance(state.get(k, {}), dict) for k in STATE_COLLECTIONS) or any(k not in state for k in ("sessions", "trips", "previews", "receipts")):
            raise ValueError("invalid store structure")
        accounts = state.get("accounts", {})
        profiles = state.get("family_profiles", {})
        report.update(bytes=len(raw), counts={k: len(state.get(k, {})) for k in STATE_COLLECTIONS})
        report["demo_accounts"] = {}
        for email in DEMO_EMAILS:
            account = next((a for a in accounts.values() if isinstance(a, dict) and a.get("email") == email), None)
            report["demo_accounts"][email] = {"exists": account is not None,
                "has_profile": account is not None and account.get("user_id") in profiles}
    except (OSError, ValueError) as error:
        report["read_error"] = type(error).__name__
    return report


def mapped_store(container: dict) -> dict:
    config = container.get("Config", {})
    args = container.get("Args", config.get("Cmd")) or []
    store = "data/backend/state.json"
    for index, arg in enumerate(args):
        if arg in ("-store", "--store") and index + 1 < len(args):
            store = args[index + 1]
        elif arg.startswith(("-store=", "--store=")):
            store = arg.split("=", 1)[1]
    location = PurePosixPath(posixpath.normpath(posixpath.join(config.get("WorkingDir") or "/", store)))
    report = {"container_path": str(location), "persistent_mount": False}
    # Prefer a mount of /app/data/backend over its parent /app/data.
    mounts = sorted(container.get("Mounts", []), key=lambda m: len(m.get("Destination", "")), reverse=True)
    for mount in mounts:
        destination = PurePosixPath(mount["Destination"])
        if location.is_relative_to(destination):
            report.update(persistent_mount=mount.get("Type") in ("bind", "volume"),
                mount_type=mount.get("Type"), writable=mount.get("RW"),
                host_path=str(Path(mount["Source"]) / str(location.relative_to(destination))))
            break
    return report


def command(args: list[str], root: Path) -> str:
    result = subprocess.run(args, cwd=root, text=True, capture_output=True, timeout=20)
    if result.returncode:
        # Docker stderr/config can contain environment data; don't include it.
        raise RuntimeError("command failed")
    return result.stdout.strip()


def audit(root: Path) -> dict:
    report = {"repository": str(root), "repository_store": summarize_state(root / "data/backend/state.json")}
    compose = ["docker", "compose", "--project-directory", str(root)]
    try:
        ids = command(compose + ["ps", "-q", "backend"], root).splitlines()
        if len(ids) != 1:
            raise RuntimeError("expected one running backend")
        container = json.loads(command(["docker", "inspect", ids[0]], root))[0]
        report["runtime_store"] = mapped_store(container)
        if report["runtime_store"].get("host_path"):
            report["runtime_store"]["host_state"] = summarize_state(Path(report["runtime_store"]["host_path"]))
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        report["runtime_error"] = "Cannot inspect backend; run on its Docker host with Docker access."
    try:
        psql = compose + ["exec", "-T", "postgres", "psql", "-X", "-U", "familyroutes", "-d", "familyroutes", "-tA", "-v", "ON_ERROR_STOP=1", "-c"]
        tables = {}
        report["postgres"] = tables
        for table in TABLES:
            exists = command(psql + [f"BEGIN READ ONLY; SELECT to_regclass('public.{table}') IS NOT NULL; COMMIT;"], root).splitlines()
            if "t" not in exists:
                tables[table] = {"exists": False}
                continue
            rows = command(psql + [f"BEGIN READ ONLY; SELECT count(*) FROM public.{table}; COMMIT;"], root).splitlines()
            tables[table] = {"exists": True, "rows": next(int(row) for row in rows if row.isdigit())}
        report["postgres"] = tables
    except (OSError, ValueError, RuntimeError, StopIteration, subprocess.TimeoutExpired):
        report["postgres_error"] = "Cannot read catalog tables; check postgres container and access."
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    print(json.dumps(audit(args.repo.resolve()), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
