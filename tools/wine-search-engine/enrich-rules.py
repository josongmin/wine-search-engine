#!/usr/bin/env python3
"""
Phase 3 — Rule-based structural enrichment. $0, ~10 seconds, 7040 records.

Fills:
  finish_length       100%   body+tannin formula → float 0-1
  occasion            100%   priceBand × wineType × rating matrix → array<string>
  classification       ~20%  label parsing (Grand Cru, Riserva, Gran Reserva …)
  producer_type        ~24%  producer/label name → domaine/chateau/estate/winery
  oak_treatment       whites region/grape signal → oaked/unoaked/neutral
  grape_family         ~92%  primary grape → family string (Pinot, Cabernet …)
  region_hierarchy     ~99%  region string → ["Country", "Region", "Sub-region"]
  price_band_numeric   100%  value→1 / mid→2 / premium→3 / luxury→4

Usage:
  python3 tools/wine-search-engine/enrich-rules.py \
    --input  data/silver-phase2.ndjson \
    --output data/silver-phase3.ndjson
"""

import json, re, argparse
from typing import Any, Optional

# ─────────────────────────────────────────────────────────────────────────────
# finish_length  (float 0–1 mapping to short/medium/long for UI)
# ─────────────────────────────────────────────────────────────────────────────

def compute_finish_length(body: float, tannin: float, wine_type: str) -> float:
    """
    Returns a float 0–1 representing finish length.
      long:   body ≥ 0.65 AND tannin ≥ 0.55  → 0.85
      short:  body < 0.38                      → 0.20
      medium: everything else                  → 0.55
    Sparkling gets a slight boost (persistent mousse = longer perceived finish).
    """
    if body >= 0.65 and tannin >= 0.55:
        base = 0.85
    elif body < 0.38:
        base = 0.20
    else:
        base = 0.55
    if wine_type == "sparkling":
        base = min(1.0, base + 0.05)
    return round(base, 2)


# ─────────────────────────────────────────────────────────────────────────────
# occasion  (array<string>)
# ─────────────────────────────────────────────────────────────────────────────

def compute_occasion(price_band: str, wine_type: str, rating: float) -> list[str]:
    """
    Decision matrix → occasion tags.
    Tags: celebration, gift, special_occasion, date_night, dinner_party,
          weeknight, aperitif, everyday, dessert, after_dinner
    """
    tags: list[str] = []

    # Sparkling → always celebration / aperitif
    if wine_type == "sparkling":
        tags += ["celebration", "aperitif"]
        if price_band in ("premium", "luxury"):
            tags.append("gift")
        return _dedup(tags)

    # Fortified → dessert / after dinner
    if wine_type == "fortified":
        return ["dessert", "after_dinner"]

    # Rosé → aperitif / weeknight
    if wine_type == "rose":
        tags += ["aperitif"]
        if price_band in ("value", "mid"):
            tags.append("weeknight")
        else:
            tags.append("dinner_party")
        return _dedup(tags)

    # Red / White by price + rating
    if price_band == "luxury":
        tags += ["special_occasion", "gift", "celebration"]
        if rating >= 4.3:
            tags.append("cellar")
    elif price_band == "premium":
        tags += ["dinner_party", "gift"]
        if rating >= 4.2:
            tags.append("date_night")
    elif price_band == "mid":
        tags += ["dinner_party", "weeknight"]
        if wine_type == "white":
            tags.append("aperitif")
    else:  # value
        tags += ["everyday", "weeknight"]
        if wine_type == "white":
            tags.append("aperitif")

    return _dedup(tags)


def _dedup(lst: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in lst:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# classification  (string — from label)
# ─────────────────────────────────────────────────────────────────────────────

# Ordered from most-specific to least (first match wins)
CLASSIFICATION_PATTERNS: list[tuple[str, str]] = [
    # Bordeaux
    ("Premier Grand Cru Classé", "premier_grand_cru_classe"),
    ("Grand Cru Classé",         "grand_cru_classe"),
    ("Cru Bourgeois Exceptionnel","cru_bourgeois_exceptionnel"),
    ("Cru Bourgeois Supérieur",  "cru_bourgeois_superieur"),
    ("Cru Bourgeois",            "cru_bourgeois"),
    # Burgundy
    ("Grand Cru",                "grand_cru"),
    ("Premier Cru",              "premier_cru"),
    ("1er Cru",                  "premier_cru"),
    ("Villages",                 "villages"),
    # Italy
    ("Gran Selezione",           "gran_selezione"),
    ("Riserva Speciale",         "riserva_speciale"),
    ("Riserva",                  "riserva"),
    ("Superiore",                "superiore"),
    ("Classico",                 "classico"),
    ("Normale",                  "normale"),
    ("Novello",                  "novello"),
    # Spain
    ("Gran Reserva",             "gran_reserva"),
    ("Reserva",                  "reserva"),
    ("Crianza",                  "crianza"),
    ("Joven",                    "joven"),
    # Germany / Austria
    ("Trockenbeerenauslese",     "trockenbeerenauslese"),
    ("Beerenauslese",            "beerenauslese"),
    ("Eiswein",                  "eiswein"),
    ("Spätlese",                 "spatlese"),
    ("Auslese",                  "auslese"),
    ("Kabinett",                 "kabinett"),
    ("Qualitätswein",            "qualitätswein"),
    ("Landwein",                 "landwein"),
    # Portugal
    ("Garrafeira",               "garrafeira"),
    # Generic
    ("Old Vines",                "old_vines"),
    ("Vieilles Vignes",          "old_vines"),
    ("Late Harvest",             "late_harvest"),
    ("Ice Wine",                 "eiswein"),
]

def extract_classification(label: str) -> Optional[str]:
    label_lower = label.lower()
    for signal, cls in CLASSIFICATION_PATTERNS:
        if signal.lower() in label_lower:
            return cls
    return None


# ─────────────────────────────────────────────────────────────────────────────
# producer_type  (string)
# ─────────────────────────────────────────────────────────────────────────────

PRODUCER_TYPE_SIGNALS: list[tuple[list[str], str]] = [
    (["Domaine", "Dom.", "Clos", "Mas ", "Mas de", "Lieu-dit"], "domaine"),
    (["Château", "Chateau", "Chx.", "Clos du Château"],         "chateau"),
    (["Estate", "Estates", "Tenuta", "Quinta", "Weingut",
      "Weinkellerei", "Güt", "Dominio"],                        "estate"),
    (["Bodega", "Bodegas", "Cave", "Caves", "Cantina",
      "Cantine", "Adega", "Adegas"],                            "bodega"),
    (["Cooperative", "Coop", "Cave Coopérative",
      "Coopérative", "Winzergenossenschaft"],                   "cooperative"),
    (["Négociant", "Negociant", "Maison", "House"],             "negociant"),
    (["Winery", "Vineyards", "Vineyard", "Cellars", "Cellar",
      "Wines", "Wine Co", "Wine Company"],                      "winery"),
]

def extract_producer_type(producer: str, label: str) -> str:
    text = producer + " " + label
    for signals, ptype in PRODUCER_TYPE_SIGNALS:
        for sig in signals:
            if sig.lower() in text.lower():
                return ptype
    return "winery"  # default


# ─────────────────────────────────────────────────────────────────────────────
# oak_treatment  (string: oaked / unoaked / neutral)
# ─────────────────────────────────────────────────────────────────────────────

OAKED_REGION_SIGNALS = [
    "Meursault", "Montrachet", "Corton-Charlemagne", "Pouilly-Fuissé",
    "Mâcon", "Saint-Véran", "Rully", "Bouzeron",
    "Barossa", "Margaret River", "Napa Valley", "Sonoma",
    "Rioja", "Ribera del Duero", "Barolo", "Barbaresco",
    "Brunello", "Chianti", "Bolgheri", "Priorat",
]

UNOAKED_SIGNALS = [
    "Chablis", "Muscadet", "Vinho Verde", "Riesling",
    "Sauvignon Blanc", "Pinot Grigio", "Pinot Gris",
    "Albariño", "Albarino", "Assyrtiko", "Gruner Veltliner",
    "Grüner Veltliner", "Txakoli", "Picpoul",
    "Beaujolais", "Gamay",
]

OAKED_LABEL_SIGNALS = ["Barrique", "Oak", "Chêne", "Élevé en Fût", "Fût de Chêne"]

def compute_oak_treatment(wine_type: str, label: str, region: str, grapes: list[str]) -> Optional[str]:
    """Only assign for whites + reds where signal is clear. None = unknown."""
    combined = (label + " " + region + " " + " ".join(grapes)).lower()

    # Label-explicit signals
    for sig in OAKED_LABEL_SIGNALS:
        if sig.lower() in combined:
            return "oaked"

    if wine_type in ("red", "white"):
        for sig in UNOAKED_SIGNALS:
            if sig.lower() in combined:
                return "unoaked"
        for sig in OAKED_REGION_SIGNALS:
            if sig.lower() in region.lower():
                return "oaked"

    # Reds with long finish are typically oak-aged — soft inference
    # (don't want false positives, so skip this heuristic)
    return None  # unknown


# ─────────────────────────────────────────────────────────────────────────────
# grape_family  (string — broadest category for hierarchical search)
# ─────────────────────────────────────────────────────────────────────────────

GRAPE_FAMILY_MAP: dict[str, str] = {
    # Pinot family
    "Pinot Noir":     "Pinot",
    "Pinot Gris":     "Pinot",
    "Pinot Grigio":   "Pinot",
    "Pinot Blanc":    "Pinot",
    "Pinot Meunier":  "Pinot",
    # Cabernet family
    "Cabernet Sauvignon": "Cabernet",
    "Cabernet Franc":     "Cabernet",
    # Sauvignon family
    "Sauvignon Blanc": "Sauvignon Blanc",
    # Chardonnay
    "Chardonnay":     "Chardonnay",
    # Riesling
    "Riesling":       "Riesling",
    # Syrah/Shiraz
    "Syrah":          "Syrah",
    "Shiraz":         "Syrah",
    # Grenache/Garnacha
    "Grenache":       "Grenache",
    "Garnacha":       "Grenache",
    # Merlot
    "Merlot":         "Merlot",
    # Sangiovese
    "Sangiovese":     "Sangiovese",
    # Nebbiolo
    "Nebbiolo":       "Nebbiolo",
    # Tempranillo
    "Tempranillo":    "Tempranillo",
    # Malbec
    "Malbec":         "Malbec",
    # Zinfandel/Primitivo
    "Zinfandel":      "Zinfandel",
    "Primitivo":      "Zinfandel",
    # Gamay
    "Gamay":          "Gamay",
    # Chenin
    "Chenin Blanc":   "Chenin",
    # Gewurztraminer
    "Gewurztraminer": "Gewurztraminer",
    # Grüner Veltliner
    "Grüner Veltliner": "Grüner Veltliner",
    # Corvina
    "Corvina":        "Corvina",
    # Mourvèdre
    "Mourvèdre":      "Mourvèdre",
    # Touriga
    "Touriga Nacional": "Touriga",
    # Blaufränkisch
    "Blaufränkisch":  "Blaufränkisch",
    # Viognier
    "Viognier":       "Viognier",
    # Muscat
    "Muscat":         "Muscat",
    "Moscato":        "Muscat",
    # Sémillon
    "Sémillon":       "Sémillon",
}

def compute_grape_family(grapes: list[str]) -> Optional[str]:
    if not grapes:
        return None
    return GRAPE_FAMILY_MAP.get(grapes[0], grapes[0].split()[0])  # fallback: first word


# ─────────────────────────────────────────────────────────────────────────────
# region_hierarchy  (array<string>)
# ─────────────────────────────────────────────────────────────────────────────

KNOWN_COUNTRIES = {
    "France", "Italy", "Spain", "United States", "Germany", "Austria",
    "Portugal", "Australia", "New Zealand", "Argentina", "Chile",
    "South Africa", "Israel", "Hungary", "Greece", "Croatia",
    "Mexico", "Japan", "Lebanon", "Georgia", "Romania", "Bulgaria",
    "Switzerland", "Slovenia", "Canada", "Uruguay",
}

def compute_region_hierarchy(region: str, country: str) -> list[str]:
    """
    "France / Gevrey-Chambertin / France / Bourgogne / Côte de Nuits / Gevrey-Chambertin"
    → ["France", "Bourgogne", "Côte de Nuits", "Gevrey-Chambertin"]
    (deduplicated, country-filtered, max 4 levels)
    """
    if not region and not country:
        return []

    parts = [p.strip() for p in region.split("/") if p.strip()]
    # Remove duplicates while preserving order, skip bare country repeats
    seen: set[str] = set()
    unique: list[str] = []
    for p in parts:
        if p not in seen:
            seen.add(p)
            unique.append(p)

    # Ensure country is first
    if country and (not unique or unique[0] != country):
        if country in unique:
            unique.remove(country)
        unique.insert(0, country)

    # Remove redundant country-level entries in the middle
    result: list[str] = []
    for p in unique:
        if p in KNOWN_COUNTRIES and result:
            continue  # skip country duplicates after first position
        result.append(p)

    return result[:5]  # cap at 5 levels


# ─────────────────────────────────────────────────────────────────────────────
# price_band_numeric  (int 1–4)
# ─────────────────────────────────────────────────────────────────────────────

PRICE_BAND_NUMERIC = {"value": 1, "mid": 2, "premium": 3, "luxury": 4}

def compute_price_band_numeric(price_band: str) -> int:
    return PRICE_BAND_NUMERIC.get(price_band, 2)


# ─────────────────────────────────────────────────────────────────────────────
# PATCH
# ─────────────────────────────────────────────────────────────────────────────

def patch(wine: dict) -> dict:
    w = dict(wine)

    wine_type  = w.get("wineType", "red")
    price_band = w.get("priceBand", "mid")
    label      = w.get("canonicalLabel", "")
    producer   = w.get("producer", "")
    region     = w.get("region", "")
    country    = w.get("country", "")
    grapes     = w.get("grapes") or []
    body       = float(w.get("body") or 0.5)
    tannin     = float(w.get("tannin") or 0.5)
    rating     = float(w.get("ratingAvg") or 4.0)

    # finish_length
    w["finishLength"] = compute_finish_length(body, tannin, wine_type)

    # occasion
    if not w.get("occasion"):
        w["occasion"] = compute_occasion(price_band, wine_type, rating)

    # classification
    if not w.get("classification"):
        cls = extract_classification(label)
        if cls:
            w["classification"] = cls

    # producer_type
    if not w.get("producerType"):
        w["producerType"] = extract_producer_type(producer, label)

    # oak_treatment
    if not w.get("oakTreatment"):
        oak = compute_oak_treatment(wine_type, label, region, grapes)
        if oak:
            w["oakTreatment"] = oak

    # grape_family
    if not w.get("grapeFamily"):
        gf = compute_grape_family(grapes)
        if gf:
            w["grapeFamily"] = gf

    # region_hierarchy
    if not w.get("regionHierarchy"):
        rh = compute_region_hierarchy(region, country)
        if rh:
            w["regionHierarchy"] = rh

    # price_band_numeric
    w["priceBandNumeric"] = compute_price_band_numeric(price_band)

    return w


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",  default="data/silver-phase2.ndjson")
    parser.add_argument("--output", default="data/silver-phase3.ndjson")
    args = parser.parse_args()

    wines = []
    with open(args.input, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                wines.append(json.loads(line))

    n = len(wines)
    print(f"  Patching {n} wines...", flush=True)
    patched = [patch(w) for w in wines]

    with open(args.output, "w", encoding="utf-8") as f:
        for w in patched:
            f.write(json.dumps(w, ensure_ascii=False) + "\n")

    print(f"  Written → {args.output}")
    print()

    def pct(x): return str(x) + "/" + str(n) + " (" + str(round(100*x/n,1)) + "%)"

    has_finish  = sum(1 for w in patched if w.get("finishLength"))
    has_occ     = sum(1 for w in patched if w.get("occasion"))
    has_cls     = sum(1 for w in patched if w.get("classification"))
    has_ptype   = sum(1 for w in patched if w.get("producerType"))
    has_oak     = sum(1 for w in patched if w.get("oakTreatment"))
    has_gfam    = sum(1 for w in patched if w.get("grapeFamily"))
    has_rhier   = sum(1 for w in patched if w.get("regionHierarchy"))
    has_pbn     = sum(1 for w in patched if w.get("priceBandNumeric"))

    print("  finish_length:     ", pct(has_finish))
    print("  occasion:          ", pct(has_occ))
    print("  classification:    ", pct(has_cls))
    print("  producerType:      ", pct(has_ptype))
    print("  oakTreatment:      ", pct(has_oak))
    print("  grapeFamily:       ", pct(has_gfam))
    print("  regionHierarchy:   ", pct(has_rhier))
    print("  priceBandNumeric:  ", pct(has_pbn))

    # Sample occasion
    print()
    print("  === occasion samples ===")
    samples = patched[:5]
    for w in samples:
        print(f"    [{w.get('priceBand'):8}] [{w.get('wineType'):10}] "
              f"r={w.get('ratingAvg','?')} → {w.get('occasion')}")

    # Sample classification
    print()
    print("  === classification samples ===")
    classified = [(w['canonicalLabel'], w['classification']) for w in patched if w.get('classification')][:5]
    for label, cls in classified:
        print(f"    {cls:30} ← {label[:50]}")


if __name__ == "__main__":
    main()
