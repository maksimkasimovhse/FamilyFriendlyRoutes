"""Validate reviewed activity-by-age-band labels and make leakage-safe splits."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "labels" / "age_fit_template.csv"
OUTPUT_DIR = ROOT / "data" / "processed" / "age_fit"
AGE_BANDS = {"3-5", "6-8", "9-11"}
ALLOWED = {"allowed", "forbidden", "unknown"}
FIT_LEVELS = {0.0, 0.25, 0.5, 0.75, 1.0}
REQUIRED = {
    "activity_id", "age_band", "participation_allowed", "age_fit",
    "evidence_url", "reviewer_id", "reviewed_at",
}


def split_for(activity_id: str) -> str:
    bucket = int(hashlib.sha256(activity_id.encode()).hexdigest()[:8], 16) % 10
    return "test" if bucket == 0 else "validation" if bucket == 1 else "train"


def fail(row: int, message: str) -> None:
    raise ValueError(f"row {row + 2}: {message}")


def main() -> None:
    frame = pd.read_csv(SOURCE, dtype=str, keep_default_na=False)
    missing = REQUIRED - set(frame.columns)
    extra = set(frame.columns) - REQUIRED
    if missing or extra:
        raise ValueError(f"columns mismatch; missing={sorted(missing)}, extra={sorted(extra)}")

    seen: set[tuple[str, str]] = set()
    for index, row in frame.iterrows():
        activity_id = row["activity_id"].strip()
        age_band = row["age_band"].strip()
        allowed = row["participation_allowed"].strip()
        if not activity_id:
            fail(index, "activity_id is required")
        if age_band not in AGE_BANDS:
            fail(index, f"age_band must be one of {sorted(AGE_BANDS)}")
        if allowed not in ALLOWED:
            fail(index, f"participation_allowed must be one of {sorted(ALLOWED)}")
        key = (activity_id, age_band)
        if key in seen:
            fail(index, "duplicate activity_id × age_band")
        seen.add(key)

        raw_fit = row["age_fit"].strip()
        if raw_fit:
            try:
                fit = float(raw_fit)
            except ValueError:
                fail(index, "age_fit must be a number in [0,1] or blank")
            if not 0 <= fit <= 1:
                fail(index, "age_fit must be in [0,1]")
            if fit not in FIT_LEVELS:
                fail(index, f"age_fit must use the annotation scale {sorted(FIT_LEVELS)}")
            if allowed == "forbidden":
                fail(index, "forbidden is a hard rule; leave age_fit blank")
        if not row["evidence_url"].strip():
            fail(index, "evidence_url is required")
        if not row["reviewer_id"].strip() or not row["reviewed_at"].strip():
            fail(index, "reviewer_id and reviewed_at are required")

    frame["age_fit"] = pd.to_numeric(frame["age_fit"], errors="coerce")
    frame["split"] = frame["activity_id"].map(split_for)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(OUTPUT_DIR / "labels.parquet", index=False)
    report = {
        "rows": len(frame),
        "activities": int(frame["activity_id"].nunique()),
        "age_bands": frame["age_band"].value_counts().sort_index().to_dict(),
        "splits": frame["split"].value_counts().sort_index().to_dict(),
        "note": "Splits are grouped by activity_id; forbidden rows are hard eligibility facts, not soft labels.",
    }
    (OUTPUT_DIR / "labels_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
