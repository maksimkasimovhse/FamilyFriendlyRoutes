"""Audit downloaded source datasets without modifying their records."""

from __future__ import annotations

import ast
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"


def file_info(path: Path) -> dict[str, int | str]:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def audit_stravl() -> dict:
    folder = RAW / "stravl"
    csv_path = folder / "Stravl_Travel_Preference_Data.csv"
    ids_path = folder / "destination_ids.txt"
    destination_count = len(ids_path.read_text(encoding="utf-8").splitlines())
    counts = Counter()
    seen_users: set[str] = set()
    with csv_path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        columns = reader.fieldnames or []
        for row in reader:
            counts["rows"] += 1
            user_id = row["id"]
            if user_id in seen_users:
                counts["duplicate_user_ids"] += 1
            seen_users.add(user_id)
            sets = []
            for key in ("yes_swipes", "no_swipes", "maybe_swipes"):
                try:
                    values = [int(value) for value in ast.literal_eval(row[key])]
                except (ValueError, SyntaxError, TypeError):
                    counts["invalid_swipe_rows"] += 1
                    sets = []
                    break
                counts[key] += len(values)
                counts["out_of_range_swipes"] += sum(
                    value < 0 or value >= destination_count for value in values
                )
                sets.append(set(values))
            if len(sets) == 3:
                if not any(sets):
                    counts["users_without_swipes"] += 1
                if (sets[0] & sets[1]) or (sets[0] & sets[2]) or (sets[1] & sets[2]):
                    counts["users_with_conflicting_swipes"] += 1
    return {
        "files": {
            csv_path.name: file_info(csv_path),
            ids_path.name: file_info(ids_path),
        },
        "columns": columns,
        "destination_count": destination_count,
        "counts": dict(counts),
    }


def audit_geo_reviews() -> dict:
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    path = RAW / "geo_reviews_2023" / "train.parquet"
    parquet = pq.ParquetFile(path)
    nizhny_count = 0
    for batch in parquet.iter_batches(columns=["address"], batch_size=32768):
        matches = pc.match_substring_regex(batch.column(0), "(?i)нижн(ий|его) новгород")
        nizhny_count += pc.sum(pc.cast(matches, "int64")).as_py() or 0
    return {
        "file": file_info(path),
        "rows": parquet.metadata.num_rows,
        "columns": parquet.schema_arrow.names,
        "nizhny_address_matches": nizhny_count,
    }


def main() -> None:
    result = {"stravl": audit_stravl(), "geo_reviews_2023": audit_geo_reviews()}
    osm = RAW / "osm_nizhny" / "volga-fed-district-261117.osm.pbf"
    if osm.exists():
        result["osm_volga_2026_11_17"] = {"file": file_info(osm)}
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
