import { buildNormalizedQueryViews } from '../../query/service/query-normalizer.js';

function normalizeDisplayPart(value: string | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }
  return buildNormalizedQueryViews(value).punctuationStripped;
}

export interface DisplayIdentityParts {
  readonly canonicalLabel: string;
  readonly producer?: string | undefined;
  readonly region?: string | undefined;
  readonly country?: string | undefined;
  readonly vintage?: number | undefined;
  readonly type?: string | undefined;
}

export function buildDisplayIdentitySignature(parts: DisplayIdentityParts): string {
  return [
    normalizeDisplayPart(parts.canonicalLabel),
    normalizeDisplayPart(parts.producer),
    normalizeDisplayPart(parts.region),
    normalizeDisplayPart(parts.country),
    parts.vintage !== undefined ? String(parts.vintage) : '',
    normalizeDisplayPart(parts.type),
  ].join('\u0000');
}

export function buildClarificationCandidateSignature(candidate: {
  readonly label: string;
  readonly distinguishingFeatures: readonly string[];
}): string {
  const normalizedFeatures = candidate.distinguishingFeatures
    .map((value) => normalizeDisplayPart(value))
    .filter((value) => value.length > 0)
    .sort();

  return [
    normalizeDisplayPart(candidate.label),
    ...normalizedFeatures,
  ].join('\u0000');
}
