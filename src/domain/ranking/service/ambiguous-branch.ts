import type { RankedResult } from '../model/ranked-result.js';
import type { AmbiguousBranchPolicyGroup } from '../port/ranking-policy.port.js';
import { buildNormalizedQueryViews } from '../../query/service/query-normalizer.js';
import { stripVintageYearsBounded } from '../../shared/utils/vintage.js';

function normalizeBranchLabel(value: string): string {
  return buildNormalizedQueryViews(stripVintageYearsBounded(value)).punctuationStripped;
}

export function shouldApplyCanonicalFamilyBranchPrior(queryClass: string): boolean {
  return queryClass === 'short_entity' || queryClass === 'ambiguous_short_form';
}

export function extractSingleTokenNormalizedQuery(
  normalizedQuery: string | undefined,
): string | undefined {
  const tokens = buildNormalizedQueryViews(normalizedQuery ?? '').punctuationStripped
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length !== 1) {
    return undefined;
  }
  return tokens[0];
}

export function deriveCanonicalFamilyBranchLabel(
  result: Pick<RankedResult, 'canonicalLabel'>,
): string | undefined {
  const normalized = normalizeBranchLabel(result.canonicalLabel);
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveAmbiguousBranchLabel(
  result: RankedResult,
  groups?: readonly AmbiguousBranchPolicyGroup[]  ,
): string | undefined {
  if (groups === undefined || groups.length === 0) {
    return deriveCanonicalFamilyBranchLabel(result);
  }

  const candidateValues = [
    result.grapePrimary,
  ]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());

  for (const group of groups) {
    const normalizedMatches = group.matchValues.map((value) => value.trim().toLowerCase());
    if (candidateValues.some((value) => normalizedMatches.includes(value))) {
      return group.label;
    }
  }
  return undefined;
}
