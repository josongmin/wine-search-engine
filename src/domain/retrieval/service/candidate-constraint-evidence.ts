import type {
  ConstraintBundle,
  ConstraintOperator,
  NormalizedConstraint,
} from '../../shared/types/index.js';
import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import { GEOGRAPHY_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';
import { convertConstraintUsdToApproxKrw } from '../../shared/utils/canonical-price.js';
import {
  normalizeConstraintComparableArray,
  normalizeConstraintComparableString,
} from '../../attribute/service/constraint-ontology-normalization.js';
import { resolveSemanticStyleEvidenceProfile } from '../../query/service/semantic-style-query-terms.js';
import { isNoOpSemanticStyleHint } from '../../query/service/semantic-style-query-terms.js';
import { candidateMatchesRecipientProfile } from '../../query/service/recipient-situation-profile.js';

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
  if (style.includes('white')) return 'white';
  if (style.includes('dessert') || style.includes('sweet')) return 'dessert';
  if (style.includes('rose') || style.includes('ros')) return 'rose';
  return 'red';
}

function deriveColor(candidate: HybridCandidate): string | undefined {
  const wineType = deriveWineType(candidate);
  if (wineType === 'sparkling') {
    return 'white';
  }
  return wineType;
}

/**
 * Normalizes a string for comparison: trim → lowercase → NFD decompose →
 * strip combining diacritical marks (U+0300–U+036F).
 *
 * This mirrors Vespa's `accent-removal: true` index setting so that
 * annotation-layer comparisons are consistent with retrieval-layer filtering.
 * Without this, "Côtes du Rhône" ≠ "Cotes du Rhone" at annotation time even
 * though Vespa treats them as equivalent — causing false unmetHardConstraints.
 */
function normalizeString(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function geographyContains(attrValue: string, constraintValue: string): boolean {
  return normalizeString(attrValue).includes(normalizeString(constraintValue));
}

function geographyExcludesAll(attrValue: string, constraintValues: readonly string[]): boolean {
  const norm = normalizeString(attrValue);
  return constraintValues.every((cv) => !norm.includes(normalizeString(cv)));
}

function normalizeWineType(value: string): string {
  const normalized = normalizeString(value);
  return normalized === 'rose' ? 'rosé' : normalized;
}

function normalizeClosure(value: string): string {
  return normalizeString(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

function closureMatches(attrValue: string, constraintValue: string): boolean {
  const normalizedAttr = normalizeClosure(attrValue);
  const normalizedConstraint = normalizeClosure(constraintValue);
  return normalizedConstraint.length > 0 && normalizedAttr.includes(normalizedConstraint);
}

function collectCandidateStyleFragments(candidate: HybridCandidate): readonly string[] {
  const style = candidate.style?.trim();
  if (style === undefined || style.length === 0) {
    return [];
  }

  return [
    style,
    ...style.split(/\s+/u),
  ];
}

function candidateMatchesSemanticStyleProfile(
  candidate: HybridCandidate,
  profile: NonNullable<ReturnType<typeof resolveSemanticStyleEvidenceProfile>>,
): boolean {
  const candidateWineTypes = [
    candidate.wineType,
    deriveWineType(candidate),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeWineType);
  const candidateGrapes = [
    candidate.grapePrimary,
    candidate.grapeFamily,
    ...(candidate.grapes ?? []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeString(value));
  const candidateStyleFragments = collectCandidateStyleFragments(candidate)
    .map((value) => normalizeString(value));
  const candidateOccasions = (candidate.occasion ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeString(value));

  if (profile.wineTypes.some((wineType) => candidateWineTypes.includes(normalizeWineType(wineType)))) {
    return true;
  }

  if (profile.occasionTerms.some((term) => candidateOccasions.includes(normalizeString(term)))) {
    return true;
  }

  if (profile.grapeTerms.some((term) => candidateGrapes.includes(normalizeString(term)))) {
    return true;
  }

  if (profile.styleTerms.some((term) => candidateStyleFragments.includes(normalizeString(term)))) {
    return true;
  }

  const easyDrinkingStructuralMatch =
    (candidate.body === undefined || candidate.body <= 3)
    && (candidate.tannin === undefined || candidate.tannin <= 3);
  if (easyDrinkingStructuralMatch && profile.styleTerms.some((term) => normalizeString(term) === 'easy drinking')) {
    return true;
  }

  return false;
}

function satisfiesSemanticStyleConstraint(
  candidate: HybridCandidate,
  constraint: NormalizedConstraint,
): boolean | undefined {
  if (constraint.attribute !== 'style') {
    return undefined;
  }

  const requestedStyles =
    typeof constraint.value === 'string'
      ? [constraint.value]
      : Array.isArray(constraint.value)
        ? constraint.value.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
  if (requestedStyles.length === 0) {
    return undefined;
  }

  const semanticProfiles = requestedStyles
    .map((value) => normalizeConstraintComparableString('style', value))
    .map((style) => resolveSemanticStyleEvidenceProfile(style))
    .filter((profile): profile is NonNullable<typeof profile> => profile !== undefined);

  if (semanticProfiles.length === 0) {
    return undefined;
  }

  if (constraint.operator !== '=' && constraint.operator !== 'in') {
    return undefined;
  }

  return semanticProfiles.some((profile) => candidateMatchesSemanticStyleProfile(candidate, profile));
}

function satisfiesRecipientProfileConstraint(
  candidate: HybridCandidate,
  constraint: NormalizedConstraint,
): boolean | undefined {
  if (constraint.attribute !== 'recipient_profile') {
    return undefined;
  }
  if (constraint.operator !== '=' && constraint.operator !== 'in') {
    return undefined;
  }

  const requestedProfiles =
    typeof constraint.value === 'string'
      ? [constraint.value]
      : Array.isArray(constraint.value)
        ? constraint.value.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
  if (requestedProfiles.length === 0) {
    return undefined;
  }

  return requestedProfiles.some((profile) => candidateMatchesRecipientProfile(candidate, profile) === true);
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
    case 'closure':
      return candidate.closure;
    case 'vintage':
    case 'vintage_year':
      return candidate.vintageYear;
    case 'critic_score':
    case 'critic_score_normalized':
      return candidate.criticScoreNormalized;
    case 'producer_prestige':
      return candidate.producerPrestige;
    case 'popularity_score':
      return candidate.popularityScore;
    case 'price':
    case 'price_usd':
      return candidate.priceUsd;
    case 'max_price_krw':
    case 'min_price_krw':
      return candidate.priceUsd === undefined ? undefined : convertConstraintUsdToApproxKrw(candidate.priceUsd);
    case 'drinking_window':
      return candidate.drinkingWindowStart !== undefined && candidate.drinkingWindowEnd !== undefined
        ? candidate.drinkingWindowStart
        : undefined;
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
    case 'grape_family':
      return candidate.grapeFamily;
    case 'flavor_profile':
      // flavor_profiles is a string array fetched from Vespa (flavor_profiles field).
      // Constraint matching uses 'in' semantics: the candidate satisfies the constraint
      // if ANY of its flavor profiles matches the constraint value.
      return candidate.flavorProfiles;
    case 'gift_suitability':
      return candidate.giftSuitabilityScore;
    case 'beginner_suitability':
      return candidate.beginnerSuitabilityScore;
    case 'fruit_intensity':
      // fruit_intensity has no backing field in HybridCandidate or Vespa schema.
      // Return undefined so the caller (annotateCandidateConstraintEvidence) can detect
      // "no backing field" and treat this soft constraint as not-evaluable rather than
      // unmet — preventing the ranker from penalising every result via totalWeight growth
      // without a matching weightedSum contribution.
      return undefined;
    default: {
      throw new Error(
        `Unknown constraint attribute "${attribute}" in candidate-constraint-evidence; add an explicit resolver mapping before using it at runtime.`,
      );
    }
  }
}

function evaluateOperator(
  attribute: string,
  operator: ConstraintOperator,
  attrValue: Exclude<CandidateValue, undefined>,
  constraintValue: NormalizedConstraint['value'],
): boolean {
  switch (operator) {
    case '=': {
      if (typeof attrValue === 'string' && typeof constraintValue === 'string') {
        return normalizeConstraintComparableString(attribute, attrValue)
          === normalizeConstraintComparableString(attribute, constraintValue);
      }
      // Array attribute (e.g. flavorProfiles, certifications, pairing, occasion):
      // '=' means "the array contains this value" — mirrors 'in' single-value semantics.
      if (Array.isArray(attrValue) && typeof constraintValue === 'string') {
        const attrValueSet = new Set(
          normalizeConstraintComparableArray(
            attribute,
            attrValue.filter((v): v is string => typeof v === 'string'),
          ),
        );
        return attrValueSet.has(normalizeConstraintComparableString(attribute, constraintValue));
      }
      return attrValue === constraintValue;
    }

    case '<=':
      // CLAUDE.md schema quality: Number.isFinite() rejects NaN and Infinity.
      // typeof NaN === 'number' passes the type guard but NaN <= x is always false,
      // silently treating NaN attribute values as failing the constraint.
      return Number.isFinite(attrValue) &&
        Number.isFinite(constraintValue) &&
        (attrValue as number) <= (constraintValue as number);

    case '>=':
      return Number.isFinite(attrValue) &&
        Number.isFinite(constraintValue) &&
        (attrValue as number) >= (constraintValue as number);

    case 'range': {
      if (
        !Number.isFinite(attrValue) ||
        typeof constraintValue !== 'object' ||
        Array.isArray(constraintValue) ||
        !('min' in constraintValue) ||
        !('max' in constraintValue) ||
        !Number.isFinite(constraintValue.min) ||
        !Number.isFinite(constraintValue.max)
      ) {
        return false;
      }
      return (attrValue as number) >= constraintValue.min && (attrValue as number) <= constraintValue.max;
    }

    case 'in': {
      if (Array.isArray(attrValue)) {
        const attrValueSet = new Set(normalizeConstraintComparableArray(
          attribute,
          attrValue.filter((value): value is string => typeof value === 'string'),
        ));
        if (Array.isArray(constraintValue)) {
          return normalizeConstraintComparableArray(
            attribute,
            constraintValue.filter((value): value is string => typeof value === 'string'),
          ).some((value) => attrValueSet.has(value));
        }
        return typeof constraintValue === 'string' &&
          attrValueSet.has(normalizeConstraintComparableString(attribute, constraintValue));
      }
      if (Array.isArray(constraintValue)) {
        if (typeof attrValue !== 'string') {
          return false;
        }
        const constraintSet = new Set(normalizeConstraintComparableArray(
          attribute,
          constraintValue.filter((value): value is string => typeof value === 'string'),
        ));
        return constraintSet.has(normalizeConstraintComparableString(attribute, attrValue));
      }
      if (typeof attrValue === 'string' && typeof constraintValue === 'string') {
        return normalizeConstraintComparableString(attribute, attrValue)
          === normalizeConstraintComparableString(attribute, constraintValue);
      }
      return attrValue === constraintValue;
    }

    case 'exclude': {
      // Build the set of values to exclude — handles both scalar and array constraintValue.
      const excludeVals = Array.isArray(constraintValue)
        ? normalizeConstraintComparableArray(
            attribute,
            constraintValue.filter((v): v is string => typeof v === 'string'),
          )
        : typeof constraintValue === 'string'
          ? [normalizeConstraintComparableString(attribute, constraintValue)]
          : [];
      const excludeSet = new Set(excludeVals);

      if (Array.isArray(attrValue)) {
        // attrValue is a list (e.g. certifications) — all elements must not be excluded.
        return normalizeConstraintComparableArray(
          attribute,
          attrValue.filter((v): v is string => typeof v === 'string'),
        ).every((v) => !excludeSet.has(v));
      }
      if (typeof attrValue === 'string') {
        return !excludeSet.has(normalizeConstraintComparableString(attribute, attrValue));
      }
      // Non-string, non-array — equality check (number case).
      return attrValue !== constraintValue;
    }

    case 'not_in': {
      // Exclude if the attribute value matches ANY of the listed values.
      // Use Set for O(1) lookup instead of Array.includes O(n).
      const excludeSet = new Set(
        Array.isArray(constraintValue)
          ? normalizeConstraintComparableArray(
              attribute,
              constraintValue.filter((v): v is string => typeof v === 'string'),
            )
          : typeof constraintValue === 'string'
            ? [normalizeConstraintComparableString(attribute, constraintValue)]
            : [],
      );
      if (Array.isArray(attrValue)) {
        return normalizeConstraintComparableArray(
          attribute,
          attrValue.filter((v): v is string => typeof v === 'string'),
        ).every((v) => !excludeSet.has(v));
      }
      if (typeof attrValue === 'string') {
        return !excludeSet.has(normalizeConstraintComparableString(attribute, attrValue));
      }
      return true;
    }

    default: {
      // Exhaustiveness check: if a new operator is added, TypeScript will error here.
      operator satisfies never;
      return false;
    }
  }
}

function satisfiesConstraint(
  candidate: HybridCandidate,
  constraint: NormalizedConstraint,
): boolean {
  const semanticStyleMatch = satisfiesSemanticStyleConstraint(candidate, constraint);
  if (semanticStyleMatch !== undefined) {
    return semanticStyleMatch;
  }

  const recipientProfileMatch = satisfiesRecipientProfileConstraint(candidate, constraint);
  if (recipientProfileMatch !== undefined) {
    return recipientProfileMatch;
  }

  // grape_primary uses OR semantics at retrieval time (grape_or filter covers both
  // grape_primary AND grapes fields). Annotation must mirror Vespa's retrieval logic:
  // a candidate satisfies grape_primary = X if X appears in EITHER grapePrimary OR grapes[].
  // Without this, blend wines where the requested variety appears only in grapes[]
  // are false-negatives: retrieval finds them but annotation marks them unmet.
  if (constraint.attribute === 'grape_primary') {
    const { operator, value } = constraint;
    const primaryGrape = candidate.grapePrimary;
    const grapesArray = candidate.grapes ?? [];
    const allGrapes = [
      ...(primaryGrape !== undefined ? [primaryGrape] : []),
      ...grapesArray,
    ];
    if (allGrapes.length === 0) return false;
    // Delegate to evaluateOperator with the full grape list so array 'in' / exclude semantics work.
    return evaluateOperator(constraint.attribute, operator, allGrapes, value);
  }

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

  if (constraint.attribute === 'closure' && typeof attrValue === 'string') {
    const { operator, value } = constraint;
    const vals = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : typeof value === 'string'
        ? [value]
        : [];
    if (operator === '=') {
      return vals.length === 1 && closureMatches(attrValue, vals[0]!);
    }
    if (operator === 'in') {
      return vals.some((v) => closureMatches(attrValue, v));
    }
    if (operator === 'exclude' || operator === 'not_in') {
      return vals.every((v) => !closureMatches(attrValue, v));
    }
  }

  // Geography attributes (country, region, appellation) use Vespa `contains`
  // (substring) at retrieval time. Annotation must mirror this: "Bordeaux AOC"
  // satisfies constraint value "Bordeaux" for positive operators.
  // Negative operators (exclude, not_in) retain exact semantics — broad
  // exclusions must never pass a superset string.
  if (GEOGRAPHY_ATTRIBUTES.has(constraint.attribute) && typeof attrValue === 'string') {
    const { operator, value } = constraint;
    if (operator === '=') {
      return typeof value === 'string' && geographyContains(attrValue, value);
    }
    if (operator === 'in') {
      const vals = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : typeof value === 'string'
          ? [value]
          : [];
      return vals.some((v) => geographyContains(attrValue, v));
    }
    if (operator === 'exclude' || operator === 'not_in') {
      // Both exclude and not_in mean "attrValue must NOT match any listed value".
      // Use geographyExcludesAll for both to keep negative semantics consistent:
      // excludes means "not a substring of attrValue" for geography.
      const vals = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : typeof value === 'string'
          ? [value]
          : [];
      return geographyExcludesAll(attrValue, vals);
    }
  }

  return evaluateOperator(
    constraint.attribute,
    constraint.operator,
    attrValue,
    constraint.value,
  );
}

function isConstraintStyleWithoutBackedSemanticProfile(constraint: NormalizedConstraint): boolean {
  if (constraint.attribute !== 'style') {
    return false;
  }
  if (constraint.operator !== '=' && constraint.operator !== 'in') {
    return false;
  }

  const requestedStyles = typeof constraint.value === 'string'
    ? [constraint.value]
    : Array.isArray(constraint.value)
      ? constraint.value.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
  if (requestedStyles.length === 0) {
    return false;
  }

  const hasBackedProfile = requestedStyles.some((value) => {
    const normalized = normalizeConstraintComparableString('style', value);
    return isNoOpSemanticStyleHint(normalized)
      ? false
      : resolveSemanticStyleEvidenceProfile(normalized) !== undefined;
  });

  return !hasBackedProfile;
}

export function annotateCandidateConstraintEvidence(
  candidate: HybridCandidate,
  constraints: ConstraintBundle,
  graph?: ConstraintGraph  ,
): HybridCandidate {
  const matched = new Set(candidate.matchedConstraints);
  const unmetHardSet = new Set<string>();

  for (const constraint of constraints.hard) {
    if (satisfiesConstraint(candidate, constraint)) {
      matched.add(constraint.attribute);
    } else {
      unmetHardSet.add(constraint.attribute);
    }
  }

  for (const constraint of constraints.soft) {
    if (satisfiesConstraint(candidate, constraint)) {
      matched.add(constraint.attribute);
    } else if (constraint.attribute === 'recipient_profile') {
      // Recipient profiles are backed by derived candidate evidence above.
      // A non-match must remain a real soft miss, not a missing-field exemption.
    } else if (isConstraintStyleWithoutBackedSemanticProfile(constraint)) {
      // Unsupported style preferences (예: presentation_forward) are not backed by
      // measurable catalog evidence. Treat as "not evaluable" instead of strict
      // mismatch to avoid soft-constraint denominator pollution.
      matched.add(constraint.attribute);
    } else if (resolveCandidateValue(candidate, constraint.attribute) === undefined) {
      // Soft constraint has no backing field on this candidate (e.g. fruit_intensity
      // is not projected from Vespa). Treat as "not evaluable" rather than "unmet" so
      // the ranker's computeSoftConstraint does not penalise every result by counting
      // this attribute in totalWeight but never in weightedSum.
      // Hard constraints intentionally do NOT get this exemption — unknown hard attrs
      // are already caught by the default case in resolveCandidateValue and surfaced as
      // unmetHardConstraints so engineers see the misconfiguration immediately.
      matched.add(constraint.attribute);
    }
  }

  for (const constraint of constraints.inferred) {
    if (satisfiesConstraint(candidate, constraint)) {
      matched.add(constraint.attribute);
    }
  }

  // ADR-014 Phase 1b.3b: when a ConstraintGraph is present, emit
  // `matchedAtomRefs` / `unmetAtomRefs` keyed to `SlotNode.nodeId`. These
  // are NOT deduplicated — two slot nodes with the same attribute but
  // distinct nodeIds each emit their own record, so downstream consumers
  // can distinguish "matched via slot A vs slot B" under XOR.
  let matchedAtomRefs: string[] | undefined;
  let unmetAtomRefs: string[] | undefined;
  if (graph !== undefined) {
    matchedAtomRefs = [];
    unmetAtomRefs = [];
    for (const node of graph.nodes) {
      if (node.kind !== 'slot') continue;
      if (matched.has(node.attribute)) {
        matchedAtomRefs.push(node.nodeId);
      } else {
        unmetAtomRefs.push(node.nodeId);
      }
    }
  }

  return {
    ...candidate,
    matchedConstraints: [...matched],
    ...(unmetHardSet.size > 0
      ? { unmetHardConstraints: [...unmetHardSet] }
      : {}),
    ...(matchedAtomRefs !== undefined ? { matchedAtomRefs } : {}),
    ...(unmetAtomRefs !== undefined ? { unmetAtomRefs } : {}),
  };
}

export function annotateCandidateConstraintEvidenceBatch(
  candidates: readonly HybridCandidate[],
  constraints: ConstraintBundle,
  graph?: ConstraintGraph  ,
): readonly HybridCandidate[] {
  if (
    constraints.hard.length === 0 &&
    constraints.soft.length === 0 &&
    constraints.inferred.length === 0 &&
    graph === undefined
  ) {
    return candidates;
  }
  return candidates.map((candidate) =>
    annotateCandidateConstraintEvidence(candidate, constraints, graph));
}
