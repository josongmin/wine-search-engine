import type { DrinkingWindowDeterministicInputV2 } from '../../domain/drinking-window/model/drinking-window-deterministic-input-v2.js';
import type {
  DrinkingWindowDeterministicFormulaPort,
  DrinkingWindowDeterministicFormulaResult,
  DrinkingWindowDeterministicTermBreakdown,
  DrinkingWindowDeterministicTermContribution,
} from '../../domain/drinking-window/port/drinking-window-deterministic-formula.port.js';

export const STRUCTURAL_DRINKING_WINDOW_FORMULA_VERSION = 'structural-slot-v2';

type ConfidenceLevel = DrinkingWindowDeterministicFormulaResult['confidence'];

const VARIETAL_LONGEVITY_PRIORS = new Map<string, number>([
  ['nebbiolo', 0.92],
  ['cabernet sauvignon', 0.86],
  ['riesling', 0.82],
  ['syrah', 0.76],
  ['shiraz', 0.76],
  ['chenin blanc', 0.74],
  ['sangiovese', 0.72],
  ['petit verdot', 0.72],
  ['tempranillo', 0.70],
  ['cabernet franc', 0.68],
  ['mourvedre', 0.68],
  ['monastrell', 0.68],
  ['mataro', 0.68],
  ['semillon', 0.66],
  ['pinot noir', 0.58],
  ['chardonnay', 0.56],
  ['merlot', 0.56],
  ['malbec', 0.56],
  ['carignan', 0.52],
  ['zinfandel', 0.48],
  ['primitivo', 0.48],
  ['grenache', 0.42],
  ['garnacha', 0.42],
  ['gamay', 0.34],
  ['sauvignon blanc', 0.30],
  ['glera', 0.18],
  ['prosecco', 0.18],
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function norm(value: number | undefined, low: number, high: number, fallback: number): number {
  return clamp((((value ?? fallback) - low) / (high - low)), 0, 1);
}

function lognorm(value: number | undefined, maxValue: number): number {
  if (value === undefined || value <= 0) return 0;
  return clamp(Math.log1p(value) / Math.log1p(maxValue), 0, 1);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function parseBottleSizeMl(input: DrinkingWindowDeterministicInputV2): number | undefined {
  if (input.bottleSizeMl !== undefined && Number.isFinite(input.bottleSizeMl) && input.bottleSizeMl > 0) {
    return input.bottleSizeMl;
  }

  const raw = input.bottleSize?.trim().toLowerCase();
  if (!raw) return undefined;
  const normalized = raw.replace(/\s+/g, '');
  if (normalized === 'magnum') return 1500;

  const mlMatch = normalized.match(/^(\d+(?:\.\d+)?)ml$/);
  if (mlMatch) {
    const parsed = Number.parseFloat(mlMatch[1] ?? '');
    return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
  }

  const literMatch = normalized.match(/^(\d+(?:\.\d+)?)l$/);
  if (literMatch) {
    const parsed = Number.parseFloat(literMatch[1] ?? '');
    return Number.isFinite(parsed) ? Math.round(parsed * 1000) : undefined;
  }

  return undefined;
}

function extractPrimaryVarietal(input: DrinkingWindowDeterministicInputV2): string | undefined {
  if (input.grapePrimary !== undefined && input.grapePrimary.trim().length > 0) {
    return normalizeName(input.grapePrimary);
  }
  const firstGrape = input.grapes?.[0];
  if (firstGrape !== undefined && firstGrape.trim().length > 0) {
    return normalizeName(firstGrape);
  }
  return undefined;
}

function extractVarietalSet(input: DrinkingWindowDeterministicInputV2): ReadonlySet<string> {
  const values = new Set<string>();
  if (input.grapePrimary !== undefined && input.grapePrimary.trim().length > 0) {
    values.add(normalizeName(input.grapePrimary));
  }
  for (const grape of input.grapes ?? []) {
    if (grape.trim().length > 0) {
      values.add(normalizeName(grape));
    }
  }
  return values;
}

function hasAny(values: ReadonlySet<string>, ...candidates: readonly string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}

function varietalLongevityPrior(primaryVarietal: string | undefined): number {
  if (primaryVarietal === undefined) return 0.5;
  return VARIETAL_LONGEVITY_PRIORS.get(primaryVarietal) ?? 0.5;
}

function blendAdjustment(primaryVarietal: string | undefined, varietals: ReadonlySet<string>): number {
  if (hasAny(varietals, 'cabernet sauvignon') && (hasAny(varietals, 'merlot') || hasAny(varietals, 'cabernet franc'))) {
    return 0.08;
  }
  if (
    (hasAny(varietals, 'grenache', 'garnacha')) &&
    (hasAny(varietals, 'syrah', 'shiraz')) &&
    (hasAny(varietals, 'mourvedre', 'monastrell', 'mataro'))
  ) {
    return 0.03;
  }
  if ((varietals.size > 1 || primaryVarietal === 'nebbiolo') && hasAny(varietals, 'nebbiolo')) {
    return 0.04;
  }
  if (varietals.size > 1 && primaryVarietal !== undefined && primaryVarietal.startsWith('pinot')) {
    return -0.02;
  }
  if (primaryVarietal !== undefined && (primaryVarietal === 'glera' || primaryVarietal === 'prosecco')) {
    return -0.08;
  }
  return 0;
}

function consensusStability(distribution: DrinkingWindowDeterministicInputV2['ratingDistribution']): number {
  if (distribution === undefined) return 0.55;
  const n1 = distribution['1'] ?? 0;
  const n2 = distribution['2'] ?? 0;
  const n3 = distribution['3'] ?? 0;
  const n4 = distribution['4'] ?? 0;
  const n5 = distribution['5'] ?? 0;
  const total = Math.max(1, n1 + n2 + n3 + n4 + n5);
  return clamp(0.5 + 0.5 * (((n4 + n5) - (n1 + n2)) / total), 0, 1);
}

function bottleSizeFactor(sizeMl: number | undefined): number {
  if (sizeMl === undefined) return 1;
  if (sizeMl >= 3000) return 1.3;
  if (sizeMl >= 1500) return 1.18;
  if (sizeMl >= 750) return 1;
  if (sizeMl >= 375) return 0.86;
  return 0.78;
}

function closureAdjustment(closure: string | undefined): number {
  if (closure === undefined || closure.trim().length === 0) return 0;
  const normalized = normalizeName(closure);
  if (normalized.includes('screw')) return 0.01;
  if (normalized.includes('synthetic')) return -0.02;
  return 0;
}

function completenessScore(input: DrinkingWindowDeterministicInputV2, primaryVarietal: string | undefined, sizeMl: number | undefined): number {
  const completenessAxes = [
    input.ratingAvg !== undefined ? 1 : 0,
    input.priceUsd !== undefined ? 1 : 0,
    input.producer !== undefined && input.producer.trim().length > 0 ? 1 : 0,
    input.ratingsCount !== undefined || input.reviewCount !== undefined ? 1 : 0,
    input.wineryRatingCount !== undefined ? 1 : 0,
    input.ratingDistribution !== undefined ? 1 : 0,
    sizeMl !== undefined ? 1 : 0,
    input.closure !== undefined && input.closure.trim().length > 0 ? 1 : 0,
    primaryVarietal !== undefined ? 1 : 0,
  ];
  return completenessAxes.reduce((sum, value) => sum + value, 0) / completenessAxes.length;
}

function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.75) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

function contribution(value: number, rationale: string): DrinkingWindowDeterministicTermContribution {
  return { value, rationale };
}

export class StructuralDrinkingWindowFormula implements DrinkingWindowDeterministicFormulaPort {
  readonly formulaVersion = STRUCTURAL_DRINKING_WINDOW_FORMULA_VERSION;

  evaluate(input: DrinkingWindowDeterministicInputV2): DrinkingWindowDeterministicFormulaResult {
    const primaryVarietal = extractPrimaryVarietal(input);
    const varietals = extractVarietalSet(input);
    const sizeMl = parseBottleSizeMl(input);

    const engagement = Math.max(input.ratingsCount ?? 0, input.reviewCount ?? 0, 0);
    const C = lognorm(engagement, 20_000);
    const W = lognorm(input.wineryRatingCount, 50_000);
    const R = norm(input.ratingAvg, 3.2, 4.8, 4.0);
    const P = lognorm(input.priceUsd, 400);
    const D = consensusStability(input.ratingDistribution);

    const varietalAnchor = varietalLongevityPrior(primaryVarietal);
    const blendCorrection = blendAdjustment(primaryVarietal, varietals);
    const varietalAdjusted = clamp(varietalAnchor + blendCorrection, 0, 1);

    const marketQuality = 0.62 * R + 0.2 * C + 0.18 * D;
    const producerSignal = clamp(
      0.75 * W +
      0.25 * (input.producer !== undefined && input.producer.trim().length > 0 ? 1 : 0),
      0,
      1,
    );
    const sizeFactor = bottleSizeFactor(sizeMl);
    const closureSignal = closureAdjustment(input.closure);

    const longevityRaw = 0.52 * varietalAdjusted + 0.18 * marketQuality + 0.12 * producerSignal + 0.06 * P + closureSignal;
    const longevity = clamp(longevityRaw * sizeFactor, 0, 1.15);
    const readiness = clamp(
      0.58 * (1 - varietalAdjusted) +
      0.2 * R +
      0.14 * D +
      0.08 * (1 - (sizeFactor / 1.3)),
      0,
      1,
    );

    const drinkFromOffset = Math.round(clamp(1 + 11 * longevity - 4 * readiness, 0, 18));
    const peakCenterOffset = Math.round(clamp(drinkFromOffset + 2 + 9 * longevity, 1, 32));
    const peakWidth = Math.round(clamp(2 + 5 * varietalAdjusted + 2 * C, 2, 14));
    const tailOffset = Math.round(clamp(1 + 5 * longevity, 1, 8));

    let peakStartOffset = Math.max(drinkFromOffset, peakCenterOffset - Math.round(peakWidth / 2));
    let peakEndOffset = peakCenterOffset + Math.round(peakWidth / 2);
    let bestUntilOffset = peakEndOffset + tailOffset;

    if (primaryVarietal !== undefined && ['glera', 'prosecco', 'sauvignon blanc', 'gamay'].includes(primaryVarietal)) {
      bestUntilOffset = Math.min(bestUntilOffset, 8);
    }
    if (primaryVarietal !== undefined && ['nebbiolo', 'cabernet sauvignon', 'riesling'].includes(primaryVarietal)) {
      bestUntilOffset = Math.max(bestUntilOffset, 12);
    }

    peakStartOffset = Math.max(peakStartOffset, drinkFromOffset);
    peakEndOffset = Math.max(peakEndOffset, peakStartOffset + 1);
    bestUntilOffset = Math.max(bestUntilOffset, peakEndOffset + 1);

    const complete = completenessScore(input, primaryVarietal, sizeMl);
    const hasDistribution = input.ratingDistribution !== undefined ? 1 : 0;
    const dataConfidence = clamp(0.4 * complete + 0.4 * C + 0.2 * hasDistribution, 0, 1);
    const modelConfidence = clamp(
      0.6 * (primaryVarietal !== undefined ? 1 : 0) +
      0.2 * 1 +
      0.2 * (input.priceUsd !== undefined ? 1 : 0),
      0,
      1,
    );
    const confidenceScore = clamp(0.55 * dataConfidence + 0.45 * modelConfidence, 0, 1);

    const breakdown: DrinkingWindowDeterministicTermBreakdown = {
      varietalAnchor: contribution(
        varietalAnchor,
        'primary varietal longevity prior is the dominant cellarability anchor',
      ),
      blendAdjustment: contribution(
        blendCorrection,
        'explicit blend-class correction for Bordeaux/GSM/Nebbiolo/Pinot/Glera patterns',
      ),
      marketQuality: contribution(
        marketQuality,
        'rating quality mixes mean rating, engagement depth, and rating-distribution stability',
      ),
      producerStrength: contribution(
        producerSignal,
        'producer signal combines winery rating-count scale and producer identity presence',
      ),
      priceSignal: contribution(
        P,
        'price acts only as a weak cellarability proxy',
      ),
      bottleSizeFactor: contribution(
        sizeFactor,
        'bottle size scales maturation speed relative to the 750ml baseline',
      ),
      closureAdjustment: contribution(
        closureSignal,
        'closure adds a small additive correction only',
      ),
      longevity: contribution(
        longevity,
        'final longevity score after size scaling',
      ),
      readiness: contribution(
        readiness,
        'readiness score pulls accessible wines earlier even when longevity remains moderate',
      ),
      confidence: contribution(
        confidenceScore,
        'confidence blends data completeness/engagement with model-side anchor availability',
      ),
      offsets: {
        drinkFromYears: drinkFromOffset,
        peakStartYears: peakStartOffset,
        peakCenterYears: peakCenterOffset,
        peakEndYears: peakEndOffset,
        bestUntilYears: bestUntilOffset,
      },
    };

    return {
      startOffsetYears: drinkFromOffset,
      endOffsetYears: bestUntilOffset,
      peakOffsetYears: peakCenterOffset,
      peakStartOffsetYears: peakStartOffset,
      peakEndOffsetYears: peakEndOffset,
      longevityScore: longevity,
      readinessScore: readiness,
      confidenceScore,
      confidence: confidenceLevel(confidenceScore),
      termBreakdown: breakdown,
    };
  }
}
