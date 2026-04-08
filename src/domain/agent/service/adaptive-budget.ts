/**
 * Per-query-family adaptive step budget.
 *
 * The default flat maxSteps=5 over-budgets simple lookups (specific SKU)
 * and under-budgets complex multi-course pairings. A lightweight classifier
 * picks a tighter ceiling so:
 *
 *   - Specific SKU lookups       → 2 steps  (entity + maybe drinking-window)
 *   - Adversarial / off-domain   → 1 step   (refuse, no tool call)
 *   - Compound / multi-course    → 6 steps  (search × 2-3 + pairing)
 *   - Default                    → 4 steps  (one search + one refinement)
 *
 * The classifier is purely lexical to avoid LLM cost on the entry point.
 * Returns undefined when no rule fires, letting the orchestrator default
 * to its configured budget.
 */

const PROPER_NOUN_PATTERN = /\b(?:[A-Z][a-zA-Z'\u00C0-\u017F-]+\s+){0,3}[A-Z][a-zA-Z'\u00C0-\u017F-]+\b/;
const VINTAGE_PATTERN = /\b(?:18|19|20)\d{2}\b/;
/** Hangul wine name patterns: 3+ consecutive Hangul syllables that look like
 *  a wine entity name (not common Korean words). The previous 2+ char pattern
 *  matched "와인", "년산" etc. causing false positives on generic queries like
 *  "와인 2018". Requiring 3+ chars reduces false positives while still catching
 *  "오푸스원", "바롤로", "브루넬로", "샤토마고" etc. */
const HANGUL_SKU_PATTERN = /[\uAC00-\uD7A3]{3,}/;

const ADVERSARIAL_PATTERNS: readonly RegExp[] = [
  // SQL injection
  /\b(?:select|insert|update|delete|drop|truncate|alter|create)\b[\s\S]{0,20}\b(?:from|into|table|database)\b/i,
  // Prompt injection
  /\b(?:ignore\s+(?:all\s+)?(?:previous|prior|your)\s+(?:instructions|rules))\b/i,
  /\bsystem\s*[:>]/i,
  /\b(?:dan\s+mode|jailbreak)\b/i,
  // Schema/PII extraction
  /\b(?:db|database)\s+schema\b/i,
  /\b(?:other|previous)\s+users?\b/i,
  // PII / cross-tenant extraction
  /(?:다른\s*사용자|other\s*user|다른\s*고객|other\s*customer)/i,
  /(?:개인\s*정보|personal\s*(?:info|data)|이메일|email|전화번호|phone)/i,
  // Schema / API leak
  /(?:api\s*key|secret|password|비밀번호|토큰|token)/i,
  // Resource exhaustion patterns (extremely long repetitive input)
  /(.{5,})\1{10,}/,
];

const OFF_DOMAIN_PATTERNS: readonly RegExp[] = [
  // Non-wine subjects. Unicode-aware boundaries because \b is ASCII-only
  // and silently fails on Korean (한글 chars are not \w).
  /(?:^|[^\p{L}\p{N}])(?:weather|날씨)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[^\p{L}\p{N}])(?:stock|주식|환율|exchange\s+rate)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[^\p{L}\p{N}])(?:맥주|beer|소주|whisky|위스키|vodka)(?=$|[^\p{L}\p{N}])/iu,
];

const COMPOUND_INDICATORS: readonly string[] = [
  '코스', 'course', '에피타이저', 'appetizer', '디저트', 'dessert',
  '메인', 'main course', '여러', 'multiple', '각각', 'each',
  '비교', 'compare', 'vs', '둘 다', 'both',
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

  // 1. Adversarial — tightest budget. Agent should refuse.
  for (const pattern of ADVERSARIAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        maxSteps: 1,
        classification: 'adversarial',
        reason: `matched adversarial pattern: ${pattern.source.slice(0, 40)}`,
      };
    }
  }

  // 2. Off-domain — also 1 step (refuse + redirect).
  for (const pattern of OFF_DOMAIN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        maxSteps: 1,
        classification: 'off_domain',
        reason: `matched off-domain pattern: ${pattern.source.slice(0, 40)}`,
      };
    }
  }

  // 3. Nested condition: 3+ constraint types in one query → needs more steps to decompose.
  const NESTED_CONDITION_INDICATORS: readonly RegExp[] = [
    /(?:만\s*원|\d+\s*원|달러|\$|₩)/i,   // price — require 만원 or digit+원 to avoid matching 원래/원산지
    /(?:레드|화이트|로제|스파클링|red|white|rosé|sparkling)/i, // color
    /(?:이탈리아|프랑스|스페인|칠레|호주|미국|Italy|France|Spain|Chile|Australia|USA|Napa|Bordeaux|Burgundy|Tuscany)/i, // region
    /(?:카베르네|메를로|피노|샤르도네|소비뇽|Cabernet|Merlot|Pinot|Chardonnay|Sauvignon|Riesling|Syrah|Nebbiolo)/i, // grape
    /(?:타닌|산도|바디|드라이|스위트|tannin|acidity|body|dry|sweet|oaky|fruity)/i, // style
    /(?:스테이크|파스타|치킨|해산물|삼겹살|steak|pasta|seafood|chicken|cheese)/i, // food
  ];
  const nestedHits = NESTED_CONDITION_INDICATORS.filter((re) => re.test(trimmed));
  if (nestedHits.length >= 3) {
    return {
      maxSteps: 8,
      classification: 'nested_condition',
      reason: `nested constraints: ${nestedHits.map((re) => re.source.slice(0, 20)).join(', ')}`,
    };
  }

  // 3b. Situation-based: occasion/gift/atmosphere + at least one constraint.
  const SITUATION_INDICATORS: readonly string[] = [
    '선물', 'gift', '생일', 'birthday', '기념일', 'anniversary', '데이트', 'date',
    '파티', 'party', '혼술', '홈파티', 'home party', '캠핑', 'camping',
    '분위기', 'mood', 'atmosphere', '로맨틱', 'romantic',
  ];
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
  const hasProperNoun = PROPER_NOUN_PATTERN.test(trimmed) || HANGUL_SKU_PATTERN.test(trimmed);
  if (hasProperNoun && VINTAGE_PATTERN.test(trimmed)) {
    return {
      maxSteps: 3,
      classification: 'specific_sku',
      reason: 'proper noun + vintage year detected',
    };
  }

  // 5. No rule fired — let caller default.
  return undefined;
}
