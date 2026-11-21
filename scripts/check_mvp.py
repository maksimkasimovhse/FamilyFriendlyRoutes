"""Run the Python model + Go preview/apply integration without Docker or GigaChat.

Routing is a Go test fixture; real OSM geometry is verified separately.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
from recommendation_engine import CATALOG_RELATIVE_PATH, CATALOG_VERSION


def main() -> None:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    address = f"http://127.0.0.1:{port}"
    environment = {**os.environ, "PYTHONPATH": str(ROOT / "models") + os.pathsep + str(ROOT),
                   "MODEL_CATALOG_PATH": str(ROOT / CATALOG_RELATIVE_PATH),
                   "MODEL_CATALOG_VERSION": CATALOG_VERSION, "MVP_MODEL_URL": address}
    with tempfile.TemporaryFile(mode="w+") as log:
        server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "services.model_service.app:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 20
            health = None
            with httpx.Client(timeout=1, trust_env=False) as client:
                while time.monotonic() < deadline and server.poll() is None:
                    try:
                        response = client.get(address + "/ready")
                        if response.status_code == 200:
                            health = response.json()
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.1)
            if health is None:
                raise RuntimeError("model-service did not become ready")
            completed = subprocess.run(
                ["go", "test", "./internal/httpapi", "-run", "TestMVP(ModelPreviewApply|AssistantInitialAndCatalogChoice)", "-v", "-count=1"],
                cwd=ROOT, env=environment, timeout=120,
            )
            report = {"checked_at": datetime.now(timezone.utc).isoformat(), "passed": completed.returncode == 0,
                      "model": health, "routing": "test_fixture_not_real_osm",
                      "checks": ["recommendation HTTP contract", "mandatory selection", "preview does not mutate",
                                 "unknown data acknowledgement", "apply", "idempotent apply", "stale apply rejected",
                                 "validated snapshot survives ML outage", "fresh ML outage preserves draft and saved plan", "initial LLM understanding reaches model",
                                 "explicit time budget", "assistant catalog suggestions and contextual selection"]}
            output = ROOT / "data/processed/mvp/checks.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            if completed.returncode:
                raise SystemExit(completed.returncode)
            print(f"MVP check passed. Report: {output.relative_to(ROOT)}; routing fixture only.")
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    main()
