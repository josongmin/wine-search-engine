#!/usr/bin/env python3
"""
merge-fields.py — donor NDJSON의 특정 필드를 base NDJSON에 병합.
sourceId 기준으로 매칭. base에 이미 값이 있으면 skip (idempotent).

주 용도: silver-docquery.ndjson의 drinkingWindow(7033개)를
         silver-phase3.ndjson에 무료로 이식.

Usage:
  python3 tools/wine-search-engine/merge-fields.py \
    --base   data/silver-phase3.ndjson \
    --donor  data/silver-docquery.ndjson \
    --fields drinkingWindow \
    --output data/silver-phase4.ndjson
"""

import json, argparse
from typing import Any

def merge(base_rec: dict, donor_rec: dict, fields: list[str]) -> dict:
    w = dict(base_rec)
    for field in fields:
        val = donor_rec.get(field)
        if val is not None and not w.get(field):
            w[field] = val
    return w


def flatten_drinking_window(wine: dict) -> dict:
    """
    drinkingWindow: {drinkingWindowStart, drinkingWindowEnd, peakYear, ...}
    → top-level drinkingWindowStart, drinkingWindowEnd 로 펼치기.
    ETL index-to-vespa.ts가 gold.drinkingWindow 구조를 읽음.
    """
    dw = wine.get("drinkingWindow")
    if isinstance(dw, dict):
        if "drinkingWindowStart" in dw and "drinkingWindowStart" not in wine:
            wine = dict(wine)
            wine["drinkingWindowStart"] = dw["drinkingWindowStart"]
            wine["drinkingWindowEnd"]   = dw.get("drinkingWindowEnd")
    return wine


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base",   required=True)
    parser.add_argument("--donor",  required=True)
    parser.add_argument("--fields", nargs="+", default=["drinkingWindow"])
    parser.add_argument("--output", required=True)
    parser.add_argument("--flatten-drinking-window", action="store_true", default=True,
                        help="Also flatten drinkingWindow → top-level start/end fields")
    args = parser.parse_args()

    # Load donor index
    print(f"  Loading donor: {args.donor}", flush=True)
    donor_index: dict[str, dict] = {}
    with open(args.donor, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            sid = rec.get("sourceId")
            if sid:
                donor_index[sid] = rec

    print(f"  Donor records: {len(donor_index)}")

    # Load base
    base_records = []
    with open(args.base, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                base_records.append(json.loads(line))

    print(f"  Base records:  {len(base_records)}")

    # Merge
    merged = 0
    result = []
    for rec in base_records:
        sid = rec.get("sourceId")
        donor = donor_index.get(sid)
        if donor:
            patched = merge(rec, donor, args.fields)
            if patched is not rec:
                merged += 1
            rec = patched

        if args.flatten_drinking_window and "drinkingWindow" in args.fields:
            rec = flatten_drinking_window(rec)

        result.append(rec)

    with open(args.output, "w", encoding="utf-8") as f:
        for w in result:
            f.write(json.dumps(w, ensure_ascii=False) + "\n")

    print(f"  Written → {args.output}")
    print()
    print(f"  Merged from donor: {merged}/{len(base_records)}")

    # Stats per field
    for field in args.fields:
        has = sum(1 for w in result if w.get(field))
        flat_start = sum(1 for w in result if w.get("drinkingWindowStart"))
        print(f"  {field} filled: {has}/{len(result)}")
    if "drinkingWindow" in args.fields:
        flat_start = sum(1 for w in result if w.get("drinkingWindowStart"))
        print(f"  drinkingWindowStart (flattened): {flat_start}/{len(result)}")


if __name__ == "__main__":
    main()
