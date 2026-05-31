/**
 * Result + option contracts for `NLMapper.mapConstraints`, plus the pure
 * {@link NLMapping} → {@link NormalizedConstraint} conversion.
 *
 * Extracted verbatim from `service/nl-mapper.ts` (behavior-preserving split)
 * and re-exported from there so existing import paths keep working.
 */
import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { ConstraintExtractionTrace } from './constraint-extraction-trace.js';
import type { NLMapping } from './nl-mapping.js';

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
