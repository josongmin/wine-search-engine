import type { NormalizedConstraint } from '../../shared/types/index.js';
import { throwIfAborted } from '../../shared/cooperative-abort.js';
import type { ConstraintExtractionTrace } from '../model/constraint-extraction-trace.js';
import type { NLMapping } from '../model/nl-mapping.js';
import type { MappingTablePort } from '../port/mapping-table.port.js';

/**
 * Current version of the default mapping table.
 */
const DEFAULT_MAPPING_VERSION = 'v1.0';

/**
 * Default source identifier for built-in mappings.
 */
const DEFAULT_SOURCE = 'builtin_curated';

/** Lower bound for moderate-sweet / elegant-light body curated ranges. */
const DEFAULT_MAPPING_ATTR_MODERATE_MIN = 0.3;
/** Upper bound shared by moderate-sweet and balanced-high body band. */
const DEFAULT_MAPPING_ATTR_MODERATE_MAX = 0.6;
/** Lower bound for "balanced body" phrasing (slightly fuller than elegant). */
const DEFAULT_MAPPING_ATTR_BALANCED_MIN = 0.4;
/** Curated [min,max] attribute range: moderately sweet / elegant light body. */
const DEFAULT_MAPPING_RANGE_MODERATE: readonly [number, number] = [
  DEFAULT_MAPPING_ATTR_MODERATE_MIN,
  DEFAULT_MAPPING_ATTR_MODERATE_MAX,
];
/** Curated [min,max] for "balanced" body phrasing. */
const DEFAULT_MAPPING_RANGE_BALANCED_BODY: readonly [number, number] = [
  DEFAULT_MAPPING_ATTR_BALANCED_MIN,
  DEFAULT_MAPPING_ATTR_MODERATE_MAX,
];

/**
 * Hardcoded default NL-to-attribute mappings for common Korean wine phrases.
 * These are deterministic: same phrase + same version = same output.
 * LLM-generated hard constraints are forbidden per RFC-004.
 */
const DEFAULT_MAPPINGS: ReadonlyMap<string, NLMapping> = new Map<string, NLMapping>([
  [
    '묵직한',
    {
      phrase: '묵직한',
      mappedAttribute: 'body',
      operator: '>=',
      value: 0.7,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '풀바디',
    {
      phrase: '풀바디',
      mappedAttribute: 'body',
      operator: '>=',
      value: 0.7,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '가벼운',
    {
      phrase: '가벼운',
      mappedAttribute: 'body',
      operator: '<=',
      value: 0.3,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '라이트바디',
    {
      phrase: '라이트바디',
      mappedAttribute: 'body',
      operator: '<=',
      value: 0.3,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '달지 않은',
    {
      phrase: '달지 않은',
      mappedAttribute: 'sweetness',
      operator: '<=',
      value: 0.2,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '드라이',
    {
      phrase: '드라이',
      mappedAttribute: 'sweetness',
      operator: '<=',
      value: 0.2,
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '달달한',
    {
      phrase: '달달한',
      mappedAttribute: 'sweetness',
      operator: '>=',
      value: 0.5,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '스위트',
    {
      phrase: '스위트',
      mappedAttribute: 'sweetness',
      operator: '>=',
      value: 0.5,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '적당히 달달한',
    {
      phrase: '적당히 달달한',
      mappedAttribute: 'sweetness',
      operator: 'range',
      value: DEFAULT_MAPPING_RANGE_MODERATE,
      mappingConfidence: 0.85,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '선물용',
    {
      phrase: '선물용',
      mappedAttribute: 'occasion',
      operator: 'in',
      value: 'gift',
      mappingConfidence: 0.95,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '입문용',
    {
      phrase: '입문용',
      mappedAttribute: 'price_band',
      operator: '=',
      value: 'low',
      mappingConfidence: 0.85,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '데일리 와인',
    {
      phrase: '데일리 와인',
      mappedAttribute: 'price_band',
      operator: '=',
      value: 'low',
      mappingConfidence: 0.8,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '산도 높은',
    {
      phrase: '산도 높은',
      mappedAttribute: 'acidity',
      operator: '>=',
      value: 0.7,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '타닌감',
    {
      phrase: '타닌감',
      mappedAttribute: 'tannin',
      operator: '>=',
      value: 0.6,
      mappingConfidence: 0.85,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '부드러운',
    {
      phrase: '부드러운',
      mappedAttribute: 'tannin',
      operator: '<=',
      value: 0.3,
      mappingConfidence: 0.8,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '파티용',
    {
      phrase: '파티용',
      mappedAttribute: 'occasion',
      operator: 'in',
      value: 'party',
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    'drinking window',
    {
      phrase: 'drinking window',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    'when to drink',
    {
      phrase: 'when to drink',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '마실 시기',
    {
      phrase: '마실 시기',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],
  [
    '음용 시기',
    {
      phrase: '음용 시기',
      mappedAttribute: 'drinking_window',
      operator: '>=',
      value: 0,
      mappingConfidence: 0.9,
      mappingVersion: DEFAULT_MAPPING_VERSION,
      source: DEFAULT_SOURCE,
    },
  ],

  // ── Korean slang / abbreviations / extended vocabulary ──────────────

  // Price: standalone price-level words
  ['비싼', { phrase: '비싼', mappedAttribute: 'price_band', operator: '=', value: 'luxury', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['비싸', { phrase: '비싸', mappedAttribute: 'price_band', operator: '=', value: 'luxury', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['저렴한', { phrase: '저렴한', mappedAttribute: 'price_band', operator: '=', value: 'budget', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['싼', { phrase: '싼', mappedAttribute: 'price_band', operator: '=', value: 'budget', mappingConfidence: 0.75, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['가성비', { phrase: '가성비', mappedAttribute: 'price_band', operator: '=', value: 'mid', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['고급', { phrase: '고급', mappedAttribute: 'price_band', operator: '=', value: 'premium', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // Critic score / rating
  ['평점 좋은', { phrase: '평점 좋은', mappedAttribute: 'critic_score', operator: '>=', value: 0.7, mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['평점좋은', { phrase: '평점좋은', mappedAttribute: 'critic_score', operator: '>=', value: 0.7, mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['평점 높은', { phrase: '평점 높은', mappedAttribute: 'critic_score', operator: '>=', value: 0.8, mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['점수 높은', { phrase: '점수 높은', mappedAttribute: 'critic_score', operator: '>=', value: 0.8, mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // Flavor / aroma
  ['과일향', { phrase: '과일향', mappedAttribute: 'flavor_profile', operator: 'in', value: 'fruity', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['오크향', { phrase: '오크향', mappedAttribute: 'flavor_profile', operator: 'in', value: 'oaky', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['꽃향', { phrase: '꽃향', mappedAttribute: 'flavor_profile', operator: 'in', value: 'floral', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['스파이시', { phrase: '스파이시', mappedAttribute: 'flavor_profile', operator: 'in', value: 'spicy', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['미네랄', { phrase: '미네랄', mappedAttribute: 'flavor_profile', operator: 'in', value: 'mineral', mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // Texture / body
  ['강렬한', { phrase: '강렬한', mappedAttribute: 'body', operator: '>=', value: 0.8, mappingConfidence: 0.8, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['우아한', { phrase: '우아한', mappedAttribute: 'body', operator: 'range', value: DEFAULT_MAPPING_RANGE_MODERATE, mappingConfidence: 0.75, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['균형 잡힌', { phrase: '균형 잡힌', mappedAttribute: 'body', operator: 'range', value: DEFAULT_MAPPING_RANGE_BALANCED_BODY, mappingConfidence: 0.75, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],

  // Occasion extended
  ['기념일', { phrase: '기념일', mappedAttribute: 'occasion', operator: 'in', value: 'anniversary', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['데이트', { phrase: '데이트', mappedAttribute: 'occasion', operator: 'in', value: 'date', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['혼술', { phrase: '혼술', mappedAttribute: 'occasion', operator: 'in', value: 'solo', mappingConfidence: 0.85, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
  ['집들이', { phrase: '집들이', mappedAttribute: 'occasion', operator: 'in', value: 'housewarming', mappingConfidence: 0.9, mappingVersion: DEFAULT_MAPPING_VERSION, source: DEFAULT_SOURCE }],
]);

/**
 * Converts an {@link NLMapping} to a {@link NormalizedConstraint}.
 */
export function toNormalizedConstraint(mapping: NLMapping): NormalizedConstraint {
  let constraintValue: NormalizedConstraint['value'];

  if (mapping.operator === 'range' && Array.isArray(mapping.value)) {
    const [min, max] = mapping.value as readonly [number, number];
    constraintValue = { min, max };
  } else if (mapping.operator === 'in' && typeof mapping.value === 'string') {
    constraintValue = [mapping.value];
  } else {
    constraintValue = mapping.value as string | number;
  }

  return {
    attribute: mapping.mappedAttribute,
    operator: mapping.operator,
    value: constraintValue,
    source_phrase: mapping.phrase,
    confidence: mapping.mappingConfidence,
    mapping_version: mapping.mappingVersion,
  };
}

/** Result of {@link NLMapper.mapConstraints} — constraints plus optional extraction provenance. */
export interface MapConstraintsResult {
  readonly constraints: NormalizedConstraint[];
  /** Request-scoped extraction provenance (observability / QueryPlanV2.constraintExtraction shape). */
  readonly constraintExtraction?: ConstraintExtractionTrace | undefined;
}

/** Optional controls for {@link NLMapper.mapConstraints} (cancellation, future flags). */
export interface MapConstraintsOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

/**
 * Maps natural-language phrases to structured attribute constraints.
 * Implements RFC-004 §4.
 *
 * All mappings are deterministic. Same input + same version = same output.
 * Falls back to built-in default mappings when the repository has no match.
 */
export class NLMapper {
  constructor(private readonly mappingTable: MappingTablePort) {}

  /**
   * Maps a single natural-language phrase to a structured NLMapping.
   *
   * Resolution order:
   * 1. Query the mapping table repository.
   * 2. Fall back to built-in default mappings.
   *
   * @param phrase - The natural-language phrase (e.g. "묵직한").
   * @returns The mapping, or `null` if no mapping exists.
   */
  async mapPhrase(phrase: string): Promise<NLMapping | null> {
    const trimmed = phrase.trim();

    // 1. Check the repository
    const repoMapping = await this.mappingTable.findMapping(trimmed);
    if (repoMapping !== null) {
      return repoMapping;
    }

    // 2. Fall back to built-in defaults
    const builtIn = DEFAULT_MAPPINGS.get(trimmed);
    return builtIn ?? null;
  }

  /**
   * Maps multiple natural-language phrases to normalized constraints.
   * Phrases that do not match any mapping are silently skipped.
   *
   * @param phrases - Array of natural-language phrases.
   * @param options - Optional cancellation — when {@link MapConstraintsOptions.abortSignal}
   *   aborts, throws an `AbortError`-named {@link Error} (checked before each phrase).
   * @returns Constraints and a rule-table extraction trace (no LLM fields).
   */
  async mapConstraints(
    phrases: readonly string[],
    options?: MapConstraintsOptions,
  ): Promise<MapConstraintsResult> {
    throwIfAborted(options?.abortSignal, 'Constraint mapping aborted');

    const results: NormalizedConstraint[] = [];

    for (const phrase of phrases) {
      throwIfAborted(options?.abortSignal, 'Constraint mapping aborted');
      const mapping = await this.mapPhrase(phrase);
      if (mapping !== null) {
        results.push(toNormalizedConstraint(mapping));
      }
    }

    const source: ConstraintExtractionTrace['source'] =
      results.length > 0 ? 'rule_only' : 'fallback';
    const constraintExtraction: ConstraintExtractionTrace = {
      candidatePhraseCount: phrases.length,
      ruleTableHitCount: results.length,
      llmHitCount: 0,
      llmSkippedCount: 0,
      fallbackTriggered: results.length === 0,
      source,
      llmLatencyMs: null,
      phraseCacheHits: 0,
      phraseCacheNegativeSkipped: 0,
      phraseCacheMisses: 0,
      missedPhrases: phrases.filter(
        (p) => !results.some((r) => r.source_phrase === p),
      ),
    };

    return { constraints: results, constraintExtraction };
  }
}
