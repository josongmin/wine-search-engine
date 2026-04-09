import type { ConstraintBundle, NormalizedConstraint } from '../../../src/domain/shared/types/index.js';
import type { ExpectedConstraint, ExpectedEntity } from './scenario.js';

export interface SemanticConstraintRecallScore {
  readonly hard: number | null;
  readonly soft: number | null;
  readonly inferred: number | null;
  readonly overall: number | null;
}

export interface EntityLinkingAccuracyScore {
  readonly precision: number | null;
  readonly recall: number | null;
  readonly elaAt1: number | null;
}

export interface ExtractedEntityMention {
  readonly surface: string;
  readonly canonical: string;
  readonly type: ExpectedEntity['type'];
}

const SCR_WEIGHT_HARD = 0.6;
const SCR_WEIGHT_SOFT = 0.2;
const SCR_WEIGHT_INFERRED = 0.2;

export function scoreSemanticConstraintRecall(
  extracted: ConstraintBundle,
  expected?: {
    readonly hard?: readonly ExpectedConstraint[];
    readonly soft?: readonly ExpectedConstraint[];
    readonly inferred?: readonly ExpectedConstraint[];
  },
): SemanticConstraintRecallScore {
  if (expected === undefined) {
    return { hard: null, soft: null, inferred: null, overall: null };
  }

  const hard = scoreConstraintBucket(extracted.hard, expected.hard);
  const soft = scoreConstraintBucket(extracted.soft, expected.soft);
  const inferred = scoreConstraintBucket(extracted.inferred, expected.inferred);

  const weighted = [
    hard !== null ? hard * SCR_WEIGHT_HARD : null,
    soft !== null ? soft * SCR_WEIGHT_SOFT : null,
    inferred !== null ? inferred * SCR_WEIGHT_INFERRED : null,
  ].filter((entry): entry is number => entry !== null);
  const activeWeights =
    (hard !== null ? SCR_WEIGHT_HARD : 0)
    + (soft !== null ? SCR_WEIGHT_SOFT : 0)
    + (inferred !== null ? SCR_WEIGHT_INFERRED : 0);

  return {
    hard,
    soft,
    inferred,
    overall: activeWeights > 0 ? weighted.reduce((sum, value) => sum + value, 0) / activeWeights : null,
  };
}

export function scoreEntityLinkingAccuracy(
  extracted: readonly ExtractedEntityMention[],
  expected?: readonly ExpectedEntity[],
): EntityLinkingAccuracyScore {
  if (expected === undefined || expected.length === 0) {
    return { precision: null, recall: null, elaAt1: null };
  }

  let correct = 0;
  for (const entity of expected) {
    if (extracted.some((candidate) => entityMentionsMatch(candidate, entity))) {
      correct++;
    }
  }

  return {
    precision: extracted.length > 0 ? correct / extracted.length : 0,
    recall: correct / expected.length,
    elaAt1: correct / expected.length,
  };
}

function scoreConstraintBucket(
  extracted: readonly NormalizedConstraint[],
  expected?: readonly ExpectedConstraint[],
): number | null {
  if (expected === undefined) {
    return null;
  }
  if (expected.length === 0) {
    return 1;
  }
  let hitCount = 0;
  for (const expectedConstraint of expected) {
    if (extracted.some((constraint) => constraintsMatch(constraint, expectedConstraint))) {
      hitCount++;
    }
  }
  return hitCount / expected.length;
}

function constraintsMatch(
  extracted: NormalizedConstraint,
  expected: ExpectedConstraint,
): boolean {
  if (normalizeText(extracted.attribute) !== normalizeText(expected.attribute)) {
    return false;
  }
  if (extracted.operator !== expected.operator) {
    return false;
  }
  return valuesMatch(extracted.value, expected.value);
}

function valuesMatch(
  extracted: NormalizedConstraint['value'],
  expected: ExpectedConstraint['value'],
): boolean {
  if (typeof extracted === 'string' && typeof expected === 'string') {
    return normalizeText(extracted) === normalizeText(expected);
  }
  if (typeof extracted === 'number' && typeof expected === 'number') {
    return extracted === expected;
  }
  if (Array.isArray(extracted) && Array.isArray(expected)) {
    const extractedSet = new Set(extracted.map((entry) => normalizeScalar(entry)));
    return expected.every((entry) => extractedSet.has(normalizeScalar(entry)));
  }
  if (
    typeof extracted === 'object'
    && extracted !== null
    && !Array.isArray(extracted)
    && typeof expected === 'object'
    && expected !== null
    && !Array.isArray(expected)
  ) {
    const extractedMin = typeof extracted.min === 'number' ? extracted.min : -Infinity;
    const extractedMax = typeof extracted.max === 'number' ? extracted.max : Infinity;
    const expectedMin = typeof expected.min === 'number' ? expected.min : -Infinity;
    const expectedMax = typeof expected.max === 'number' ? expected.max : Infinity;
    return extractedMin <= expectedMax && expectedMin <= extractedMax;
  }
  return false;
}

function entityMentionsMatch(
  extracted: ExtractedEntityMention,
  expected: ExpectedEntity,
): boolean {
  return normalizeText(extracted.surface) === normalizeText(expected.surface)
    && normalizeText(extracted.canonical) === normalizeText(expected.canonical)
    && extracted.type === expected.type;
}

function normalizeScalar(value: string | number): string {
  return typeof value === 'number' ? value.toString() : normalizeText(value);
}

function normalizeText(value: string): string {
  return value.toLowerCase().normalize('NFKC').trim();
}
