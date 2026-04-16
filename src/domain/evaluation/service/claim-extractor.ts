/**
 * Schema-aware claim extractor (RFC-020).
 *
 * Extracts typed claims from an agent's answer using regex + domain knowledge.
 * Zero LLM calls — structured field extraction is deterministic.
 *
 * Claim extraction pipeline:
 *   1. Extract identity claims (wine names, producers)
 *   2. Extract core structured claims (vintage, price, region, grape, wine type)
 *   3. Extract semantic claims (tasting notes, pairing, style sentences)
 *   4. Deduplicate by (category, field, normalizedValue)
 */

import crypto from 'node:crypto';
import { KRW_PER_MAN_WON, KRW_PER_USD_APPROXIMATE } from '../../shared/constants.js';
import { containsHangul } from '../../shared/utils/hangul.js';
import { Transliterator } from '../../alias/service/transliterator.js';
import { resolveEntity } from '../../attribute/service/entity-resolver.js';
import type { ExtractedClaim, ClaimCategory, WineField } from '../model/claim.js';
import { resolveGrapeAlias, normalizeWineType, REGION_PARENTS } from './wine-ontology.js';
import { correctKoreanWineTypos } from '../../query/service/korean-wine-aliases.js';
import { GENERATED_REGION_PARENTS } from './region-parents.generated.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants (module-scope per CLAUDE.md rule 16)
// ─────────────────────────────────────────────────────────────────────────────

/** Korean stopwords — not wine proper nouns. */
const KOREAN_STOPWORDS = new Set([
  '와인', '추천', '드립니다', '합니다', '입니다', '습니다', '있습니다',
  '좋습니다', '됩니다', '됩니다', '하겠습니다', '것입니다', '수있습니다',
  '해드리겠습니다', '알려드리겠습니다', '소개해', '안내해',
  '레드', '화이트', '로제', '스파클링', '디저트',
  '풀바디', '미디엄', '라이트', '드라이', '스위트',
]);

/** Korean predicate suffix — grammatical endings, not wine names. */
const KOREAN_PREDICATE_SUFFIX_RE = /(?:합니다|습니다|입니다|에요|이에요|세요|하세요|겠습니다|드립니다|줄게요|할게요|인데요|거든요|잖아요)$/u;

/** Korean particle suffix — grammatical case markers attached to wine names.
 *  Includes single-char and multi-char compound particles.
 *  e.g. "오푸스원을" → strip "을" → "오푸스원"
 *       "오푸스원에서는" → strip "에서는" → "오푸스원"
 *       "오푸스원이라는" → strip "이라는" → "오푸스원" */
const KOREAN_PARTICLE_RE = /(?:이라는|이라고|이라며|이라서|에서는|에서도|에서|으로는|으로도|으로|에는|에도|에게|한테|한테서|보다|처럼|같이|마다|밖에|조차|부터|까지|와의|과의|을|를|이|가|은|는|의|도|만|과|와|로)$/u;

/** Vintage year extraction regex — Unicode-safe boundaries. */
const VINTAGE_RE = /(?:^|[^\p{L}\p{N}])(1[6-9]\d{2}|20\d{2})(?=$|[^\p{L}\p{N}])/gu;

/** Drinking-window context — years preceded by these are NOT vintages.
 *  Includes: drink/drinking, consume/consumed, age/aged, hold, cellar,
 *  through, until, peak, closed, Korean equivalents. */
const DRINK_WINDOW_CONTEXT_RE = /(?:drink(?:ing)?|consume[d]?|age[d]?|hold|cellar|through|until|peak|closed|음용|마시기|숙성|셀러링?|적기|까지|~)\s*(?:window|기간|동안)?\s*:?\s*$/iu;

/** Korean price patterns. */
const PRICE_MAN_WON_RE = /(\d+(?:\.\d+)?)\s*만\s*원/gu;
const PRICE_PLAIN_WON_RE = /(\d{1,3}(?:,\d{3})+|\d{4,})\s*원/gu;
const PRICE_USD_RE = /\$\s*(\d+(?:\.\d+)?)/gu;

/** Common grape varieties for extraction. */
const KNOWN_GRAPES = new Set([
  'cabernet sauvignon', 'merlot', 'pinot noir', 'syrah', 'shiraz',
  'chardonnay', 'sauvignon blanc', 'riesling', 'grenache', 'tempranillo',
  'nebbiolo', 'sangiovese', 'malbec', 'zinfandel', 'gamay',
  'pinot grigio', 'pinot gris', 'gewurztraminer', 'viognier',
  'chenin blanc', 'moscato', 'muscat', 'primitivo', 'mourvèdre',
  'touriga nacional', 'corvina', 'barbera', 'dolcetto',
  'cabernet franc', 'petit verdot', 'carmenère', 'petite sirah',
  'grüner veltliner', 'albariño', 'torrontés', 'verdejo',
  'nero d\'avola', 'nerello mascalese', 'aglianico', 'blaufränkisch',
  'pinotage', 'tannat', 'mencía', 'carignan', 'cinsault', 'zweigelt',
]);

/** Known wine regions for extraction (lowercased keys → display form values). */
const KNOWN_REGIONS: ReadonlyMap<string, string> = new Map([
  ['bordeaux', 'Bordeaux'], ['burgundy', 'Burgundy'], ['bourgogne', 'Burgundy'],
  ['champagne', 'Champagne'], ['rhône', 'Rhône'], ['rhone', 'Rhône'],
  ['loire', 'Loire'], ['alsace', 'Alsace'], ['provence', 'Provence'],
  ['languedoc', 'Languedoc'], ['pauillac', 'Pauillac'], ['margaux', 'Margaux'],
  ['saint-julien', 'Saint-Julien'], ['saint-émilion', 'Saint-Émilion'],
  ['pomerol', 'Pomerol'], ['médoc', 'Médoc'], ['medoc', 'Médoc'],
  ['graves', 'Graves'], ['sauternes', 'Sauternes'], ['chablis', 'Chablis'],
  ['meursault', 'Meursault'], ['pommard', 'Pommard'], ['volnay', 'Volnay'],
  ['gevrey-chambertin', 'Gevrey-Chambertin'], ['vosne-romanée', 'Vosne-Romanée'],
  ['châteauneuf-du-pape', 'Châteauneuf-du-Pape'], ['hermitage', 'Hermitage'],
  ['côte-rôtie', 'Côte-Rôtie'], ['gigondas', 'Gigondas'],
  ['sancerre', 'Sancerre'], ['muscadet', 'Muscadet'],
  ['piedmont', 'Piedmont'], ['piemonte', 'Piedmont'], ['barolo', 'Barolo'],
  ['barbaresco', 'Barbaresco'], ['tuscany', 'Tuscany'], ['toscana', 'Tuscany'],
  ['chianti', 'Chianti'], ['brunello di montalcino', 'Brunello di Montalcino'],
  ['bolgheri', 'Bolgheri'], ['amarone', 'Amarone'], ['valpolicella', 'Valpolicella'],
  ['veneto', 'Veneto'], ['sicily', 'Sicily'], ['etna', 'Etna'],
  ['rioja', 'Rioja'], ['ribera del duero', 'Ribera del Duero'],
  ['priorat', 'Priorat'], ['penedès', 'Penedès'],
  ['douro', 'Douro'], ['mosel', 'Mosel'], ['rheingau', 'Rheingau'],
  ['napa valley', 'Napa Valley'], ['napa', 'Napa Valley'],
  ['sonoma county', 'Sonoma County'], ['sonoma', 'Sonoma County'],
  ['russian river valley', 'Russian River Valley'],
  ['paso robles', 'Paso Robles'], ['santa barbara', 'Santa Barbara'],
  ['california', 'California'], ['willamette valley', 'Willamette Valley'],
  ['oregon', 'Oregon'], ['washington', 'Washington'],
  ['barossa valley', 'Barossa Valley'], ['barossa', 'Barossa Valley'],
  ['mclaren vale', 'McLaren Vale'], ['margaret river', 'Margaret River'],
  ['yarra valley', 'Yarra Valley'], ['hunter valley', 'Hunter Valley'],
  ['marlborough', 'Marlborough'], ['central otago', 'Central Otago'],
  ['mendoza', 'Mendoza'], ['maipo valley', 'Maipo Valley'],
  ['stellenbosch', 'Stellenbosch'],
]);

/** Korean and compact alias surfaces for region extraction. */
const REGION_ALIASES: ReadonlyMap<string, string> = new Map([
  ['보르도', 'Bordeaux'],
  ['부르고뉴', 'Burgundy'],
  ['샴페인', 'Champagne'],
  ['론', 'Rhône'],
  ['나파', 'Napa Valley'],
  ['나파 밸리', 'Napa Valley'],
  ['나파밸리', 'Napa Valley'],
  ['소노마', 'Sonoma County'],
  ['피에몬테', 'Piedmont'],
  ['토스카나', 'Tuscany'],
  ['리오하', 'Rioja'],
  ['모젤', 'Mosel'],
  ['알자스', 'Alsace'],
  ['프로방스', 'Provence'],
  ['보졸레', 'Beaujolais'],
]);

/** Korean + Latin grape alias surfaces for claim extraction. */
const GRAPE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:카베르네\s*소비뇽|카베르네소비뇽|까쇼|cab(?:ernet)?\s*sauv(?:ignon)?)/iu, 'Cabernet Sauvignon'],
  [/(?:카베르네\s*프랑|cab(?:ernet)?\s*franc)/iu, 'Cabernet Franc'],
  [/(?:메를로|merlot)/iu, 'Merlot'],
  [/(?:피노\s*누아르?|피노누아|pinot\s*noir)/iu, 'Pinot Noir'],
  [/(?:피노\s*그리(?:지오)?|pinot\s*gri(?:gio|s))/iu, 'Pinot Grigio'],
  [/(?:소비뇽\s*블랑|쇼비|sauvignon\s*blanc)/iu, 'Sauvignon Blanc'],
  [/(?:샤르도네|샤도네이|chardonnay)/iu, 'Chardonnay'],
  [/(?:시라(?:즈)?|shiraz|syrah)/iu, 'Syrah'],
  [/(?:리슬링|riesling)/iu, 'Riesling'],
  [/(?:그르나슈|grenache|garnacha)/iu, 'Grenache'],
  [/(?:산지오베제|sangiovese)/iu, 'Sangiovese'],
  [/(?:템프라니요|tempranillo)/iu, 'Tempranillo'],
  [/(?:네비올로|nebbiolo)/iu, 'Nebbiolo'],
  [/(?:말벡|malbec)/iu, 'Malbec'],
];

/** Latin words commonly capitalized in wine context but NOT wine identities. */
const LATIN_IDENTITY_STOPWORDS: ReadonlySet<string> = new Set([
  'reserve', 'reserva', 'estate', 'estates', 'vineyard', 'vineyards',
  'winery', 'wines', 'wine', 'cellars', 'cellar', 'collection',
  'select', 'selection', 'special', 'limited', 'release',
  'classic', 'premium', 'gold', 'silver', 'old', 'young',
  'red', 'white', 'rose', 'sparkling', 'dessert',
]);

/** Wine type keywords for extraction. */
const WINE_TYPE_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ['레드', 'red'], ['화이트', 'white'], ['로제', 'rosé'],
  ['스파클링', 'sparkling'], ['디저트', 'dessert'], ['포티파이드', 'fortified'],
  ['red', 'red'], ['white', 'white'], ['rosé', 'rosé'], ['rose', 'rosé'],
  ['sparkling', 'sparkling'], ['dessert', 'dessert'], ['fortified', 'fortified'],
]);

/** Chars to look back before a year token for drinking-window context detection. */
const VINTAGE_CONTEXT_LOOKBACK = 30;
/** Digit length of a 4-digit vintage year (used to skip past the matched year token). */
const VINTAGE_YEAR_CHAR_LEN = 4;
/** Maximum year gap between two adjacent vintage years to treat them as a drinking-window range. */
const VINTAGE_WINDOW_GAP_MAX = 30;
/** Prefix length for claim ID (sha256 hex truncated to first N chars). */
const CLAIM_ID_PREFIX_LEN = 16;
/** Maximum token width for Korean multi-word identity candidates. */
const KOREAN_IDENTITY_MAX_TOKENS = 4;
/** Korean-only phrase segments to scan for curated wine-name matches. */
const KOREAN_IDENTITY_SEGMENT_RE = /[\uAC00-\uD7A3]+(?:\s+[\uAC00-\uD7A3]+)*/gu;
/** Latin-script candidate spans for wine labels / producers. */
const LATIN_IDENTITY_RE = /(?:^|(?<=[\s,;:(]))(?:[A-Z][a-zA-Z'\u00C0-\u017F-]*\.?|[A-Z]{2,})(?:\s+(?:(?:d[eu]s?|d'|de|del|du|des|la|le|les|y|of|and|van|von|di)\s+)?(?:[A-Z][a-zA-Z'\u00C0-\u017F-]*\.?|[A-Z]{2,}|\d{1,4}))*(?=$|[\s,;:.)/])/gu;
/** Accent-folded geography surfaces derived from deterministic ontology sources only. */
const STRUCTURED_GEOGRAPHY_SURFACES: ReadonlySet<string> = (() => {
  const surfaces = new Set<string>();
  const register = (surface: string): void => {
    const normalized = normalizeStructuredEntityKey(surface);
    if (normalized.length > 0) surfaces.add(normalized);
  };

  for (const [region, ancestors] of REGION_PARENTS) {
    register(region);
    for (const ancestor of ancestors) register(ancestor);
  }
  for (const [region, ancestors] of GENERATED_REGION_PARENTS) {
    register(region);
    for (const ancestor of ancestors) register(ancestor);
  }

  return surfaces;
})();

/** Hangul (Korean) syllable range check. Delegates to @shared/utils/hangul (SSoT). */
const isHangul = containsHangul;

/** Unicode-aware word containment check.
 *  Latin: "napa" in "napa cabbage" → true (would be wrong for region)
 *  needs word boundaries: "napa" in "from napa valley" → true, in "napa cabbage" → false
 *
 *  Korean: word boundaries don't exist in CJK (no spaces between morphemes).
 *  "레드" inside "레드와인" must match. We fall back to substring containment
 *  for Hangul needles, but exclude common syllable-level false positives by
 *  rejecting matches inside known stopwords (handled at the call site).
 */
function containsAsWord(haystack: string, needle: string): boolean {
  if (isHangul(needle)) {
    // Hangul: substring match (CJK has no word boundaries)
    return haystack.includes(needle);
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  return re.test(haystack);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main extraction function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for {@link extractClaims}.
 */
interface ExtractClaimsOptions {
  /**
   * Deterministic "current year" used as the upper bound for accepted vintage
   * years (vintages > currentYear + 1 are rejected as implausible). When
   * omitted, falls back to `new Date().getFullYear()`. Replay harnesses and
   * golden-set fixtures MUST pin this value to keep claim extraction
   * byte-stable across runs; otherwise a claim like "2026" would be accepted
   * in 2026 but rejected in 2025, silently changing eval metrics across a
   * year boundary.
   */
  readonly currentYear?: number;
}

/**
 * Extract typed claims from an agent's answer.
 *
 * @param answer - The agent's answer text
 * @param options - Optional extraction options (e.g. pinned currentYear for replay determinism)
 * @returns Array of extracted claims, deduplicated by (category, field, normalizedValue)
 */
export function extractClaims(
  answer: string,
  options?: ExtractClaimsOptions,
): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const currentYear = options?.currentYear ?? new Date().getFullYear();

  claims.push(...extractRegionClaims(answer));
  claims.push(...extractIdentityClaims(answer));
  claims.push(...extractVintageClaims(answer, currentYear));
  claims.push(...extractPriceClaims(answer));
  claims.push(...extractGrapeClaims(answer));
  claims.push(...extractWineTypeClaims(answer));
  claims.push(...extractSemanticClaims(answer));

  return deduplicateClaims(claims);
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity claims (wine names, producers)
// ─────────────────────────────────────────────────────────────────────────────

function extractIdentityClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];

  // Latin proper nouns: "Opus One", "Château Margaux", "Cepa 21 Malabrigo"
  const latinMatches = text.match(LATIN_IDENTITY_RE);
  if (latinMatches) {
    for (const name of latinMatches) {
      const trimmed = name.trim();
      if (trimmed.length < 3) continue;
      const lowered = trimmed.toLowerCase().normalize('NFKC');
      if (KNOWN_GRAPES.has(lowered)) continue;
      if (KNOWN_REGIONS.has(lowered)) continue;
      if (WINE_TYPE_KEYWORDS.has(lowered)) continue;
      if (LATIN_IDENTITY_STOPWORDS.has(lowered)) continue;
      if (isStructuredEntitySurface(trimmed)) continue;
      claims.push(makeClaim('identity_claim', 'canonical_label', trimmed, trimmed));
    }
  }

  // Korean identity claims are precision-gated via the curated transliteration
  // dictionary. This avoids turning generic Korean prose ("검색", "결과", "기준")
  // into entity claims while still preserving well-known wine labels.
  for (const { value, sourceText } of extractKoreanIdentityCandidates(text)) {
    claims.push(makeClaim('identity_claim', 'canonical_label', value, sourceText));
  }

  return claims;
}

function extractKoreanIdentityCandidates(
  text: string,
): readonly { readonly value: string; readonly sourceText: string }[] {
  const matches = text.match(KOREAN_IDENTITY_SEGMENT_RE);
  if (matches === null) return [];

  const candidates = new Map<string, { readonly value: string; readonly sourceText: string }>();

  for (const segment of matches) {
    const tokens = segment
      .trim()
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    for (let start = 0; start < tokens.length; start++) {
      for (let width = 1; width <= KOREAN_IDENTITY_MAX_TOKENS && start + width <= tokens.length; width++) {
        const rawCandidate = tokens.slice(start, start + width).join(' ');
        const normalizedCandidate = normalizeKoreanIdentityCandidate(rawCandidate);
        if (normalizedCandidate === undefined) continue;

        const romanized = Transliterator.romanizeWineTerm(normalizedCandidate);
        if (romanized === undefined) continue;

        const key = normalizedCandidate.toLowerCase().normalize('NFKC');
        if (!candidates.has(key)) {
          candidates.set(key, {
            value: normalizedCandidate,
            sourceText: rawCandidate,
          });
        }
      }
    }
  }

  return [...candidates.values()];
}

function normalizeKoreanIdentityCandidate(candidate: string): string | undefined {
  const corrected = correctKoreanWineTypos(candidate).trim();
  if (corrected.length < 2) return undefined;

  const parts = corrected.split(/\s+/u);
  const last = parts.at(-1);
  if (last === undefined) return undefined;

  const strippedLast = last.replace(KOREAN_PARTICLE_RE, '');
  const normalizedParts = [
    ...parts.slice(0, -1),
    strippedLast.length >= 2 ? strippedLast : last,
  ];
  const normalized = normalizedParts.join(' ').trim();

  if (normalized.length < 2) return undefined;
  if (KOREAN_STOPWORDS.has(normalized)) return undefined;
  if (KNOWN_REGIONS.has(normalized.toLowerCase())) return undefined;
  if (WINE_TYPE_KEYWORDS.has(normalized.toLowerCase())) return undefined;
  if (KOREAN_PREDICATE_SUFFIX_RE.test(normalized)) return undefined;
  if (isStructuredEntitySurface(normalized)) return undefined;

  return normalized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core structured claims
// ─────────────────────────────────────────────────────────────────────────────

function extractVintageClaims(text: string, currentYear: number): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const allMatches: { year: number; yearStart: number; yearEnd: number }[] = [];
  for (const m of text.matchAll(VINTAGE_RE)) {
    // m.index points to the START of the whole match (which may include a prefix char).
    // The year capture group is m[1] (always 4 digits).
    const yearStr = m[1]!;
    const yearStart = m.index + m[0].indexOf(yearStr);
    const yearNum = Number(yearStr);
    if (!Number.isFinite(yearNum)) continue;
    allMatches.push({
      year: yearNum,
      yearStart,
      yearEnd: yearStart + VINTAGE_YEAR_CHAR_LEN,
    });
  }

  for (let i = 0; i < allMatches.length; i++) {
    const { year, yearStart } = allMatches[i]!;
    const leftContext = text.slice(Math.max(0, yearStart - VINTAGE_CONTEXT_LOOKBACK), yearStart);
    if (DRINK_WINDOW_CONTEXT_RE.test(leftContext)) continue;

    // Filter dash-pair drinking windows
    if (i > 0) {
      const prev = allMatches[i - 1]!;
      const gap = year - prev.year;
      const between = text.slice(prev.yearEnd, yearStart).trim();
      // Drinking-window dash pairs: any gap 1-VINTAGE_WINDOW_GAP_MAX with a dash separator suggests a range.
      if (gap >= 1 && gap <= VINTAGE_WINDOW_GAP_MAX && /^[-–~]$/u.test(between)) continue;
    }

    const maxYear = currentYear + 1;
    if (year > maxYear) continue;

    claims.push(makeClaim('core_structured_claim', 'vintage_year', String(year), String(year)));
  }

  return claims;
}

function extractPriceClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  for (const m of text.matchAll(PRICE_MAN_WON_RE)) {
    const krw = Number(m[1]);
    if (!Number.isFinite(krw)) continue;
    claims.push(makeClaim('core_structured_claim', 'price_usd', (krw * KRW_PER_MAN_WON / KRW_PER_USD_APPROXIMATE).toFixed(2), m[0]));
  }
  for (const m of text.matchAll(PRICE_PLAIN_WON_RE)) {
    const krw = Number(m[1]!.replace(/,/g, ''));
    if (!Number.isFinite(krw)) continue;
    claims.push(makeClaim('core_structured_claim', 'price_usd', (krw / KRW_PER_USD_APPROXIMATE).toFixed(2), m[0]));
  }
  for (const m of text.matchAll(PRICE_USD_RE)) {
    claims.push(makeClaim('core_structured_claim', 'price_usd', m[1]!, m[0]));
  }

  return claims;
}

function extractRegionClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const normalized = correctKoreanWineTypos(text).toLowerCase().normalize('NFKC');

  // Sort by length descending so multi-word regions match before substrings
  const sortedRegions = [...new Map([...KNOWN_REGIONS, ...REGION_ALIASES]).entries()].sort((a, b) => b[0].length - a[0].length);

  const matched = new Set<string>();
  for (const [key, display] of sortedRegions) {
    if (matched.has(key)) continue;
    if (containsAsWord(normalized, key.toLowerCase().normalize('NFKC'))) {
      // Skip if a longer region containing this key was already matched
      let isSubstringOfMatched = false;
      for (const m of matched) {
        if (m.includes(key)) { isSubstringOfMatched = true; break; }
      }
      if (isSubstringOfMatched) continue;
      claims.push(makeClaim('core_structured_claim', 'region', display, key));
      matched.add(key);
    }
  }

  return claims;
}

function extractGrapeClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const normalized = correctKoreanWineTypos(text).toLowerCase().normalize('NFKC');

  for (const [pattern, canonicalGrape] of GRAPE_ALIASES) {
    if (pattern.test(normalized)) {
      const canonical = resolveGrapeAlias(canonicalGrape.toLowerCase());
      claims.push(makeClaim('core_structured_claim', 'grape_primary', canonical, canonicalGrape));
    }
  }

  for (const grape of KNOWN_GRAPES) {
    if (containsAsWord(normalized, grape)) {
      const canonical = resolveGrapeAlias(grape);
      claims.push(makeClaim('core_structured_claim', 'grape_primary', canonical, grape));
    }
  }

  return claims;
}

function extractWineTypeClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const lower = text.toLowerCase().normalize('NFKC');

  for (const [keyword, canonical] of WINE_TYPE_KEYWORDS) {
    if (containsAsWord(lower, keyword)) {
      claims.push(makeClaim('core_structured_claim', 'wine_type', normalizeWineType(canonical), keyword));
    }
  }

  return claims;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic claims (tasting, pairing, style)
// ─────────────────────────────────────────────────────────────────────────────

/** Indicator regex — sentences without these keywords are not treated as semantic claims. */
const SEMANTIC_INDICATORS_RE = /(?:맛|향|노트|풍미|아로마|테이스팅|바디|탄닌|산미|페어링|음식|어울|곁들|추천|권하|잘\s+맞|좋은\s+선택|recommended?\s+for|great\s+for|ideal\s+for|perfect\s+for|tasting|aroma|nose|palate|finish|pairs?\s+(?:well\s+)?with|food|body|tannin|acidity|flavor|flavour|notes?\s+of)/iu;
/** Comparative indicator regex — explicit A vs B style assertions. */
const COMPARATIVE_INDICATORS_RE = /(?:보다|more\s+.+?\s+than|less\s+.+?\s+than|richer\s+than|lighter\s+than|bolder\s+than|more\s+powerful\s+than|more\s+concentrated\s+than|higher\s+(?:acid|acidity|tannin)\s+than)/iu;
/** Recommendation / occasion-suggestion surface indicators. */
const RECOMMENDATION_INDICATORS_RE = /(?:추천|권하|추천드립|추천합|recommended?\s+for|great\s+for|ideal\s+for|perfect\s+for)/iu;

function extractSemanticClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];

  // Split into sentences (Korean/English)
  const sentences = text.split(/[.!?。]\s*|\n+/u).filter((s) => s.trim().length > 10);

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (COMPARATIVE_INDICATORS_RE.test(trimmed)) {
      claims.push(makeClaim('comparative_claim', 'general_opinion', trimmed, trimmed));
      continue;
    }

    // Skip sentences with no semantic indicator at all (avoid promoting
    // bare facts like "Opus One 2015" to semantic claims).
    if (!SEMANTIC_INDICATORS_RE.test(trimmed)) continue;

    // Emit one claim per matched semantic dimension (a sentence may match multiple)
    const fields = classifySemanticFields(trimmed);
    for (const field of fields) {
      claims.push(makeClaim('semantic_claim', field, trimmed, trimmed));
    }
  }

  return claims;
}

function classifySemanticFields(sentence: string): WineField[] {
  const fields: WineField[] = [];
  const lower = sentence.toLowerCase();
  if (/페어링|음식|어울|곁들|잘\s+맞|pairs?\s+(?:well\s+)?with|food/iu.test(lower)) fields.push('pairing_rationale');
  if (/맛|향|노트|아로마|tasting|aroma|nose|palate|flavor|flavour|notes?\s+of/iu.test(lower)) fields.push('tasting_notes');
  if (/바디|탄닌|산미|body|tannin|acidity|finish/iu.test(lower)) fields.push('style_description');
  if (RECOMMENDATION_INDICATORS_RE.test(lower)) fields.push('general_opinion');
  // If indicator matched but no specific dimension, fall back to general_opinion
  if (fields.length === 0) fields.push('general_opinion');
  return fields;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeClaim(
  category: ClaimCategory,
  field: WineField,
  value: string,
  sourceText: string,
): ExtractedClaim {
  const normalizedValue = value.toLowerCase().normalize('NFKC').trim();
  const id = crypto
    .createHash('sha256')
    .update(`${category}:${field}:${normalizedValue}`)
    .digest('hex')
    .slice(0, CLAIM_ID_PREFIX_LEN);

  return { id, category, field, value, normalizedValue, sourceText };
}

function deduplicateClaims(claims: ExtractedClaim[]): ExtractedClaim[] {
  const seen = new Set<string>();
  const result: ExtractedClaim[] = [];
  for (const claim of claims) {
    const key = `${claim.category}:${claim.field}:${claim.normalizedValue}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(claim);
    }
  }
  return result;
}

function isStructuredEntitySurface(surface: string): boolean {
  if (STRUCTURED_GEOGRAPHY_SURFACES.has(normalizeStructuredEntityKey(surface))) return true;
  if (resolveStructuredEntity(surface)) return true;

  const accentFolded = stripLatinDiacritics(surface);
  if (accentFolded !== surface && resolveStructuredEntity(accentFolded)) return true;

  const coordinatedParts = surface
    .split(/\s+(?:and|&|y)\s+/iu)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (coordinatedParts.length >= 2) {
    return coordinatedParts.every((part) => {
      if (resolveStructuredEntity(part)) return true;
      const foldedPart = stripLatinDiacritics(part);
      return foldedPart !== part && resolveStructuredEntity(foldedPart);
    });
  }

  return false;
}

function resolveStructuredEntity(surface: string): boolean {
  return resolveEntity(surface, { preferEntityOverStyle: true }) !== null;
}

function stripLatinDiacritics(surface: string): string {
  return surface.normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC');
}

function normalizeStructuredEntityKey(surface: string): string {
  return stripLatinDiacritics(surface)
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, ' ');
}
