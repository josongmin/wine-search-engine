#!/usr/bin/env python3
"""
LLM enrichment — fills grape varieties + searchTextEn for wines that rule-based
enrichment couldn't handle.

Strategy:
  - Only processes records missing grapes (or with short searchTextEn < 80 chars)
  - Sends parallel requests (--concurrency, default 20)
  - Skips records already enriched (idempotent — safe to re-run)
  - Writes output incrementally so you can Ctrl-C and resume

Models supported (via --model):
  claude-haiku-4-5      Claude Haiku 3.5  ~$0.65 / 1557 records
  gpt-4o-mini           GPT-4o-mini       ~$0.10 / 1557 records  (default)
  gemini-flash          Gemini 1.5 Flash  ~$0.05 / 1557 records

Requires env vars depending on model:
  ANTHROPIC_API_KEY     for claude-*
  OPENAI_API_KEY        for gpt-*
  GOOGLE_API_KEY        for gemini-*

Usage:
  python3 tools/wine-search-engine/enrich-llm.py \\
    --input  data/silver-phase1b.ndjson \\
    --output data/silver-phase2.ndjson \\
    --model  claude-haiku-4-5 \\
    --concurrency 20 \\
    --grape-only          # skip searchTextEn enrichment (faster, cheaper)
    --dry-run             # print first 3 prompts without calling API
"""

import json, os, re, sys, time, argparse, asyncio
from typing import Any, Optional

# ─────────────────────────────────────────────────────────────────────────────
# PROMPT
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM = """\
You are a sommelier expert. Given a wine's label, region, and type, return a JSON
object with two fields:
  "grapes": array of grape variety names (1-3 items), empty array if truly unknown
  "searchTextEn": one rich paragraph (2-4 sentences) describing the wine — style,
    typical flavours, structure, and origin — suitable for semantic search.

Rules:
- grapes: use canonical names (e.g. "Pinot Noir" not "Pinot noir", "Grenache" not "Garnacha")
- searchTextEn: 60-120 words, factual, no marketing fluff
- If grapes are unknowable (e.g. proprietary blend with no region hints), use []
- Respond ONLY with the JSON object, no markdown fences
"""

def build_prompt(wine: dict) -> str:
    label   = wine.get("canonicalLabel", "")
    region  = wine.get("region", "")
    country = wine.get("country", "")
    wtype   = wine.get("wineType", "red")
    producer = wine.get("producer", "")
    vintage = wine.get("vintageYear", "")
    existing_grapes = wine.get("grapes") or []
    existing_en = wine.get("searchTextEn", "")

    lines = [f'Label: {label}']
    if region:
        lines.append(f'Region: {region}')
    if country:
        lines.append(f'Country: {country}')
    lines.append(f'Wine type: {wtype}')
    if producer:
        lines.append(f'Producer: {producer}')
    if vintage:
        lines.append(f'Vintage: {vintage}')
    if existing_grapes:
        lines.append(f'Known grapes: {", ".join(existing_grapes)}')
    if existing_en and len(existing_en) >= 30:
        lines.append(f'Existing description (improve it): {existing_en[:200]}')

    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# API CLIENTS
# ─────────────────────────────────────────────────────────────────────────────

async def call_anthropic(session, prompt: str, model: str) -> Optional[dict]:
    """Call Anthropic Messages API."""
    import aiohttp
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    payload = {
        "model": model,
        "max_tokens": 300,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    async with session.post(
        "https://api.anthropic.com/v1/messages",
        json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=30)
    ) as resp:
        if resp.status == 429:
            return None  # rate limit — caller will retry
        resp.raise_for_status()
        data = await resp.json()
        text = data["content"][0]["text"].strip()
        return json.loads(text)


async def call_openai(session, prompt: str, model: str) -> Optional[dict]:
    """Call OpenAI Chat Completions API."""
    import aiohttp
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")

    payload = {
        "model": model,
        "max_tokens": 300,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with session.post(
        "https://api.openai.com/v1/chat/completions",
        json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=30)
    ) as resp:
        if resp.status == 429:
            return None
        resp.raise_for_status()
        data = await resp.json()
        text = data["choices"][0]["message"]["content"].strip()
        return json.loads(text)


async def call_gemini(session, prompt: str, model: str) -> Optional[dict]:
    """Call Google Gemini generateContent API."""
    import aiohttp
    api_key = os.environ.get("GOOGLE_API_KEY", "")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY not set")

    payload = {
        "contents": [{"parts": [{"text": SYSTEM + "\n\n" + prompt}]}],
        "generationConfig": {
            "maxOutputTokens": 300,
            "responseMimeType": "application/json",
        },
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    async with session.post(
        url, json=payload, timeout=aiohttp.ClientTimeout(total=30)
    ) as resp:
        if resp.status == 429:
            return None
        resp.raise_for_status()
        data = await resp.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        return json.loads(text)


MODEL_DISPATCH = {
    # Anthropic
    "claude-haiku-4-5":          ("anthropic", "claude-haiku-4-5-20251001"),
    "claude-haiku-3-5":          ("anthropic", "claude-haiku-4-5-20251001"),  # alias
    "claude-haiku":              ("anthropic", "claude-haiku-4-5-20251001"),
    "claude-sonnet-4-5":         ("anthropic", "claude-sonnet-4-5"),
    # OpenAI
    "gpt-4o-mini":               ("openai",    "gpt-4o-mini"),
    "gpt-4o":                    ("openai",    "gpt-4o"),
    # Gemini
    "gemini-flash":              ("gemini",    "gemini-1.5-flash"),
    "gemini-1.5-flash":          ("gemini",    "gemini-1.5-flash"),
    "gemini-2.0-flash":          ("gemini",    "gemini-2.0-flash"),
}

async def call_model(session, prompt: str, provider: str, model_id: str) -> Optional[dict]:
    if provider == "anthropic":
        return await call_anthropic(session, prompt, model_id)
    elif provider == "openai":
        return await call_openai(session, prompt, model_id)
    elif provider == "gemini":
        return await call_gemini(session, prompt, model_id)
    raise ValueError(f"Unknown provider: {provider}")


# ─────────────────────────────────────────────────────────────────────────────
# ENRICHMENT LOGIC
# ─────────────────────────────────────────────────────────────────────────────

def needs_enrichment(wine: dict, grape_only: bool) -> bool:
    missing_grapes = not wine.get("grapes")
    short_en = len(wine.get("searchTextEn", "")) < 80
    if grape_only:
        return missing_grapes
    return missing_grapes or short_en


def apply_result(wine: dict, result: dict, grape_only: bool) -> dict:
    w = dict(wine)
    grapes = result.get("grapes")
    if isinstance(grapes, list) and grapes:
        # Only overwrite if we got something useful
        w["grapes"] = grapes
        w["grapePrimary"] = grapes[0]
    en = result.get("searchTextEn", "")
    if not grape_only and isinstance(en, str) and len(en) >= 40:
        w["searchTextEn"] = en
    return w


# ─────────────────────────────────────────────────────────────────────────────
# WORKER
# ─────────────────────────────────────────────────────────────────────────────

async def enrich_one(
    sem: asyncio.Semaphore,
    session,
    wine: dict,
    provider: str,
    model_id: str,
    grape_only: bool,
    retries: int = 3,
) -> dict:
    if not needs_enrichment(wine, grape_only):
        return wine

    prompt = build_prompt(wine)
    async with sem:
        for attempt in range(retries):
            try:
                result = await call_model(session, prompt, provider, model_id)
                if result is None:
                    # Rate limit — back off
                    await asyncio.sleep(2 ** attempt)
                    continue
                return apply_result(wine, result, grape_only)
            except json.JSONDecodeError:
                # Bad JSON from model — skip
                break
            except Exception as e:
                if attempt < retries - 1:
                    await asyncio.sleep(1.5 ** attempt)
                else:
                    print(f"\n  [WARN] failed: {wine.get('canonicalLabel','?')[:50]} — {e}",
                          file=sys.stderr)
    return wine  # return original on failure


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",       default="data/silver-phase1b.ndjson")
    parser.add_argument("--output",      default="data/silver-phase2.ndjson")
    parser.add_argument("--model",       default="gpt-4o-mini",
                        choices=list(MODEL_DISPATCH.keys()))
    parser.add_argument("--concurrency", type=int, default=20)
    parser.add_argument("--grape-only",  action="store_true",
                        help="Only fill missing grapes, skip searchTextEn")
    parser.add_argument("--limit",       type=int, default=0,
                        help="Process at most N records (0 = all, for testing)")
    parser.add_argument("--dry-run",     action="store_true",
                        help="Print first 3 prompts without calling API")
    args = parser.parse_args()

    provider, model_id = MODEL_DISPATCH[args.model]

    # Load
    wines = []
    with open(args.input, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                wines.append(json.loads(line))

    if args.limit:
        wines = wines[:args.limit]

    to_enrich = [w for w in wines if needs_enrichment(w, args.grape_only)]
    skip_count = len(wines) - len(to_enrich)

    print(f"  Input:       {len(wines)} records")
    print(f"  Skip (ok):   {skip_count}")
    print(f"  To enrich:   {len(to_enrich)}")
    print(f"  Model:       {args.model} ({model_id})")
    print(f"  Concurrency: {args.concurrency}")
    print(f"  Grape-only:  {args.grape_only}")
    print()

    if args.dry_run:
        print("=== DRY RUN — first 3 prompts ===\n")
        for w in to_enrich[:3]:
            print("--- PROMPT ---")
            print(build_prompt(w))
            print()
        return

    # Check API key
    key_var = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "gemini": "GOOGLE_API_KEY"}[provider]
    if not os.environ.get(key_var):
        print(f"  ERROR: {key_var} not set", file=sys.stderr)
        sys.exit(1)

    try:
        import aiohttp
    except ImportError:
        print("  ERROR: aiohttp not installed. Run: pip install aiohttp", file=sys.stderr)
        sys.exit(1)

    # Build index for O(1) lookup
    wine_index = {w["sourceId"]: i for i, w in enumerate(wines)}

    sem = asyncio.Semaphore(args.concurrency)
    start = time.time()
    done = 0
    errors = 0

    async with aiohttp.ClientSession() as session:
        tasks = [
            enrich_one(sem, session, w, provider, model_id, args.grape_only)
            for w in to_enrich
        ]

        results = []
        for coro in asyncio.as_completed(tasks):
            result = await coro
            results.append(result)
            done += 1

            # Progress
            if done % 50 == 0 or done == len(tasks):
                elapsed = time.time() - start
                rps = done / elapsed if elapsed > 0 else 0
                eta = (len(tasks) - done) / rps if rps > 0 else 0
                print(f"  [{done:4d}/{len(tasks)}]  {rps:.1f} req/s  ETA {eta:.0f}s",
                      end="\r", flush=True)

    print()  # newline after progress

    # Merge back into original order
    result_by_id = {r["sourceId"]: r for r in results}
    final = []
    for w in wines:
        sid = w["sourceId"]
        final.append(result_by_id.get(sid, w))

    # Write
    with open(args.output, "w", encoding="utf-8") as f:
        for w in final:
            f.write(json.dumps(w, ensure_ascii=False) + "\n")

    elapsed = time.time() - start
    grapes_after  = sum(1 for w in final if w.get("grapes"))
    grapes_before = sum(1 for w in wines if w.get("grapes"))
    en_short_after  = sum(1 for w in final if len(w.get("searchTextEn","")) < 80)

    print(f"  Written → {args.output}  ({elapsed:.1f}s)")
    print()
    print(f"  grapes:        {grapes_before} → {grapes_after} / {len(final)}"
          f"  (+{grapes_after - grapes_before})")
    print(f"  en short (<80): {en_short_after}")


if __name__ == "__main__":
    asyncio.run(main())
