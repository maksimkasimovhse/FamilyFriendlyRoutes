"""Fetch an approved site and extract catalog candidates with GigaChat."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))

from gigachat_client import GigaChatStructuredClient  # noqa: E402
from site_extractor import extract_site  # noqa: E402
from site_ingestion import SourcePolicy, fetch_page  # noqa: E402


def load_policy(path: Path, source_id: str) -> SourcePolicy:
    registry = json.loads(path.read_text(encoding="utf-8"))
    try:
        value = next(item for item in registry["sources"] if item["source_id"] == source_id)
    except (KeyError, StopIteration) as error:
        raise ValueError(f"source_id {source_id!r} is absent from registry") from error
    return SourcePolicy(
        source_id=value["source_id"],
        allowed_hosts=tuple(value["allowed_hosts"]),
        enabled=bool(value["enabled"]),
        respect_robots=bool(value.get("respect_robots", True)),
        max_response_bytes=int(value.get("max_response_bytes", 2_000_000)),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--registry", type=Path, default=ROOT / "data" / "source_registry.json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    policy = load_policy(args.registry, args.source_id)
    page = fetch_page(args.url, policy)
    extraction, llm = extract_site(page, GigaChatStructuredClient())
    result = {
        "document": {
            "source_id": policy.source_id,
            "requested_url": page.source_url,
            "final_url": page.final_url,
            "canonical_url": page.canonical_url,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "content_sha256": page.content_sha256,
        },
        "extractor": {"provider": "gigachat", "model": llm.model, "usage": llm.usage},
        "extraction": extraction.model_dump(mode="json"),
    }
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
