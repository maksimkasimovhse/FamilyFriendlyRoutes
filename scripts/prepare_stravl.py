"""Prepare Stravl interactions for cold-user recommendation experiments.

The dataset's budget field (form_b) is intentionally excluded from outputs.
"""

from __future__ import annotations

import ast
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "raw" / "stravl"
OUTPUT = ROOT / "data" / "processed" / "stravl"
PROFILE_FIELDS = ("form_a", "form_c", "form_f", "form_g", "form_h", "form_i", "form_j", "form_k", "form_r", "form_rr")
RESPONSE_FIELDS = (("yes_swipes", "yes"), ("no_swipes", "no"), ("maybe_swipes", "maybe"))


def split_for_user(user_id: str) -> str:
    bucket = int.from_bytes(hashlib.sha256(user_id.encode("utf-8")).digest()[:8], "big") % 10
    return "train" if bucket < 8 else "validation" if bucket == 8 else "test"


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    names = (SOURCE / "destination_ids.txt").read_text(encoding="utf-8").splitlines()
    with (OUTPUT / "destinations.csv").open("w", newline="", encoding="utf-8") as target:
        writer = csv.writer(target)
        writer.writerow(("destination_id", "name"))
        writer.writerows(enumerate(names))

    interaction_schema = pa.schema([
        ("user_id", pa.string()),
        ("split", pa.string()),
        ("destination_id", pa.int32()),
        ("response", pa.string()),
    ])
    profile_schema = pa.schema([
        ("user_id", pa.string()),
        ("split", pa.string()),
        *((field, pa.list_(pa.string())) for field in PROFILE_FIELDS),
    ])
    report = Counter()
    interaction_rows: list[dict] = []
    profile_rows: list[dict] = []
    with pq.ParquetWriter(OUTPUT / "interactions.parquet", interaction_schema) as interactions, \
         pq.ParquetWriter(OUTPUT / "profiles.parquet", profile_schema) as profiles, \
         (SOURCE / "Stravl_Travel_Preference_Data.csv").open(newline="", encoding="utf-8-sig") as source:
        for row in csv.DictReader(source):
            user_id = row["id"]
            split = split_for_user(user_id)
            report[f"users_{split}"] += 1
            by_destination: dict[int, set[str]] = {}
            for field, response in RESPONSE_FIELDS:
                for value in ast.literal_eval(row[field]):
                    destination_id = int(value)
                    if destination_id < 0 or destination_id >= len(names):
                        raise ValueError(f"Destination ID out of range: {destination_id}")
                    by_destination.setdefault(destination_id, set()).add(response)
            valid_count = 0
            for destination_id, responses in by_destination.items():
                if len(responses) != 1:
                    report["conflicting_user_destination_pairs_removed"] += 1
                    continue
                interaction_rows.append({
                    "user_id": user_id,
                    "split": split,
                    "destination_id": destination_id,
                    "response": next(iter(responses)),
                })
                valid_count += 1
                report[f"interactions_{split}"] += 1
            if not valid_count:
                report["users_without_valid_interactions"] += 1
                continue
            profile = {"user_id": user_id, "split": split}
            for field in PROFILE_FIELDS:
                value = ast.literal_eval(row[field]) if row[field] else []
                profile[field] = [str(item) for item in value]
            profile_rows.append(profile)
            if len(interaction_rows) >= 100_000:
                interactions.write_table(pa.Table.from_pylist(interaction_rows, schema=interaction_schema))
                interaction_rows.clear()
            if len(profile_rows) >= 10_000:
                profiles.write_table(pa.Table.from_pylist(profile_rows, schema=profile_schema))
                profile_rows.clear()
        if interaction_rows:
            interactions.write_table(pa.Table.from_pylist(interaction_rows, schema=interaction_schema))
        if profile_rows:
            profiles.write_table(pa.Table.from_pylist(profile_rows, schema=profile_schema))

    (OUTPUT / "report.json").write_text(
        json.dumps(dict(report), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(dict(report), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
