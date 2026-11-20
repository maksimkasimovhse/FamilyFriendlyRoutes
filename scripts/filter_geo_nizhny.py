"""Extract reviews whose address mentions Nizhny Novgorod.

This is a candidate pool for review, not verified local POI matches or labels.
"""

from pathlib import Path

import pyarrow.compute as pc
import pyarrow.parquet as pq


root = Path(__file__).resolve().parents[1]
source = root / "data" / "raw" / "geo_reviews_2023" / "train.parquet"
target = root / "data" / "processed" / "geo_reviews_2023" / "nizhny_address_matches.parquet"
target.parent.mkdir(parents=True, exist_ok=True)

table = pq.read_table(source)
mask = pc.match_substring_regex(table["address"], "(?i)нижн(ий|его) новгород")
subset = table.filter(mask)
pq.write_table(subset, target, compression="zstd")
print(f"{subset.num_rows} rows written to {target}")
