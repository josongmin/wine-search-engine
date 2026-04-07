#!/usr/bin/env python3
"""
LLM enrichment v2 — parallel async, idempotent, multi-field, multi-mode.

Modes (--mode):
  core      grapes + searchTextEn                          ~$0.10 / 7040
  extended  alcoholPct + producerPrestige + oakTreatment   ~$0.39 / 7040
  full      all of the above in one call                   ~$0.61 / 7040  (default)

Models (--model):
  gpt-4o-mini     (default, best value)
  claude-haiku-4-5
  gemini-flash

Usage:
  set -a && source .env && set +a
  python3 tools/wine-search-engine/enrich-llm-v2.py \
    --input data/silver-phase1b.ndjson --output data/silver-phase2.ndjson \
    --mode full --model gpt-4o-mini --concurrency 100
"""

import json, os, sys, time, argparse, asyncio
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM PROMPTS
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_CORE = """\
You are a wine expert. Return a JSON object for the given wine:
{"grapes":["Grape1","Grape2"],"searchTextEn":"60-120 word factual description of region, grape, style, flavours, structure"}
Rules: canonical grape names (Pinot Noir not pinot noir); [] if grapes truly unknown; JSON only, no fences."""

SYSTEM_EXTENDED = """\
You are a wine expert. Return a JSON object for the given wine:
{"alcoholPct":13.5,"producerPrestige":0.55,"oakTreatment":"oaked","organic":false,"biodynamic":false}
Rules:
- alcoholPct: regional norms (Mosel~8-9%, Loire Cab Franc~12%, Barolo~14%, Napa Cab~14.5%); null if unknown
- producerPrestige 0-1: DRC/Petrus/Screaming Eagle→0.95-1.0; well-known regional→0.5-0.75; unknown small→0.2-0.35
- oakTreatment: "oaked"|"unoaked"|"neutral"|null (null if unclear)
- organic/biodynamic: false by default; true ONLY for verifiably certified estates
- JSON only, no fences."""

SYSTEM_FULL = """\
You are a wine expert. Return a JSON object for the given wine:
{"grapes":["Grape1"],"searchTextEn":"60-120 word factual description","alcoholPct":13.5,"producerPrestige":0.55,"oakTreatment":"oaked","organic":false,"biodynamic":false}
Rules:
- grapes: canonical names (Pinot Noir not pinot noir); [] if truly unknowable
- searchTextEn: 60-120 words, factual, mention region/grape/style/flavours/structure
- alcoholPct: regional norms (Mosel~8-9%, Champagne~12%, Burgundy~13%, Barolo~14%, Napa Cab~14.5%); null if unknown
- producerPrestige 0-1: DRC/Petrus→0.95-1.0; well-known→0.5-0.75; unknown small→0.2-0.35
- oakTreatment: "oaked"|"unoaked"|"neutral"|null
- organic/biodynamic: false by default; true ONLY for verifiably certified estates
- JSON only, no markdown fences"""

SYSTEM_MAP = {"core": SYSTEM_CORE, "extended": SYSTEM_EXTENDED, "full": SYSTEM_FULL}

# ─────────────────────────────────────────────────────────────────────────────
# PROMPT
# ─────────────────────────────────────────────────────────────────────────────

def build_prompt(wine: dict, mode: str) -> str:
    lines = [f"Label: {wine.get('canonicalLabel','')}"]
    if wine.get("region"):    lines.append(f"Region: {wine['region']}")
    if wine.get("country"):   lines.append(f"Country: {wine['country']}")
    lines.append(f"Wine type: {wine.get('wineType','red')}")
    if wine.get("producer"):  lines.append(f"Producer: {wine['producer']}")
    if wine.get("vintageYear"): lines.append(f"Vintage: {wine['vintageYear']}")
    grapes = wine.get("grapes") or []
    if grapes:                lines.append(f"Grapes: {', '.join(grapes)}")
    if mode == "core":
        en = wine.get("searchTextEn","")
        if len(en) >= 30:     lines.append(f"Existing (improve): {en[:200]}")
    return "\n".join(lines)

# ─────────────────────────────────────────────────────────────────────────────
# NEEDS CHECK
# ─────────────────────────────────────────────────────────────────────────────

def needs(wine: dict, mode: str) -> bool:
    if mode == "core":
        return not wine.get("grapes") or len(wine.get("searchTextEn","")) < 80
    if mode == "extended":
        return (wine.get("alcoholPct") is None
                or wine.get("producerPrestige") is None
                or not wine.get("oakTreatment"))
    # full
    return (not wine.get("grapes")
            or len(wine.get("searchTextEn","")) < 80
            or wine.get("alcoholPct") is None
            or wine.get("producerPrestige") is None
            or not wine.get("oakTreatment"))

# ─────────────────────────────────────────────────────────────────────────────
# APPLY
# ─────────────────────────────────────────────────────────────────────────────

def apply(wine: dict, result: dict, mode: str) -> dict:
    w = dict(wine)
    if mode in ("core", "full"):
        g = result.get("grapes")
        if isinstance(g, list) and g and not w.get("grapes"):
            w["grapes"] = g; w["grapePrimary"] = g[0]
        en = result.get("searchTextEn","")
        if isinstance(en, str) and len(en) >= 40 and len(w.get("searchTextEn","")) < 80:
            w["searchTextEn"] = en
    if mode in ("extended", "full"):
        abv = result.get("alcoholPct")
        if isinstance(abv, (int,float)) and 5 <= abv <= 22 and w.get("alcoholPct") is None:
            w["alcoholPct"] = round(float(abv), 1)
        pres = result.get("producerPrestige")
        if isinstance(pres, (int,float)) and 0 <= pres <= 1 and w.get("producerPrestige") is None:
            w["producerPrestige"] = round(float(pres), 3)
        oak = result.get("oakTreatment")
        if isinstance(oak, str) and oak in ("oaked","unoaked","neutral") and not w.get("oakTreatment"):
            w["oakTreatment"] = oak
        if result.get("organic") is True:   w["organic"] = True
        if result.get("biodynamic") is True: w["biodynamic"] = True
    return w

# ─────────────────────────────────────────────────────────────────────────────
# API CLIENTS
# ─────────────────────────────────────────────────────────────────────────────

async def call_openai(session, system: str, prompt: str, model: str) -> Optional[dict]:
    import aiohttp
    key = os.environ.get("OPENAI_API_KEY","")
    if not key: raise RuntimeError("OPENAI_API_KEY not set")
    payload = {"model": model, "max_tokens": 400,
               "response_format": {"type": "json_object"},
               "messages": [{"role":"system","content":system},{"role":"user","content":prompt}]}
    async with session.post("https://api.openai.com/v1/chat/completions", json=payload,
        headers={"Authorization":f"Bearer {key}","Content-Type":"application/json"},
        timeout=aiohttp.ClientTimeout(total=30)) as r:
        if r.status == 429: return None
        r.raise_for_status()
        d = await r.json()
        return json.loads(d["choices"][0]["message"]["content"].strip())

async def call_anthropic(session, system: str, prompt: str, model: str) -> Optional[dict]:
    import aiohttp
    key = os.environ.get("ANTHROPIC_API_KEY","")
    if not key: raise RuntimeError("ANTHROPIC_API_KEY not set")
    payload = {"model": model, "max_tokens": 400, "system": system,
               "messages": [{"role":"user","content":prompt}]}
    async with session.post("https://api.anthropic.com/v1/messages", json=payload,
        headers={"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},
        timeout=aiohttp.ClientTimeout(total=30)) as r:
        if r.status == 429: return None
        r.raise_for_status()
        d = await r.json()
        return json.loads(d["content"][0]["text"].strip())

async def call_gemini(session, system: str, prompt: str, model: str) -> Optional[dict]:
    import aiohttp
    key = os.environ.get("GOOGLE_API_KEY","")
    if not key: raise RuntimeError("GOOGLE_API_KEY not set")
    payload = {"contents":[{"parts":[{"text":system+"\n\n"+prompt}]}],
               "generationConfig":{"maxOutputTokens":400,"responseMimeType":"application/json"}}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=30)) as r:
        if r.status == 429: return None
        r.raise_for_status()
        d = await r.json()
        return json.loads(d["candidates"][0]["content"]["parts"][0]["text"].strip())

MODEL_DISPATCH = {
    "gpt-4o-mini":       ("openai",    "gpt-4o-mini"),
    "gpt-4o":            ("openai",    "gpt-4o"),
    "claude-haiku-4-5":  ("anthropic", "claude-haiku-4-5-20251001"),
    "claude-haiku":      ("anthropic", "claude-haiku-4-5-20251001"),
    "gemini-flash":      ("gemini",    "gemini-1.5-flash"),
    "gemini-2.0-flash":  ("gemini",    "gemini-2.0-flash"),
}

async def call_model(session, system, prompt, provider, model_id):
    if provider == "openai":     return await call_openai(session, system, prompt, model_id)
    if provider == "anthropic":  return await call_anthropic(session, system, prompt, model_id)
    if provider == "gemini":     return await call_gemini(session, system, prompt, model_id)
    raise ValueError(provider)

# ─────────────────────────────────────────────────────────────────────────────
# WORKER
# ─────────────────────────────────────────────────────────────────────────────

async def enrich_one(sem, session, wine, system, mode, provider, model_id):
    if not needs(wine, mode): return wine
    prompt = build_prompt(wine, mode)
    async with sem:
        for attempt in range(3):
            try:
                result = await call_model(session, system, prompt, provider, model_id)
                if result is None:
                    await asyncio.sleep(2 ** attempt); continue
                return apply(wine, result, mode)
            except json.JSONDecodeError:
                break
            except Exception as e:
                if attempt < 2: await asyncio.sleep(1.5 ** attempt)
                else: print(f"\n  [WARN] {wine.get('canonicalLabel','')[:50]} — {e}", file=sys.stderr)
    return wine

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input",       default="data/silver-phase1b.ndjson")
    p.add_argument("--output",      default="data/silver-phase2.ndjson")
    p.add_argument("--model",       default="gpt-4o-mini", choices=list(MODEL_DISPATCH))
    p.add_argument("--mode",        default="full", choices=["core","extended","full"])
    p.add_argument("--concurrency", type=int, default=100)
    p.add_argument("--limit",       type=int, default=0)
    p.add_argument("--dry-run",     action="store_true")
    args = p.parse_args()

    provider, model_id = MODEL_DISPATCH[args.model]
    system = SYSTEM_MAP[args.mode]

    wines = [json.loads(l) for l in open(args.input, encoding="utf-8") if l.strip()]
    if args.limit: wines = wines[:args.limit]

    to_enrich = [w for w in wines if needs(w, args.mode)]
    print(f"  Input: {len(wines)}  Skip: {len(wines)-len(to_enrich)}  To enrich: {len(to_enrich)}")
    print(f"  Mode: {args.mode}  Model: {args.model}  Concurrency: {args.concurrency}")
    inp = len(to_enrich)*180; out = len(to_enrich)*100
    costs = {"openai":(inp/1e6*.15)+(out/1e6*.60), "anthropic":(inp/1e6*.80)+(out/1e6*4.00), "gemini":(inp/1e6*.075)+(out/1e6*.30)}
    print(f"  Est. cost: ${costs[provider]:.3f}")

    if args.dry_run:
        for w in to_enrich[:3]:
            print("\n---"); print(build_prompt(w, args.mode))
        return

    key_env = {"openai":"OPENAI_API_KEY","anthropic":"ANTHROPIC_API_KEY","gemini":"GOOGLE_API_KEY"}[provider]
    if not os.environ.get(key_env): print(f"ERROR: {key_env} not set", file=sys.stderr); sys.exit(1)

    try: import aiohttp
    except ImportError: print("pip install aiohttp", file=sys.stderr); sys.exit(1)

    sem = asyncio.Semaphore(args.concurrency)
    results_by_id: dict = {}
    done = 0; start = time.time()

    async with aiohttp.ClientSession() as session:
        tasks = [enrich_one(sem, session, w, system, args.mode, provider, model_id) for w in to_enrich]
        for coro in asyncio.as_completed(tasks):
            r = await coro
            results_by_id[r["sourceId"]] = r
            done += 1
            if done % 100 == 0 or done == len(tasks):
                el = time.time()-start; rps = done/el if el else 0; eta = (len(tasks)-done)/rps if rps else 0
                print(f"  [{done:4d}/{len(tasks)}]  {rps:.1f} req/s  ETA {eta:.0f}s", end="\r", flush=True)

    print()
    final = [results_by_id.get(w["sourceId"], w) for w in wines]
    with open(args.output, "w", encoding="utf-8") as f:
        for w in final: f.write(json.dumps(w, ensure_ascii=False)+"\n")

    el = time.time()-start
    print(f"  Written → {args.output}  ({el:.1f}s  {len(to_enrich)/el:.1f} req/s avg)")
    n = len(final)
    if args.mode in ("core","full"):
        print(f"  grapes:          {sum(1 for w in final if w.get('grapes'))}/{n}")
        print(f"  searchTextEn≥80: {sum(1 for w in final if len(w.get('searchTextEn',''))>=80)}/{n}")
    if args.mode in ("extended","full"):
        print(f"  alcoholPct:      {sum(1 for w in final if w.get('alcoholPct') is not None)}/{n}")
        print(f"  producerPrestige:{sum(1 for w in final if w.get('producerPrestige') is not None)}/{n}")
        print(f"  oakTreatment:    {sum(1 for w in final if w.get('oakTreatment'))}/{n}")
        print(f"  organic=true:    {sum(1 for w in final if w.get('organic'))}")
        print(f"  biodynamic=true: {sum(1 for w in final if w.get('biodynamic'))}")

if __name__ == "__main__":
    asyncio.run(main())
