import { buildComparisonDecompositionLegs } from '../../domain/query/service/decomposition-detector.js';
import type { ComparisonDecompositionLeg } from '../../domain/query/model/query-decomposition.js';

type CompareConceptEntityType =
  | 'country'
  | 'region'
  | 'appellation'
  | 'grape_primary'
  | 'wine_type';

const SIDE_SPECIFIC_SHARED_CONSTRAINT_FIELDS = [
  'country',
  'region',
  'appellation',
  'grape_primary',
  'wine_type',
] as const satisfies readonly CompareConceptEntityType[];

interface CompareToolSharedConstraintInput {
  readonly query_a: string;
  readonly query_b: string;
  readonly country?: string | undefined;
  readonly region?: string | undefined;
  readonly appellation?: string | undefined;
  readonly grape_primary?: string | undefined;
  readonly wine_type?: string | undefined;
}

function normalizeComparisonAxisValue(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC').trim().toLowerCase();
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

function getComparisonLegConceptEntityType(
  leg: ComparisonDecompositionLeg,
): CompareConceptEntityType | undefined {
  const conceptEntityType = leg.conceptEntityType;
  return conceptEntityType === 'country'
    || conceptEntityType === 'region'
    || conceptEntityType === 'appellation'
    || conceptEntityType === 'grape_primary'
    || conceptEntityType === 'wine_type'
    ? conceptEntityType
    : undefined;
}

function comparisonLegMatchesSharedField(
  leg: ComparisonDecompositionLeg,
  field: CompareConceptEntityType,
  target: string,
): boolean {
  const conceptEntityType = getComparisonLegConceptEntityType(leg);
  if (conceptEntityType !== undefined && conceptEntityType !== field) {
    return false;
  }

  const axisValues = [
    normalizeComparisonAxisValue(leg.rawQuery),
    normalizeComparisonAxisValue(leg.canonicalConcept),
  ];
  return axisValues.includes(target);
}

function isSideSpecificSharedConstraint(
  input: CompareToolSharedConstraintInput,
  field: CompareConceptEntityType,
): boolean {
  const target = normalizeComparisonAxisValue(input[field]);
  if (target === undefined) {
    return false;
  }

  const comparisonLegs = buildComparisonDecompositionLegs([input.query_a, input.query_b]);
  const matchingLegCount = comparisonLegs.filter((leg) =>
    comparisonLegMatchesSharedField(leg, field, target),
  ).length;

  return matchingLegCount === 1;
}

/**
 * compare_wines shared fields apply to BOTH sides. If the planner emits a
 * side identity (for example `appellation: Barolo` in `Barolo vs Brunello`),
 * carrying it as parent context contaminates the opposite leg.
 */
export function stripSideSpecificCompareSharedConstraints<T extends CompareToolSharedConstraintInput>(
  input: T,
): T {
  const strippedInput: Partial<CompareToolSharedConstraintInput> = { ...input };
  let strippedAny = false;
  for (const field of SIDE_SPECIFIC_SHARED_CONSTRAINT_FIELDS) {
    if (isSideSpecificSharedConstraint(input, field)) {
      delete strippedInput[field];
      strippedAny = true;
    }
  }
  if (!strippedAny) {
    return input;
  }
  return strippedInput as T;
}

export function buildCompareBaseRetrievalQueries(
  input: Pick<CompareToolSharedConstraintInput, 'query_a' | 'query_b'>,
): readonly [string, string] {
  const comparisonLegs = buildComparisonDecompositionLegs([input.query_a, input.query_b]);
  return [
    comparisonLegs[0].retrievalQuery,
    comparisonLegs[1].retrievalQuery,
  ];
}
