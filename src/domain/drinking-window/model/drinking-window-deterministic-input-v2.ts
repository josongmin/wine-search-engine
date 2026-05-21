import { z } from 'zod';
import {
  DETERMINISTIC_DRINKING_WINDOW_MIN_VINTAGE_YEAR,
  MAX_PRODUCED_VINTAGE_YEAR,
} from '../../shared/constants.js';
import type { DrinkingWindowInput } from '../port/drinking-window-predictor.port.js';

/**
 * Deterministic drinking-window vintage bounds.
 *
 * Sourced from `@domain/shared/constants` to satisfy Rule 30 (no duplicated
 * cross-module constants) and to ensure the structural formula stays aligned
 * with the wider ingestion bounds whenever the calibration window shifts.
 */
const DETERMINISTIC_MIN_VINTAGE_YEAR = DETERMINISTIC_DRINKING_WINDOW_MIN_VINTAGE_YEAR;
const DETERMINISTIC_MAX_VINTAGE_YEAR = MAX_PRODUCED_VINTAGE_YEAR;

/** Sensory ordinal scale upper bound (1–5 ordinal, schema allows 0 for "absent"). */
const SENSORY_ORDINAL_MAX = 5;

/** Critic proxy score upper bound (0–100 scale, e.g. 100-point Parker/WS). */
const CRITIC_PROXY_SCORE_MAX = 100;

/** Alcohol-by-volume ceiling. 25% covers high-proof fortified wines (Port, sherry). */
const ALCOHOL_PCT_MAX = 25;

/**
 * Engagement count ceiling for ratings/reviews/winery-rating counts.
 * 10M is far above Vivino's largest single-wine review count and safely
 * rejects corrupted multi-billion values without truncating real data.
 */
const ENGAGEMENT_COUNT_MAX = 10_000_000;

/**
 * Price-in-USD ceiling. 1M USD permits ultra-rare investment bottlings
 * (e.g. 1945 Romanée-Conti hammer prices exceed $500K) while still
 * catching obvious unit / decimal errors.
 */
const PRICE_USD_MAX = 1_000_000;

/**
 * Bottle volume ceiling in ml. 30L covers the largest commercial format
 * (Melchizedek). Volumes above this are almost certainly bad ETL data.
 */
const BOTTLE_SIZE_ML_MAX = 30_000;

/**
 * Canonical wine-type enum already used across search/query layers.
 * Keep the deterministic schema aligned with the rest of the repo.
 */
export const DRINKING_WINDOW_DETERMINISTIC_WINE_TYPES = [
  'red',
  'white',
  'rosé',
  'sparkling',
  'natural',
  'dessert',
  'fortified',
  'orange',
] as const;
const DRINKING_WINDOW_DETERMINISTIC_WINE_TYPE_SET = new Set<string>(
  DRINKING_WINDOW_DETERMINISTIC_WINE_TYPES,
);

/**
 * Producer archetypes currently present or expected in retrieval/catalog data.
 * These remain open-world at runtime, but the enum documents the main buckets
 * a deterministic formula can treat as structured priors.
 */
export const DRINKING_WINDOW_DETERMINISTIC_PRODUCER_TYPES = [
  'chateau',
  'domaine',
  'estate',
  'winery',
  'negociant',
  'cooperative',
  'grower',
] as const;
const DRINKING_WINDOW_DETERMINISTIC_PRODUCER_TYPE_SET = new Set<string>(
  DRINKING_WINDOW_DETERMINISTIC_PRODUCER_TYPES,
);

/**
 * Confidence of upstream feature provenance. This is NOT the final drinking
 * window confidence — it indicates how trustworthy the inputs are.
 */
export const DRINKING_WINDOW_SOURCE_CONFIDENCE_LEVELS = [
  'high',
  'medium',
  'low',
] as const;

export type DrinkingWindowDeterministicValueKind =
  | 'number'
  | 'integer'
  | 'string'
  | 'string_array'
  | 'object'
  | 'enum'
  | 'boolean';

export interface DrinkingWindowDeterministicFieldSpec {
  readonly kind: DrinkingWindowDeterministicValueKind;
  readonly required: boolean;
  readonly description: string;
  readonly range?: readonly [number, number] | undefined;
  readonly unit?: string | undefined;
  readonly enumValues?: readonly string[] | undefined;
  readonly examples?: readonly string[] | undefined;
  readonly sourceCandidates: readonly string[];
}

export interface DrinkingWindowRatingDistribution {
  readonly '1'?: number | undefined;
  readonly '2'?: number | undefined;
  readonly '3'?: number | undefined;
  readonly '4'?: number | undefined;
  readonly '5'?: number | undefined;
}

/**
 * Wide deterministic input schema for future structural drinking-window math.
 *
 * Goal:
 * - accept as much catalog / retrieval / ETL context as we already have
 * - let the deterministic formula ignore fields today without changing the seam
 * - keep types explicit so a future formula can be implemented deterministically
 *   without another schema migration
 */
export interface DrinkingWindowDeterministicInputV2 {
  /** Production year of the wine. Integer calendar year. */
  readonly vintage: number;
  /** Primary grape encoded id used by current learned model. Integer, OOV allowed. */
  readonly grapePrimaryEnc?: number | undefined;
  /** Region encoded id used by current learned model. Integer, OOV allowed. */
  readonly regionEnc?: number | undefined;
  /** Country encoded id used by current learned model. Integer, OOV allowed. */
  readonly countryEnc?: number | undefined;

  /** Canonical primary grape label. Open string because ontology expands over time. */
  readonly grapePrimary?: string | undefined;
  /** Canonical producer / winery / domaine label. */
  readonly producer?: string | undefined;
  /** Full grape list when the wine is a blend or multi-varietal bottling. */
  readonly grapes?: readonly string[] | undefined;
  /** Canonical country label. */
  readonly country?: string | undefined;
  /** Canonical region label. */
  readonly region?: string | undefined;
  /** Finer-grained appellation / AVA / DOCG / village label. */
  readonly appellation?: string | undefined;
  /** Region lineage from coarse to fine, e.g. ["France", "Bordeaux", "Pauillac"]. */
  readonly regionHierarchy?: readonly string[] | undefined;
  /** Broad taxonomy bucket, e.g. "pinot_family", "cabernet_family". */
  readonly grapeFamily?: string | undefined;

  /** Catalog wine type. Closed enum in repo search layers. */
  readonly wineType?: (typeof DRINKING_WINDOW_DETERMINISTIC_WINE_TYPES)[number] | undefined;
  /** Free-form style descriptor; open string because style vocabulary is not closed. */
  readonly style?: string | undefined;
  /** Official classification string such as DOCG / Grand Cru / 1er Cru. */
  readonly classification?: string | undefined;
  /** Oak regime / élevage note. Open string. */
  readonly oakTreatment?: string | undefined;
  /** Producer archetype bucket. */
  readonly producerType?: (typeof DRINKING_WINDOW_DETERMINISTIC_PRODUCER_TYPES)[number] | undefined;
  /** Certifications such as organic / biodynamic / sustainable / natural. */
  readonly certifications?: readonly string[] | undefined;
  /** Soil descriptor when available, e.g. limestone / schist / gravel. */
  readonly soilType?: string | undefined;

  /** Body on 1–5 ordinal scale. */
  readonly body?: number | undefined;
  /** Tannin on 1–5 ordinal scale. */
  readonly tannin?: number | undefined;
  /** Acidity on 1–5 ordinal scale. */
  readonly acidity?: number | undefined;
  /** Sweetness on 1–5 ordinal scale. */
  readonly sweetness?: number | undefined;
  /** Finish length normalized score, typically [0,1]. */
  readonly finishLength?: number | undefined;
  /** Alcohol by volume percentage, e.g. 13.5. */
  readonly alcoholPct?: number | undefined;

  /** Critic proxy score on 0–100 scale. */
  readonly avgCriticProxyScore?: number | undefined;
  /** Wine-level average rating on the source's 1–5 scale. */
  readonly ratingAvg?: number | undefined;
  /** Count backing the wine-level rating average. */
  readonly ratingsCount?: number | undefined;
  /** Count of text reviews for this wine. */
  readonly reviewCount?: number | undefined;
  /** Histogram of wine-level 1–5 ratings when the upstream source exposes it. */
  readonly ratingDistribution?: DrinkingWindowRatingDistribution | undefined;
  /** Normalized critic score on [0,1]. */
  readonly criticScoreNormalized?: number | undefined;
  /** Producer prestige on [0,1]. */
  readonly producerPrestige?: number | undefined;
  /** Count backing the producer / winery prestige signal. */
  readonly wineryRatingCount?: number | undefined;
  /** Optional price in USD as a luxury / cellarability prior. */
  readonly priceUsd?: number | undefined;
  /** Bottle volume in ml. */
  readonly bottleSizeMl?: number | undefined;
  /** Bottle size label from source payload, e.g. "750ml", "1.5L". */
  readonly bottleSize?: string | undefined;
  /** Closure label from the source payload, e.g. "Cork", "Screw Cap". */
  readonly closure?: string | undefined;

  /** Upstream cached start year, if already computed elsewhere. */
  readonly priorDrinkingWindowStart?: number | undefined;
  /** Upstream cached end year, if already computed elsewhere. */
  readonly priorDrinkingWindowEnd?: number | undefined;
  /** Upstream model version that produced prior window fields. */
  readonly priorDrinkingWindowModelVersion?: string | undefined;

  /** Whether sensory / catalog fields are believed complete for this record. */
  readonly hasCompleteStructureSignals?: boolean | undefined;
  /** Confidence of the input provenance itself. */
  readonly sourceConfidence?: (typeof DRINKING_WINDOW_SOURCE_CONFIDENCE_LEVELS)[number] | undefined;
}

export const DrinkingWindowDeterministicInputV2Schema = z.object({
  vintage: z.number().int().min(DETERMINISTIC_MIN_VINTAGE_YEAR).max(DETERMINISTIC_MAX_VINTAGE_YEAR),
  grapePrimaryEnc: z.number().int().optional(),
  regionEnc: z.number().int().optional(),
  countryEnc: z.number().int().optional(),
  grapePrimary: z.string().trim().min(1).optional(),
  producer: z.string().trim().min(1).optional(),
  grapes: z.array(z.string().trim().min(1)).min(1).optional(),
  country: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  appellation: z.string().trim().min(1).optional(),
  regionHierarchy: z.array(z.string().trim().min(1)).min(1).optional(),
  grapeFamily: z.string().trim().min(1).optional(),
  wineType: z.enum(DRINKING_WINDOW_DETERMINISTIC_WINE_TYPES).optional(),
  style: z.string().trim().min(1).optional(),
  classification: z.string().trim().min(1).optional(),
  oakTreatment: z.string().trim().min(1).optional(),
  producerType: z.enum(DRINKING_WINDOW_DETERMINISTIC_PRODUCER_TYPES).optional(),
  certifications: z.array(z.string().trim().min(1)).min(1).optional(),
  soilType: z.string().trim().min(1).optional(),
  body: z.number().min(0).max(SENSORY_ORDINAL_MAX).optional(),
  tannin: z.number().min(0).max(SENSORY_ORDINAL_MAX).optional(),
  acidity: z.number().min(0).max(SENSORY_ORDINAL_MAX).optional(),
  sweetness: z.number().min(0).max(SENSORY_ORDINAL_MAX).optional(),
  finishLength: z.number().min(0).max(1).optional(),
  alcoholPct: z.number().min(0).max(ALCOHOL_PCT_MAX).optional(),
  avgCriticProxyScore: z.number().min(0).max(CRITIC_PROXY_SCORE_MAX).optional(),
  ratingAvg: z.number().min(0).max(SENSORY_ORDINAL_MAX).optional(),
  ratingsCount: z.number().int().min(0).optional(),
  reviewCount: z.number().int().min(0).optional(),
  ratingDistribution: z.object({
    '1': z.number().int().min(0).optional(),
    '2': z.number().int().min(0).optional(),
    '3': z.number().int().min(0).optional(),
    '4': z.number().int().min(0).optional(),
    '5': z.number().int().min(0).optional(),
  }).strict().optional(),
  criticScoreNormalized: z.number().min(0).max(1).optional(),
  producerPrestige: z.number().min(0).max(1).optional(),
  wineryRatingCount: z.number().int().min(0).optional(),
  priceUsd: z.number().min(0).max(PRICE_USD_MAX).optional(),
  bottleSizeMl: z.number().int().min(0).max(BOTTLE_SIZE_ML_MAX).optional(),
  bottleSize: z.string().trim().min(1).optional(),
  closure: z.string().trim().min(1).optional(),
  priorDrinkingWindowStart: z.number().int().min(DETERMINISTIC_MIN_VINTAGE_YEAR).max(DETERMINISTIC_MAX_VINTAGE_YEAR).optional(),
  priorDrinkingWindowEnd: z.number().int().min(DETERMINISTIC_MIN_VINTAGE_YEAR).max(DETERMINISTIC_MAX_VINTAGE_YEAR).optional(),
  priorDrinkingWindowModelVersion: z.string().trim().min(1).optional(),
  hasCompleteStructureSignals: z.boolean().optional(),
  sourceConfidence: z.enum(DRINKING_WINDOW_SOURCE_CONFIDENCE_LEVELS).optional(),
}).superRefine((value, ctx) => {
  if (
    value.priorDrinkingWindowStart !== undefined &&
    value.priorDrinkingWindowEnd !== undefined &&
    value.priorDrinkingWindowStart > value.priorDrinkingWindowEnd
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['priorDrinkingWindowEnd'],
      message: 'priorDrinkingWindowEnd must be >= priorDrinkingWindowStart',
    });
  }
});

export const DRINKING_WINDOW_DETERMINISTIC_FIELD_SPECS: Readonly<
  Record<keyof DrinkingWindowDeterministicInputV2, DrinkingWindowDeterministicFieldSpec>
> = {
  vintage: {
    kind: 'integer',
    required: true,
    description: 'Production year used as the absolute calendar anchor for all offsets.',
    range: [DETERMINISTIC_MIN_VINTAGE_YEAR, DETERMINISTIC_MAX_VINTAGE_YEAR],
    unit: 'year',
    examples: ['2018', '2020'],
    sourceCandidates: ['catalog.vintageYear', 'entity.vintage', 'retrieval.vintageYear'],
  },
  grapePrimaryEnc: {
    kind: 'integer',
    required: false,
    description: 'Encoded primary-grape id used by the current learned predictor and future prior tables.',
    examples: ['42', '999'],
    sourceCandidates: ['retrieval.grapePrimaryEnc', 'ml.encoder.grape'],
  },
  regionEnc: {
    kind: 'integer',
    required: false,
    description: 'Encoded region id used by the current learned predictor and future prior tables.',
    examples: ['10', '999'],
    sourceCandidates: ['retrieval.regionEnc', 'ml.encoder.region'],
  },
  countryEnc: {
    kind: 'integer',
    required: false,
    description: 'Encoded country id used by the current learned predictor and future prior tables.',
    examples: ['1', '999'],
    sourceCandidates: ['retrieval.countryEnc', 'ml.encoder.country'],
  },
  grapePrimary: {
    kind: 'string',
    required: false,
    description: 'Canonical grape label for deterministic grape-family priors.',
    examples: ['Nebbiolo', 'Cabernet Sauvignon'],
    sourceCandidates: ['retrieval.grapePrimary', 'entity.grapes[0]'],
  },
  producer: {
    kind: 'string',
    required: false,
    description: 'Canonical producer / winery / domaine label.',
    examples: ['Giacomo Conterno', 'Chateau Margaux'],
    sourceCandidates: ['retrieval.producer', 'catalog.producer', 'vivino.producer'],
  },
  grapes: {
    kind: 'string_array',
    required: false,
    description: 'Full varietal list for blend-aware structural priors.',
    examples: ['["Cabernet Sauvignon","Merlot","Cabernet Franc"]'],
    sourceCandidates: ['catalog.grapes', 'retrieval.grapes', 'vivino.payload.varietal'],
  },
  country: {
    kind: 'string',
    required: false,
    description: 'Country label for broad aging priors.',
    examples: ['France', 'Italy'],
    sourceCandidates: ['retrieval.country', 'entity.country'],
  },
  region: {
    kind: 'string',
    required: false,
    description: 'Region label for sub-country aging priors.',
    examples: ['Bordeaux', 'Piedmont'],
    sourceCandidates: ['retrieval.region', 'entity.region'],
  },
  appellation: {
    kind: 'string',
    required: false,
    description: 'Fine-grained appellation / AVA / DOCG label.',
    examples: ['Pauillac', 'Barolo DOCG'],
    sourceCandidates: ['retrieval.appellation', 'entity.appellation'],
  },
  regionHierarchy: {
    kind: 'string_array',
    required: false,
    description: 'Ordered geographic lineage from coarse to fine.',
    examples: ['["France","Bordeaux","Pauillac"]'],
    sourceCandidates: ['retrieval.regionHierarchy', 'ontology.regionHierarchy'],
  },
  grapeFamily: {
    kind: 'string',
    required: false,
    description: 'Broad taxonomy family for shared longevity priors.',
    examples: ['pinot_family', 'cabernet_family'],
    sourceCandidates: ['retrieval.grapeFamily', 'ontology.grapeFamily'],
  },
  wineType: {
    kind: 'enum',
    required: false,
    description: 'Closed catalog wine-type enum already used by query/search layers.',
    enumValues: DRINKING_WINDOW_DETERMINISTIC_WINE_TYPES,
    sourceCandidates: ['retrieval.wineType', 'entity.wineType'],
  },
  style: {
    kind: 'string',
    required: false,
    description: 'Open style descriptor string.',
    examples: ['bold red', 'crisp white', 'oxidative'],
    sourceCandidates: ['retrieval.style', 'entity.style'],
  },
  classification: {
    kind: 'string',
    required: false,
    description: 'Official quality / legal classification label.',
    examples: ['Grand Cru', 'DOCG', 'Premier Grand Cru Classe'],
    sourceCandidates: ['retrieval.classification', 'entity.classification'],
  },
  oakTreatment: {
    kind: 'string',
    required: false,
    description: 'Oak regime / élevage note.',
    examples: ['new French oak 18 months', 'unoaked stainless'],
    sourceCandidates: ['retrieval.oakTreatment', 'catalog.oakTreatment'],
  },
  producerType: {
    kind: 'enum',
    required: false,
    description: 'Producer archetype bucket.',
    enumValues: DRINKING_WINDOW_DETERMINISTIC_PRODUCER_TYPES,
    sourceCandidates: ['retrieval.producerType', 'catalog.producerType'],
  },
  certifications: {
    kind: 'string_array',
    required: false,
    description: 'Certification labels as open string array.',
    examples: ['["organic","biodynamic"]'],
    sourceCandidates: ['retrieval.certifications', 'catalog.certifications'],
  },
  soilType: {
    kind: 'string',
    required: false,
    description: 'Soil descriptor when available.',
    examples: ['limestone', 'gravel', 'schist'],
    sourceCandidates: ['catalog.soilType'],
  },
  body: {
    kind: 'number',
    required: false,
    description: 'Body intensity on 1–5 ordinal scale.',
    range: [0, SENSORY_ORDINAL_MAX],
    sourceCandidates: ['predictor.body', 'retrieval.body', 'sensory.body'],
  },
  tannin: {
    kind: 'number',
    required: false,
    description: 'Tannin structure on 1–5 ordinal scale.',
    range: [0, SENSORY_ORDINAL_MAX],
    sourceCandidates: ['predictor.tannin', 'retrieval.tannin', 'sensory.tannin'],
  },
  acidity: {
    kind: 'number',
    required: false,
    description: 'Acidity on 1–5 ordinal scale.',
    range: [0, SENSORY_ORDINAL_MAX],
    sourceCandidates: ['predictor.acidity', 'retrieval.acidity', 'sensory.acidity'],
  },
  sweetness: {
    kind: 'number',
    required: false,
    description: 'Sweetness on 1–5 ordinal scale.',
    range: [0, SENSORY_ORDINAL_MAX],
    sourceCandidates: ['predictor.sweetness', 'retrieval.sweetness', 'sensory.sweetness'],
  },
  finishLength: {
    kind: 'number',
    required: false,
    description: 'Finish length normalized to [0,1].',
    range: [0, 1],
    sourceCandidates: ['retrieval.finishLength', 'catalog.finishLength'],
  },
  alcoholPct: {
    kind: 'number',
    required: false,
    description: 'Alcohol percentage by volume.',
    range: [0, ALCOHOL_PCT_MAX],
    unit: '% abv',
    sourceCandidates: ['retrieval.alcoholPct', 'entity.alcoholPct'],
  },
  avgCriticProxyScore: {
    kind: 'number',
    required: false,
    description: 'Critic proxy score on 0–100 scale.',
    range: [0, CRITIC_PROXY_SCORE_MAX],
    sourceCandidates: ['predictor.avgCriticProxyScore', 'catalog.criticProxyScore'],
  },
  ratingAvg: {
    kind: 'number',
    required: false,
    description: 'Wine-level average rating on the source 1–5 scale.',
    range: [0, SENSORY_ORDINAL_MAX],
    sourceCandidates: ['vivino.ratingAvg', 'vivino.payload.rating'],
  },
  ratingsCount: {
    kind: 'integer',
    required: false,
    description: 'Wine-level rating count backing the average score.',
    range: [0, ENGAGEMENT_COUNT_MAX],
    sourceCandidates: ['vivino.ratingsCount', 'vivino.payload.rating_count'],
  },
  reviewCount: {
    kind: 'integer',
    required: false,
    description: 'Wine-level text review count.',
    range: [0, ENGAGEMENT_COUNT_MAX],
    sourceCandidates: ['vivino.payload.review_count'],
  },
  ratingDistribution: {
    kind: 'object',
    required: false,
    description: 'Histogram of 1–5 ratings for stability / consensus-aware scoring.',
    examples: ['{"1":9,"2":22,"3":105,"4":387,"5":912}'],
    sourceCandidates: ['vivino.payload.rating_distribution'],
  },
  criticScoreNormalized: {
    kind: 'number',
    required: false,
    description: 'Normalized critic score on [0,1].',
    range: [0, 1],
    sourceCandidates: ['retrieval.criticScoreNormalized', 'entity.criticScore'],
  },
  producerPrestige: {
    kind: 'number',
    required: false,
    description: 'Producer prestige prior on [0,1].',
    range: [0, 1],
    sourceCandidates: ['retrieval.producerPrestige', 'entity.producerPrestige'],
  },
  wineryRatingCount: {
    kind: 'integer',
    required: false,
    description: 'Count backing the winery-level prestige signal.',
    range: [0, ENGAGEMENT_COUNT_MAX],
    sourceCandidates: ['vivino.payload.winery_rating_count'],
  },
  priceUsd: {
    kind: 'number',
    required: false,
    description: 'Price in USD; optional luxury / cellarability prior only.',
    range: [0, PRICE_USD_MAX],
    unit: 'USD',
    sourceCandidates: ['retrieval.priceUsd', 'catalog.priceUsd'],
  },
  bottleSizeMl: {
    kind: 'integer',
    required: false,
    description: 'Bottle volume in milliliters; controls maturation time scaling.',
    range: [0, BOTTLE_SIZE_ML_MAX],
    unit: 'ml',
    examples: ['375', '750', '1500'],
    sourceCandidates: ['vivino.payload.bottle_ml', 'vivino.payload.bottle_size'],
  },
  bottleSize: {
    kind: 'string',
    required: false,
    description: 'Bottle size label as scraped from the upstream source.',
    examples: ['750ml', '1.5L', 'Magnum'],
    sourceCandidates: ['vivino.payload.bottle_size'],
  },
  closure: {
    kind: 'string',
    required: false,
    description: 'Free-form closure label from the upstream source.',
    examples: ['Cork', 'Screw Cap'],
    sourceCandidates: ['vivino.payload.closure'],
  },
  priorDrinkingWindowStart: {
    kind: 'integer',
    required: false,
    description: 'Existing cached drinking-window start year from another source.',
    range: [DETERMINISTIC_MIN_VINTAGE_YEAR, DETERMINISTIC_MAX_VINTAGE_YEAR],
    unit: 'year',
    sourceCandidates: ['retrieval.drinkingWindowStart', 'entity.drinkingWindowStart'],
  },
  priorDrinkingWindowEnd: {
    kind: 'integer',
    required: false,
    description: 'Existing cached drinking-window end year from another source.',
    range: [DETERMINISTIC_MIN_VINTAGE_YEAR, DETERMINISTIC_MAX_VINTAGE_YEAR],
    unit: 'year',
    sourceCandidates: ['retrieval.drinkingWindowEnd', 'entity.drinkingWindowEnd'],
  },
  priorDrinkingWindowModelVersion: {
    kind: 'string',
    required: false,
    description: 'Model version that produced cached drinking-window years.',
    examples: ['onnx:v2.1', 'deterministic:structural-slot-v2'],
    sourceCandidates: ['retrieval.drinkingWindowModelVersion', 'entity.drinkingWindowModelVersion'],
  },
  hasCompleteStructureSignals: {
    kind: 'boolean',
    required: false,
    description: 'Whether structural sensory fields are considered complete enough for deterministic math.',
    sourceCandidates: ['derived.missingnessGate'],
  },
  sourceConfidence: {
    kind: 'enum',
    required: false,
    description: 'Confidence in the upstream feature provenance itself.',
    enumValues: DRINKING_WINDOW_SOURCE_CONFIDENCE_LEVELS,
    sourceCandidates: ['derived.sourceConfidence'],
  },
};

/**
 * Legacy predictor input adapter.
 *
 * This keeps the deterministic seam backward-compatible with the current
 * narrow predictor port while allowing future callers to provide a much wider
 * typed input without changing the deterministic formula contract.
 */
export function toDrinkingWindowDeterministicInputV2(
  input: DrinkingWindowInput,
): DrinkingWindowDeterministicInputV2 {
  const normalizedWineType: DrinkingWindowDeterministicInputV2['wineType'] =
    input.wineType !== undefined && DRINKING_WINDOW_DETERMINISTIC_WINE_TYPE_SET.has(input.wineType)
      ? input.wineType as DrinkingWindowDeterministicInputV2['wineType']
      : undefined;
  const normalizedProducerType: DrinkingWindowDeterministicInputV2['producerType'] =
    input.producerType !== undefined && DRINKING_WINDOW_DETERMINISTIC_PRODUCER_TYPE_SET.has(input.producerType)
      ? input.producerType as DrinkingWindowDeterministicInputV2['producerType']
      : undefined;
  return {
    vintage: input.vintage,
    grapePrimaryEnc: input.grapePrimaryEnc,
    regionEnc: input.regionEnc,
    countryEnc: input.countryEnc,
    body: input.body,
    tannin: input.tannin,
    acidity: input.acidity,
    sweetness: input.sweetness,
    avgCriticProxyScore: input.avgCriticProxyScore,
    ...(input.priorDrinkingWindowStart !== undefined
      ? { priorDrinkingWindowStart: input.priorDrinkingWindowStart }
      : {}),
    ...(input.priorDrinkingWindowEnd !== undefined
      ? { priorDrinkingWindowEnd: input.priorDrinkingWindowEnd }
      : {}),
    ...(input.priorDrinkingWindowModelVersion !== undefined
      ? { priorDrinkingWindowModelVersion: input.priorDrinkingWindowModelVersion }
      : {}),
    ...(input.grapePrimary !== undefined ? { grapePrimary: input.grapePrimary } : {}),
    ...(input.grapes !== undefined ? { grapes: input.grapes } : {}),
    ...(input.grapeFamily !== undefined ? { grapeFamily: input.grapeFamily } : {}),
    ...(input.producer !== undefined ? { producer: input.producer } : {}),
    ...(input.country !== undefined ? { country: input.country } : {}),
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(input.appellation !== undefined ? { appellation: input.appellation } : {}),
    ...(input.regionHierarchy !== undefined ? { regionHierarchy: input.regionHierarchy } : {}),
    ...(normalizedWineType !== undefined ? { wineType: normalizedWineType } : {}),
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.classification !== undefined ? { classification: input.classification } : {}),
    ...(input.oakTreatment !== undefined ? { oakTreatment: input.oakTreatment } : {}),
    ...(input.producerPrestige !== undefined ? { producerPrestige: input.producerPrestige } : {}),
    ...(input.ratingAvg !== undefined ? { ratingAvg: input.ratingAvg } : {}),
    ...(input.ratingsCount !== undefined ? { ratingsCount: input.ratingsCount } : {}),
    ...(input.reviewCount !== undefined ? { reviewCount: input.reviewCount } : {}),
    ...(input.ratingDistribution !== undefined
      ? { ratingDistribution: input.ratingDistribution }
      : {}),
    ...(input.wineryRatingCount !== undefined
      ? { wineryRatingCount: input.wineryRatingCount }
      : {}),
    ...(input.priceUsd !== undefined ? { priceUsd: input.priceUsd } : {}),
    ...(input.bottleSizeMl !== undefined ? { bottleSizeMl: input.bottleSizeMl } : {}),
    ...(input.bottleSize !== undefined ? { bottleSize: input.bottleSize } : {}),
    ...(input.closure !== undefined ? { closure: input.closure } : {}),
    ...(input.certifications !== undefined ? { certifications: input.certifications } : {}),
    ...(normalizedProducerType !== undefined ? { producerType: normalizedProducerType } : {}),
    ...(input.soilType !== undefined ? { soilType: input.soilType } : {}),
    ...(input.finishLength !== undefined ? { finishLength: input.finishLength } : {}),
    ...(input.alcoholPct !== undefined ? { alcoholPct: input.alcoholPct } : {}),
  };
}
