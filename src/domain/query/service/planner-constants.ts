import type { NLMapper } from '../../attribute/service/nl-mapper.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import { STYLE_SENSORY_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';

/** Current planner version. */
export const PLANNER_VERSION = '1.0.0';

/**
 * TA2-T2: Minimum confidence floor for planner_heuristic anchors.
 * Fuzzy matches at maximum edit distance would otherwise get confidence 0;
 * clamp to this floor so they still contribute signal to the resolver.
 */
export const FUZZY_ANCHOR_CONFIDENCE_FLOOR = 0.5;

/**
 * TA2-T2: Confidence penalty per unit of edit distance for planner_heuristic anchors.
 * A fuzzy hit with editDistance=1 → confidence × 0.9 (10% discount).
 * A fuzzy hit with editDistance=5 → confidence × 0.5 (clamped at floor).
 */
export const FUZZY_ANCHOR_EDIT_DISTANCE_PENALTY = 0.1;

export const CONSTRAINT_SHAPED_ANCHOR_ATTRIBUTES = new Set([
  'appellation',
  'region',
  'country',
  'grape_primary',
  'wine_type',
  'classification',
  'vintage_year',
]);

export const SEMANTIC_DISCOVERY_SENSORY_ATTRIBUTES = new Set([
  ...STYLE_SENSORY_ATTRIBUTES,
  'fruit_intensity',
  'finish_length',
]);

export const GENERIC_ANCHOR_SOURCE_ATTRIBUTES = new Set([
  ...CONSTRAINT_SHAPED_ANCHOR_ATTRIBUTES,
  ...SEMANTIC_DISCOVERY_SENSORY_ATTRIBUTES,
  'pairing',
  'price_usd',
]);

export const GENERIC_LOOKUP_VARIANT_SINGLE_SUPPORT_MAX = 1;

export const GENERIC_CONSTRAINT_SURFACE_TRUSTED_ALIAS_TYPES: ReadonlySet<
  NonNullable<AnchorCandidate['aliasType']>
> = new Set([
  'canonical',
  'abbreviation',
]);

export const SEMANTIC_DISCOVERY_ALLOWED_HARD_ATTRIBUTES = new Set([
  'wine_type',
  'grape_primary',
  'country',
  'region',
  'appellation',
]);

export const EXPLICIT_NO_MATCH_PATTERNS: readonly RegExp[] = [
  /존재하지\s*않(?:는|은|았(?:던|다)|는지|는데)?/u,
  /(?<![\p{L}\p{N}])(?:unknown|non(?:-|\s)?existent|does\s+not\s+exist|not\s+found)(?![\p{L}\p{N}])/iu,
];

/** Current policy rule version. */
export const POLICY_RULE_VERSION = '1.0.0';

/** Short-query ambiguity: anchor confidence must exceed this when multiple candidates exist. */
export const SHORT_QUERY_AMBIGUOUS_ANCHOR_CONFIDENCE_THRESHOLD = 0.8;
/** Confidence assigned to taxonomy-derived pairing soft constraints. */
export const PAIRING_SOFT_CONSTRAINT_CONFIDENCE = 0.88;
export const PAIRING_SOFT_CONSTRAINT_MAPPING_VERSION = 'pairing-taxonomy-v1.0';
/** Parser confidence floor in uncertainty (weak prior). */
export const UNCERTAINTY_PARSER_CONFIDENCE_FLOOR = 0.5;
/** Parser confidence reduction per whitespace token. */
export const UNCERTAINTY_PARSER_CONFIDENCE_PER_TOKEN_PENALTY = 0.05;
/** Constraint confidence when no hard constraints are present. */
export const UNCERTAINTY_CONSTRAINT_CONFIDENCE_NEUTRAL = 0.5;
/** Below this aggregate anchor confidence, flag low_anchor_confidence ambiguity. */
export const UNCERTAINTY_LOW_ANCHOR_CONFIDENCE_THRESHOLD = 0.6;
export const UNCERTAINTY_OVERALL_WEIGHT_PARSER = 0.3;
export const UNCERTAINTY_OVERALL_WEIGHT_ANCHOR = 0.4;
export const UNCERTAINTY_OVERALL_WEIGHT_CONSTRAINT = 0.3;
/** Added to overall uncertainty when any ambiguity markers fire. */
export const UNCERTAINTY_AMBIGUITY_OVERALL_BUMP = 0.15;
/** Overall uncertainty at or above this triggers raise_threshold decision effect. */
export const UNCERTAINTY_RAISE_THRESHOLD_OVERALL = 0.6;
/** Exact ambiguity-dictionary surface marker preserved for decision hard gates. */
export const KNOWN_AMBIGUOUS_SURFACE_TYPE = 'known_ambiguous_surface';

/** Producer catalog browse: "Château X best wines" (Epic 7, golden `producer_browse`). */
export const PRODUCER_BROWSE_QUERY_PATTERN = /(?<!\p{L})(?<!\p{N})(?:best|top|great|famous)\s+wines(?!\p{L})(?!\p{N})/iu;

/** Region/location keywords for geographic entity detection. */
export const REGION_KEYWORDS: readonly RegExp[] = [
  /(?<!\p{L})(?<!\p{N})(?:napa|sonoma|bordeaux|burgundy|tuscany|champagne)(?!\p{L})(?!\p{N})/iu,
  /(?<!\p{L})(?<!\p{N})(?:valley|region|appellation|aoc|doc|doca|côtes|côte)(?!\p{L})(?!\p{N})/iu,
  /(?:^|[^\p{L}\p{N}])(?:나파|샤블리|보르도|투지|롱글로|토스카나)(?=$|[^\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])(?:지역|지방|아펠라시옹|지역명)(?=$|[^\p{L}\p{N}])/u,
] as const;

export const KOREAN_NOT_MARKER_PATTERN = '\\s*(?:말고|대신)\\s*';
export const ENGLISH_NOT_MARKER_PATTERN = '(?<!\\p{L})(?<!\\p{N})instead\\s+of\\s+';

/**
 * Similarity markers used to strip a similarity-query ANCHOR from the
 * constraint-parsing surface (intent-aware soft anchoring).
 *
 * On a similarity / relative query ("마고 비슷한 레드" — "red wine similar to
 * Margaux"), the anchor (마고 / Margaux) is a REFERENCE POINT, not a hard
 * filter: the user wants wines *like* Margaux, not wines that *are* Margaux.
 * If the anchor surface stays in the constraint-parsing query, the compiler
 * resolves it into HARD appellation/country/region constraints and the
 * ranker's coarse prune drops every candidate to zero results.
 *
 * We therefore remove the anchor surface together with its similarity marker
 * — exactly mirroring the existing `not`-operator strip (which already removes
 * `<anchor> 말고`) — so the anchor degrades to the soft/anchor retrieval path
 * (the `similar_items` retrieval mode still consumes it via `relativeQuery`),
 * while the remaining intent words (e.g. 레드 → wine_type) are still parsed.
 *
 * Korean markers follow the anchor (`<anchor> 비슷한`); English markers precede
 * it (`like <anchor>`). Patterns are interpolated with the regex-escaped anchor
 * by {@link Planner.buildConstraintParsingQuery}. The English lookbehinds keep
 * the boundary Unicode-safe (CLAUDE.md test discipline rule 8 — never `\\b`).
 */
export const KOREAN_SIMILARITY_MARKER_PATTERN = '\\s*(?:같은|비슷한|처럼|같이)\\s*';
export const ENGLISH_SIMILARITY_MARKER_PATTERN =
  '(?<!\\p{L})(?<!\\p{N})(?:like|similar\\s+to)\\s+';

export const EMPTY_FALLBACK_MAPPER: NLMapper = {
  mapPhrase: () => Promise.resolve(null),
  mapConstraints: (phrases: readonly string[]) =>
    Promise.resolve({
      constraints: [],
      constraintExtraction: {
        candidatePhraseCount: phrases.length,
        ruleTableHitCount: 0,
        llmHitCount: 0,
        llmSkippedCount: 0,
        fallbackTriggered: true,
        source: 'fallback',
        llmLatencyMs: null,
        phraseCacheHits: 0,
        phraseCacheNegativeSkipped: 0,
        phraseCacheMisses: 0,
        missedPhrases: [],
        fallbackReason: 'nlmapper_exception',
      },
    }),
} as unknown as NLMapper;
