import type { DrinkingWindowDeterministicInputV2 } from '../../domain/drinking-window/model/drinking-window-deterministic-input-v2.js';
import type {
  DrinkingWindowDeterministicFormulaPort,
  DrinkingWindowDeterministicFormulaResult,
  DrinkingWindowDeterministicTermBreakdown,
  DrinkingWindowDeterministicTermContribution,
} from '../../domain/drinking-window/port/drinking-window-deterministic-formula.port.js';

export const STRUCTURAL_DRINKING_WINDOW_FORMULA_VERSION = 'structural-slot-v2';

type ConfidenceLevel = DrinkingWindowDeterministicFormulaResult['confidence'];

// ---------------------------------------------------------------------------
// Varietal longevity priors
//
// Each value sits on a normalized [0,1] cellarability axis. The numbers are
// the calibration anchors derived from professional cellaring guidance and
// auction-market survival distributions. They are NOT learned weights — they
// are the structural priors a deterministic formula must encode by hand.
// ---------------------------------------------------------------------------

const LONGEVITY_PRIOR_NEBBIOLO = 0.92;
const LONGEVITY_PRIOR_CABERNET_SAUVIGNON = 0.86;
const LONGEVITY_PRIOR_RIESLING = 0.82;
const LONGEVITY_PRIOR_SYRAH = 0.76;
const LONGEVITY_PRIOR_CHENIN_BLANC = 0.74;
const LONGEVITY_PRIOR_SANGIOVESE = 0.72;
const LONGEVITY_PRIOR_PETIT_VERDOT = 0.72;
const LONGEVITY_PRIOR_TEMPRANILLO = 0.70;
const LONGEVITY_PRIOR_CABERNET_FRANC = 0.68;
const LONGEVITY_PRIOR_MOURVEDRE = 0.68;
const LONGEVITY_PRIOR_SEMILLON = 0.66;
const LONGEVITY_PRIOR_PINOT_NOIR = 0.58;
const LONGEVITY_PRIOR_CHARDONNAY = 0.56;
const LONGEVITY_PRIOR_MERLOT = 0.56;
const LONGEVITY_PRIOR_MALBEC = 0.56;
const LONGEVITY_PRIOR_CARIGNAN = 0.52;
const LONGEVITY_PRIOR_ZINFANDEL = 0.48;
const LONGEVITY_PRIOR_GRENACHE = 0.42;
const LONGEVITY_PRIOR_GAMAY = 0.34;
const LONGEVITY_PRIOR_SAUVIGNON_BLANC = 0.30;
const LONGEVITY_PRIOR_GLERA = 0.18;

const VARIETAL_LONGEVITY_PRIORS = new Map<string, number>([
  ['nebbiolo', LONGEVITY_PRIOR_NEBBIOLO],
  ['cabernet sauvignon', LONGEVITY_PRIOR_CABERNET_SAUVIGNON],
  ['riesling', LONGEVITY_PRIOR_RIESLING],
  ['syrah', LONGEVITY_PRIOR_SYRAH],
  ['shiraz', LONGEVITY_PRIOR_SYRAH],
  ['chenin blanc', LONGEVITY_PRIOR_CHENIN_BLANC],
  ['sangiovese', LONGEVITY_PRIOR_SANGIOVESE],
  ['petit verdot', LONGEVITY_PRIOR_PETIT_VERDOT],
  ['tempranillo', LONGEVITY_PRIOR_TEMPRANILLO],
  ['cabernet franc', LONGEVITY_PRIOR_CABERNET_FRANC],
  ['mourvedre', LONGEVITY_PRIOR_MOURVEDRE],
  ['monastrell', LONGEVITY_PRIOR_MOURVEDRE],
  ['mataro', LONGEVITY_PRIOR_MOURVEDRE],
  ['semillon', LONGEVITY_PRIOR_SEMILLON],
  ['pinot noir', LONGEVITY_PRIOR_PINOT_NOIR],
  ['chardonnay', LONGEVITY_PRIOR_CHARDONNAY],
  ['merlot', LONGEVITY_PRIOR_MERLOT],
  ['malbec', LONGEVITY_PRIOR_MALBEC],
  ['carignan', LONGEVITY_PRIOR_CARIGNAN],
  ['zinfandel', LONGEVITY_PRIOR_ZINFANDEL],
  ['primitivo', LONGEVITY_PRIOR_ZINFANDEL],
  ['grenache', LONGEVITY_PRIOR_GRENACHE],
  ['garnacha', LONGEVITY_PRIOR_GRENACHE],
  ['gamay', LONGEVITY_PRIOR_GAMAY],
  ['sauvignon blanc', LONGEVITY_PRIOR_SAUVIGNON_BLANC],
  ['glera', LONGEVITY_PRIOR_GLERA],
  ['prosecco', LONGEVITY_PRIOR_GLERA],
]);

// ---------------------------------------------------------------------------
// Neutral defaults + bottle-size parsing constants
// ---------------------------------------------------------------------------

/** Neutral midpoint on [0,1] used whenever a prior cannot be derived. */
const NEUTRAL_LONGEVITY_PRIOR = 0.5;

/** Magnum bottle volume in ml — used when the source label says "magnum". */
const MAGNUM_BOTTLE_SIZE_ML = 1500;

/** Conversion factor from liters to ml for `<N>L` labels (e.g. "1.5L"). */
const ML_PER_LITER = 1000;

// ---------------------------------------------------------------------------
// Blend-class corrections applied on top of the primary varietal prior.
// Positive values: blend extends cellaring potential; negative: shortens it.
// ---------------------------------------------------------------------------

/** Bordeaux blend (Cabernet + Merlot/Cab Franc) reinforces structural longevity. */
const BLEND_BORDEAUX_BOOST = 0.08;
/** Classic GSM blend (Grenache + Syrah + Mourvèdre) — mild longevity boost. */
const BLEND_GSM_BOOST = 0.03;
/** Nebbiolo-dominant blends — tannic backbone outlasts pure varietal expression. */
const BLEND_NEBBIOLO_BOOST = 0.04;
/** Pinot-dominant blends — pulled slightly earlier (Pinot oxidizes faster in blends). */
const BLEND_PINOT_PENALTY = -0.02;
/** Sparkling-aromatic primary (Glera/Prosecco) — strong freshness-first penalty. */
const BLEND_SPARKLING_AROMATIC_PENALTY = -0.08;

// ---------------------------------------------------------------------------
// Rating-distribution consensus stability
// ---------------------------------------------------------------------------

/** Neutral consensus when no rating distribution is available. */
const CONSENSUS_NEUTRAL_DEFAULT = 0.55;
/** Midpoint anchor of the consensus axis (0 = pure dislike, 1 = pure praise). */
const CONSENSUS_MIDPOINT = 0.5;
/** Scaling factor that maps the (4+5)-(1+2) skew into a ±0.5 offset around the midpoint. */
const CONSENSUS_SKEW_AMPLITUDE = 0.5;

// ---------------------------------------------------------------------------
// Bottle-size factor — how volume scales maturation speed vs. 750ml baseline.
// Larger bottles age more slowly (lower headspace-to-volume ratio).
// ---------------------------------------------------------------------------

const BOTTLE_SIZE_THRESHOLD_DOUBLE_MAGNUM_ML = 3000;
const BOTTLE_SIZE_THRESHOLD_MAGNUM_ML = 1500;
const BOTTLE_SIZE_THRESHOLD_STANDARD_ML = 750;
const BOTTLE_SIZE_THRESHOLD_HALF_ML = 375;

const BOTTLE_FACTOR_DOUBLE_MAGNUM_OR_LARGER = 1.3;
const BOTTLE_FACTOR_MAGNUM = 1.18;
const BOTTLE_FACTOR_STANDARD = 1;
const BOTTLE_FACTOR_HALF = 0.86;
const BOTTLE_FACTOR_QUARTER_OR_SMALLER = 0.78;

// ---------------------------------------------------------------------------
// Closure adjustment — tiny additive correction only.
// Screw caps preserve fruit slightly longer than cork in early life;
// synthetic closures leak oxygen and shorten the window.
// ---------------------------------------------------------------------------

const CLOSURE_SCREW_CAP_BOOST = 0.01;
const CLOSURE_SYNTHETIC_PENALTY = -0.02;

// ---------------------------------------------------------------------------
// Confidence thresholds for the categorical `confidence` label.
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD_HIGH = 0.75;
const CONFIDENCE_THRESHOLD_MEDIUM = 0.5;

// ---------------------------------------------------------------------------
// Lognorm engagement / price scales — pegged to realistic upper percentiles
// of the Vivino-style distribution. Lognorm saturates at these scales.
// ---------------------------------------------------------------------------

/** ~99th-percentile engagement (ratings or reviews) for a single wine. */
const ENGAGEMENT_LOGNORM_SCALE = 20_000;
/** ~99th-percentile winery-level rating count. */
const WINERY_RATING_LOGNORM_SCALE = 50_000;
/** ~99th-percentile bottle price in USD where log saturation is acceptable. */
const PRICE_USD_LOGNORM_SCALE = 400;

// ---------------------------------------------------------------------------
// Rating-average normalization bounds for the 1–5 source scale.
// `RATING_AVG_FALLBACK` is the "no data" anchor — slightly above the typical
// crowd mean so blank inputs don't drag scores down.
// ---------------------------------------------------------------------------

const RATING_AVG_LOWER = 3.2;
const RATING_AVG_UPPER = 4.8;
const RATING_AVG_FALLBACK = 4.0;

// ---------------------------------------------------------------------------
// Longevity composite weights — must sum to 1.0 across the principal terms.
// ---------------------------------------------------------------------------

/** Market quality = mean rating × MARKET_WEIGHT_RATING_AVG + engagement × … + dispersion × … */
const MARKET_WEIGHT_RATING_AVG = 0.62;
const MARKET_WEIGHT_ENGAGEMENT = 0.2;
const MARKET_WEIGHT_CONSENSUS = 0.18;

/** Producer signal = winery-rating-count saturation + producer identity presence. */
const PRODUCER_WEIGHT_WINERY_RATING = 0.75;
const PRODUCER_WEIGHT_IDENTITY = 0.25;

/** Longevity composite weights. */
const LONGEVITY_WEIGHT_VARIETAL = 0.52;
const LONGEVITY_WEIGHT_MARKET = 0.18;
const LONGEVITY_WEIGHT_PRODUCER = 0.12;
const LONGEVITY_WEIGHT_PRICE = 0.06;
/** Headroom above 1.0 for size-bonus blow-out on large formats. */
const LONGEVITY_CEILING_WITH_SIZE_BONUS = 1.15;

/** Readiness composite weights — pulls accessible wines earlier on calendar. */
const READINESS_WEIGHT_INV_VARIETAL = 0.58;
const READINESS_WEIGHT_RATING_AVG = 0.2;
const READINESS_WEIGHT_CONSENSUS = 0.14;
const READINESS_WEIGHT_INV_SIZE = 0.08;

// ---------------------------------------------------------------------------
// Year-offset coefficients — convert dimensionless longevity/readiness into
// integer year offsets from the vintage anchor.
// ---------------------------------------------------------------------------

const OFFSET_DRINK_FROM_BASE_YEARS = 1;
const OFFSET_DRINK_FROM_LONGEVITY_COEF = 11;
const OFFSET_DRINK_FROM_READINESS_COEF = 4;
const OFFSET_DRINK_FROM_MAX_YEARS = 18;

const OFFSET_PEAK_CENTER_LEAD_YEARS = 2;
const OFFSET_PEAK_CENTER_LONGEVITY_COEF = 9;
const OFFSET_PEAK_CENTER_MAX_YEARS = 32;

const OFFSET_PEAK_WIDTH_BASE_YEARS = 2;
const OFFSET_PEAK_WIDTH_VARIETAL_COEF = 5;
const OFFSET_PEAK_WIDTH_ENGAGEMENT_COEF = 2;
const OFFSET_PEAK_WIDTH_MIN_YEARS = 2;
const OFFSET_PEAK_WIDTH_MAX_YEARS = 14;

const OFFSET_TAIL_BASE_YEARS = 1;
const OFFSET_TAIL_LONGEVITY_COEF = 5;
const OFFSET_TAIL_MAX_YEARS = 8;

/** Hard ceiling for sparkling/aromatic primaries (e.g. Prosecco, SB, Gamay). */
const SHORT_LIVED_BEST_UNTIL_CEILING_YEARS = 8;
/** Hard floor for tannic/longevity primaries (e.g. Nebbiolo, Cab Sauv, Riesling). */
const LONG_LIVED_BEST_UNTIL_FLOOR_YEARS = 12;

// ---------------------------------------------------------------------------
// Confidence-composite weights (sum to 1.0 within each composite).
// ---------------------------------------------------------------------------

const DATA_CONFIDENCE_WEIGHT_COMPLETENESS = 0.4;
const DATA_CONFIDENCE_WEIGHT_ENGAGEMENT = 0.4;
const DATA_CONFIDENCE_WEIGHT_DISTRIBUTION = 0.2;

const MODEL_CONFIDENCE_WEIGHT_PRIMARY_VARIETAL = 0.6;
const MODEL_CONFIDENCE_WEIGHT_FORMULA_PRESENT = 0.2;
const MODEL_CONFIDENCE_WEIGHT_PRICE = 0.2;

const CONFIDENCE_BLEND_DATA = 0.55;
const CONFIDENCE_BLEND_MODEL = 0.45;

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
  if (normalized === 'magnum') return MAGNUM_BOTTLE_SIZE_ML;

  const mlMatch = normalized.match(/^(\d+(?:\.\d+)?)ml$/);
  if (mlMatch) {
    const parsed = Number.parseFloat(mlMatch[1] ?? '');
    return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
  }

  const literMatch = normalized.match(/^(\d+(?:\.\d+)?)l$/);
  if (literMatch) {
    const parsed = Number.parseFloat(literMatch[1] ?? '');
    return Number.isFinite(parsed) ? Math.round(parsed * ML_PER_LITER) : undefined;
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
  if (primaryVarietal === undefined) return NEUTRAL_LONGEVITY_PRIOR;
  return VARIETAL_LONGEVITY_PRIORS.get(primaryVarietal) ?? NEUTRAL_LONGEVITY_PRIOR;
}

function blendAdjustment(primaryVarietal: string | undefined, varietals: ReadonlySet<string>): number {
  if (hasAny(varietals, 'cabernet sauvignon') && (hasAny(varietals, 'merlot') || hasAny(varietals, 'cabernet franc'))) {
    return BLEND_BORDEAUX_BOOST;
  }
  if (
    (hasAny(varietals, 'grenache', 'garnacha')) &&
    (hasAny(varietals, 'syrah', 'shiraz')) &&
    (hasAny(varietals, 'mourvedre', 'monastrell', 'mataro'))
  ) {
    return BLEND_GSM_BOOST;
  }
  if ((varietals.size > 1 || primaryVarietal === 'nebbiolo') && hasAny(varietals, 'nebbiolo')) {
    return BLEND_NEBBIOLO_BOOST;
  }
  if (varietals.size > 1 && primaryVarietal !== undefined && primaryVarietal.startsWith('pinot')) {
    return BLEND_PINOT_PENALTY;
  }
  if (primaryVarietal !== undefined && (primaryVarietal === 'glera' || primaryVarietal === 'prosecco')) {
    return BLEND_SPARKLING_AROMATIC_PENALTY;
  }
  return 0;
}

function consensusStability(distribution: DrinkingWindowDeterministicInputV2['ratingDistribution']): number {
  if (distribution === undefined) return CONSENSUS_NEUTRAL_DEFAULT;
  const n1 = distribution['1'] ?? 0;
  const n2 = distribution['2'] ?? 0;
  const n3 = distribution['3'] ?? 0;
  const n4 = distribution['4'] ?? 0;
  const n5 = distribution['5'] ?? 0;
  const total = Math.max(1, n1 + n2 + n3 + n4 + n5);
  return clamp(
    CONSENSUS_MIDPOINT + CONSENSUS_SKEW_AMPLITUDE * (((n4 + n5) - (n1 + n2)) / total),
    0,
    1,
  );
}

function bottleSizeFactor(sizeMl: number | undefined): number {
  if (sizeMl === undefined) return BOTTLE_FACTOR_STANDARD;
  if (sizeMl >= BOTTLE_SIZE_THRESHOLD_DOUBLE_MAGNUM_ML) return BOTTLE_FACTOR_DOUBLE_MAGNUM_OR_LARGER;
  if (sizeMl >= BOTTLE_SIZE_THRESHOLD_MAGNUM_ML) return BOTTLE_FACTOR_MAGNUM;
  if (sizeMl >= BOTTLE_SIZE_THRESHOLD_STANDARD_ML) return BOTTLE_FACTOR_STANDARD;
  if (sizeMl >= BOTTLE_SIZE_THRESHOLD_HALF_ML) return BOTTLE_FACTOR_HALF;
  return BOTTLE_FACTOR_QUARTER_OR_SMALLER;
}

function closureAdjustment(closure: string | undefined): number {
  if (closure === undefined || closure.trim().length === 0) return 0;
  const normalized = normalizeName(closure);
  if (normalized.includes('screw')) return CLOSURE_SCREW_CAP_BOOST;
  if (normalized.includes('synthetic')) return CLOSURE_SYNTHETIC_PENALTY;
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
  if (score >= CONFIDENCE_THRESHOLD_HIGH) return 'high';
  if (score >= CONFIDENCE_THRESHOLD_MEDIUM) return 'medium';
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
    const C = lognorm(engagement, ENGAGEMENT_LOGNORM_SCALE);
    const W = lognorm(input.wineryRatingCount, WINERY_RATING_LOGNORM_SCALE);
    const R = norm(input.ratingAvg, RATING_AVG_LOWER, RATING_AVG_UPPER, RATING_AVG_FALLBACK);
    const P = lognorm(input.priceUsd, PRICE_USD_LOGNORM_SCALE);
    const D = consensusStability(input.ratingDistribution);

    const varietalAnchor = varietalLongevityPrior(primaryVarietal);
    const blendCorrection = blendAdjustment(primaryVarietal, varietals);
    const varietalAdjusted = clamp(varietalAnchor + blendCorrection, 0, 1);

    const marketQuality =
      MARKET_WEIGHT_RATING_AVG * R + MARKET_WEIGHT_ENGAGEMENT * C + MARKET_WEIGHT_CONSENSUS * D;
    const hasProducerIdentity = input.producer !== undefined && input.producer.trim().length > 0 ? 1 : 0;
    const producerSignal = clamp(
      PRODUCER_WEIGHT_WINERY_RATING * W + PRODUCER_WEIGHT_IDENTITY * hasProducerIdentity,
      0,
      1,
    );
    const sizeFactor = bottleSizeFactor(sizeMl);
    const closureSignal = closureAdjustment(input.closure);

    const longevityRaw =
      LONGEVITY_WEIGHT_VARIETAL * varietalAdjusted +
      LONGEVITY_WEIGHT_MARKET * marketQuality +
      LONGEVITY_WEIGHT_PRODUCER * producerSignal +
      LONGEVITY_WEIGHT_PRICE * P +
      closureSignal;
    const longevity = clamp(longevityRaw * sizeFactor, 0, LONGEVITY_CEILING_WITH_SIZE_BONUS);
    const readiness = clamp(
      READINESS_WEIGHT_INV_VARIETAL * (1 - varietalAdjusted) +
        READINESS_WEIGHT_RATING_AVG * R +
        READINESS_WEIGHT_CONSENSUS * D +
        READINESS_WEIGHT_INV_SIZE * (1 - (sizeFactor / BOTTLE_FACTOR_DOUBLE_MAGNUM_OR_LARGER)),
      0,
      1,
    );

    const drinkFromOffset = Math.round(
      clamp(
        OFFSET_DRINK_FROM_BASE_YEARS +
          OFFSET_DRINK_FROM_LONGEVITY_COEF * longevity -
          OFFSET_DRINK_FROM_READINESS_COEF * readiness,
        0,
        OFFSET_DRINK_FROM_MAX_YEARS,
      ),
    );
    const peakCenterOffset = Math.round(
      clamp(
        drinkFromOffset + OFFSET_PEAK_CENTER_LEAD_YEARS + OFFSET_PEAK_CENTER_LONGEVITY_COEF * longevity,
        1,
        OFFSET_PEAK_CENTER_MAX_YEARS,
      ),
    );
    const peakWidth = Math.round(
      clamp(
        OFFSET_PEAK_WIDTH_BASE_YEARS +
          OFFSET_PEAK_WIDTH_VARIETAL_COEF * varietalAdjusted +
          OFFSET_PEAK_WIDTH_ENGAGEMENT_COEF * C,
        OFFSET_PEAK_WIDTH_MIN_YEARS,
        OFFSET_PEAK_WIDTH_MAX_YEARS,
      ),
    );
    const tailOffset = Math.round(
      clamp(OFFSET_TAIL_BASE_YEARS + OFFSET_TAIL_LONGEVITY_COEF * longevity, 1, OFFSET_TAIL_MAX_YEARS),
    );

    const halfPeakWidth = Math.round(peakWidth / 2);
    let peakStartOffset = Math.max(drinkFromOffset, peakCenterOffset - halfPeakWidth);
    let peakEndOffset = peakCenterOffset + halfPeakWidth;
    let bestUntilOffset = peakEndOffset + tailOffset;

    if (primaryVarietal !== undefined && ['glera', 'prosecco', 'sauvignon blanc', 'gamay'].includes(primaryVarietal)) {
      bestUntilOffset = Math.min(bestUntilOffset, SHORT_LIVED_BEST_UNTIL_CEILING_YEARS);
    }
    if (primaryVarietal !== undefined && ['nebbiolo', 'cabernet sauvignon', 'riesling'].includes(primaryVarietal)) {
      bestUntilOffset = Math.max(bestUntilOffset, LONG_LIVED_BEST_UNTIL_FLOOR_YEARS);
    }

    peakStartOffset = Math.max(peakStartOffset, drinkFromOffset);
    peakEndOffset = Math.max(peakEndOffset, peakStartOffset + 1);
    bestUntilOffset = Math.max(bestUntilOffset, peakEndOffset + 1);

    const complete = completenessScore(input, primaryVarietal, sizeMl);
    const hasDistribution = input.ratingDistribution !== undefined ? 1 : 0;
    const dataConfidence = clamp(
      DATA_CONFIDENCE_WEIGHT_COMPLETENESS * complete +
        DATA_CONFIDENCE_WEIGHT_ENGAGEMENT * C +
        DATA_CONFIDENCE_WEIGHT_DISTRIBUTION * hasDistribution,
      0,
      1,
    );
    const hasPrimaryVarietal = primaryVarietal !== undefined ? 1 : 0;
    const hasPrice = input.priceUsd !== undefined ? 1 : 0;
    // FORMULA_PRESENT axis is always 1 here — this implementation IS the
    // deterministic formula. Kept as an explicit term so future variants
    // (e.g. fallback predictor) can reuse the same weighting scheme.
    const formulaPresent = 1;
    const modelConfidence = clamp(
      MODEL_CONFIDENCE_WEIGHT_PRIMARY_VARIETAL * hasPrimaryVarietal +
        MODEL_CONFIDENCE_WEIGHT_FORMULA_PRESENT * formulaPresent +
        MODEL_CONFIDENCE_WEIGHT_PRICE * hasPrice,
      0,
      1,
    );
    const confidenceScore = clamp(
      CONFIDENCE_BLEND_DATA * dataConfidence + CONFIDENCE_BLEND_MODEL * modelConfidence,
      0,
      1,
    );

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
