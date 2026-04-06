#!/usr/bin/env python3
"""
Phase 1 patch — two targeted improvements on top of silver-phase1.ndjson:

  A. grapes / grapePrimary  — expanded region→grape map (covers Beaujolais crus,
     Jura, Bandol, Valtellina, Alto Adige, Colchagua, Israel appellations, etc.)
     Goal: 71% → 85%+

  B. searchTextEn — enrich short entries (<50 chars) with flavour/taste-based
     tasting-note sentences so semantic embedding has meaningful content.
     Goal: 627 short entries → near 0

Usage:
  python3 scripts/etl/enrich-phase1-patch.py \
    --input  data/silver-phase1.ndjson \
    --output data/silver-phase1b.ndjson
"""

import json, re, sys, argparse
from typing import Any, Optional

# ─────────────────────────────────────────────────────────────────────────────
# A. EXPANDED REGION → GRAPE MAP
# ─────────────────────────────────────────────────────────────────────────────

# All keys are matched case-insensitively as substrings of the region field.
# Listed roughly from most-specific to least-specific so the first match wins.
EXTENDED_REGION_GRAPE: list[tuple[str, list[str]]] = [

    # ── Beaujolais crus ──────────────────────────────────────────────────────
    ("Moulin-à-Vent",       ["Gamay"]),
    ("Fleurie",             ["Gamay"]),
    ("Morgon",              ["Gamay"]),
    ("Brouilly",            ["Gamay"]),
    ("Côte de Brouilly",    ["Gamay"]),
    ("Chiroubles",          ["Gamay"]),
    ("Juliénas",            ["Gamay"]),
    ("Chénas",              ["Gamay"]),
    ("Régnié",              ["Gamay"]),
    ("Saint-Amour",         ["Gamay"]),
    ("Beaujolais",          ["Gamay"]),

    # ── Jura / Savoie ────────────────────────────────────────────────────────
    ("Arbois Pupillin",     ["Poulsard", "Trousseau"]),
    ("Arbois",              ["Poulsard", "Trousseau", "Savagnin"]),
    ("Côtes du Jura",       ["Poulsard", "Trousseau", "Savagnin"]),
    ("Vin Jaune",           ["Savagnin"]),
    ("Savoie",              ["Jacquère", "Mondeuse"]),

    # ── Provence / Languedoc ─────────────────────────────────────────────────
    ("Bandol",              ["Mourvèdre", "Grenache"]),
    ("Côtes de Provence",   ["Grenache", "Syrah", "Cinsault"]),
    ("Provence",            ["Grenache", "Syrah", "Cinsault"]),
    ("Côtes Catalanes",     ["Grenache", "Carignan"]),
    ("Côtes du Roussillon", ["Grenache", "Syrah", "Carignan"]),
    ("Vaucluse",            ["Grenache", "Syrah"]),
    ("Languedoc",           ["Grenache", "Syrah", "Mourvèdre"]),
    ("Roussillon",          ["Grenache", "Carignan"]),
    ("Corsica",             ["Nielluccio", "Sciaccarello"]),
    ("Corse",               ["Nielluccio", "Sciaccarello"]),

    # ── South-West France ────────────────────────────────────────────────────
    ("Cahors",              ["Malbec"]),
    ("Madiran",             ["Tannat"]),
    ("Bergerac",            ["Merlot", "Cabernet Franc"]),
    ("Gaillac",             ["Braucol", "Syrah"]),
    ("Irouléguy",           ["Tannat"]),

    # ── Loire ────────────────────────────────────────────────────────────────
    ("Vouvray",             ["Chenin Blanc"]),
    ("Savennières",         ["Chenin Blanc"]),
    ("Chinon",              ["Cabernet Franc"]),
    ("Bourgueil",           ["Cabernet Franc"]),
    ("Saumur",              ["Cabernet Franc", "Chenin Blanc"]),
    ("Anjou",               ["Chenin Blanc"]),
    ("Touraine",            ["Sauvignon Blanc", "Cabernet Franc"]),
    ("Muscadet",            ["Melon de Bourgogne"]),

    # ── Bordeaux specific ────────────────────────────────────────────────────
    ("Saint-Estèphe",       ["Cabernet Sauvignon", "Merlot"]),
    ("Listrac-Médoc",       ["Cabernet Sauvignon", "Merlot"]),
    ("Moulis",              ["Cabernet Sauvignon", "Merlot"]),
    ("Fronsac",             ["Merlot", "Cabernet Franc"]),
    ("Bourg",               ["Merlot", "Cabernet Sauvignon"]),
    ("Blaye",               ["Merlot", "Cabernet Sauvignon"]),
    ("Entre-Deux-Mers",     ["Sauvignon Blanc"]),
    ("Sauternes",           ["Sémillon", "Sauvignon Blanc"]),
    ("Barsac",              ["Sémillon", "Sauvignon Blanc"]),

    # ── Burgundy white ───────────────────────────────────────────────────────
    ("Mâcon",               ["Chardonnay"]),
    ("Pouilly-Fuissé",      ["Chardonnay"]),
    ("Saint-Véran",         ["Chardonnay"]),
    ("Rully",               ["Chardonnay", "Pinot Noir"]),
    ("Mercurey",            ["Pinot Noir"]),
    ("Givry",               ["Pinot Noir"]),
    ("Bouzeron",            ["Aligoté"]),
    ("Fixin",               ["Pinot Noir"]),
    ("Marsannay",           ["Pinot Noir"]),
    ("Maranges",            ["Pinot Noir"]),
    ("Auxey-Duresses",      ["Pinot Noir", "Chardonnay"]),
    ("Saint-Aubin",         ["Chardonnay"]),
    ("Santenay",            ["Pinot Noir"]),

    # ── Rhône ────────────────────────────────────────────────────────────────
    ("Saint-Joseph",        ["Syrah"]),
    ("Lirac",               ["Grenache", "Mourvèdre"]),
    ("Vacqueyras",          ["Grenache", "Syrah"]),
    ("Rasteau",             ["Grenache"]),
    ("Condrieu",            ["Viognier"]),
    ("Viognier",            ["Viognier"]),

    # ── Italy: Piedmont ──────────────────────────────────────────────────────
    ("Barolo",              ["Nebbiolo"]),
    ("Barbaresco",          ["Nebbiolo"]),
    ("Roero",               ["Nebbiolo", "Arneis"]),
    ("Gattinara",           ["Nebbiolo"]),
    ("Ghemme",              ["Nebbiolo"]),
    ("Sforzato della Valtellina", ["Nebbiolo"]),
    ("Valtellina Superiore",["Nebbiolo"]),
    ("Valtellina",          ["Nebbiolo"]),
    ("Barbera d'Asti",      ["Barbera"]),
    ("Barbera d'Alba",      ["Barbera"]),
    ("Barbera",             ["Barbera"]),
    ("Dolcetto d'Alba",     ["Dolcetto"]),
    ("Dolcetto",            ["Dolcetto"]),
    ("Moscato d'Asti",      ["Moscato"]),
    ("Brachetto",           ["Brachetto"]),
    ("Grignolino",          ["Grignolino"]),
    ("Freisa",              ["Freisa"]),

    # ── Italy: Veneto ────────────────────────────────────────────────────────
    ("Amarone della Valpolicella", ["Corvina", "Rondinella"]),
    ("Ripasso",             ["Corvina", "Rondinella"]),
    ("Recioto",             ["Corvina", "Rondinella"]),
    ("Valpolicella Ripasso",["Corvina", "Rondinella"]),
    ("Prosecco",            ["Glera"]),
    ("Lugana",              ["Trebbiano di Lugana"]),
    ("Soave Classico",      ["Garganega"]),

    # ── Italy: Tuscany ───────────────────────────────────────────────────────
    ("Brunello di Montalcino", ["Sangiovese"]),
    ("Rosso di Montalcino", ["Sangiovese"]),
    ("Nobile di Montepulciano", ["Sangiovese"]),
    ("Morellino di Scansano", ["Sangiovese"]),
    ("Chianti Classico",    ["Sangiovese"]),
    ("Chianti Rufina",      ["Sangiovese"]),
    ("Carmignano",          ["Sangiovese", "Cabernet Sauvignon"]),
    ("Bolgheri",            ["Cabernet Sauvignon", "Merlot"]),
    ("Maremma",             ["Sangiovese", "Cabernet Sauvignon"]),
    ("Vernaccia di San Gimignano", ["Vernaccia"]),

    # ── Italy: Central / Southern ────────────────────────────────────────────
    ("Sagrantino di Montefalco", ["Sagrantino"]),
    ("Montefalco Sagrantino", ["Sagrantino"]),
    ("Montefalco",          ["Sagrantino", "Sangiovese"]),
    ("Torgiano",            ["Sangiovese"]),
    ("Lazio",               ["Cesanese", "Trebbiano"]),
    ("Umbria",              ["Sagrantino", "Sangiovese"]),
    ("Colli Orientali del Friuli", ["Friulano", "Pinot Grigio", "Refosco"]),
    ("Friuli-Venezia Giulia",["Friulano", "Pinot Grigio"]),
    ("Collio",              ["Friulano", "Pinot Grigio"]),
    ("Alto Adige",          ["Pinot Grigio", "Gewurztraminer", "Lagrein"]),
    ("Südtirol",            ["Pinot Grigio", "Gewurztraminer", "Lagrein"]),
    ("Trentino",            ["Pinot Grigio", "Teroldego"]),
    ("Isola dei Nuraghi",   ["Cannonau", "Vermentino"]),
    ("Sardinia",            ["Cannonau", "Vermentino"]),
    ("Sardegna",            ["Cannonau", "Vermentino"]),
    ("Vigneti delle Dolomiti", ["Pinot Grigio", "Lagrein"]),

    # ── Spain ────────────────────────────────────────────────────────────────
    ("Toro",                ["Tempranillo"]),
    ("Cigales",             ["Tempranillo"]),
    ("Rueda",               ["Verdejo"]),
    ("Txakoli",             ["Hondarrabi Zuri"]),
    ("Navarra",             ["Garnacha", "Tempranillo"]),
    ("Campo de Borja",      ["Garnacha"]),
    ("Calatayud",           ["Garnacha"]),
    ("Cariñena",            ["Garnacha", "Carignan"]),
    ("Jumilla",             ["Monastrell"]),
    ("Yecla",               ["Monastrell"]),
    ("Almansa",             ["Monastrell"]),
    ("Valencia",            ["Monastrell", "Bobal"]),
    ("Utiel-Requena",       ["Bobal"]),
    ("Montsant",            ["Grenache", "Carignan"]),
    ("Ribeira Sacra",       ["Mencía"]),
    ("Valdeorras",          ["Godello"]),
    ("Ribeiro",             ["Treixadura"]),
    ("Vino de España",      ["Tempranillo"]),
    ("Castilla y León",     ["Tempranillo"]),
    ("Madrid",              ["Tempranillo", "Garnacha"]),
    ("Mallorca",            ["Callet", "Mantonegro"]),

    # ── Portugal ─────────────────────────────────────────────────────────────
    ("Douro",               ["Touriga Nacional", "Tinta Roriz"]),
    ("Alentejo",            ["Aragonez", "Trincadeira"]),
    ("Vinho Verde",         ["Loureiro", "Arinto"]),
    ("Dão",                 ["Touriga Nacional", "Alfrocheiro"]),
    ("Bairrada",            ["Baga"]),
    ("Setúbal",             ["Castelão"]),
    ("Lisboa",              ["Castelão", "Aragonez"]),

    # ── Germany ──────────────────────────────────────────────────────────────
    ("Mosel",               ["Riesling"]),
    ("Rheingau",            ["Riesling"]),
    ("Pfalz",               ["Riesling", "Spätburgunder"]),
    ("Rheinhessen",         ["Riesling", "Silvaner"]),
    ("Nahe",                ["Riesling"]),
    ("Ahr",                 ["Spätburgunder"]),
    ("Baden",               ["Spätburgunder", "Grauburgunder"]),
    ("Württemberg",         ["Trollinger", "Lemberger"]),
    ("Franken",             ["Silvaner"]),
    ("Sachsen",             ["Riesling", "Müller-Thurgau"]),
    ("Mittelrhein",         ["Riesling"]),
    ("Germany",             ["Riesling"]),

    # ── Austria ──────────────────────────────────────────────────────────────
    ("Wachau",              ["Grüner Veltliner", "Riesling"]),
    ("Kamptal",             ["Grüner Veltliner", "Riesling"]),
    ("Kremstal",            ["Grüner Veltliner", "Riesling"]),
    ("Traisental",          ["Grüner Veltliner"]),
    ("Burgenland",          ["Blaufränkisch", "Zweigelt"]),
    ("Neusiedlersee",       ["Zweigelt", "Welschriesling"]),
    ("Südburgenland",       ["Blaufränkisch"]),
    ("Steiermark",          ["Sauvignon Blanc", "Welschriesling"]),
    ("Wien",                ["Grüner Veltliner", "Riesling"]),
    ("Austria",             ["Grüner Veltliner"]),

    # ── Greece ───────────────────────────────────────────────────────────────
    ("Santorini",           ["Assyrtiko"]),
    ("Naoussa",             ["Xinomavro"]),
    ("Goumenissa",          ["Xinomavro"]),
    ("Amyndeon",            ["Xinomavro"]),
    ("Nemea",               ["Agiorgitiko"]),
    ("Patras",              ["Roditis"]),
    ("Mantineia",           ["Moschofilero"]),
    ("Epanomi",             ["Assyrtiko", "Xinomavro"]),
    ("Greece",              ["Assyrtiko"]),

    # ── Israel ───────────────────────────────────────────────────────────────
    ("Galilee",             ["Cabernet Sauvignon", "Syrah"]),
    ("Upper Galilee",       ["Cabernet Sauvignon", "Syrah"]),
    ("Judean Hills",        ["Cabernet Sauvignon", "Merlot"]),
    ("Jerusalem",           ["Cabernet Sauvignon", "Merlot"]),
    ("Golan Heights",       ["Cabernet Sauvignon", "Merlot"]),
    ("Samaria",             ["Cabernet Sauvignon"]),
    ("Israel",              ["Cabernet Sauvignon"]),

    # ── Croatia ──────────────────────────────────────────────────────────────
    ("Srednja I Juzna Dalmacija", ["Plavac Mali"]),
    ("Dalmatian Coast",     ["Plavac Mali", "Pošip"]),
    ("Dalmatia",            ["Plavac Mali"]),
    ("Istria",              ["Malvazija", "Teran"]),
    ("Slavonia",            ["Graševina"]),
    ("Croatia",             ["Plavac Mali"]),

    # ── USA specific ─────────────────────────────────────────────────────────
    ("Santa Lucia Highlands", ["Pinot Noir", "Chardonnay"]),
    ("Santa Cruz Mountains",  ["Pinot Noir", "Chardonnay"]),
    ("Happy Canyon of Santa Barbara", ["Cabernet Sauvignon", "Sauvignon Blanc"]),
    ("Santa Ynez Valley",   ["Pinot Noir", "Syrah"]),
    ("Sta. Rita Hills",     ["Pinot Noir", "Chardonnay"]),
    ("Ballard Canyon",      ["Syrah"]),
    ("Anderson Valley",     ["Pinot Noir", "Chardonnay"]),
    ("Carneros",            ["Pinot Noir", "Chardonnay"]),
    ("Stags Leap",          ["Cabernet Sauvignon"]),
    ("Oakville",            ["Cabernet Sauvignon"]),
    ("Rutherford",          ["Cabernet Sauvignon"]),
    ("Howell Mountain",     ["Cabernet Sauvignon"]),
    ("Spring Mountain",     ["Cabernet Sauvignon"]),
    ("Diamond Mountain",    ["Cabernet Sauvignon"]),
    ("Mount Veeder",        ["Cabernet Sauvignon"]),
    ("Calistoga",           ["Cabernet Sauvignon"]),
    ("Yountville",          ["Cabernet Sauvignon", "Merlot"]),
    ("Walla Walla",         ["Cabernet Sauvignon", "Syrah"]),
    ("Columbia Valley",     ["Cabernet Sauvignon", "Riesling"]),
    ("Yakima Valley",       ["Riesling", "Syrah"]),
    ("Red Mountain",        ["Cabernet Sauvignon"]),
    ("Dry Creek Valley",    ["Zinfandel", "Cabernet Sauvignon"]),
    ("Alexander Valley",    ["Cabernet Sauvignon", "Chardonnay"]),
    ("Chalk Hill",          ["Chardonnay"]),
    ("Rockpile",            ["Zinfandel"]),
    ("Lodi",                ["Zinfandel", "Cabernet Sauvignon"]),
    ("Amador County",       ["Zinfandel"]),
    ("Sierra Foothills",    ["Zinfandel"]),
    ("Central Coast",       ["Pinot Noir", "Chardonnay"]),
    ("Monterey",            ["Pinot Noir", "Chardonnay"]),
    ("Virginia",            ["Cabernet Franc", "Viognier"]),
    ("Texas",               ["Tempranillo", "Cabernet Sauvignon"]),
    ("California",          ["Cabernet Sauvignon"]),

    # ── Chile ────────────────────────────────────────────────────────────────
    ("Colchagua Valley",    ["Cabernet Sauvignon", "Carmenère"]),
    ("Cachapoal Valley",    ["Cabernet Sauvignon", "Carmenère"]),
    ("Apalta",              ["Carmenère", "Cabernet Sauvignon"]),
    ("Maule Valley",        ["Carmenère", "Carignan"]),
    ("Itata Valley",        ["Cinsault", "País"]),
    ("Bio Bio",             ["Riesling", "Pinot Noir"]),
    ("Casablanca Valley",   ["Sauvignon Blanc", "Chardonnay"]),
    ("San Antonio",         ["Sauvignon Blanc", "Pinot Noir"]),
    ("Leyda Valley",        ["Sauvignon Blanc", "Pinot Noir"]),
    ("Aconcagua",           ["Cabernet Sauvignon"]),

    # ── Argentina ────────────────────────────────────────────────────────────
    ("Luján de Cuyo",       ["Malbec"]),
    ("Valle de Uco",        ["Malbec", "Cabernet Franc"]),
    ("Tupungato",           ["Malbec", "Chardonnay"]),
    ("Patagonia",           ["Pinot Noir", "Malbec"]),
    ("Salta",               ["Torrontés", "Malbec"]),
    ("San Rafael",          ["Malbec", "Cabernet Sauvignon"]),

    # ── South Africa ─────────────────────────────────────────────────────────
    ("Stellenbosch",        ["Cabernet Sauvignon", "Pinotage"]),
    ("Swartland",           ["Syrah", "Chenin Blanc"]),
    ("Franschhoek",         ["Cabernet Sauvignon", "Chardonnay"]),
    ("Walker Bay",          ["Pinot Noir", "Chardonnay"]),
    ("Elgin",               ["Sauvignon Blanc", "Pinot Noir"]),
    ("Constantia",          ["Sauvignon Blanc"]),
    ("Hemel-en-Aarde",      ["Pinot Noir", "Chardonnay"]),
    ("Robertson",           ["Chardonnay"]),
    ("South Africa",        ["Pinotage", "Chenin Blanc"]),

    # ── Australia ────────────────────────────────────────────────────────────
    ("Barossa Valley",      ["Shiraz", "Grenache"]),
    ("Eden Valley",         ["Riesling", "Shiraz"]),
    ("Clare Valley",        ["Riesling"]),
    ("McLaren Vale",        ["Shiraz", "Grenache"]),
    ("Coonawarra",          ["Cabernet Sauvignon"]),
    ("Margaret River",      ["Cabernet Sauvignon", "Chardonnay"]),
    ("Mornington Peninsula",["Pinot Noir", "Chardonnay"]),
    ("Yarra Valley",        ["Pinot Noir", "Chardonnay"]),
    ("Hunter Valley",       ["Semillon", "Shiraz"]),
    ("Heathcote",           ["Shiraz"]),
    ("Rutherglen",          ["Muscat"]),
    ("Padthaway",           ["Shiraz", "Cabernet Sauvignon"]),
    ("Langhorne Creek",     ["Cabernet Sauvignon", "Shiraz"]),
    ("Riverland",           ["Shiraz", "Cabernet Sauvignon"]),
    ("Australia",           ["Shiraz"]),

    # ── New Zealand ──────────────────────────────────────────────────────────
    ("Marlborough",         ["Sauvignon Blanc"]),
    ("Hawke's Bay",         ["Syrah", "Cabernet Sauvignon"]),
    ("Martinborough",       ["Pinot Noir"]),
    ("Central Otago",       ["Pinot Noir"]),
    ("Waipara",             ["Riesling", "Pinot Noir"]),
    ("Gisborne",            ["Chardonnay"]),
    ("Nelson",              ["Sauvignon Blanc", "Pinot Noir"]),
    ("New Zealand",         ["Sauvignon Blanc"]),

    # ── Hungary ──────────────────────────────────────────────────────────────
    ("Tokaj",               ["Furmint", "Hárslevelű"]),
    ("Eger",                ["Egri Bikavér", "Kékfrankos"]),
    ("Villány",             ["Cabernet Franc", "Merlot"]),
    ("Szekszárd",           ["Kadarka", "Kékfrankos"]),

    # ── Switzerland ──────────────────────────────────────────────────────────
    ("Valais",              ["Pinot Noir", "Chasselas"]),
    ("Vaud",                ["Chasselas"]),
    ("Geneva",              ["Chasselas", "Gamay"]),
    ("Graubünden",          ["Pinot Noir"]),
    ("Switzerland",         ["Pinot Noir", "Chasselas"]),

    # ── Mexico ───────────────────────────────────────────────────────────────
    ("Valle de Guadalupe",  ["Nebbiolo", "Cabernet Sauvignon"]),
    ("Mexico",              ["Cabernet Sauvignon", "Nebbiolo"]),

    # ── Lebanon ──────────────────────────────────────────────────────────────
    ("Bekaa Valley",        ["Cabernet Sauvignon", "Cinsault"]),
    ("Lebanon",             ["Cabernet Sauvignon", "Cinsault"]),

    # ── Georgia (country) ────────────────────────────────────────────────────
    ("Kakheti",             ["Rkatsiteli", "Saperavi"]),
    ("Kartli",              ["Rkatsiteli"]),
    ("Georgia",             ["Saperavi", "Rkatsiteli"]),
]

# ─────────────────────────────────────────────────────────────────────────────
# B. SEARCHTEXT_EN ENRICHMENT
# ─────────────────────────────────────────────────────────────────────────────

BODY_EN = {
    (0.0, 0.35): "light-bodied",
    (0.35, 0.55): "medium-bodied",
    (0.55, 0.72): "full-bodied",
    (0.72, 1.01): "full-bodied and powerful",
}

TANNIN_EN = {
    (0.0, 0.3): "silky tannins",
    (0.3, 0.5): "soft tannins",
    (0.5, 0.65): "firm tannins",
    (0.65, 1.01): "grippy tannins",
}

ACIDITY_EN = {
    (0.0, 0.45): "low acidity",
    (0.45, 0.65): "balanced acidity",
    (0.65, 0.80): "bright acidity",
    (0.80, 1.01): "crisp, high acidity",
}

SWEETNESS_EN = {
    (0.0, 0.15): "dry",
    (0.15, 0.35): "off-dry",
    (0.35, 0.60): "semi-sweet",
    (0.60, 1.01): "sweet",
}

def _range_label(val: float, mapping: dict) -> str:
    for (lo, hi), label in mapping.items():
        if lo <= val < hi:
            return label
    return ""

WINE_TYPE_ADJ = {
    "red": "red wine",
    "white": "white wine",
    "rose": "rosé wine",
    "sparkling": "sparkling wine",
    "fortified": "fortified wine",
}

def build_search_text_en(wine: dict) -> str:
    """
    Compose a rich English tasting note for semantic embedding.
    Example: "Elegant light-bodied Pinot Noir red wine from Burgundy, France.
              Notes of cherry, raspberry, earth and violets. Silky tannins,
              bright acidity, dry finish."
    """
    parts: list[str] = []

    wine_type = wine.get("wineType", "red")
    grapes = wine.get("grapes") or []
    region = wine.get("region", "")
    country = wine.get("country", "")
    flavors = wine.get("flavorProfiles") or []
    body_val = float(wine.get("body") or 0.5)
    tannin_val = float(wine.get("tannin") or 0.5)
    acidity_val = float(wine.get("acidity") or 0.5)
    sweetness_val = float(wine.get("sweetness") or 0.12)
    producer = wine.get("producer", "")
    vintage = wine.get("vintageYear")
    label = wine.get("canonicalLabel", "")

    body_str    = _range_label(body_val, BODY_EN)
    tannin_str  = _range_label(tannin_val, TANNIN_EN)
    acidity_str = _range_label(acidity_val, ACIDITY_EN)
    sweet_str   = _range_label(sweetness_val, SWEETNESS_EN)
    type_str    = WINE_TYPE_ADJ.get(wine_type, "wine")

    # Extract a clean region name (second or last specific segment)
    region_parts = [p.strip() for p in region.split("/")]
    countries_set = {"France","Italy","Spain","United States","Germany","Australia",
                     "Portugal","Argentina","Chile","South Africa","New Zealand",
                     "Austria","Israel","Croatia","Greece","Hungary","Switzerland",
                     "Mexico","Lebanon","Georgia","Japan","Romania","Bulgaria"}
    clean_region_parts = [p for p in region_parts if p and p not in countries_set]
    clean_region = clean_region_parts[-1] if clean_region_parts else ""

    # Sentence 1: identity
    grape_str = ", ".join(grapes[:2]) if grapes else ""
    loc_parts = [p for p in [clean_region, country] if p]
    loc_str = " / ".join(loc_parts) if loc_parts else ""

    if grape_str and loc_str:
        parts.append(f"{body_str.capitalize()} {grape_str} {type_str} from {loc_str}.")
    elif grape_str:
        parts.append(f"{body_str.capitalize()} {grape_str} {type_str}.")
    elif loc_str:
        parts.append(f"{body_str.capitalize()} {type_str} from {loc_str}.")
    else:
        parts.append(f"{body_str.capitalize()} {type_str}.")

    # Sentence 2: flavours
    if flavors:
        flavor_list = ", ".join(flavors[:5])
        parts.append(f"Notes of {flavor_list}.")

    # Sentence 3: structure
    structure_bits = []
    if wine_type == "red":
        structure_bits.append(tannin_str)
    structure_bits.append(acidity_str)
    structure_bits.append(f"{sweet_str} finish")
    parts.append(", ".join(b for b in structure_bits if b).capitalize() + ".")

    # Sentence 4: producer + vintage context
    meta_bits = []
    if producer:
        meta_bits.append(f"Produced by {producer}")
    if vintage:
        meta_bits.append(f"vintage {vintage}")
    if meta_bits:
        parts.append(". ".join(meta_bits) + ".")

    return " ".join(parts)


# ─────────────────────────────────────────────────────────────────────────────
# APPLY
# ─────────────────────────────────────────────────────────────────────────────

def patch_grapes(wine: dict) -> dict:
    """Only fill grapes if currently empty."""
    if wine.get("grapes"):
        return wine
    region = wine.get("region", "").lower()
    label  = wine.get("canonicalLabel", "").lower()
    for key, grapes in EXTENDED_REGION_GRAPE:
        if key.lower() in region or key.lower() in label:
            wine = dict(wine)
            wine["grapes"] = grapes
            wine["grapePrimary"] = grapes[0]
            return wine
    return wine


def patch_search_text_en(wine: dict) -> dict:
    """Rebuild searchTextEn when it is short (just producer name or empty)."""
    existing = wine.get("searchTextEn", "")
    if len(existing) >= 50:
        return wine
    wine = dict(wine)
    wine["searchTextEn"] = build_search_text_en(wine)
    return wine


def patch(wine: dict) -> dict:
    wine = patch_grapes(wine)
    wine = patch_search_text_en(wine)
    return wine


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",  default="data/silver-phase1.ndjson")
    parser.add_argument("--output", default="data/silver-phase1b.ndjson")
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

    # Stats
    def pct(x): return str(x) + "/" + str(n) + " (" + str(round(100*x/n, 1)) + "%)"

    grapes_filled   = sum(1 for w in patched if w.get("grapes"))
    grapes_was      = sum(1 for w in wines   if w.get("grapes"))
    en_short_after  = sum(1 for w in patched if len(w.get("searchTextEn","")) < 50)
    en_short_before = sum(1 for w in wines   if len(w.get("searchTextEn","")) < 50)

    print()
    print("  === GRAPE FILL ===")
    print("  Before:", pct(grapes_was))
    print("  After: ", pct(grapes_filled))
    print()
    print("  === searchTextEn SHORT (<50 chars) ===")
    print("  Before:", en_short_before)
    print("  After: ", en_short_after)

    # Sample enriched searchTextEn
    print()
    print("  === searchTextEn samples (was short) ===")
    samples = [w for w in patched if len(wines[patched.index(w)].get("searchTextEn","")) < 50][:3]
    for w in samples:
        print("  label:", w["canonicalLabel"])
        print("  en:   ", w["searchTextEn"][:120])
        print()


if __name__ == "__main__":
    main()
