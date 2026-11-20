"""GigaChat adapter for the versioned free-text request parser contract."""

from __future__ import annotations

import json
from dataclasses import dataclass

from gigachat_client import GigaChatStructuredClient
from request_schema import ParsedRequest, REQUEST_PARSER_INSTRUCTIONS, strict_schema, validate_evidence
from taxonomy import CATEGORIES, FORMATS, INTEREST_IDS, TAXONOMY_VERSION


@dataclass(frozen=True)
class GigaChatParserResult:
    parsed: ParsedRequest
    model: str
    usage: dict[str, object]


def parse_request_text(request_text: str, client: GigaChatStructuredClient) -> GigaChatParserResult:
    request_text = request_text.strip()
    if not request_text:
        raise ValueError("request_text must be nonempty")
    payload = {
        "request_text": request_text,
        "taxonomy": {
            "taxonomy_version": TAXONOMY_VERSION,
            "interest": INTEREST_IDS,
            "category": CATEGORIES,
            "format": FORMATS,
        },
    }
    response = client.extract(
        instructions=REQUEST_PARSER_INSTRUCTIONS,
        input_text=json.dumps(payload, ensure_ascii=False),
        schema=strict_schema(),
    )
    parsed = ParsedRequest.model_validate(response.value)
    validate_evidence(parsed, request_text)
    return GigaChatParserResult(parsed=parsed, model=response.model, usage=response.usage)
