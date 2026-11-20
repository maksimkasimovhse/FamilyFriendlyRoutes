"""Structured free-text parser backed by the OpenAI Responses API."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

import httpx

from request_schema import (
    ParsedRequest,
    REQUEST_PARSER_INSTRUCTIONS as INSTRUCTIONS,
    strict_schema as _strict_schema,
    validate_evidence,
)
from taxonomy import CATEGORIES, FORMATS, INTEREST_IDS, TAXONOMY_VERSION


@dataclass(frozen=True)
class ParserResult:
    parsed: ParsedRequest
    response_id: str
    model: str


class OpenAIRequestParser:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
        timeout_seconds: float = 30,
    ) -> None:
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY is not set")
        self.model = model or os.environ.get("OPENAI_MODEL", "gpt-6-luna")
        self.base_url = (base_url or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")).rstrip("/")
        self.timeout_seconds = timeout_seconds

    def parse(self, request_text: str) -> ParserResult:
        request_text = request_text.strip()
        if not request_text:
            raise ValueError("request_text must be nonempty")
        taxonomy = {
            "taxonomy_version": TAXONOMY_VERSION,
            "interest": INTEREST_IDS,
            "category": CATEGORIES,
            "format": FORMATS,
        }
        payload = {
            "model": self.model,
            "store": False,
            "instructions": INSTRUCTIONS,
            "input": json.dumps({"request_text": request_text, "taxonomy": taxonomy}, ensure_ascii=False),
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "family_request_preferences",
                    "strict": True,
                    "schema": _strict_schema(),
                }
            },
        }
        with httpx.Client(timeout=self.timeout_seconds) as client:
            response = client.post(
                f"{self.base_url}/responses",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=payload,
            )
        response.raise_for_status()
        body = response.json()
        output_text = _extract_output_text(body)
        parsed = ParsedRequest.model_validate_json(output_text)
        validate_evidence(parsed, request_text)
        return ParserResult(parsed=parsed, response_id=body["id"], model=body.get("model", self.model))


def _extract_output_text(body: dict[str, object]) -> str:
    for item in body.get("output", []):  # type: ignore[union-attr]
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if isinstance(content, dict) and content.get("type") == "output_text":
                text = content.get("text")
                if isinstance(text, str):
                    return text
    raise ValueError("Responses API returned no output_text")
