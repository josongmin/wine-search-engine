import type {
  AnchorConditionedQuery,
  RelativeOperator,
  RelativeQueryExpression,
} from '../model/relative-query.js';

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
}

const OPERATOR_PATTERNS: readonly OperatorPattern[] = [
  // similar_to: "X 같은" / "X 비슷한" / "like X" / "similar to X"
  {
    operator: 'similar_to',
    prefixPatterns: [
      /(?<anchor>.+?)\s*같은/,
      /(?<anchor>.+?)\s*비슷한/,
    ],
    postfixPatterns: [
      /\blike\s+(?<anchor>.+?)(?:\s+wine)?$/i,
      /\bsimilar\s+to\s+(?<anchor>.+?)(?:\s+wine)?$/i,
    ],
  },

  // cheaper_than: "X보다 저렴한" / "cheaper than X" / "less expensive than X"
  {
    operator: 'cheaper_than',
    impliedAxis: 'price_band',
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*저렴한/,
      /(?<anchor>.+?)\s*보다\s*싼/,
    ],
    postfixPatterns: [
      /\bcheaper\s+than\s+(?<anchor>.+)/i,
      /\bless\s+expensive\s+than\s+(?<anchor>.+)/i,
    ],
  },

  // more_expensive_than: "X보다 비싼" / "more expensive than X"
  {
    operator: 'more_expensive_than',
    impliedAxis: 'price_band',
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*비싼/,
    ],
    postfixPatterns: [
      /\bmore\s+expensive\s+than\s+(?<anchor>.+)/i,
      /\bpricier\s+than\s+(?<anchor>.+)/i,
    ],
  },

  // lighter_than: "X보다 가벼운" / "lighter than X"
  {
    operator: 'lighter_than',
    impliedAxis: 'body',
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*가벼운/,
    ],
    postfixPatterns: [
      /\blighter\s+than\s+(?<anchor>.+)/i,
    ],
  },

  // fuller_than: "X보다 묵직한" / "heavier than X" / "fuller than X"
  {
    operator: 'fuller_than',
    impliedAxis: 'body',
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*묵직한/,
    ],
    postfixPatterns: [
      /\bheavier\s+than\s+(?<anchor>.+)/i,
      /\bfuller\s+than\s+(?<anchor>.+)/i,
      /\bfull[\s-]?bodied\s+than\s+(?<anchor>.+)/i,
    ],
  },

  // drier_than: "X보다 드라이한" / "drier than X"
  {
    operator: 'drier_than',
    impliedAxis: 'sweetness',
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*드라이한/,
    ],
    postfixPatterns: [
      /\bdrier\s+than\s+(?<anchor>.+)/i,
      /\bmore\s+dry\s+than\s+(?<anchor>.+)/i,
    ],
  },

  // sweeter_than: "X보다 달달한" / "sweeter than X"
  {
    operator: 'sweeter_than',
    impliedAxis: 'sweetness',
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*달달한/,
      /(?<anchor>.+?)\s*보다\s*단/,
    ],
    postfixPatterns: [
      /\bsweeter\s+than\s+(?<anchor>.+)/i,
      /\bmore\s+sweet\s+than\s+(?<anchor>.+)/i,
    ],
  },

  // better_than: "X보다 좋은" / "better than X"
  {
    operator: 'better_than',
    prefixPatterns: [
      /(?<anchor>.+?)\s*보다\s*좋은/,
      /(?<anchor>.+?)\s*보다\s*나은/,
    ],
    postfixPatterns: [
      /\bbetter\s+than\s+(?<anchor>.+)/i,
    ],
  },

  // not: "X 말고" / "X 대신" / "instead of X"
  {
    operator: 'not',
    prefixPatterns: [
      /(?<anchor>.+?)\s*말고/,
      /(?<anchor>.+?)\s*대신/,
    ],
    postfixPatterns: [
      /\binstead\s+of\s+(?<anchor>.+)/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimAnchor(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
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

      const expression: RelativeQueryExpression = {
        anchorSurfaceForm: anchorSurface,
        operator: entry.operator,
        confidence: 0.85,
        ...(entry.impliedAxis !== undefined
          ? { impliedAxis: entry.impliedAxis }
          : {}),
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
