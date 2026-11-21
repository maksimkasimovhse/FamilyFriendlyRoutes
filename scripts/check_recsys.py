"""Run the real RecSys HTTP service and Go backend scenario acceptance."""
from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'models'))
from recommendation_engine import ENRICHED_CATALOG_PATH, ENRICHED_CATALOG_VERSION


def main():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    address=f'http://127.0.0.1:{port}'
    with socket.socket() as parser_socket:
        parser_socket.bind(('127.0.0.1',0));parser_port=parser_socket.getsockname()[1]
    parser_address=f'http://127.0.0.1:{parser_port}'
    env={**os.environ,'PYTHONPATH':str(ROOT/'models')+os.pathsep+str(ROOT),
         'MODEL_CATALOG_PATH':str(ROOT/ENRICHED_CATALOG_PATH),'MODEL_CATALOG_VERSION':ENRICHED_CATALOG_VERSION,
         'MVP_MODEL_URL':address,'MVP_PARSER_URL':parser_address,'ML_API_TOKEN':secrets.token_hex(24),'REQUEST_PARSER_URL':'','GIGACHAT_CREDENTIALS':'','GIGACHAT_ACCESS_TOKEN':'','ASSISTANT_RULES_FALLBACK':'true'}
    output=ROOT/'data/processed/recsys';output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryFile(mode='w+') as log:
        server=subprocess.Popen([sys.executable,'-m','uvicorn','services.model_service.app:app',
            '--host','127.0.0.1','--port',str(port)],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        parser_server=subprocess.Popen([sys.executable,'-m','uvicorn','services.parser_service.app:app','--host','127.0.0.1','--port',str(parser_port)],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            health=None;deadline=time.monotonic()+20
            with httpx.Client(timeout=2,trust_env=False) as client:
                while time.monotonic()<deadline and server.poll() is None:
                    try:
                        response=client.get(address+'/health')
                        if response.status_code==200 and client.get(parser_address+'/health').status_code==200:health=response.json();break
                    except httpx.HTTPError:pass
                    time.sleep(0.1)
            if health is None:
                log.seek(0);raise RuntimeError('RecSys did not become ready: '+log.read()[-2500:])
            completed=subprocess.run(['go','test','./internal/httpapi','-run','TestRecSysBackendScenarios|TestUserJourneyExplicitWalkingLimit','-v','-count=1'],
                                     cwd=ROOT,env=env,timeout=120)
            report=dict(checked_at=datetime.now(timezone.utc).isoformat(),passed=completed.returncode==0,model=health,
                routing='test_fixture_not_real_osm',llm='structured_test_double',checks=[
                    'initial/restaurant/along_route backend endpoints','source-backed restaurant filters',
                    'unknown properties do not match filters','fixed session preview/apply',
                    'toilet/rain/playground/tired/hotel needs','explicit hotel point required',
                    'real meal insertion and duration/balance','assistant food without map database',
                    'contextual choice creates preview','search and previews do not mutate trip',
                    'version conflict','ownership isolation','source-backed active start/progress/replan'])
            (output/'checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            if completed.returncode:raise SystemExit(completed.returncode)
            print('RecSys backend acceptance passed; report: data/processed/recsys/checks.json')
        finally:
            parser_server.terminate()
            try:parser_server.wait(timeout=5)
            except subprocess.TimeoutExpired:parser_server.kill();parser_server.wait()
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait()


if __name__=='__main__':main()
