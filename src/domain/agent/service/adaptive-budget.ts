/**
 * Per-query-family adaptive step budget.
 *
 * The default flat maxSteps=5 over-budgets simple lookups (specific SKU)
 * and under-budgets complex multi-course pairings. A lightweight classifier
 * picks a tighter ceiling so:
 *
 *   - Specific SKU lookups       → 2 steps  (entity + maybe drinking-window)
 *   - Sanitizer-blocked / off-domain → 1 step   (refuse, no tool call)
 *   - Compound / multi-course    → 6 steps  (search × 2-3 + pairing)
 *   - Default                    → 4 steps  (one search + one refinement)
 *
 * The classifier is purely lexical to avoid LLM cost on the entry point.
 * Returns undefined when no rule fires, letting the orchestrator default
 * to its configured budget.
 */

import { extractSearchConstraints } from '../../query/service/search-constraint-extractor.js';
import { QuerySanitizer } from '../../security/service/query-sanitizer.js';

/**
 * Minimum step count for queries with 4+ explicit hard constraints.
 * Allows enough iterations for staged search + iterative constraint relaxation.
 * 4 constraints → up to 4 searches (one per relaxation) + 2 reasoning steps + 2 buffer = 8.
 */
const MIN_STEPS_FOUR_PLUS_CONSTRAINTS = 8;

/**
 * Minimum step count for queries with exactly 3 explicit hard constraints.
 * 3 constraints → up to 3 searches + 2 reasoning steps + 1 buffer = 6.
 */
const MIN_STEPS_THREE_CONSTRAINTS = 6;

/** Truncate regex source in adaptive-budget log reasons (telemetry string cap). */
const ADAPTIVE_BUDGET_PATTERN_REASON_CHARS = 40;
/** Shorter preview for nested-condition reason strings. */
const ADAPTIVE_BUDGET_NESTED_REASON_CHARS = 20;
/** Minimum hard-constraint count to allocate iterative-refinement step budget. */
const CONSTRAINT_COUNT_FOR_ITERATIVE_REFINEMENT = 4;

const PROPER_NOUN_PATTERN = /(?<!\p{L}\p{N})(?:[A-Z][a-zA-Z'\u00C0-\u017F-]+\s+){0,3}[A-Z][a-zA-Z'\u00C0-\u017F-]+(?!\p{L}\p{N})/u;
const VINTAGE_PATTERN = /(?<!\p{L}\p{N})(?:18|19|20)\d{2}(?!\p{L}\p{N})/u;
/** Hangul wine name patterns: 3+ consecutive Hangul syllables that look like
 *  a wine entity name (not common Korean words). The previous 2+ char pattern
 *  matched "와인", "년산" etc. causing false positives on generic queries like
 *  "와인 2018". Requiring 3+ chars reduces false positives while still catching
 *  "오푸스원", "바롤로", "브루넬로", "샤토마고" etc. */
const HANGUL_SKU_PATTERN = /[\uAC00-\uD7A3]{3,}/;

/**
 * Adaptive-budget reuses the canonical QuerySanitizer for blocked-input
 * classification instead of maintaining a second security regex corpus here.
 * This file remains responsible for budget sizing, not primary security policy.
 */
const ADAPTIVE_BUDGET_SANITIZER = new QuerySanitizer();
/** Resource-exhaustion hint kept local because it affects budget sizing even
 * when the input is not strictly a policy block.
 * Two patterns cover different repeat-unit sizes:
 *   - 2-4 char units (e.g. "카베르네 " × 800): `(.{2,4})\1{15,}`
 *   - 5+ char units (longer repeating phrases): `(.{5,})\1{10,}`
 * Both use /u flag so `.` matches Unicode codepoints (not UTF-16 code units). */
const REPETITIVE_INPUT_PATTERN_SHORT: RegExp = /(.{2,4})\1{15,}/u;
const REPETITIVE_INPUT_PATTERN_LONG: RegExp = /(.{5,})\1{10,}/u;

const OFF_DOMAIN_PATTERNS: readonly RegExp[] = [
  // Non-wine subjects. Unicode-aware boundaries because \b is ASCII-only
  // and silently fails on Korean (한글 chars are not \w).
  /(?:^|[^\p{L}\p{N}])(?:weather|날씨)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[^\p{L}\p{N}])(?:stock|주식|환율|exchange\s+rate)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[^\p{L}\p{N}])(?:맥주|beer|소주|whisky|위스키|vodka)(?=$|[^\p{L}\p{N}])/iu,
  // Sports — numeric context not needed; these words are unambiguous off-domain
  /(?:^|[^\p{L}\p{N}])(?:축구|football|야구|baseball|농구|basketball)(?=$|[^\p{L}\p{N}])/iu,
  // Crypto / finance — unambiguous off-domain
  /(?:^|[^\p{L}\p{N}])(?:코인|bitcoin|crypto|암호화폐)(?=$|[^\p{L}\p{N}])/iu,
  // Politics — "champagne region politics" should NOT trigger this because
  // "politics" requires a word boundary; the pattern won't match mid-word.
  // Note: "champagne region politics" WILL match — politics is a clear off-domain
  // signal regardless of context in a wine search engine.
  /(?:^|[^\p{L}\p{N}])(?:정치|politics|대통령|president|선거|election)(?=$|[^\p{L}\p{N}])/iu,
];

const COMPOUND_INDICATORS: readonly string[] = [
  '코스', 'course', '에피타이저', 'appetizer', '디저트', 'dessert',
  '메인', 'main course', '여러', 'multiple', '각각', 'each',
  '비교', 'compare', 'vs', '둘 다', 'both',
];

/**
 * Indicators for nested-condition queries (3+ constraint types in one query).
 * Defined at module scope — deterministic, allocated per call is wasteful (rule 16).
 */
const NESTED_CONDITION_INDICATORS: readonly RegExp[] = [
  /(?:만\s*원|\d+\s*원|달러|\$|₩)/iu,   // price — require 만원 or digit+원 to avoid matching 원래/원산지
  /(?:레드|화이트|로제|스파클링|red|white|rosé|sparkling)/iu, // color
  /(?:이탈리아|프랑스|스페인|칠레|호주|미국|Italy|France|Spain|Chile|Australia|USA|Napa|Bordeaux|Burgundy|Tuscany)/iu, // region
  /(?:카베르네|메를로|피노|샤르도네|소비뇽|Cabernet|Merlot|Pinot|Chardonnay|Sauvignon|Riesling|Syrah|Nebbiolo)/iu, // grape
  /(?:타닌|산도|바디|드라이|스위트|tannin|acidity|body|dry|sweet|oaky|fruity)/iu, // style
  /(?:스테이크|파스타|치킨|해산물|삼겹살|steak|pasta|seafood|chicken|cheese)/iu, // food
];

/**
 * Indicators for situation-based queries (occasion/gift/atmosphere context).
 * Defined at module scope — deterministic, allocated per call is wasteful (rule 16).
 */
const SITUATION_INDICATORS: readonly string[] = [
  '선물', 'gift', '생일', 'birthday', '기념일', 'anniversary', '데이트', 'date',
  '파티', 'party', '혼술', '홈파티', 'home party', '캠핑', 'camping',
  '분위기', 'mood', 'atmosphere', '로맨틱', 'romantic',
];

export interface AdaptiveBudget {
  readonly maxSteps: number;
  readonly classification: 'specific_sku' | 'adversarial' | 'off_domain' | 'nested_condition' | 'situation_based' | 'compound' | 'default';
  readonly reason: string;
}

export function classifyQueryBudget(query: string): AdaptiveBudget | undefined {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    // Empty query: agent should produce zero tool calls. The HTTP layer
    // would normally 400 this; benchmark scenario #21 expects 0 steps.
    return { maxSteps: 0, classification: 'default', reason: 'empty query' };
  }

  // 1. Sanitizer-blocked queries — tightest budget. The sanitizer remains the
  // real block/deny layer; this classification only aligns the budget with it.
  const sanitizeResult = ADAPTIVE_BUDGET_SANITIZER.sanitize(trimmed);
  if (!sanitizeResult.safe) {
    return {
      maxSteps: 1,
      classification: 'adversarial',
      reason: `query sanitizer blocked input: ${sanitizeResult.reason.slice(0, ADAPTIVE_BUDGET_PATTERN_REASON_CHARS)}`,
    };
  }

  if (REPETITIVE_INPUT_PATTERN_SHORT.test(trimmed) || REPETITIVE_INPUT_PATTERN_LONG.test(trimmed)) {
    return {
      maxSteps: 1,
      classification: 'adversarial',
      reason: 'repetitive input pattern',
    };
  }

  // 2. Off-domain — also 1 step (refuse + redirect).
  for (const pattern of OFF_DOMAIN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        maxSteps: 1,
        classification: 'off_domain',
        reason: `matched off-domain pattern: ${pattern.source.slice(0, ADAPTIVE_BUDGET_PATTERN_REASON_CHARS)}`,
      };
    }
  }

  // 3. Nested condition: 3+ constraint types in one query → needs more steps to decompose.
  const nestedHits = NESTED_CONDITION_INDICATORS.filter((re) => re.test(trimmed));
  if (nestedHits.length >= 3) {
    return {
      maxSteps: 8,
      classification: 'nested_condition',
      reason: `nested constraints: ${nestedHits.map((re) => re.source.slice(0, ADAPTIVE_BUDGET_NESTED_REASON_CHARS)).join(', ')}`,
    };
  }

  // 3b. Situation-based: occasion/gift/atmosphere + at least one constraint.
  const lowerTrimmed = trimmed.toLowerCase();
  const situationHits = SITUATION_INDICATORS.filter((kw) => lowerTrimmed.includes(kw.toLowerCase()));
  const hasConstraint = NESTED_CONDITION_INDICATORS.some((re) => re.test(trimmed));
  if (situationHits.length >= 2 && hasConstraint) {
    return {
      maxSteps: 6,
      classification: 'situation_based',
      reason: `situation indicators: ${situationHits.slice(0, 3).join(', ')}; has constraint`,
    };
  }

  // 4. Compound / multi-course — generous budget for legitimate complex queries.
  const compoundHits = COMPOUND_INDICATORS.filter((kw) => trimmed.toLowerCase().includes(kw.toLowerCase()));
  if (compoundHits.length >= 2) {
    return {
      maxSteps: 6,
      classification: 'compound',
      reason: `compound indicators: ${compoundHits.slice(0, 3).join(', ')}`,
    };
  }

  // 4. Specific SKU — proper noun + vintage year. Allow 3 steps so the agent
  // can do entity lookup → optional drinking-window → final answer without
  // hitting fallback termination on the natural happy path. Real benchmark
  // measurement showed maxSteps=2 was too tight for "Opus One 2018"-style
  // queries where the agent legitimately wants context plus the result.
  // Both Latin (Opus One 2018) and Hangul (오푸스원 2018) variants supported.
  // Lowercase-input detection for vintage+proper-noun path only:
  // "opus one 2018" typed all-lowercase should be treated as specific_sku.
  // Requires 2+ consecutive all-lowercase Latin words (each 3+ chars) — this matches
  // "opus one", "chateau margaux", "screaming eagle", etc. but NOT bare "wine 2018"
  // (single word before vintage) or "2018 wine" (word after vintage).
  // Only applied to the vintage path; the no-vintage path keeps original behavior
  // to avoid misclassifying generic queries like "2018 wine" or single-word queries.
  const ALL_LOWERCASE_PROPER_NOUN_RE = /(?:^|(?<=\s))[a-z][a-z'\u00C0-\u017F-]{2,}(?:\s+[a-z][a-z'\u00C0-\u017F-]{2,})+/u;
  const hasLowercaseProperNoun = ALL_LOWERCASE_PROPER_NOUN_RE.test(trimmed) && !/[A-Z\uAC00-\uD7A3]/.test(trimmed);
  const hasProperNoun = PROPER_NOUN_PATTERN.test(trimmed) || HANGUL_SKU_PATTERN.test(trimmed);
  // For vintage+lowercase queries, also check hasLowercaseProperNoun
  if ((hasProperNoun || hasLowercaseProperNoun) && VINTAGE_PATTERN.test(trimmed)) {
    return {
      maxSteps: 3,
      classification: 'specific_sku',
      reason: 'proper noun + vintage year detected',
    };
  }

  // 4b. Specific SKU without vintage — a bare Latin proper noun (e.g. "Opus One",
  // "Château Margaux") is still a specific entity lookup that needs at most 3
  // steps (entity search + optional detail + answer).
  // For Hangul: require the ENTIRE trimmed string to be Hangul characters only
  // (no spaces, no other chars) — this matches pure Hangul wine names like
  // "오푸스원" while rejecting generic Korean queries like "와인 추천해줘" which
  // contain spaces / non-Hangul chars alongside 3+ syllable Hangul words.
  // Guard: skip if the query also contains compound or situation signals, or if
  // a constraint fires (those paths already get their own classification above).
  const noCompoundHits = compoundHits.length === 0;
  const noSituationHits = situationHits.length === 0;
  const noConstraint = !hasConstraint;
  // Require 4+ syllables for pure-Hangul SKU classification: 3-syllable common Korean words
  // (사랑해, 맛있어, 고마워, 스테이크) are too ambiguous to classify as wine entity lookups.
  // 4+ syllables (오푸스원=4, 바롤로=3! — still a risk, 샤토마고=4, 브루넬로=4) provides
  // a better signal. Note: 바롤로 is 3 syllables and IS a real wine name — this is a known
  // FP tradeoff. 3-syllable pure-Hangul queries will fall to the default budget (which is fine).
  const isPureHangulSku = /^[\uAC00-\uD7A3]{4,}$/.test(trimmed);
  if ((PROPER_NOUN_PATTERN.test(trimmed) || hasLowercaseProperNoun || isPureHangulSku) && noCompoundHits && noSituationHits && noConstraint) {
    return {
      maxSteps: 3,
      classification: 'specific_sku',
      reason: 'proper noun (no vintage) — specific entity lookup',
    };
  }

  // 5. Constraint count — use extractSearchConstraints to count explicit hard
  // constraints (exclusions + price + vintage). More constraints need more steps
  // to allow iterative relaxation when the initial tightly-constrained search fails.
  const constraints = extractSearchConstraints(trimmed);
  const exclusionCount =
    (constraints.excludeGrapes?.length ?? 0) +
    (constraints.excludeCountries?.length ?? 0) +
    (constraints.excludeRegions?.length ?? 0);
  const hasPrice = constraints.maxPriceKrw !== undefined || constraints.minPriceKrw !== undefined ? 1 : 0;
  const hasVintage = constraints.vintageMin !== undefined || constraints.vintageMax !== undefined ? 1 : 0;
  const constraintCount = exclusionCount + hasPrice + hasVintage;

  if (constraintCount >= CONSTRAINT_COUNT_FOR_ITERATIVE_REFINEMENT) {
    return {
      maxSteps: MIN_STEPS_FOUR_PLUS_CONSTRAINTS,
      classification: 'nested_condition',
      reason: `constraint count ${constraintCount} >= 4 — iterative refinement budget`,
    };
  }
  if (constraintCount >= 3) {
    return {
      maxSteps: MIN_STEPS_THREE_CONSTRAINTS,
      classification: 'nested_condition',
      reason: `constraint count ${constraintCount} >= 3 — staged search budget`,
    };
  }

  // 6. No rule fired — let caller default.
  return undefined;
}
