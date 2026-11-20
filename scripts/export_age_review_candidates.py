"""Export review snippets that may contain age evidence for manual review.

The output is a candidate queue, never a source of automatic age-fit labels.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "processed" / "geo_reviews_2023" / "nizhny_address_matches.parquet"
OUTPUT = ROOT / "data" / "processed" / "age_fit" / "review_candidates.csv"
AGE = re.compile(r"(?<!\d)(10|11|[3-9])\s*(?:-?\s*летн\w*|лет|года|год)\b", re.I)
CHILD = re.compile(r"реб[её]н|дет|сын|доч|малыш|школьник", re.I)


def band(age: int) -> str:
    return "3-5" if age <= 5 else "6-8" if age <= 8 else "9-11"


def main() -> None:
    source = pd.read_parquet(SOURCE)
    rows: list[dict[str, object]] = []
    for item in source.to_dict("records"):
        text = item.get("text")
        if not isinstance(text, str) or not CHILD.search(text):
            continue
        ages = sorted({int(value) for value in AGE.findall(text)})
        if not ages:
            continue
        identity = "\x1f".join((str(item.get("address", "")), str(item.get("name_ru", "")), text))
        rows.append({
            "candidate_id": hashlib.sha256(identity.encode()).hexdigest()[:16],
            "name_ru": item.get("name_ru"),
            "address": item.get("address"),
            "rubrics": item.get("rubrics"),
            "rating": item.get("rating"),
            "ages_mentioned": ",".join(map(str, ages)),
            "age_bands": ",".join(sorted({band(age) for age in ages})),
            "review_text": text,
            "review_status": "unreviewed",
        })
    output = pd.DataFrame(rows).sort_values(["name_ru", "candidate_id"])
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.to_csv(OUTPUT, index=False)
    print(f"exported {len(output)} screening candidates to {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
