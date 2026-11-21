"""Safe SSR HTML retrieval and normalization before LLM extraction."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import socket
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup


USER_AGENT = "FamilyFriendlyRoutesCatalogBot/0.1 (+catalog ingestion; contact project owner)"


@dataclass(frozen=True)
class SourcePolicy:
    source_id: str
    allowed_hosts: tuple[str, ...]
    enabled: bool
    respect_robots: bool = True
    max_response_bytes: int = 2_000_000


@dataclass(frozen=True)
class NormalizedPage:
    source_url: str
    final_url: str
    title: str | None
    canonical_url: str | None
    text: str
    json_ld: tuple[object, ...]
    content_sha256: str


def _validate_url(url: str, policy: SourcePolicy) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("only absolute HTTP(S) URLs are supported")
    host = parsed.hostname.lower().rstrip(".")
    if host not in policy.allowed_hosts:
        raise ValueError(f"host {host!r} is not allowed for source {policy.source_id!r}")
    for info in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM):
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global:
            raise ValueError("private, loopback and link-local targets are forbidden")


def _robots_allows(client: httpx.Client, url: str) -> bool:
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    response = client.get(robots_url)
    if response.status_code == 404:
        return True
    if response.status_code != 200:
        raise PermissionError(f"cannot verify robots.txt: HTTP {response.status_code}")
    response.raise_for_status()
    parser = RobotFileParser()
    parser.set_url(robots_url)
    parser.parse(response.text.splitlines())
    return parser.can_fetch(USER_AGENT, url)


def fetch_page(url: str, policy: SourcePolicy, *, timeout_seconds: float = 20, raw_output: Path | None = None) -> NormalizedPage:
    if not policy.enabled:
        raise ValueError(f"source {policy.source_id!r} is disabled")
    _validate_url(url, policy)
    current_url = url
    with httpx.Client(headers={"User-Agent": USER_AGENT}, follow_redirects=False, timeout=timeout_seconds) as client:
        for _ in range(6):
            _validate_url(current_url, policy)
            if policy.respect_robots and not _robots_allows(client, current_url):
                raise PermissionError("robots.txt does not allow this fetch")
            with client.stream("GET", current_url) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("redirect has no Location header")
                    current_url = urljoin(current_url, location)
                    continue
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").lower()
                if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                    raise ValueError(f"unsupported content type: {content_type or 'missing'}")
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > policy.max_response_bytes:
                        raise ValueError("page exceeds source max_response_bytes")
                    chunks.append(chunk)
                raw = b"".join(chunks)
                final_url = str(response.url)
                break
        else:
            raise ValueError("too many redirects")
    if raw_output is not None:
        raw_output.parent.mkdir(parents=True, exist_ok=True)
        raw_output.write_bytes(raw)
    return normalize_html(raw, final_url=final_url, source_url=url)


def normalize_html(raw: bytes, *, final_url: str, source_url: str) -> NormalizedPage:
    soup = BeautifulSoup(raw, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else None
    canonical_node = soup.find("link", rel=lambda value: value and "canonical" in value)
    canonical = urljoin(final_url, canonical_node.get("href")) if canonical_node and canonical_node.get("href") else None

    json_ld: list[object] = []
    for node in soup.find_all("script", type="application/ld+json"):
        try:
            json_ld.append(json.loads(node.get_text()))
        except (json.JSONDecodeError, TypeError):
            continue

    root = soup.find("main") or soup.find("article") or soup.body or soup
    for node in root.find_all(["script", "style", "noscript", "svg", "nav", "footer", "header", "form"]):
        node.decompose()
    lines = []
    for value in root.stripped_strings:
        cleaned = re.sub(r"\s+", " ", value).strip()
        if cleaned:
            lines.append(cleaned)
    text = "\n".join(lines)
    return NormalizedPage(
        source_url=source_url,
        final_url=final_url,
        title=title,
        canonical_url=canonical,
        text=text,
        json_ld=tuple(json_ld),
        content_sha256=hashlib.sha256(raw).hexdigest(),
    )
