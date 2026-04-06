import type {
  ConstraintBundle,
  ConstraintOperator,
  NormalizedConstraint,
} from '../../shared/types/index.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';

type CandidateValue = string | number | readonly string[] | undefined;

function deriveWineType(candidate: HybridCandidate): string | undefined {
  if (candidate.wineType !== undefined && candidate.wineType.trim().length > 0) {
    return candidate.wineType.trim().toLowerCase();
  }

  const style = candidate.style?.trim().toLowerCase();
  if (style === undefined || style.length === 0) {
    return undefined;
  }
  if (style.includes('sparkling')) return 'sparkling';
  if (style.includes('dessert') || style.includes('sweet')) return 'dessert';
  if (style.includes('rose') || style.includes('ros')) return 'rose';
  if (style.includes('white')) return 'white';
  return 'red';
}

function deriveColor(candidate: HybridCandidate): string | undefined {
  const wineType = deriveWineType(candidate);
  if (wineType === 'sparkling') {
    return 'white';
  }
  return wineType;
}

function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

function resolveCandidateValue(
  candidate: HybridCandidate,
  attribute: string,
): CandidateValue {
  switch (attribute) {
    case 'body':
      return candidate.body;
    case 'sweetness':
      return candidate.sweetness;
    case 'acidity':
      return candidate.acidity;
    case 'tannin':
      return candidate.tannin;
    case 'finish_length':
      return candidate.finishLength;
    case 'style':
      return candidate.style;
    case 'price_band':
      return candidate.priceBand;
    case 'pairing':
      return candidate.pairing;
    case 'occasion':
      return candidate.occasion;
    case 'wine_type':
      return deriveWineType(candidate);
    case 'color':
      return deriveColor(candidate);
    case 'grape_primary':
      return candidate.grapePrimary;
    case 'country':
      return candidate.country;
    case 'appellation':
      return candidate.appellation;
    case 'region':
      return candidate.region;
    case 'vintage':
    case 'vintage_year':
      return candidate.vintageYear;
    case 'critic_score':
    case 'critic_score_normalized':
      return candidate.criticScoreNormalized;
    case 'producer_prestige':
      return candidate.producerPrestige;
    case 'price':
    case 'price_usd':
      return candidate.priceUsd;
    case 'classification':
      return candidate.classification;
    case 'alcohol':
    case 'alcohol_pct':
      return candidate.alcoholPct;
    case 'certification':
      return candidate.certifications;
    case 'soil_type':
      return candidate.soilType;
    case 'producer_type':
      return candidate.producerType;
    default:
      return undefined;
  }
}

function evaluateOperator(
  operator: ConstraintOperator,
  attrValue: Exclude<CandidateValue, undefined>,
  constraintValue: NormalizedConstraint['value'],
): boolean {
  switch (operator) {
    case '=': {
      if (typeof attrValue === 'string' && typeof constraintValue === 'string') {
        return normalizeString(attrValue) === normalizeString(constraintValue);
      }
      return attrValue === constraintValue;
    }

    case '<=':
      return typeof attrValue === 'number' &&
        typeof constraintValue === 'number' &&
        attrValue <= constraintValue;

    case '>=':
      return typeof attrValue === 'number' &&
        typeof constraintValue === 'number' &&
        attrValue >= constraintValue;

    case 'range': {
      if (
        typeof attrValue !== 'number' ||
        typeof constraintValue !== 'object' ||
        Array.isArray(constraintValue) ||
        !('min' in constraintValue) ||
        !('max' in constraintValue)
      ) {
        return false;
      }
      return attrValue >= constraintValue.min && attrValue <= constraintValue.max;
    }

    case 'in': {
      if (Array.isArray(attrValue)) {
        const attrValues = attrValue
          .filter((value): value is string => typeof value === 'string')
          .map(normalizeString);
        if (Array.isArray(constraintValue)) {
          return constraintValue
            .filter((value): value is string => typeof value === 'string')
            .map(normalizeString)
            .some((value) => attrValues.includes(value));
        }
        return typeof constraintValue === 'string' &&
          attrValues.includes(normalizeString(constraintValue));
      }
      if (Array.isArray(constraintValue)) {
        if (typeof attrValue !== 'string') {
          return false;
        }
        return constraintValue
          .filter((value): value is string => typeof value === 'string')
          .map(normalizeString)
          .includes(normalizeString(attrValue));
      }
      if (typeof attrValue === 'string' && typeof constraintValue === 'string') {
        return normalizeString(attrValue) === normalizeString(constraintValue);
      }
      return attrValue === constraintValue;
    }

    case 'exclude': {
      if (Array.isArray(attrValue)) {
        const attrValues = attrValue
          .filter((value): value is string => typeof value === 'string')
          .map(normalizeString);
        if (Array.isArray(constraintValue)) {
          return constraintValue
            .filter((value): value is string => typeof value === 'string')
            .map(normalizeString)
            .every((value) => !attrValues.includes(value));
        }
        return typeof constraintValue !== 'string' ||
          !attrValues.includes(normalizeString(constraintValue));
      }
      if (typeof attrValue === 'string' && typeof constraintValue === 'string') {
        return normalizeString(attrValue) !== normalizeString(constraintValue);
      }
      return attrValue !== constraintValue;
    }
  }
}

function satisfiesConstraint(
  candidate: HybridCandidate,
  constraint: NormalizedConstraint,
): boolean {
  if (constraint.attribute === 'drinking_window') {
    if (
      constraint.operator !== '=' ||
      typeof constraint.value !== 'number' ||
      candidate.drinkingWindowStart === undefined ||
      candidate.drinkingWindowEnd === undefined
    ) {
      return false;
    }
    return candidate.drinkingWindowStart <= constraint.value &&
      candidate.drinkingWindowEnd >= constraint.value;
  }

  const attrValue = resolveCandidateValue(candidate, constraint.attribute);
  if (attrValue === undefined) {
    return false;
  }
  return evaluateOperator(constraint.operator, attrValue, constraint.value);
}

export function annotateCandidateConstraintEvidence(
  candidate: HybridCandidate,
  constraints: ConstraintBundle,
): HybridCandidate {
  const { unmetHardConstraints: _ignored, ...rest } = candidate;
  const matched = new Set(candidate.matchedConstraints);
  const unmetHard: string[] = [];

  for (const constraint of constraints.hard) {
    if (satisfiesConstraint(candidate, constraint)) {
      matched.add(constraint.attribute);
    } else {
      unmetHard.push(constraint.attribute);
    }
  }

  for (const constraint of constraints.soft) {
    if (satisfiesConstraint(candidate, constraint)) {
      matched.add(constraint.attribute);
    }
  }

  for (const constraint of constraints.inferred) {
    if (satisfiesConstraint(candidate, constraint)) {
      matched.add(constraint.attribute);
    }
  }

  return {
    ...rest,
    matchedConstraints: [...matched],
    ...(unmetHard.length > 0 ? { unmetHardConstraints: unmetHard } : {}),
  };
}

export function annotateCandidateConstraintEvidenceBatch(
  candidates: readonly HybridCandidate[],
  constraints: ConstraintBundle,
): readonly HybridCandidate[] {
  if (
    constraints.hard.length === 0 &&
    constraints.soft.length === 0 &&
    constraints.inferred.length === 0
  ) {
    return candidates;
  }
  return candidates.map((candidate) =>
    annotateCandidateConstraintEvidence(candidate, constraints));
}
