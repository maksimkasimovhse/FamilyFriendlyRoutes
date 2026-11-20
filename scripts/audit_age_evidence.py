"""Count possible age mentions in local reviews; do not infer age labels."""

import json
import re
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "processed" / "geo_reviews_2023" / "nizhny_address_matches.parquet"
AGE = re.compile(r"(?<!\d)(10|11|[3-9])\s*(?:-?\s*летн\w*|лет|года|год)\b", re.I)
CHILD = re.compile(r"реб[её]н|дет|сын|доч|малыш|школьник", re.I)


def main() -> None:
    counts = Counter()
    texts = pq.read_table(SOURCE, columns=["text"]).column("text").to_pylist()
    counts["local_reviews"] = len(texts)
    for text in texts:
        if not text:
            continue
        ages = {int(value) for value in AGE.findall(text)}
        child_word = bool(CHILD.search(text))
        if child_word:
            counts["child_word_reviews"] += 1
        if ages:
            counts["age_mention_reviews"] += 1
        if ages and child_word:
            counts["age_and_child_word_reviews"] += 1
            for age in ages:
                band = "3-5" if age <= 5 else "6-8" if age <= 8 else "9-11"
                counts[f"candidate_mentions_{band}"] += 1
    print(json.dumps({
        "screening_only": True,
        "note": "Regex matches are possible review candidates, not age-fit labels or unique activities.",
        "counts": dict(counts),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
