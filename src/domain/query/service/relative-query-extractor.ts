import type {
  AnchorConditionedQuery,
  RelativeOperator,
  RelativeQueryExpression,
} from '../model/relative-query.js';

// ---------------------------------------------------------------------------
// Bounded delta heuristic constants (CLAUDE.md test discipline rule 15)
//
// These values are NOT learned — they are deterministic, bounded hints for
// downstream consumers (e.g. mixed-mode retrieval) describing roughly how
// far the user wants to deviate from the anchor on `impliedAxis`.
//
// Magnitudes live in the axis unit interval [-1, 1]. The "regular" tier
// (`±0.2`) mirrors a single-bucket shift on a 5-bucket axis discretisation
// (1/5 = 0.2). The "much" tier (`±0.5`) mirrors a half-axis shift, used
// when the surface form contains an intensifier ("much less", "훨씬 더").
//
// Similarity ("처럼", "같은", "like X") explicitly resolves to `0` because
// the constraint is "near the anchor", not "shifted away from it".
//
// Magnitudes intentionally avoid the extremes (±1) so downstream score
// adjustments never fully zero out a valid candidate.
// ---------------------------------------------------------------------------

/** Single-bucket negative shift against anchor (e.g. "less tannic"). */
export const RELATIVE_DELTA_LESS = -0.2;

/** Single-bucket positive shift against anchor (e.g. "more fruity"). */
export const RELATIVE_DELTA_MORE = 0.2;

/** Half-axis negative shift, triggered by intensifier (e.g. "much less"). */
export const RELATIVE_DELTA_MUCH_LESS = -0.5;

/** Half-axis positive shift, triggered by intensifier (e.g. "much more"). */
export const RELATIVE_DELTA_MUCH_MORE = 0.5;

/** Similarity neutral — anchor-near, no axis shift. */
export const RELATIVE_DELTA_SIMILAR = 0;

// ---------------------------------------------------------------------------
// Pattern tables
// ---------------------------------------------------------------------------

/**
 * Each entry describes one operator and its detection patterns.
 *
 * Patterns are applied in order; the first match wins per operator.
 * The anchor capture group is always named `anchor`.
 */
interface OperatorPattern {
  readonly operator: RelativeOperator;
  /**
   * Patterns where the anchor comes BEFORE the operator keyword.
   *
   * Named group `anchor` must capture the entity surface form.
   */
  readonly prefixPatterns: readonly RegExp[];
  /**
   * Patterns where the operator keyword comes BEFORE the anchor.
   *
   * Named group `anchor` must capture the entity surface form.
   */
  readonly postfixPatterns: readonly RegExp[];
  /** implied axis, omitted if not applicable */
  readonly impliedAxis?: string;
  /**
   * Default bounded delta on `impliedAxis`. Bounded in [-1, 1].
   *
   * Omitted when the operator has no quantitative interpretation
   * (e.g. `not`, `better_than`).
   */
  readonly defaultDelta?: number;
}

const OPERATOR_PATTERNS: readonly OperatorPattern[] = [
  // less_tannic_than: "X보다 덜 떫은" / "less tannic than X"
  //
  // Listed BEFORE generic similar_to so "less tannic than Opus One" does NOT
  // get swallowed by an unrelated similarity match downstream.
  {
    operator: 'less_tannic_than',
    impliedAxis: 'tannin',
    defaultDelta: RELATIVE_DELTA_LESS,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*덜\s*떫은/u,
      /(?<anchor>.+?)\s*보다\s*덜\s*탄닌/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})less\s+tannic\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // more_tannic_than: "X보다 더 떫은" / "more tannic than X"
  {
    operator: 'more_tannic_than',
    impliedAxis: 'tannin',
    defaultDelta: RELATIVE_DELTA_MORE,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*더\s*떫은/u,
      /(?<anchor>.+?)\s*보다\s*탄닌\s*강한/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})more\s+tannic\s+than\s+(?<anchor>.+)/iu,
      /(?<!\p{L})(?<!\p{N})tannin\s+heavier\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // less_fruity_than: "X보다 덜 과실향" / "less fruity than X"
  {
    operator: 'less_fruity_than',
    impliedAxis: 'fruit',
    defaultDelta: RELATIVE_DELTA_LESS,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*덜\s*과실(?:향|미)/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})less\s+fruity\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // more_fruity_than: "X보다 더 과실향" / "more fruity than X"
  {
    operator: 'more_fruity_than',
    impliedAxis: 'fruit',
    defaultDelta: RELATIVE_DELTA_MORE,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*더\s*과실(?:향|미)/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})more\s+fruity\s+than\s+(?<anchor>.+)/iu,
      /(?<!\p{L})(?<!\p{N})fruitier\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // similar_to: "X 같은" / "X 비슷한" / "X 처럼" / "X 같이" / "like X" / "similar to X"
  {
    operator: 'similar_to',
    defaultDelta: RELATIVE_DELTA_SIMILAR,
    prefixPatterns: [
      /(?<anchor>.+?)\s*같은/u,
      /(?<anchor>.+?)\s*비슷한/u,
      /(?<anchor>.+?)\s*처럼/u,
      /(?<anchor>.+?)\s*같이/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})like\s+(?<anchor>.+?)(?:\s+wine)?$/iu,
      /(?<!\p{L})(?<!\p{N})similar\s+to\s+(?<anchor>.+?)(?:\s+wine)?$/iu,
    ],
  },

  // cheaper_than: "X보다 저렴한" / "X보다 덜 비싼" / "cheaper than X" / "less expensive than X"
  {
    operator: 'cheaper_than',
    impliedAxis: 'price_band',
    defaultDelta: RELATIVE_DELTA_LESS,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*저렴한/u,
      /(?<anchor>.+?)\s*보다\s*싼/u,
      /(?<anchor>.+?)\s*보다\s*덜\s*비싼/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})cheaper\s+than\s+(?<anchor>.+)/iu,
      /(?<!\p{L})(?<!\p{N})less\s+expensive\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // more_expensive_than: "X보다 비싼" / "more expensive than X"
  {
    operator: 'more_expensive_than',
    impliedAxis: 'price_band',
    defaultDelta: RELATIVE_DELTA_MORE,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*비싼/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})more\s+expensive\s+than\s+(?<anchor>.+)/iu,
      /(?<!\p{L})(?<!\p{N})pricier\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // lighter_than: "X보다 가벼운" / "lighter than X"
  {
    operator: 'lighter_than',
    impliedAxis: 'body',
    defaultDelta: RELATIVE_DELTA_LESS,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*가벼운/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})lighter\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // fuller_than: "X보다 묵직한" / "heavier than X" / "fuller than X"
  {
    operator: 'fuller_than',
    impliedAxis: 'body',
    defaultDelta: RELATIVE_DELTA_MORE,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*묵직한/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})heavier\s+than\s+(?<anchor>.+)/iu,
      /(?<!\p{L})(?<!\p{N})fuller\s+than\s+(?<anchor>.+)/iu,
      /(?<!\p{L})(?<!\p{N})full[\s-]?bodied\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // drier_than: "X보다 드라이한" / "drier than X"
  {
    operator: 'drier_than',
    impliedAxis: 'sweetness',
    defaultDelta: RELATIVE_DELTA_LESS,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*드라이한/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})drier\s+than\s+(?<anchor>.+)/iu,
      /(?<!\p{L})(?<!\p{N})more\s+dry\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // sweeter_than: "X보다 달달한" / "sweeter than X"
  {
    operator: 'sweeter_than',
    impliedAxis: 'sweetness',
    defaultDelta: RELATIVE_DELTA_MORE,
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*달달한/u,
      /(?<anchor>.+?)\s*보다\s*단/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})sweeter\s+than\s+(?<anchor>.+)/iu,
      /(?<!\p{L})(?<!\p{N})more\s+sweet\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // better_than: "X보다 좋은" / "better than X"
  //
  // Intentionally has no axis / delta — "better" does not map to a single
  // axis. Downstream consumers must treat as a soft re-rank signal.
  {
    operator: 'better_than',
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*좋은/u,
      /(?<anchor>.+?)\s*보다\s*나은/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})better\s+than\s+(?<anchor>.+)/iu,
    ],
  },

  // not: "X 말고" / "X 대신" / "instead of X"
  //
  // No axis / delta — the user is excluding the anchor, not comparing to it.
  {
    operator: 'not',
    prefixPatterns: [
      /(?<anchor>.+?)\s*말고/u,
      /(?<anchor>.+?)\s*대신/u,
    ],
    postfixPatterns: [
      /(?<!\p{L})(?<!\p{N})instead\s+of\s+(?<anchor>.+)/iu,
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimAnchor(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Detects an intensifier ("much", "way", "훨씬", "한참") in the query.
 *
 * When present alongside a `less`/`more` operator, the bounded delta is
 * promoted from the regular tier (`±0.2`) to the much tier (`±0.5`).
 *
 * ASCII-safe regex: uses `[^\p{L}\p{N}]` lookarounds so non-Latin contexts
 * (e.g. Korean text) don't silently break boundary semantics (CLAUDE.md
 * test discipline rule 8).
 */
const INTENSIFIER_PATTERNS: readonly RegExp[] = [
  /(?:^|[^\p{L}\p{N}])much(?=[^\p{L}\p{N}]|$)/iu,
  /(?:^|[^\p{L}\p{N}])way(?=[^\p{L}\p{N}]|$)/iu,
  /훨씬/u,
  /한참/u,
];

function hasIntensifier(query: string): boolean {
  for (const re of INTENSIFIER_PATTERNS) {
    if (re.test(query)) {
      return true;
    }
  }
  return false;
}

/**
 * Promotes the bounded delta from the regular tier to the much tier when an
 * intensifier is present. Returns the input unchanged for `0` (similarity)
 * or `undefined` (operator has no axis).
 */
function promoteDeltaIfIntensified(
  delta: number | undefined,
  query: string,
): number | undefined {
  if (delta === undefined) {
    return undefined;
  }
  if (delta === RELATIVE_DELTA_SIMILAR) {
    return delta;
  }
  if (!hasIntensifier(query)) {
    return delta;
  }
  if (delta < 0) {
    return RELATIVE_DELTA_MUCH_LESS;
  }
  return RELATIVE_DELTA_MUCH_MORE;
}

function matchOperator(
  query: string,
  entry: OperatorPattern,
): string | null {
  for (const re of entry.prefixPatterns) {
    const m = re.exec(query);
    if (m?.groups?.['anchor'] !== undefined) {
      return trimAnchor(m.groups['anchor']);
    }
  }
  for (const re of entry.postfixPatterns) {
    const m = re.exec(query);
    if (m?.groups?.['anchor'] !== undefined) {
      return trimAnchor(m.groups['anchor']);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RelativeQueryExtractor
// ---------------------------------------------------------------------------

/**
 * Extracts structured relative / anchor-conditioned query expressions from a
 * raw user query string.
 *
 * Supports Korean and English surface patterns. Returns `null` when no
 * relative expression is found.
 */
export class RelativeQueryExtractor {
  /**
   * Attempts to extract a {@link AnchorConditionedQuery} from the given query.
   *
   * @param query - Raw or lightly normalised user query string.
   * @returns A structured relative query, or `null` if no pattern matched.
   */
  extract(query: string): AnchorConditionedQuery | null {
    const expressions: RelativeQueryExpression[] = [];

    for (const entry of OPERATOR_PATTERNS) {
      const anchorSurface = matchOperator(query, entry);
      if (anchorSurface === null) {
        continue;
      }

      const resolvedDelta = promoteDeltaIfIntensified(
        entry.defaultDelta,
        query,
      );

      const expression: RelativeQueryExpression = {
        anchorSurfaceForm: anchorSurface,
        operator: entry.operator,
        confidence: 0.85,
        ...(entry.impliedAxis !== undefined
          ? { impliedAxis: entry.impliedAxis }
          : {}),
        ...(resolvedDelta !== undefined ? { delta: resolvedDelta } : {}),
      };
      expressions.push(expression);
    }

    if (expressions.length === 0) {
      return null;
    }

    // Use the first expression's anchor as the primary anchor surface form.
    // In practice a query will match at most one operator.
    const primaryExpression = expressions[0];
    // primaryExpression is always defined here because expressions.length > 0
    const anchorSurfaceForm = primaryExpression!.anchorSurfaceForm;
    const isSimilarityQuery = expressions.some(
      (e) => e.operator === 'similar_to',
    );

    return {
      anchorSurfaceForm,
      relativeExpressions: expressions,
      isSimilarityQuery,
    };
  }
}
