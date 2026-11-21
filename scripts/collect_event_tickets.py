"""Collect bounded, publicly linked family event pages; never open checkout URLs."""
from __future__ import annotations
import hashlib
import json
import re
import sys
import time
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"models")); sys.path.insert(0,str(ROOT/"scripts"))
from site_ingestion import SourcePolicy, fetch_page
from collect_sites import write_json

OUT = ROOT / "data/processed/site_collection/event_tickets"
BASE = "https://nn.burocultura.ru/"


def collect(limit=35):
    policy = SourcePolicy("burocultura-nn",("nn.burocultura.ru",),True)
    OUT.mkdir(parents=True,exist_ok=True)
    if not (OUT/"index.html").exists():
        page=fetch_page(BASE,policy,raw_output=OUT/"index.html")
        write_json(OUT/"index.json",{"fetched_at":datetime.now(timezone.utc).isoformat(),"page":asdict(page)})
    soup=BeautifulSoup((OUT/"index.html").read_bytes(),"html.parser")
    jobs={"https://nn.burocultura.ru/events/podzemelya-kremlya-ekskursiya":"Подземелья кремля"}
    for a in soup.find_all("a",href=True):
        text=a.get_text(" ",strip=True)
        if not a["href"].startswith("/events/") or not re.search(r"(?:^|\s)(?:0|6)\+",text): continue
        if re.search(r"(?i)загородн|отправление автобуса|заволжье|йошкар|дивеево|болдино|светлояр|\bбор\b",text): continue
        jobs[urljoin(BASE,a["href"])]=text[:250]
    report=[]
    last_request=None
    for url,title in list(jobs.items())[:limit]:
        if urlparse(url).hostname!="nn.burocultura.ru": raise ValueError("Unexpected source host")
        key=hashlib.sha256(url.encode()).hexdigest()[:24]
        raw, snapshot=OUT/(key+".html"),OUT/(key+".json")
        if url.endswith("/podzemelya-kremlya-ekskursiya") and (OUT/"kremlin.json").exists():
            raw,snapshot=OUT/"kremlin.html",OUT/"kremlin.json"
        row={"url":url,"listing_title":title}
        try:
            if snapshot.exists() and raw.exists():
                saved=json.loads(snapshot.read_text())
            else:
                if last_request is not None: time.sleep(max(0,3-(time.monotonic()-last_request)))
                last_request=time.monotonic()
                page=fetch_page(url,policy,timeout_seconds=15,raw_output=raw)
                saved={"fetched_at":datetime.now(timezone.utc).isoformat(),"page":asdict(page)}
                write_json(snapshot,saved)
            row.update(status="fetched",snapshot=str(snapshot),characters=len(saved["page"]["text"]))
        except Exception as error:
            row.update(status="error",error_type=type(error).__name__,error=str(error))
        report.append(row)
        write_json(OUT/"report.json",{"planned_urls":min(limit,len(jobs)),"counts":dict(Counter(j["status"] for j in report)),"jobs":report})
        print(json.dumps({"url":url,"status":row["status"]}),flush=True)
    return report


if __name__=="__main__": collect()
