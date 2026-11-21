"""Exercise parser-service → model-service with HTTP JSON contracts."""

from __future__ import annotations

import argparse
import json
import os
import uuid
from pathlib import Path

import httpx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="Хотим животных и активную прогулку, без музеев")
    parser.add_argument("--candidates", type=Path, default=Path("data/fixtures/microservice_candidates.json"))
    parser.add_argument("--parsed-fixture", type=Path, help="skip GigaChat and use an already validated parser response")
    parser.add_argument("--parser-url", default="http://127.0.0.1:8081")
    parser.add_argument("--model-url", default="http://127.0.0.1:8082")
    args = parser.parse_args()

    request_id = str(uuid.uuid4())
    with httpx.Client(timeout=90) as client:
        if args.parsed_fixture:
            parsed = json.loads(args.parsed_fixture.read_text(encoding="utf-8"))
        else:
            response = client.post(
                f"{args.parser_url}/internal/v1/request-parses",
                headers={"Authorization": "Bearer " + os.environ["ML_API_TOKEN"]} if os.environ.get("ML_API_TOKEN") else {},
                json={"contract_version": "1.0", "request_id": request_id, "text": args.text},
            )
            response.raise_for_status()
            parsed = response.json()["parsed_request"]
        candidates = json.loads(args.candidates.read_text(encoding="utf-8"))
        response = client.post(
            f"{args.model_url}/internal/v1/rankings",
            headers={"Authorization": "Bearer " + os.environ["ML_API_TOKEN"]} if os.environ.get("ML_API_TOKEN") else {},
            json={
                "contract_version": "1.0",
                "request_id": request_id,
                "parsed_request": parsed,
                "candidates": candidates,
                "limit": 10,
            },
        )
        response.raise_for_status()
        print(json.dumps(response.json(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
