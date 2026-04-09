/**
 * Wine domain ontology for deterministic claim verification (RFC-020).
 *
 * Provides region hierarchy, grape alias resolution, and wine type
 * normalization. All data is static — zero LLM calls.
 *
 * Module-scope Maps per CLAUDE.md rule 16 (deterministic collections at module scope).
 */

/** Fold a string for accent-insensitive lookup: NFD decomposition + diacritic removal. */
function foldKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ß/gu, 'ss')
    .replace(/œ/gu, 'oe')
    .replace(/æ/gu, 'ae')
    .replace(/[\u2018\u2019\u02BC]/g, "'") // smart quotes → ASCII apostrophe
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Region hierarchy — child → parent chain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a sub-region to its parent region(s).
 * Used for hierarchy_match: "Pauillac" claim matches "Bordeaux" evidence.
 *
 * Coverage: top ~120 wine regions. Unknown regions return empty array.
 */
export const REGION_PARENTS: ReadonlyMap<string, readonly string[]> = new Map([
  // France — Bordeaux
  ['pauillac', ['haut-médoc', 'médoc', 'bordeaux', 'france']],
  ['margaux', ['haut-médoc', 'médoc', 'bordeaux', 'france']],
  ['saint-julien', ['haut-médoc', 'médoc', 'bordeaux', 'france']],
  ['saint-estèphe', ['haut-médoc', 'médoc', 'bordeaux', 'france']],
  ['haut-médoc', ['médoc', 'bordeaux', 'france']],
  ['médoc', ['bordeaux', 'france']],
  ['pomerol', ['bordeaux', 'france']],
  ['saint-émilion', ['bordeaux', 'france']],
  ['pessac-léognan', ['graves', 'bordeaux', 'france']],
  ['graves', ['bordeaux', 'france']],
  ['sauternes', ['bordeaux', 'france']],
  ['bordeaux', ['france']],
  // France — Burgundy
  ['gevrey-chambertin', ['côte de nuits', 'burgundy', 'france']],
  ['chambolle-musigny', ['côte de nuits', 'burgundy', 'france']],
  ['vosne-romanée', ['côte de nuits', 'burgundy', 'france']],
  ['nuits-saint-georges', ['côte de nuits', 'burgundy', 'france']],
  ['morey-saint-denis', ['côte de nuits', 'burgundy', 'france']],
  ['côte de nuits', ['burgundy', 'france']],
  ['pommard', ['côte de beaune', 'burgundy', 'france']],
  ['volnay', ['côte de beaune', 'burgundy', 'france']],
  ['meursault', ['côte de beaune', 'burgundy', 'france']],
  ['puligny-montrachet', ['côte de beaune', 'burgundy', 'france']],
  ['chassagne-montrachet', ['côte de beaune', 'burgundy', 'france']],
  ['côte de beaune', ['burgundy', 'france']],
  ['chablis', ['burgundy', 'france']],
  ['burgundy', ['france']],
  ['bourgogne', ['france']], // alias
  // France — Rhône
  ['côte-rôtie', ['northern rhône', 'rhône valley', 'france']],
  ['hermitage', ['northern rhône', 'rhône valley', 'france']],
  ['crozes-hermitage', ['northern rhône', 'rhône valley', 'france']],
  ['cornas', ['northern rhône', 'rhône valley', 'france']],
  ['northern rhône', ['rhône valley', 'france']],
  ['châteauneuf-du-pape', ['southern rhône', 'rhône valley', 'france']],
  ['gigondas', ['southern rhône', 'rhône valley', 'france']],
  ['southern rhône', ['rhône valley', 'france']],
  ['rhône valley', ['france']],
  ['côtes du rhône', ['rhône valley', 'france']],
  // France — Other
  ['champagne', ['france']],
  ['alsace', ['france']],
  ['loire', ['france']],
  ['sancerre', ['loire', 'france']],
  ['pouilly-fumé', ['loire', 'france']],
  ['muscadet', ['loire', 'france']],
  ['languedoc', ['france']],
  ['provence', ['france']],
  // Italy
  ['barolo', ['piedmont', 'italy']],
  ['barbaresco', ['piedmont', 'italy']],
  ['langhe', ['piedmont', 'italy']],
  ['piedmont', ['italy']],
  ['piemonte', ['italy']], // alias
  ['brunello di montalcino', ['tuscany', 'italy']],
  ['chianti', ['tuscany', 'italy']],
  ['chianti classico', ['chianti', 'tuscany', 'italy']],
  ['bolgheri', ['tuscany', 'italy']],
  ['tuscany', ['italy']],
  ['toscana', ['italy']], // alias
  ['amarone', ['veneto', 'italy']],
  ['valpolicella', ['veneto', 'italy']],
  ['soave', ['veneto', 'italy']],
  ['veneto', ['italy']],
  ['etna', ['sicily', 'italy']],
  ['sicily', ['italy']],
  ['abruzzo', ['italy']],
  // Spain
  ['rioja', ['spain']],
  ['ribera del duero', ['spain']],
  ['priorat', ['catalonia', 'spain']],
  ['penedès', ['catalonia', 'spain']],
  ['catalonia', ['spain']],
  ['rueda', ['spain']],
  ['rías baixas', ['galicia', 'spain']],
  // Portugal
  ['douro', ['portugal']],
  ['dão', ['portugal']],
  ['alentejo', ['portugal']],
  // Germany
  ['mosel', ['germany']],
  ['rheingau', ['germany']],
  ['pfalz', ['germany']],
  ['rheinhessen', ['germany']],
  // USA
  ['napa valley', ['california', 'united states']],
  ['sonoma county', ['california', 'united states']],
  ['russian river valley', ['sonoma county', 'california', 'united states']],
  ['paso robles', ['california', 'united states']],
  ['santa barbara', ['california', 'united states']],
  ['california', ['united states']],
  ['willamette valley', ['oregon', 'united states']],
  ['oregon', ['united states']],
  ['columbia valley', ['washington', 'united states']],
  ['washington', ['united states']],
  // Australia
  ['barossa valley', ['south australia', 'australia']],
  ['mclaren vale', ['south australia', 'australia']],
  ['clare valley', ['south australia', 'australia']],
  ['south australia', ['australia']],
  ['margaret river', ['western australia', 'australia']],
  ['yarra valley', ['victoria', 'australia']],
  ['hunter valley', ['new south wales', 'australia']],
  // New Zealand
  ['marlborough', ['new zealand']],
  ['central otago', ['new zealand']],
  ['hawke\'s bay', ['new zealand']],
  // South America
  ['mendoza', ['argentina']],
  ['uco valley', ['mendoza', 'argentina']],
  ['maipo valley', ['chile']],
  ['colchagua valley', ['chile']],
  ['casablanca valley', ['chile']],
  // South Africa
  ['stellenbosch', ['south africa']],
  ['swartland', ['south africa']],
  ['constantia', ['south africa']],
]);

/** Folded (accent-stripped) → canonical key index for accent-insensitive lookup. */
const REGION_PARENTS_FOLDED: ReadonlyMap<string, readonly string[]> = (() => {
  const folded = new Map<string, readonly string[]>();
  for (const [key, parents] of REGION_PARENTS) {
    folded.set(foldKey(key), parents.map((p) => foldKey(p)));
  }
  return folded;
})();

/**
 * Check if `child` region is a sub-region of `parent` (hierarchy match).
 * Both inputs are lowercased + NFKC-normalized + accent-folded before lookup.
 *
 * Returns the depth: 0 = exact match, 1 = direct parent, 2+ = ancestor.
 * Returns -1 if no hierarchy relationship found.
 */
export function regionHierarchyDepth(child: string, parent: string): number {
  const c = foldKey(child);
  const p = foldKey(parent);
  if (c === p) return 0;

  const parents = REGION_PARENTS_FOLDED.get(c);
  if (parents === undefined) return -1;

  const idx = parents.indexOf(p);
  return idx >= 0 ? idx + 1 : -1;
}

/**
 * Check if two regions are related (either direction) in the hierarchy.
 */
export function regionsRelated(a: string, b: string): boolean {
  return regionHierarchyDepth(a, b) >= 0 || regionHierarchyDepth(b, a) >= 0;
}

/**
 * RFC-019: Ontology traversal — returns the ancestor chain (parents) of a region
 * from closest to furthest. Empty array if the region is unknown or a root.
 *
 * Example: `regionAncestors('pauillac')` →
 *   `['haut-médoc', 'médoc', 'bordeaux', 'france']`
 *
 * Used by OntologyExpansion to derive inferred constraints:
 *   `region=Pauillac` → inferred `country=France`, soft `region∈[Bordeaux]`
 */
export function regionAncestors(region: string): readonly string[] {
  const folded = foldKey(region);
  return REGION_PARENTS_FOLDED.get(folded) ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Grape alias resolution — synonym → canonical
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps grape synonyms to canonical names.
 * Used for normalized_match: "Shiraz" claim matches "Syrah" evidence.
 */
export const GRAPE_ALIASES: ReadonlyMap<string, string> = new Map([
  // Syrah/Shiraz
  ['shiraz', 'syrah'],
  ['syrah', 'syrah'],
  // Grenache/Garnacha
  ['garnacha', 'grenache'],
  ['grenache', 'grenache'],
  ['grenache noir', 'grenache'],
  // Pinot family
  ['pinot grigio', 'pinot gris'],
  ['pinot gris', 'pinot gris'],
  ['pinot bianco', 'pinot blanc'],
  ['pinot blanc', 'pinot blanc'],
  // Zinfandel/Primitivo
  ['primitivo', 'zinfandel'],
  ['zinfandel', 'zinfandel'],
  // Muscat family
  ['moscato', 'muscat'],
  ['muscat', 'muscat'],
  ['muscat blanc', 'muscat'],
  ['moscatel', 'muscat'],
  // Cabernet
  ['cab sauv', 'cabernet sauvignon'],
  ['cabernet sauvignon', 'cabernet sauvignon'],
  ['cabernet franc', 'cabernet franc'],
  ['cab franc', 'cabernet franc'],
  // Other synonyms
  ['petit sirah', 'petite sirah'],
  ['petite sirah', 'petite sirah'],
  ['mourvèdre', 'mourvèdre'],
  ['mourvedre', 'mourvèdre'],
  ['monastrell', 'mourvèdre'],
  ['albariño', 'albariño'],
  ['albarino', 'albariño'],
  ['grüner veltliner', 'grüner veltliner'],
  ['gruner veltliner', 'grüner veltliner'],
  ['gewürztraminer', 'gewurztraminer'],
  ['gewurztraminer', 'gewurztraminer'],
  ['torrontés', 'torrontés'],
  ['torrontes', 'torrontés'],
  ['carmenère', 'carmenère'],
  ['carmenere', 'carmenère'],
  ['mencía', 'mencía'],
  ['mencia', 'mencía'],
  ['blaufränkisch', 'blaufränkisch'],
  ['blaufrankisch', 'blaufränkisch'],
  ['sémillon', 'sémillon'],
  ['semillon', 'sémillon'],
  // Region-name → grape mappings (Barolo → Nebbiolo, Chianti → Sangiovese, etc.)
  // were intentionally REMOVED because resolveGrapeAlias() is called on free
  // strings and would silently mis-resolve region references to grape values.
  // If region-implies-typical-grape inference is needed, add an explicit
  // regionImpliesGrape() helper instead.
]);

/**
 * Resolve a grape name to its canonical form.
 * Returns the canonical name, or the original (lowercased NFKC) if not found.
 */
export function resolveGrapeAlias(grape: string): string {
  const key = grape.toLowerCase().normalize('NFKC').trim();
  return GRAPE_ALIASES.get(key) ?? key;
}

/**
 * Check if two grape names are synonyms of the same canonical variety.
 */
export function grapesEquivalent(a: string, b: string): boolean {
  return resolveGrapeAlias(a) === resolveGrapeAlias(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wine type normalization
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical wine types. */
export const WINE_TYPE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['red', 'red'], ['레드', 'red'], ['rouge', 'red'], ['rosso', 'red'], ['tinto', 'red'],
  ['white', 'white'], ['화이트', 'white'], ['blanc', 'white'], ['bianco', 'white'], ['blanco', 'white'],
  ['rosé', 'rosé'], ['rose', 'rosé'], ['로제', 'rosé'],
  ['sparkling', 'sparkling'], ['스파클링', 'sparkling'], ['champagne', 'sparkling'],
  ['dessert', 'dessert'], ['디저트', 'dessert'], ['sweet', 'dessert'],
  ['fortified', 'fortified'], ['포트', 'fortified'], ['port', 'fortified'],
  ['sherry', 'fortified'], ['madeira', 'fortified'],
]);

/**
 * Normalize a wine type string to canonical form.
 * Returns canonical type or the original (lowercased) if not found.
 */
export function normalizeWineType(wineType: string): string {
  const key = wineType.toLowerCase().normalize('NFKC').trim();
  return WINE_TYPE_ALIASES.get(key) ?? key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Price normalization (Korean 만원 → number)
// ─────────────────────────────────────────────────────────────────────────────

/** Approximate USD→KRW for price range matching. */
const USD_TO_KRW = 1350;
/** KRW per 만원 (Korean ten-thousand won unit). */
const KRW_PER_MAN_WON = 10000;
/** Approximate EUR→USD exchange factor for price matching (not live FX). */
const EUR_TO_USD = 1.08;
/** Approximate GBP→USD for fractional currency conversion. */
const GBP_TO_USD = 1.27;

/**
 * Parse a Korean price expression to KRW number.
 * Handles: "5만원", "50,000원", "$50", "€40"
 * Returns null if unparseable.
 */
export function parseKoreanPrice(text: string): number | null {
  const trimmed = text.trim().normalize('NFKC');
  // N만원
  const manWon = trimmed.match(/(\d+(?:\.\d+)?)\s*만\s*원/u);
  if (manWon?.[1]) {
    const v = Number(manWon[1]);
    if (Number.isFinite(v)) return v * KRW_PER_MAN_WON;
  }
  // N,NNN원 or NNNN원
  const plainWon = trimmed.match(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*원/u);
  if (plainWon?.[1]) {
    const v = Number(plainWon[1].replace(/,/g, ''));
    if (Number.isFinite(v)) return v;
  }
  // $N
  const usd = trimmed.match(/\$\s*(\d+(?:\.\d+)?)/u);
  if (usd?.[1]) {
    const v = Number(usd[1]);
    if (Number.isFinite(v)) return v * USD_TO_KRW;
  }
  // €N
  const eur = trimmed.match(/€\s*(\d+(?:\.\d+)?)/u);
  if (eur?.[1]) {
    const v = Number(eur[1]);
    if (Number.isFinite(v)) return v * USD_TO_KRW * EUR_TO_USD;
  }
  // £N
  const gbp = trimmed.match(/£\s*(\d+(?:\.\d+)?)/u);
  if (gbp?.[1]) {
    const v = Number(gbp[1]);
    if (Number.isFinite(v)) return v * USD_TO_KRW * GBP_TO_USD;
  }
  return null;
}
