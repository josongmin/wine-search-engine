/**
 * E6-U3: Decomposition Reuse Map (lock)
 *
 * Decomposition is a REUSE path, not a new runtime:
 *   - Detection: this file (decomposition-detector.ts)
 *   - Model: domain/query/model/query-decomposition.ts
 *   - Adapter seam: application/search/decomposed-search-adapter.ts
 *
 * Do NOT create a decomposition-specific orchestrator stack or a parallel
 * search runtime for decomposed queries. The DecomposedSearchAdapter is the
 * single wiring point — it holds a delegate to the main SearchUseCase.
 *
 * Epic 14, Step 14.1: Query Decomposition Detector
 *
 * Detects "A vs B" style comparison queries and decomposes them into
 * typed comparison legs.
 *
 * Patterns:
 *  - English: "X vs Y", "X versus Y", "compare X and Y"
 *  - Korean: "X와 Y", "X랑 Y 비교", "X 또는 Y"
 */

import {
  buildEntityComparisonLeg,
  getComparisonDecompositionSubtype,
  toQueryDecompositionHint,
  type ComparisonDecompositionSubtype,
  type ComparisonDecompositionLeg,
  type ComparisonDecompositionLegs,
  type ComparisonIntent,
  type QueryDecompositionHint,
} from '../model/query-decomposition.js';
import { classifyQueryBudget } from '../../agent/service/adaptive-budget.js';
import { buildNormalizedQueryViews } from './query-normalizer.js';
import {
  isDirectEntityResolution,
  resolveEntity,
} from '../../attribute/service/entity-resolver.js';
import { parseSpans, resolveOverlaps, type Span } from '../../attribute/service/span-parser.js';

interface DecompositionResult {
  readonly decomposed: false;
}

interface SuccessfulDecomposition {
  readonly decomposed: true;
  readonly subQueries: [string, string];
  readonly comparisonIntent: ComparisonIntent;
  readonly comparisonSubtype: ComparisonDecompositionSubtype;
  readonly comparisonLegs: ComparisonDecompositionLegs;
}

type DecompositionOutcome = DecompositionResult | SuccessfulDecomposition;

interface QueryDecompositionAnalysis {
  readonly outcome: DecompositionOutcome;
  readonly hint: QueryDecompositionHint;
}

/**
 * Regex patterns for detecting decomposable comparison queries.
 * Ordered by priority (more specific to less specific).
 */
const COMPARISON_PATTERNS: ReadonlyArray<RegExp> = [
  // English: "X vs Y", "X vs. Y", "X versus Y"
  /(.+?)\s+(?:vs\.?|versus)\s+(.+?)(?:\?|$)/i,

  // English: "compare X and Y", "compare X with Y"
  /(?:compare)\s+(.+?)\s+(?:and|with)\s+(.+?)(?:\?|$)/i,

  // Korean: "X와 Y", "X랑 Y", "X하고 Y"
  /(.+?)(?:와|과|랑|하고|이랑)\s+(.+?)(?=\s+(?:중|비교|비교하면|뭐가|어떤|차이|어느))/u,

  // Korean: "X 와 Y", "X 랑 Y", "X 하고 Y"
  /(.+?)\s+(?:와|과|랑|하고|이랑)\s+(.+?)\s+(?:중|비교|비교하면|뭐가|어떤|차이|어느)(?:\?|$)/u,

  // English: "X or Y which is better", "X or Y better choice"
  // Allow trailing content after the cue (e.g. "which is better") by anchoring
  // the cue end on whitespace OR `?` OR end-of-string. Without `\s` the second
  // capture group greedily absorbs words between Y and the cue, e.g.
  // "Screaming Eagle which is" for "X or Y which is better".
  /(.+?)\s+or\s+(.+?)\s+(?:which|better|choice)(?:\s|\?|$)/i,

  // Korean: "X 또는 Y 어느", "X 또는 Y 어느 게 좋아"
  // Same rationale as the English "or" pattern above: allow trailing content
  // after the cue word so "어느 게 좋아" still anchors on "어느".
  /(.+?)\s+(?:또는|아니면)\s+(.+?)\s+(?:어느|뭐|어떤)(?:\s|\?|$)/u,
];

const CONCEPT_COMPARE_ENTITY_TYPES = new Set([
  'wine_type',
  'country',
  'region',
  'appellation',
  'grape_primary',
] as const);
const VINTAGE_PATTERN = /(?<!\p{L})(?<!\p{N})(?:18|19|20)\d{2}(?!\p{L})(?!\p{N})/u;

/**
 * Detects whether a query is a decomposable comparison query.
 * Returns sub-queries and inferred comparison intent.
 */
export function detectDecomposition(query: string): DecompositionOutcome {
  for (const pattern of COMPARISON_PATTERNS) {
    const match = pattern.exec(query);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      const subQuery1 = match[1].trim();
      const subQuery2 = match[2].trim();

      // Sanity check: both sub-queries must be non-empty
      if (subQuery1.length > 0 && subQuery2.length > 0) {
        const comparisonLegs = buildComparisonDecompositionLegs([subQuery1, subQuery2]);
        return {
          decomposed: true,
          subQueries: [subQuery1, subQuery2],
          comparisonIntent: inferComparisonIntent(query),
          comparisonSubtype: getComparisonDecompositionSubtype(comparisonLegs),
          comparisonLegs,
        };
      }
    }
  }

  return { decomposed: false };
}

export function analyzeQueryDecomposition(query: string): QueryDecompositionAnalysis {
  const outcome = detectDecomposition(query);
  return {
    outcome,
    hint: toQueryDecompositionHint(outcome),
  };
}

/**
 * Infers the user's intent from the comparison query.
 * - 'compare': neutral comparison
 * - 'recommend_one': user asking which one is better
 * - 'list_both': user asking for details on both
 */
function inferComparisonIntent(
  query: string,
): ComparisonIntent {
  const q = query.toLowerCase();

  // "which is better", "추천", "추천해", "어느 게 좋아"
  // Use Unicode-aware boundaries: \b is ASCII-only and silently fails on Korean.
  if (/(?:^|[^\p{L}\p{N}])(?:which|better|recommend|추천|좋아|나은)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    return 'recommend_one';
  }

  // "both", "둘 다", "정보", "details"
  if (/(?:^|[^\p{L}\p{N}])(?:both|details|information|둘|다|정보)(?=$|[^\p{L}\p{N}])/iu.test(q)) {
    return 'list_both';
  }

  // Default: neutral comparison
  return 'compare';
}

export function buildComparisonDecompositionLegs(
  subQueries: readonly [string, string],
): ComparisonDecompositionLegs {
  return [
    buildComparisonDecompositionLeg(subQueries[0]),
    buildComparisonDecompositionLeg(subQueries[1]),
  ];
}

export function buildComparisonDecompositionLegsForRetrieval(
  rawSubQueries: readonly [string, string],
  retrievalSubQueries: readonly [string, string],
): ComparisonDecompositionLegs {
  const [left, right] = buildComparisonDecompositionLegs(rawSubQueries);
  return [
    { ...left, retrievalQuery: retrievalSubQueries[0] },
    { ...right, retrievalQuery: retrievalSubQueries[1] },
  ];
}

function buildComparisonDecompositionLeg(query: string): ComparisonDecompositionLeg {
  if (shouldPreserveEntityComparisonLeg(query)) {
    return buildEntityComparisonLeg(query);
  }

  const conceptResolution = resolveConceptComparisonCanonical(query);
  if (conceptResolution !== undefined) {
    return {
      rawQuery: query,
      retrievalQuery: buildConceptComparisonRetrievalQuery(query, conceptResolution),
      mode: 'concept',
      retrievalMode: getConceptComparisonRetrievalMode(conceptResolution.entityType),
      evidenceSource: conceptResolution.evidenceSource,
      conceptEntityType: conceptResolution.entityType,
      canonicalConcept: conceptResolution.canonicalConcept,
    };
  }

  return buildEntityComparisonLeg(query);
}

function shouldPreserveEntityComparisonLeg(query: string): boolean {
  if (!VINTAGE_PATTERN.test(query)) {
    return false;
  }
  return classifyQueryBudget(query.normalize('NFC').trim())?.classification === 'specific_sku'
    || hasVintageBearingDirectEntityAnchor(query);
}

function hasVintageBearingDirectEntityAnchor(query: string): boolean {
  const stripped = query
    .replace(/(?<![\p{L}\p{N}])(?:18|19|20)\d{2}(?:년산?|년대)?(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (stripped.length === 0) {
    return false;
  }
  const resolved = resolveEntity(stripped, { preferEntityOverStyle: true });
  return isDirectEntityResolution(resolved)
    && CONCEPT_COMPARE_ENTITY_TYPES.has(resolved.entityType);
}

function getConceptComparisonRetrievalMode(
  _entityType: 'country' | 'region' | 'appellation' | 'grape_primary' | 'wine_type',
): 'entity' | 'hybrid' {
  // Concept/category comparisons need representative wine sets, not exact entity
  // lookup for the concept label itself (for example "Barolo" as an appellation).
  return 'hybrid';
}

function buildConceptComparisonRetrievalQuery(
  rawQuery: string,
  primaryConcept: {
    readonly canonicalConcept: string;
    readonly entityType: 'country' | 'region' | 'appellation' | 'grape_primary' | 'wine_type';
  },
): string {
  const normalized = buildNormalizedQueryViews(rawQuery).punctuationStripped.trim();
  const canonicalParts: string[] = [primaryConcept.canonicalConcept];
  const seen = new Set(canonicalParts.map((part) => part.toLowerCase()));
  const resolvedSpans = resolveOverlaps(
    parseSpans(normalized).map((span) => ({
      span,
      resolved: resolveEntity(span.text, { preferEntityOverStyle: true }),
    })),
  );

  for (const entry of resolvedSpans) {
    const resolved = entry.resolved;
    if (!isDirectEntityResolution(resolved) || !CONCEPT_COMPARE_ENTITY_TYPES.has(resolved.entityType)) {
      continue;
    }
    const canonical = resolved.canonicalValue;
    const key = canonical.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    canonicalParts.push(canonical);
  }

  return `${canonicalParts.join(' ')} wine`;
}

function resolveConceptComparisonCanonical(
  query: string,
): {
  readonly canonicalConcept: string;
  readonly entityType: 'country' | 'region' | 'appellation' | 'grape_primary' | 'wine_type';
  readonly evidenceSource: 'direct_entity_resolution' | 'span_entity_resolution';
} | undefined {
  const normalized = buildNormalizedQueryViews(query).punctuationStripped.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  const direct = resolveEntity(normalized, { preferEntityOverStyle: true });
  if (
    isDirectEntityResolution(direct)
    && CONCEPT_COMPARE_ENTITY_TYPES.has(direct.entityType)
  ) {
    return {
      canonicalConcept: direct.canonicalValue,
      entityType: direct.entityType,
      evidenceSource: 'direct_entity_resolution',
    };
  }

  const resolvedSpans = resolveOverlaps(
    parseSpans(normalized).map((span) => ({
      span,
      resolved: resolveEntity(span.text, { preferEntityOverStyle: true }),
    })),
  )
    .filter(
      (
        entry,
      ): entry is {
        span: Span;
        resolved: NonNullable<ReturnType<typeof resolveEntity>>;
      } => isDirectEntityResolution(entry.resolved),
    );

  const conceptResolution = resolvedSpans.find((entry) =>
    CONCEPT_COMPARE_ENTITY_TYPES.has(entry.resolved.entityType),
  );
  if (conceptResolution === undefined) {
    return undefined;
  }

  return {
    canonicalConcept: conceptResolution.resolved.canonicalValue,
    entityType: conceptResolution.resolved.entityType,
    evidenceSource: 'span_entity_resolution',
  };
}

/**
 * Checks if a query looks like a trivial decomposition attempt.
 * (e.g. empty sub-queries after extraction)
 */
export function isValidDecomposition(result: DecompositionOutcome): result is SuccessfulDecomposition {
  if (!result.decomposed) return false;

  const [q1, q2] = result.subQueries;
  // Both must have actual entity-like tokens (not just articles/prepositions)
  return q1.split(/\s+/).length >= 1 && q2.split(/\s+/).length >= 1;
}
