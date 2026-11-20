from __future__ import annotations

import asyncio
import json
import os
import hmac
from functools import lru_cache
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from assistant_schema import parse_assistant

from gigachat_client import GigaChatStructuredClient
from gigachat_request_parser import parse_request_text
from site_extractor import extract_site
from site_ingestion import SourcePolicy, fetch_page
from shared.contracts import CatalogExtractionRequest, ParseTextRequest, ParseTextResponse


app = FastAPI(title="Family Routes Parser Service", version="1.0.0")
REGISTRY_PATH = Path(os.environ.get("SOURCE_REGISTRY_PATH", "/app/config/source_registry.json"))


@lru_cache(maxsize=2)
def online_client(interactive: bool = True):
    return GigaChatStructuredClient(timeout_seconds=12 if interactive else 180)


@app.middleware("http")
async def service_auth(request: Request, call_next):
    token = os.environ.get("ML_API_TOKEN", "")
    if request.url.path != "/health" and token and not hmac.compare_digest(
        request.headers.get("authorization", "").encode(), ("Bearer " + token).encode()
    ):
        return JSONResponse(status_code=401, content={"detail": "Service authentication required"})
    return await call_next(request)


class AssistantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contract_version: str = Field(pattern=r"^1\.0$")
    request_id: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=4000)
    context: dict


@app.post("/internal/v1/assistant-intents")
async def assistant_intent(request: AssistantRequest):
    if len(json.dumps(request.context, ensure_ascii=False)) > 100000:
        raise HTTPException(422, "Context is too large")
    try:
        intent, result = await asyncio.to_thread(parse_assistant, request.message, request.context, online_client())
    except (httpx.HTTPError, OSError):
        raise HTTPException(503, "LLM is unavailable") from None
    except ValueError:
        raise HTTPException(502, "Invalid structured LLM response or configuration") from None
    return {"contract_version": "1.0", "request_id": request.request_id,
            "intent": intent.model_dump(mode="json"),
            "parser": {"provider": "gigachat", "model": result.model, "usage": result.usage}}


def load_policy(source_id: str) -> SourcePolicy:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    try:
        value = next(item for item in registry["sources"] if item["source_id"] == source_id)
    except (KeyError, StopIteration) as error:
        raise ValueError(f"unknown source_id: {source_id}") from error
    return SourcePolicy(
        source_id=value["source_id"],
        allowed_hosts=tuple(value["allowed_hosts"]),
        enabled=bool(value["enabled"]),
        respect_robots=bool(value.get("respect_robots", True)),
        max_response_bytes=int(value.get("max_response_bytes", 2_000_000)),
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "parser-service"}


@app.post("/internal/v1/request-parses", response_model=ParseTextResponse)
async def request_parse(request: ParseTextRequest) -> dict[str, object]:
    try:
        result = await asyncio.to_thread(parse_request_text, request.text, online_client())
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="LLM is unavailable") from None
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {
        "contract_version": "1.0",
        "request_id": request.request_id,
        "parser": {"provider": "gigachat", "model": result.model, "usage": result.usage},
        "parsed_request": result.parsed.model_dump(mode="json"),
    }


@app.post("/internal/v1/catalog-extractions")
async def catalog_extraction(request: CatalogExtractionRequest) -> dict[str, object]:
    try:
        policy = load_policy(request.source_id)
        page = await asyncio.to_thread(fetch_page, request.url, policy)
        extraction, llm = await asyncio.to_thread(extract_site, page, GigaChatStructuredClient())
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {
        "contract_version": "1.0",
        "request_id": request.request_id,
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
