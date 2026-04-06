#!/usr/bin/env python3
"""
Phase 1 data enrichment — rule-based, no external API.

Fills in:
  A. grapes / grapePrimary   (label parsing + region inference)
  B. wineType                (correct from all-"red" default)
  C. body/tannin/acidity/sweetness  (varietal + region rules)
  D. flavorProfiles          (varietal dictionary)
  E. pairingTags             (style + varietal rules, merge with existing)
  F. searchTextKo            (Korean translation of key attributes)
  G. country                 (parse from region string)
  H. appellation             (extract sub-region)

Usage:
  python3 scripts/etl/enrich-phase1.py \
    --input  data/silver-enriched.ndjson \
    --output data/silver-phase1.ndjson
"""

import json, re, sys, argparse
from typing import Any, Optional

# ─────────────────────────────────────────────────────────────────────────────
# A. GRAPE DICTIONARY
# ─────────────────────────────────────────────────────────────────────────────

# label-substring → canonical grape name (ordered: longer matches first)
LABEL_GRAPE_PATTERNS: list[tuple[str, str]] = [
    # Sparkling
    ("Blanc de Blancs", "Chardonnay"),
    ("Blanc de Noirs", "Pinot Noir"),
    # White
    ("Gewurztraminer", "Gewurztraminer"), ("Gewürztraminer", "Gewurztraminer"),
    ("Grüner Veltliner", "Grüner Veltliner"), ("Gruner Veltliner", "Grüner Veltliner"),
    ("Sauvignon Blanc", "Sauvignon Blanc"),
    ("Pinot Grigio", "Pinot Grigio"), ("Pinot Gris", "Pinot Gris"),
    ("Pinot Bianco", "Pinot Blanc"), ("Pinot Blanc", "Pinot Blanc"),
    ("Chardonnay", "Chardonnay"),
    ("Riesling", "Riesling"),
    ("Viognier", "Viognier"),
    ("Roussanne", "Roussanne"),
    ("Marsanne", "Marsanne"),
    ("Grenache Blanc", "Grenache Blanc"),
    ("Vermentino", "Vermentino"),
    ("Fiano", "Fiano"),
    ("Greco", "Greco"),
    ("Falanghina", "Falanghina"),
    ("Albariño", "Albariño"), ("Albarino", "Albariño"),
    ("Verdejo", "Verdejo"),
    ("Torrontés", "Torrontés"), ("Torrontes", "Torrontés"),
    ("Muscat", "Muscat"),
    ("Moscato", "Moscato"),
    ("Soave", "Garganega"),
    ("Chenin Blanc", "Chenin Blanc"),
    ("Semillon", "Sémillon"), ("Sémillon", "Sémillon"),
    # Red
    ("Cabernet Franc", "Cabernet Franc"),
    ("Cabernet Sauvignon", "Cabernet Sauvignon"),
    ("Sauvignon", "Cabernet Sauvignon"),   # fallback only if no Blanc context
    ("Petit Verdot", "Petit Verdot"),
    ("Malbec", "Malbec"),
    ("Merlot", "Merlot"),
    ("Carmenère", "Carmenère"), ("Carmenere", "Carmenère"),
    ("Pinot Noir", "Pinot Noir"),
    ("Pinot Meunier", "Pinot Meunier"),
    ("Zinfandel", "Zinfandel"),
    ("Primitivo", "Primitivo"),
    ("Syrah", "Syrah"),
    ("Shiraz", "Shiraz"),
    ("Grenache", "Grenache"),
    ("Mourvèdre", "Mourvèdre"), ("Mourvedre", "Mourvèdre"),
    ("Tempranillo", "Tempranillo"),
    ("Garnacha", "Grenache"),
    ("Sangiovese", "Sangiovese"),
    ("Brunello", "Sangiovese"),
    ("Nebbiolo", "Nebbiolo"),
    ("Barolo", "Nebbiolo"),
    ("Barbaresco", "Nebbiolo"),
    ("Dolcetto", "Dolcetto"),
    ("Barbera", "Barbera"),
    ("Montepulciano", "Montepulciano"),
    ("Aglianico", "Aglianico"),
    ("Nero d'Avola", "Nero d'Avola"),
    ("Nerello Mascalese", "Nerello Mascalese"),
    ("Touriga Nacional", "Touriga Nacional"),
    ("Petite Sirah", "Petite Sirah"),
    ("Petit Sirah", "Petite Sirah"),
    ("Pinotage", "Pinotage"),
    ("Gamay", "Gamay"),
    ("Carignan", "Carignan"),
    ("Cinsault", "Cinsault"),
    ("Tannat", "Tannat"),
    ("Mencia", "Mencía"), ("Mencía", "Mencía"),
    ("Blaufränkisch", "Blaufränkisch"), ("Blaufrankisch", "Blaufränkisch"),
    ("Zweigelt", "Zweigelt"),
    ("Corvina", "Corvina"),
    ("Amarone", "Corvina"),
    ("Valpolicella", "Corvina"),
    ("Xinomavro", "Xinomavro"),
    ("Assyrtiko", "Assyrtiko"),
]

# region keyword → [primary grape, ...]
REGION_GRAPE_MAP: dict[str, list[str]] = {
    # France
    "Gevrey-Chambertin": ["Pinot Noir"],
    "Chambertin": ["Pinot Noir"],
    "Vosne-Romanée": ["Pinot Noir"],
    "Nuits-Saint-Georges": ["Pinot Noir"],
    "Pommard": ["Pinot Noir"],
    "Volnay": ["Pinot Noir"],
    "Morey-Saint-Denis": ["Pinot Noir"],
    "Chambolle-Musigny": ["Pinot Noir"],
    "Côte de Nuits": ["Pinot Noir"],
    "Côte de Beaune": ["Pinot Noir"],
    "Bourgogne": ["Pinot Noir"],
    "Burgundy": ["Pinot Noir"],
    "Chablis": ["Chardonnay"],
    "Meursault": ["Chardonnay"],
    "Puligny-Montrachet": ["Chardonnay"],
    "Chassagne-Montrachet": ["Chardonnay"],
    "Montrachet": ["Chardonnay"],
    "Corton-Charlemagne": ["Chardonnay"],
    "Pomerol": ["Merlot", "Cabernet Franc"],
    "Saint-Émilion": ["Merlot", "Cabernet Franc"],
    "Pétrus": ["Merlot"],
    "Médoc": ["Cabernet Sauvignon", "Merlot"],
    "Pauillac": ["Cabernet Sauvignon", "Merlot"],
    "Margaux": ["Cabernet Sauvignon", "Merlot"],
    "Saint-Julien": ["Cabernet Sauvignon", "Merlot"],
    "Haut-Médoc": ["Cabernet Sauvignon", "Merlot"],
    "Graves": ["Cabernet Sauvignon", "Merlot"],
    "Pessac-Léognan": ["Cabernet Sauvignon", "Merlot"],
    "Bordeaux": ["Cabernet Sauvignon", "Merlot"],
    "Châteauneuf-du-Pape": ["Grenache", "Syrah", "Mourvèdre"],
    "Gigondas": ["Grenache", "Syrah"],
    "Côtes du Rhône": ["Grenache", "Syrah"],
    "Hermitage": ["Syrah"],
    "Crozes-Hermitage": ["Syrah"],
    "Cornas": ["Syrah"],
    "Côte-Rôtie": ["Syrah"],
    "Northern Rhône": ["Syrah"],
    "Southern Rhône": ["Grenache", "Syrah"],
    "Champagne": ["Chardonnay", "Pinot Noir", "Pinot Meunier"],
    "Alsace": ["Riesling", "Gewurztraminer", "Pinot Gris"],
    "Loire": ["Chenin Blanc", "Sauvignon Blanc"],
    "Sancerre": ["Sauvignon Blanc"],
    "Pouilly-Fumé": ["Sauvignon Blanc"],
    "Muscadet": ["Melon de Bourgogne"],
    # Italy
    "Barolo": ["Nebbiolo"],
    "Barbaresco": ["Nebbiolo"],
    "Langhe": ["Nebbiolo"],
    "Piedmont": ["Nebbiolo", "Barbera", "Dolcetto"],
    "Piemonte": ["Nebbiolo", "Barbera", "Dolcetto"],
    "Brunello di Montalcino": ["Sangiovese"],
    "Montalcino": ["Sangiovese"],
    "Chianti": ["Sangiovese"],
    "Toscana": ["Sangiovese"],
    "Tuscany": ["Sangiovese"],
    "Vino Nobile": ["Sangiovese"],
    "Amarone": ["Corvina", "Rondinella"],
    "Valpolicella": ["Corvina", "Rondinella"],
    "Soave": ["Garganega"],
    "Etna": ["Nerello Mascalese"],
    "Sicily": ["Nero d'Avola", "Nerello Mascalese"],
    "Sicilia": ["Nero d'Avola"],
    "Abruzzo": ["Montepulciano"],
    "Campania": ["Aglianico", "Fiano"],
    # Spain
    "Rioja": ["Tempranillo", "Garnacha"],
    "Ribera del Duero": ["Tempranillo"],
    "Priorat": ["Grenache", "Carignan"],
    "Penedès": ["Cava grapes"],
    "Rías Baixas": ["Albariño"],
    "Bierzo": ["Mencía"],
    # USA
    "Napa Valley": ["Cabernet Sauvignon"],
    "Sonoma": ["Pinot Noir", "Chardonnay", "Zinfandel"],
    "Russian River": ["Pinot Noir", "Chardonnay"],
    "Willamette Valley": ["Pinot Noir"],
    "Oregon": ["Pinot Noir"],
    "Washington": ["Cabernet Sauvignon", "Syrah"],
    "Paso Robles": ["Cabernet Sauvignon", "Zinfandel"],
    "Santa Barbara": ["Pinot Noir", "Chardonnay"],
    # Others
    "Mendoza": ["Malbec"],
    "Argentina": ["Malbec"],
    "Barossa Valley": ["Shiraz"],
    "McLaren Vale": ["Shiraz"],
    "Clare Valley": ["Riesling"],
    "Marlborough": ["Sauvignon Blanc"],
    "Stellenbosch": ["Cabernet Sauvignon", "Pinotage"],
    "Douro": ["Touriga Nacional"],
    "Port": ["Touriga Nacional"],
    "Tokaj": ["Furmint"],
    "Mosel": ["Riesling"],
    "Rheingau": ["Riesling"],
    "Pfalz": ["Riesling"],
}

# ─────────────────────────────────────────────────────────────────────────────
# B. WINE TYPE DETECTION
# ─────────────────────────────────────────────────────────────────────────────

WHITE_SIGNALS = [
    "blanc", "bianco", "white", "weiss", "weißer",
    "chardonnay", "riesling", "sauvignon blanc", "pinot gris", "pinot grigio",
    "pinot blanc", "pinot bianco", "viognier", "roussanne", "marsanne",
    "gewurztraminer", "gewürztraminer", "gruner veltliner", "grüner veltliner",
    "soave", "albariño", "albarino", "verdejo", "vermentino", "fiano",
    "greco di tufo", "falanghina", "chenin blanc", "semillon", "sémillon",
    "torrontés", "torrontes", "muscadet", "meursault", "chablis",
    "puligny", "chassagne", "montrachet", "corton-charlemagne", "pouilly-fumé",
    "sancerre", "assyrtiko", "arneis", "cortese", "gavi",
]
ROSE_SIGNALS = [
    "rosé", "rose", "rosato", "rosado", "clarete",
    "côtes de provence", "provence",
]
SPARKLING_SIGNALS = [
    "champagne", "prosecco", "cava", "crémant", "cremant",
    "franciacorta", "sekt", "sparkling", "spumante",
    "pétillant", "petillant", "mousseux", "brut", "blanc de blancs",
    "blanc de noirs", "extra brut", "demi-sec",
]
FORTIFIED_SIGNALS = [
    "port", "porto", "sherry", "jerez", "madeira", "marsala",
    "banyuls", "maury", "muscat de beaumes", "vin doux", "sauternes",
    "beerenauslese", "trockenbeerenauslese", "eiswein",
]

def detect_wine_type(label: str, region: str, grapes: list[str]) -> str:
    t = (label + " " + region).lower()
    g = " ".join(grapes).lower()
    if any(s in t for s in SPARKLING_SIGNALS): return "sparkling"
    if any(s in t for s in FORTIFIED_SIGNALS): return "fortified"
    if any(s in t for s in ROSE_SIGNALS): return "rose"
    if any(s in t for s in WHITE_SIGNALS): return "white"
    if any(s in g for s in ["chardonnay","riesling","sauvignon blanc","pinot gris",
                              "viognier","chenin blanc","pinot blanc","gewurz"]): return "white"
    return "red"

# ─────────────────────────────────────────────────────────────────────────────
# C. TASTE PROFILES  (body, tannin, acidity, sweetness) — all 0–1
# ─────────────────────────────────────────────────────────────────────────────

# varietal → (body, tannin, acidity, sweetness)
VARIETAL_TASTE: dict[str, tuple[float,float,float,float]] = {
    "Cabernet Sauvignon": (0.85, 0.80, 0.65, 0.10),
    "Merlot":             (0.70, 0.55, 0.58, 0.12),
    "Cabernet Franc":     (0.65, 0.60, 0.68, 0.10),
    "Malbec":             (0.80, 0.70, 0.55, 0.12),
    "Petit Verdot":       (0.88, 0.85, 0.65, 0.08),
    "Syrah":              (0.82, 0.75, 0.60, 0.10),
    "Shiraz":             (0.80, 0.72, 0.58, 0.12),
    "Grenache":           (0.68, 0.45, 0.58, 0.18),
    "Mourvèdre":          (0.80, 0.78, 0.58, 0.08),
    "Pinot Noir":         (0.42, 0.32, 0.78, 0.12),
    "Zinfandel":          (0.75, 0.62, 0.58, 0.20),
    "Primitivo":          (0.75, 0.60, 0.55, 0.22),
    "Nebbiolo":           (0.75, 0.88, 0.82, 0.08),
    "Sangiovese":         (0.65, 0.70, 0.80, 0.10),
    "Tempranillo":        (0.68, 0.65, 0.65, 0.12),
    "Barbera":            (0.58, 0.38, 0.85, 0.12),
    "Dolcetto":           (0.58, 0.55, 0.62, 0.10),
    "Gamay":              (0.35, 0.28, 0.75, 0.12),
    "Pinotage":           (0.72, 0.65, 0.62, 0.12),
    "Corvina":            (0.70, 0.65, 0.68, 0.10),
    "Touriga Nacional":   (0.85, 0.85, 0.68, 0.10),
    "Mencía":             (0.62, 0.60, 0.70, 0.10),
    "Carignan":           (0.72, 0.78, 0.72, 0.08),
    "Nero d'Avola":       (0.78, 0.68, 0.62, 0.12),
    "Nerello Mascalese":  (0.58, 0.55, 0.78, 0.10),
    "Montepulciano":      (0.72, 0.65, 0.72, 0.10),
    "Aglianico":          (0.82, 0.82, 0.78, 0.08),
    "Blaufränkisch":      (0.70, 0.68, 0.75, 0.10),
    "Tannat":             (0.88, 0.90, 0.65, 0.08),
    # White
    "Chardonnay":         (0.65, 0.05, 0.55, 0.10),
    "Sauvignon Blanc":    (0.40, 0.05, 0.82, 0.10),
    "Riesling":           (0.35, 0.05, 0.88, 0.25),
    "Pinot Gris":         (0.55, 0.05, 0.60, 0.18),
    "Pinot Grigio":       (0.40, 0.05, 0.65, 0.12),
    "Pinot Blanc":        (0.45, 0.05, 0.62, 0.10),
    "Viognier":           (0.70, 0.05, 0.45, 0.15),
    "Roussanne":          (0.65, 0.05, 0.55, 0.12),
    "Marsanne":           (0.68, 0.05, 0.48, 0.12),
    "Gewurztraminer":     (0.60, 0.05, 0.45, 0.35),
    "Grüner Veltliner":   (0.45, 0.05, 0.75, 0.10),
    "Albariño":           (0.42, 0.05, 0.78, 0.10),
    "Verdejo":            (0.42, 0.05, 0.72, 0.10),
    "Chenin Blanc":       (0.48, 0.05, 0.78, 0.22),
    "Sémillon":           (0.58, 0.05, 0.55, 0.18),
    "Muscat":             (0.42, 0.05, 0.55, 0.45),
    "Moscato":            (0.28, 0.05, 0.58, 0.65),
    "Assyrtiko":          (0.45, 0.05, 0.88, 0.08),
    "Vermentino":         (0.42, 0.05, 0.72, 0.10),
    "Garganega":          (0.40, 0.05, 0.65, 0.12),
    # Sparkling (base)
    "Pinot Meunier":      (0.45, 0.30, 0.72, 0.12),
    "Furmint":            (0.45, 0.05, 0.85, 0.30),
}

REGION_TASTE_BOOST: dict[str, dict[str, float]] = {
    # warm climates → higher body/lower acidity
    "Napa Valley":     {"body": +0.08, "acidity": -0.05},
    "Barossa Valley":  {"body": +0.10, "acidity": -0.08},
    "Mendoza":         {"body": +0.06, "acidity": -0.04},
    "Paso Robles":     {"body": +0.07, "acidity": -0.05},
    # cool climates → lower body/higher acidity
    "Burgundy":        {"body": -0.05, "acidity": +0.05},
    "Bourgogne":       {"body": -0.05, "acidity": +0.05},
    "Champagne":       {"body": -0.08, "acidity": +0.10},
    "Mosel":           {"body": -0.08, "acidity": +0.12},
    "Willamette":      {"body": -0.05, "acidity": +0.05},
    # fortified
    "Port":            {"body": +0.15, "sweetness": +0.55},
    "Sauternes":       {"body": +0.05, "sweetness": +0.60},
    "Tokaj":           {"sweetness": +0.50},
}

TYPE_DEFAULTS: dict[str, tuple[float,float,float,float]] = {
    "red":        (0.65, 0.60, 0.62, 0.10),
    "white":      (0.48, 0.05, 0.68, 0.12),
    "rose":       (0.42, 0.18, 0.68, 0.15),
    "sparkling":  (0.38, 0.08, 0.78, 0.12),
    "fortified":  (0.85, 0.15, 0.45, 0.60),
}

def compute_taste(grapes: list[str], region: str, wine_type: str) -> dict[str, float]:
    body, tannin, acidity, sweetness = TYPE_DEFAULTS.get(wine_type, (0.60,0.40,0.65,0.12))
    if grapes:
        primary = grapes[0]
        if primary in VARIETAL_TASTE:
            body, tannin, acidity, sweetness = VARIETAL_TASTE[primary]

    reg = region.lower()
    for key, boosts in REGION_TASTE_BOOST.items():
        if key.lower() in reg:
            body     = min(1.0, max(0.0, body     + boosts.get("body", 0)))
            tannin   = min(1.0, max(0.0, tannin   + boosts.get("tannin", 0)))
            acidity  = min(1.0, max(0.0, acidity  + boosts.get("acidity", 0)))
            sweetness= min(1.0, max(0.0, sweetness+ boosts.get("sweetness", 0)))
            break

    return {
        "body":      round(body, 2),
        "tannin":    round(tannin, 2),
        "acidity":   round(acidity, 2),
        "sweetness": round(sweetness, 2),
    }

# ─────────────────────────────────────────────────────────────────────────────
# D. FLAVOR PROFILES
# ─────────────────────────────────────────────────────────────────────────────

VARIETAL_FLAVORS: dict[str, list[str]] = {
    "Cabernet Sauvignon": ["blackcurrant", "dark cherry", "cedar", "tobacco", "graphite", "black plum"],
    "Merlot":             ["plum", "dark cherry", "chocolate", "bay leaf", "black cherry", "mocha"],
    "Cabernet Franc":     ["raspberry", "green pepper", "violets", "graphite", "blackcurrant", "herbs"],
    "Malbec":             ["blackberry", "plum", "violet", "dark chocolate", "leather", "tobacco"],
    "Petit Verdot":       ["blackcurrant", "blueberry", "violet", "graphite", "dark chocolate", "spice"],
    "Syrah":              ["blackberry", "pepper", "smoked meat", "dark plum", "olive", "violet"],
    "Shiraz":             ["blackberry", "pepper", "dark chocolate", "vanilla", "eucalyptus", "plum"],
    "Grenache":           ["raspberry", "strawberry", "orange peel", "garrigue", "spice", "leather"],
    "Mourvèdre":          ["blackberry", "leather", "meat", "earth", "bay", "black olive"],
    "Pinot Noir":         ["cherry", "raspberry", "earth", "mushroom", "violets", "cola", "spice"],
    "Zinfandel":          ["blackberry jam", "pepper", "raspberry", "dark chocolate", "vanilla", "tobacco"],
    "Nebbiolo":           ["cherry", "tar", "roses", "tobacco", "leather", "truffle", "licorice"],
    "Sangiovese":         ["sour cherry", "tomato leaf", "leather", "earth", "herbs", "tobacco"],
    "Tempranillo":        ["cherry", "dried fig", "tobacco", "leather", "vanilla", "cedar"],
    "Barbera":            ["sour cherry", "blueberry", "tobacco", "spice", "earthy"],
    "Gamay":              ["strawberry", "raspberry", "peony", "banana", "mineral"],
    "Corvina":            ["cherry", "almond", "dark chocolate", "dried fruit", "tobacco"],
    "Touriga Nacional":   ["blackcurrant", "plum", "violet", "dark chocolate", "spice"],
    "Nero d'Avola":       ["blackberry", "cherry", "licorice", "tobacco", "dark chocolate"],
    "Aglianico":          ["dark cherry", "tar", "tobacco", "leather", "dark chocolate", "herbs"],
    "Tannat":             ["blackcurrant", "plum", "dark chocolate", "tobacco", "leather", "iron"],
    "Pinotage":           ["blackberry", "banana", "dark chocolate", "smoke", "coffee"],
    # White
    "Chardonnay":         ["apple", "pear", "citrus", "butter", "vanilla", "toasty oak", "tropical fruit"],
    "Sauvignon Blanc":    ["grapefruit", "passion fruit", "green herb", "gooseberry", "lime", "mineral"],
    "Riesling":           ["peach", "apricot", "lime", "petrol", "slate", "honey", "floral"],
    "Pinot Gris":         ["pear", "peach", "apricot", "spice", "honey", "almond"],
    "Pinot Grigio":       ["lemon", "green apple", "pear", "mineral", "white flowers"],
    "Viognier":           ["apricot", "peach", "jasmine", "orange blossom", "mango", "honey"],
    "Gewurztraminer":     ["lychee", "rose", "ginger", "spice", "jasmine", "tropical fruit"],
    "Grüner Veltliner":   ["white pepper", "grapefruit", "mineral", "green herbs", "citrus"],
    "Albariño":           ["peach", "lemon", "grapefruit", "floral", "mineral", "salinity"],
    "Chenin Blanc":       ["apple", "quince", "honey", "ginger", "mineral", "chamomile"],
    "Muscat":             ["orange blossom", "rose", "lychee", "musk", "peach", "honey"],
    "Riesling":           ["peach", "apricot", "lime", "petrol", "slate", "honey"],
    "Assyrtiko":          ["lemon", "lime", "mineral", "saline", "white flowers", "citrus"],
    "Furmint":            ["apricot", "peach", "honey", "ginger", "mineral", "smoke"],
    # Sparkling
    "Pinot Meunier":      ["red fruit", "brioche", "citrus", "flowers"],
}

REGION_FLAVOR_EXTRA: dict[str, list[str]] = {
    "Champagne":         ["brioche", "toast", "yeast", "mineral", "citrus"],
    "Burgundy":          ["earth", "mushroom", "mineral"],
    "Bourgogne":         ["earth", "mineral", "floral"],
    "Barossa Valley":    ["jam", "eucalyptus", "chocolate"],
    "Napa Valley":       ["cassis", "vanilla", "cedar"],
    "Mosel":             ["petrol", "slate", "floral"],
    "Rioja":             ["vanilla", "coconut", "tobacco"],
    "Châteauneuf":       ["garrigue", "lavender", "thyme"],
    "Priorat":           ["licorice", "mineral", "dark fruit"],
    "Tokaj":             ["honey", "apricot", "orange peel", "saffron"],
}

def get_flavors(grapes: list[str], region: str, wine_type: str) -> list[str]:
    flavors: list[str] = []
    if grapes:
        primary = grapes[0]
        flavors = list(VARIETAL_FLAVORS.get(primary, []))

    reg = region.lower()
    for key, extras in REGION_FLAVOR_EXTRA.items():
        if key.lower() in reg:
            for e in extras:
                if e not in flavors:
                    flavors.append(e)
            break

    if not flavors:
        defaults = {
            "red":       ["dark fruit", "earth", "tannin", "spice"],
            "white":     ["citrus", "apple", "mineral", "floral"],
            "rose":      ["strawberry", "peach", "floral", "mineral"],
            "sparkling": ["brioche", "citrus", "mineral", "toast"],
            "fortified": ["dried fruit", "nuts", "caramel", "spice"],
        }
        flavors = defaults.get(wine_type, ["fruit", "earth"])

    return flavors[:6]

# ─────────────────────────────────────────────────────────────────────────────
# E. PAIRING TAGS
# ─────────────────────────────────────────────────────────────────────────────

VARIETAL_PAIRINGS: dict[str, list[str]] = {
    "Cabernet Sauvignon": ["beef", "lamb", "hard cheese", "mushroom"],
    "Merlot":             ["beef", "pork", "pasta", "soft cheese"],
    "Malbec":             ["beef", "bbq", "lamb", "hard cheese"],
    "Syrah":              ["lamb", "beef", "bbq", "game"],
    "Shiraz":             ["beef", "bbq", "lamb", "spicy food"],
    "Pinot Noir":         ["salmon", "duck", "mushroom", "soft cheese", "chicken"],
    "Zinfandel":          ["bbq", "beef", "pizza", "spicy food"],
    "Nebbiolo":           ["beef", "truffle", "game", "hard cheese", "pasta"],
    "Sangiovese":         ["pasta", "pizza", "beef", "tomato sauce", "hard cheese"],
    "Tempranillo":        ["lamb", "beef", "tapas", "hard cheese"],
    "Grenache":           ["lamb", "pork", "mediterranean", "soft cheese"],
    "Gamay":              ["chicken", "salmon", "charcuterie", "soft cheese"],
    "Chardonnay":         ["chicken", "seafood", "pasta", "soft cheese", "salmon"],
    "Sauvignon Blanc":    ["seafood", "salad", "goat cheese", "asparagus", "sushi"],
    "Riesling":           ["asian food", "spicy food", "pork", "seafood"],
    "Viognier":           ["chicken", "seafood", "spicy food", "apricot dishes"],
    "Gewurztraminer":     ["asian food", "spicy food", "foie gras", "soft cheese"],
    "Pinot Gris":         ["seafood", "chicken", "pork", "soft cheese"],
    "Albariño":           ["seafood", "shellfish", "sushi", "tapas"],
    "Chenin Blanc":       ["chicken", "seafood", "soft cheese", "pork"],
    "Muscat":             ["dessert", "fruit", "soft cheese"],
    "Furmint":            ["foie gras", "dessert", "soft cheese"],
}

TYPE_PAIRINGS: dict[str, list[str]] = {
    "red":       ["beef", "lamb", "hard cheese", "pasta"],
    "white":     ["seafood", "chicken", "salad", "soft cheese"],
    "rose":      ["seafood", "salad", "mediterranean", "chicken"],
    "sparkling": ["oysters", "caviar", "appetizers", "celebration"],
    "fortified": ["dessert", "chocolate", "nuts", "blue cheese"],
}

def get_pairings(grapes: list[str], wine_type: str, existing: list[str]) -> list[str]:
    pairings = list(existing) if existing else []
    added: list[str] = []
    if grapes:
        primary = grapes[0]
        added = VARIETAL_PAIRINGS.get(primary, [])
    if not added:
        added = TYPE_PAIRINGS.get(wine_type, [])
    for p in added:
        if p not in pairings:
            pairings.append(p)
    return pairings[:6]

# ─────────────────────────────────────────────────────────────────────────────
# F. KOREAN SEARCH TEXT
# ─────────────────────────────────────────────────────────────────────────────

COUNTRY_KO: dict[str, str] = {
    "France": "프랑스", "Italy": "이탈리아", "Spain": "스페인",
    "United States": "미국", "USA": "미국",
    "Germany": "독일", "Austria": "오스트리아", "Portugal": "포르투갈",
    "Australia": "호주", "New Zealand": "뉴질랜드",
    "Argentina": "아르헨티나", "Chile": "칠레",
    "South Africa": "남아프리카공화국", "Israel": "이스라엘",
    "Hungary": "헝가리", "Greece": "그리스", "Croatia": "크로아티아",
    "Mexico": "멕시코", "Japan": "일본",
}

REGION_KO: dict[str, str] = {
    "Bordeaux": "보르도", "Burgundy": "부르고뉴", "Bourgogne": "부르고뉴",
    "Champagne": "샴페인", "Rhône": "론", "Rhone": "론",
    "Alsace": "알자스", "Loire": "루아르", "Provence": "프로방스",
    "Tuscany": "토스카나", "Toscana": "토스카나",
    "Piedmont": "피에몬테", "Piemonte": "피에몬테",
    "Veneto": "베네토", "Sicily": "시칠리아", "Sicilia": "시칠리아",
    "Rioja": "리오하", "Ribera del Duero": "리베라 델 두에로",
    "Priorat": "프리오라트", "Rías Baixas": "리아스 바이사스",
    "Napa Valley": "나파밸리", "Sonoma": "소노마",
    "Willamette Valley": "윌라메트 밸리", "Oregon": "오레곤",
    "Washington": "워싱턴", "Paso Robles": "파소 로블레스",
    "Barossa Valley": "바로사 밸리", "McLaren Vale": "맥라렌 베일",
    "Marlborough": "말버러", "Mendoza": "멘도사",
    "Stellenbosch": "스텔렌보쉬", "Douro": "두로",
    "Mosel": "모젤", "Rheingau": "라인가우",
    "Gevrey-Chambertin": "쥬브레 샹베르탱",
    "Vosne-Romanée": "본 로마네",
    "Pauillac": "포이약", "Margaux": "마고",
    "Saint-Émilion": "생 에밀리옹", "Pomerol": "포므롤",
    "Châteauneuf-du-Pape": "샤토뇌프 뒤 파프",
    "Barolo": "바롤로", "Barbaresco": "바르바레스코",
    "Chianti": "키안티", "Brunello": "브루넬로",
    "Amarone": "아마로네", "Prosecco": "프로세코",
}

GRAPE_KO: dict[str, str] = {
    "Cabernet Sauvignon": "까베르네 소비뇽",
    "Merlot": "메를로",
    "Pinot Noir": "피노 누아",
    "Chardonnay": "샤르도네",
    "Sauvignon Blanc": "소비뇽 블랑",
    "Syrah": "시라", "Shiraz": "쉬라즈",
    "Grenache": "그르나슈",
    "Malbec": "말벡",
    "Riesling": "리슬링",
    "Zinfandel": "진판델",
    "Nebbiolo": "네비올로",
    "Sangiovese": "산조베세",
    "Tempranillo": "템프라니요",
    "Mourvèdre": "무르베드르",
    "Viognier": "비오니에",
    "Gewurztraminer": "게뷔르츠트라미너",
    "Pinot Gris": "피노 그리", "Pinot Grigio": "피노 그리지오",
    "Albariño": "알바리뇨",
    "Barbera": "바르베라",
    "Touriga Nacional": "투리가 나시오날",
    "Gamay": "가메",
    "Corvina": "코르비나",
    "Aglianico": "알리아니코",
    "Nero d'Avola": "네로 다볼라",
    "Chenin Blanc": "슈냉 블랑",
    "Muscat": "뮈스카",
    "Furmint": "푸르민트",
}

WINE_TYPE_KO: dict[str, str] = {
    "red": "레드 와인",
    "white": "화이트 와인",
    "rose": "로제 와인",
    "sparkling": "스파클링 와인",
    "fortified": "주정강화 와인",
}

FLAVOR_KO: dict[str, str] = {
    "blackcurrant": "블랙커런트", "dark cherry": "다크 체리",
    "cedar": "삼나무", "tobacco": "담배", "cherry": "체리",
    "raspberry": "라즈베리", "plum": "자두", "blackberry": "블랙베리",
    "vanilla": "바닐라", "chocolate": "초콜릿", "earth": "흙",
    "pepper": "후추", "leather": "가죽", "truffle": "트러플",
    "mushroom": "버섯", "citrus": "시트러스", "apple": "사과",
    "pear": "배", "peach": "복숭아", "apricot": "살구",
    "lemon": "레몬", "grapefruit": "자몽", "honey": "꿀",
    "floral": "꽃향", "mineral": "미네랄", "toast": "토스트",
    "brioche": "브리오슈", "tar": "타르", "roses": "장미",
    "jam": "잼", "spice": "스파이스",
}

BODY_KO = {(0.0, 0.4): "라이트바디", (0.4, 0.65): "미디엄바디", (0.65, 1.01): "풀바디"}

def body_label_ko(body: float) -> str:
    for (lo, hi), label in BODY_KO.items():
        if lo <= body < hi:
            return label
    return "미디엄바디"

def build_search_text_ko(wine: dict[str, Any], grapes: list[str], wine_type: str,
                          taste: dict[str, float], flavors: list[str]) -> str:
    parts: list[str] = []

    # wine type
    parts.append(WINE_TYPE_KO.get(wine_type, ""))

    # country
    country = wine.get("country", "")
    if country in COUNTRY_KO:
        parts.append(COUNTRY_KO[country])

    # region
    region = wine.get("region", "")
    for en, ko in REGION_KO.items():
        if en.lower() in region.lower():
            parts.append(ko)
            break

    # grapes
    for g in grapes[:2]:
        if g in GRAPE_KO:
            parts.append(GRAPE_KO[g])
        else:
            parts.append(g)

    # body
    if taste:
        parts.append(body_label_ko(taste.get("body", 0.5)))

    # top flavors (2)
    for f in flavors[:2]:
        ko = FLAVOR_KO.get(f)
        if ko:
            parts.append(ko)

    # vintage
    vintage = wine.get("vintageYear")
    if vintage:
        parts.append(f"{vintage}년")

    # producer name (keep original — for phonetic search)
    producer = wine.get("producer", "")
    if producer:
        parts.append(producer)

    return " ".join(p for p in parts if p)

# ─────────────────────────────────────────────────────────────────────────────
# G. COUNTRY  (parse from region)
# ─────────────────────────────────────────────────────────────────────────────

def extract_country(region: str, existing: "Optional[str]") -> str:
    if existing:
        return existing
    if not region:
        return ""
    # "France / Gevrey-Chambertin / ..." → first segment
    first = region.split("/")[0].strip()
    # Known country names that appear there
    known = [
        "France", "Italy", "Spain", "United States", "Germany", "Austria",
        "Portugal", "Australia", "New Zealand", "Argentina", "Chile",
        "South Africa", "Israel", "Hungary", "Greece", "Croatia",
        "Mexico", "Japan", "Lebanon", "Georgia", "Romania", "Bulgaria",
    ]
    if first in known:
        return first
    return ""

# ─────────────────────────────────────────────────────────────────────────────
# H. APPELLATION  (extract sub-region)
# ─────────────────────────────────────────────────────────────────────────────

def extract_appellation(region: str) -> "Optional[str]":
    if not region:
        return None
    parts = [p.strip() for p in region.split("/")]
    # Pattern: "France / Gevrey-Chambertin / France / Bourgogne / ... / Gevrey-Chambertin"
    # Take the second segment if it looks specific (not equal to country name)
    countries = {"France","Italy","Spain","United States","Germany","Australia","Portugal",
                 "Argentina","Chile","South Africa","New Zealand","Austria","Israel"}
    for p in parts[1:]:
        if p and p not in countries and len(p) > 3:
            return p
    return None

# ─────────────────────────────────────────────────────────────────────────────
# GRAPE EXTRACTION
# ─────────────────────────────────────────────────────────────────────────────

def extract_grapes(label: str, region: str) -> list[str]:
    grapes: list[str] = []
    label_lower = label.lower()
    region_lower = region.lower()

    # 1. Try label patterns (most reliable)
    for pattern, canonical in LABEL_GRAPE_PATTERNS:
        if pattern.lower() in label_lower:
            # avoid "Sauvignon" matching "Sauvignon Blanc"
            if canonical == "Cabernet Sauvignon" and "blanc" in label_lower:
                continue
            if canonical not in grapes:
                grapes.append(canonical)

    # 2. Try region map
    if not grapes:
        for key, region_grapes in REGION_GRAPE_MAP.items():
            if key.lower() in region_lower:
                grapes = list(region_grapes)
                break

    return grapes[:3]

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def enrich(wine: dict[str, Any]) -> dict[str, Any]:
    w = dict(wine)
    label  = w.get("canonicalLabel", "")
    region = w.get("region", "")

    # A. Grapes
    grapes = extract_grapes(label, region)
    w["grapes"]       = grapes
    w["grapePrimary"] = grapes[0] if grapes else None

    # B. Wine type
    w["wineType"] = detect_wine_type(label, region, grapes)

    # C. Taste
    taste = compute_taste(grapes, region, w["wineType"])
    w.update(taste)

    # D. Flavor profiles
    if not w.get("flavorProfiles"):
        w["flavorProfiles"] = get_flavors(grapes, region, w["wineType"])

    # E. Pairing tags
    w["pairingTags"] = get_pairings(grapes, w["wineType"], w.get("pairingTags") or [])

    # F. Korean text
    w["searchTextKo"] = build_search_text_ko(w, grapes, w["wineType"], taste, w["flavorProfiles"])

    # G. Country
    w["country"] = extract_country(region, w.get("country"))

    # H. Appellation
    if not w.get("appellation"):
        w["appellation"] = extract_appellation(region)

    return w


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",  default="data/silver-enriched.ndjson")
    parser.add_argument("--output", default="data/silver-phase1.ndjson")
    args = parser.parse_args()

    wines = []
    with open(args.input, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                wines.append(json.loads(line))

    print(f"  Enriching {len(wines)} wines...", flush=True)

    enriched = [enrich(w) for w in wines]

    with open(args.output, "w", encoding="utf-8") as f:
        for w in enriched:
            f.write(json.dumps(w, ensure_ascii=False) + "\n")

    print(f"  Written → {args.output}")

    # Stats
    total = len(enriched)
    def pct(n): return f"{n}/{total} ({100*n//total}%)"
    has_grape   = sum(1 for w in enriched if w.get("grapes"))
    has_flavor  = sum(1 for w in enriched if w.get("flavorProfiles"))
    has_ko      = sum(1 for w in enriched if w.get("searchTextKo"))
    has_taste   = sum(1 for w in enriched if w.get("body", 0.5) != 0.5)
    type_counts = {}
    for w in enriched:
        t = w.get("wineType","?")
        type_counts[t] = type_counts.get(t,0) + 1

    print(f"\n  grapes filled    : {pct(has_grape)}")
    print(f"  flavor filled    : {pct(has_flavor)}")
    print(f"  searchTextKo     : {pct(has_ko)}")
    print(f"  taste non-default: {pct(has_taste)}")
    print(f"  wine types       : {type_counts}")


if __name__ == "__main__":
    main()
