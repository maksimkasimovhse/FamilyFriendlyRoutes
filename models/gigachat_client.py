"""Minimal GigaChat v2 client with OAuth and strict JSON-schema output."""

from __future__ import annotations

import json
import os
import ssl
import time
import uuid
from dataclasses import dataclass

import httpx


OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
DEFAULT_BASE_URL = "https://api.giga.chat"


@dataclass(frozen=True)
class StructuredResponse:
    value: dict[str, object]
    model: str
    usage: dict[str, object]


class GigaChatStructuredClient:
    def __init__(
        self,
        *,
        credentials: str | None = None,
        access_token: str | None = None,
        scope: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
        ca_bundle: str | None = None,
        timeout_seconds: float = 180,
    ) -> None:
        self.credentials = credentials or os.environ.get("GIGACHAT_CREDENTIALS")
        self.access_token = access_token or os.environ.get("GIGACHAT_ACCESS_TOKEN")
        if not self.credentials and not self.access_token:
            raise ValueError("GIGACHAT_CREDENTIALS or GIGACHAT_ACCESS_TOKEN is required")
        self.scope = scope or os.environ.get("GIGACHAT_SCOPE", "GIGACHAT_API_PERS")
        if self.scope not in ("GIGACHAT_API_PERS", "GIGACHAT_API_B2B", "GIGACHAT_API_CORP"):
            raise ValueError("invalid GIGACHAT_SCOPE")
        self.model = model or os.environ.get("GIGACHAT_MODEL", "GigaChat-3-Pro")
        self.base_url = (base_url or os.environ.get("GIGACHAT_BASE_URL", DEFAULT_BASE_URL)).rstrip("/")
        bundle = ca_bundle or os.environ.get("GIGACHAT_CA_BUNDLE")
        # Keep the platform trust store and add the Ministry certificate when
        # configured. Replacing the store would break unrelated HTTPS chains.
        self.ssl_context = ssl.create_default_context()
        if bundle:
            self.ssl_context.load_verify_locations(cafile=bundle)
        self.timeout_seconds = timeout_seconds
        self._token_valid_until = time.monotonic() + 25 * 60 if self.access_token else 0.0

    def _get_token(self) -> str:
        if self.access_token and time.monotonic() < self._token_valid_until:
            return self.access_token
        authorization = self.credentials or ""
        if not authorization.lower().startswith("basic "):
            authorization = f"Basic {authorization}"
        with httpx.Client(verify=self.ssl_context, timeout=self.timeout_seconds) as client:
            response = client.post(
                OAUTH_URL,
                headers={
                    "Authorization": authorization,
                    "RqUID": str(uuid.uuid4()),
                    "Accept": "application/json",
                },
                data={"scope": self.scope},
            )
        response.raise_for_status()
        token = response.json().get("access_token")
        if not isinstance(token, str) or not token:
            raise ValueError("GigaChat OAuth response contains no access_token")
        self.access_token = token
        self._token_valid_until = time.monotonic() + 25 * 60
        return token

    def extract(self, *, instructions: str, input_text: str, schema: dict[str, object]) -> StructuredResponse:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": [{"text": instructions}]},
                {"role": "user", "content": [{"text": input_text}]},
            ],
            "model_options": {
                "response_format": {"type": "json_schema", "schema": schema, "strict": True}
            },
        }
        with httpx.Client(verify=self.ssl_context, timeout=self.timeout_seconds) as client:
            response = client.post(
                f"{self.base_url}/v2/chat/completions",
                headers={"Authorization": f"Bearer {self._get_token()}"},
                json=payload,
            )
        response.raise_for_status()
        body = response.json()
        try:
            text = body["messages"][0]["content"][0]["text"]
        except (KeyError, IndexError, TypeError) as error:
            raise ValueError("GigaChat response contains no assistant text") from error
        if not isinstance(text, str):
            raise ValueError("GigaChat assistant content is not text")
        return StructuredResponse(value=json.loads(text), model=str(body.get("model", self.model)), usage=body.get("usage", {}))
