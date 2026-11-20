"""Call the configured LLM request parser from the command line."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))

from request_parser import OpenAIRequestParser  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("text", help="free-form family request")
    args = parser.parse_args()
    result = OpenAIRequestParser().parse(args.text)
    print(json.dumps({
        "response_id": result.response_id,
        "model": result.model,
        "parsed": result.parsed.model_dump(),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
