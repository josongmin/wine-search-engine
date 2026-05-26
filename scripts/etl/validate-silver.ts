#!/usr/bin/env tsx
/**
 * Silver Data Quality Gate: validates enriched Silver records before Vespa
 * indexing. Blocks the pipeline if quality thresholds are not met.
 *
 * Usage:
 *   npx tsx scripts/etl/validate-silver.ts
 *   npx tsx scripts/etl/validate-silver.ts --input data/silver-trackc.ndjson
 *   npx tsx scripts/etl/validate-silver.ts --allow-partial
 */

import fs from 'node:fs/promises';
import { z } from 'zod';
import type { EnrichedSilverRecord, SilverQualityReport } from './types.js';
import { parseNdjson } from './ndjson.js';
import { atomicWriteFile } from './etl-utils.js';
import {
  ETL_ARTIFACT_FILES,
  classifyTrackCArtifactPath,
} from './artifact-contract.js';

// ---------------------------------------------------------------------------
// Schema versioning + backward-compat policy
// ---------------------------------------------------------------------------

/**
 * Known SilverWineRecord schema versions, ordered oldest → newest.
 *
 * Backward-compat policy (etl.silver-validation maturity 4):
 *  - Records WITHOUT a `schema_version` field default to the oldest known
 *    version ('1') so existing NDJSON files (written before the field was
 *    added) keep parsing without ETL changes.
 *  - Records WITH an unknown `schema_version` fail closed — never silently
 *    accepted, since downstream indexing assumes a known field set.
 *  - When introducing version 'N', append it to this tuple and bump
 *    `CURRENT_SILVER_SCHEMA_VERSION`. Old records remain parseable; new
 *    fields land as `.optional()` until the migration window closes.
 */
export const SILVER_SCHEMA_VERSIONS = ['1'] as const;
export type SilverSchemaVersion = (typeof SILVER_SCHEMA_VERSIONS)[number];

/** The current write version emitted by vivino-to-silver.ts and Track C. */
export const CURRENT_SILVER_SCHEMA_VERSION: SilverSchemaVersion = '1';

const WINE_TYPE_VALUES = [
  'red',
  'white',
  'rosé',
  'sparkling',
  'dessert',
  'fortified',
] as const;

const PRICE_BAND_VALUES = ['value', 'mid', 'premium', 'luxury'] as const;

// Numeric bounds for SilverWineRecord — domain facts:
//   - priceUsd: USD prices must be ≥ 0; no realistic upper bound enforced here.
//   - alcoholPct: % ABV ∈ [0, 100]. A value > 100% is physically impossible.
//   - body / sweetness / acidity / tannin: normalised to [0, 1].
//   - vintageYear: post-phylloxera realistic window [1800, current year + 1].
const ALCOHOL_PCT_MIN = 0;
const ALCOHOL_PCT_MAX = 100;
const NORMALISED_MIN = 0;
const NORMALISED_MAX = 1;

/**
 * Per-record Zod schema for SilverWineRecord.
 *
 * Required fields: sourceId, externalId, canonicalLabel, producer, country,
 * region, wineType, grapes, ratingsCount, popularityScore.
 *
 * `schema_version` is optional; when absent it defaults to the oldest known
 * version (backward-compat). When present, it MUST be a known version string.
 */
export const SilverWineRecordSchema = z
  .object({
    schema_version: z
      .enum(SILVER_SCHEMA_VERSIONS)
      .optional()
      .default(CURRENT_SILVER_SCHEMA_VERSION),
    sourceId: z.string().min(1),
    externalId: z.string().min(1),
    canonicalLabel: z.string().min(1),
    producer: z.string(),
    vintageYear: z.number().int().min(1800).max(2100).nullable(),
    country: z.string(),
    region: z.string(),
    appellation: z.string().nullable().optional(),
    wineType: z.enum(WINE_TYPE_VALUES),
    grapePrimary: z.string().nullable(),
    grapes: z.array(z.string()).max(20),
    body: z.number().finite().min(NORMALISED_MIN).max(NORMALISED_MAX).nullable(),
    sweetness: z
      .number()
      .finite()
      .min(NORMALISED_MIN)
      .max(NORMALISED_MAX)
      .nullable(),
    acidity: z.number().finite().min(NORMALISED_MIN).max(NORMALISED_MAX).nullable(),
    tannin: z.number().finite().min(NORMALISED_MIN).max(NORMALISED_MAX).nullable(),
    pairingTags: z.array(z.string()).max(50),
    flavorProfiles: z.array(z.string()).max(50),
    searchTextEn: z.string(),
    ratingAvg: z.number().finite().min(0).max(5).nullable(),
    ratingsCount: z.number().int().min(0),
    priceUsd: z.number().finite().min(0).nullable(),
    priceBand: z.enum(PRICE_BAND_VALUES).optional(),
    popularityScore: z
      .number()
      .finite()
      .min(NORMALISED_MIN)
      .max(NORMALISED_MAX),
    scrapedAt: z.string().nullable(),
    alcoholPct: z
      .number()
      .finite()
      .min(ALCOHOL_PCT_MIN)
      .max(ALCOHOL_PCT_MAX)
      .nullable(),
    producerPrestige: z
      .number()
      .finite()
      .min(NORMALISED_MIN)
      .max(NORMALISED_MAX)
      .nullable(),
    isTopRated: z.boolean(),
  })
  .passthrough();
// `.passthrough()` (not `.strict()`): Silver records carry many optional
// Track-C enrichment fields (criticProxy, drinkingWindow, gift / beginner
// suitability, learned-sparse weights, …). They are validated by their own
// stage-specific schemas, so the gate schema must not reject unknown keys.
// Per CLAUDE.md test discipline rule 10, this is a documented exception to
// the default `.strict()` policy.

export type ParsedSilverWineRecord = z.infer<typeof SilverWineRecordSchema>;

// ---------------------------------------------------------------------------
// Batch validation
// ---------------------------------------------------------------------------

export interface SilverBatchInvalidEntry {
  readonly index: number;
  readonly error: z.ZodError;
}

export interface SilverBatchValidationResult {
  readonly valid: readonly ParsedSilverWineRecord[];
  readonly invalid: readonly SilverBatchInvalidEntry[];
  readonly passed: boolean;
}

/**
 * Validate a batch of unknown silver-shaped records, returning the parsed
 * valid records plus per-record error reports for any invalid entries.
 *
 * Empty input → empty result, `passed: true` (vacuously valid).
 */
export function validateSilverRecordBatch(
  records: readonly unknown[],
): SilverBatchValidationResult {
  const valid: ParsedSilverWineRecord[] = [];
  const invalid: SilverBatchInvalidEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const parsed = SilverWineRecordSchema.safeParse(records[i]);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      invalid.push({ index: i, error: parsed.error });
    }
  }
  return {
    valid,
    invalid,
    passed: invalid.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INPUT = ETL_ARTIFACT_FILES.trackc;
export const REPORT_OUTPUT = ETL_ARTIFACT_FILES.qualityReport;

/**
 * Quality gate thresholds (Epic 1 + SOTA++ extension).
 * `minRecords`: Current Vivino Bronze connector yields ~7K deduped rows; RFC target remains 8K+ / 10K when the feed grows.
 * Raise `minRecords` toward 8_000 as the snapshot expands (see epic-1-etl-pipeline.md).
 */
export const SILVER_QUALITY_GATES = {
  minRecords: 7_000,
  minTastingNotesCoverage: 0.30,
  minAliasMeanCount: 3,
  bodyMinMean: 0.1,
  bodyMaxMean: 0.9,
  // SOTA++ coverage gates — blockers by default. Use --allow-partial only when
  // explicitly running a partial coverage audit.
  minAlcoholPctCoverage: 0.50,       // ≥50% of records should have alcohol_pct
  minProducerPrestigeCoverage: 0.70, // ≥70% from winery_rating
  minDrinkingWindowCoverage: 0.0,    // heuristic drinking-window stays experimental-only
  minCriticProxyCoverage: 0.80,      // ≥80% from Track C step 1
  minGiftSuitabilityCoverage: 0.70,  // ≥70% from Track C step 6
  minBeginnerSuitabilityCoverage: 0.70, // ≥70% from Track C step 7
} as const;

export interface SilverQualityGateThresholds {
  readonly minRecords: number;
  readonly minTastingNotesCoverage: number;
  readonly minAliasMeanCount: number;
  readonly bodyMinMean: number;
  readonly bodyMaxMean: number;
  readonly minAlcoholPctCoverage?: number;
  readonly minProducerPrestigeCoverage?: number;
  readonly minDrinkingWindowCoverage?: number;
  readonly minCriticProxyCoverage?: number;
  readonly minGiftSuitabilityCoverage?: number;
  readonly minBeginnerSuitabilityCoverage?: number;
}

export interface SilverQualityGateOptions {
  readonly allowPartialCoverage?: boolean;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { input: string; allowPartialCoverage: boolean } {
  let input = DEFAULT_INPUT;
  let allowPartialCoverage = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') input = argv[++i] ?? DEFAULT_INPUT;
    if (a === '--allow-partial' || a === '--allow-partial-coverage') {
      allowPartialCoverage = true;
    }
  }
  return { input, allowPartialCoverage };
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateSilverRecords(
  records: readonly EnrichedSilverRecord[],
  gates: SilverQualityGateThresholds = SILVER_QUALITY_GATES,
  options: SilverQualityGateOptions = {},
): SilverQualityReport {
  const n = records.length;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const ratio = (count: number): number => (n === 0 ? 0 : count / n);

  // Helper: access optional Track-C fields that are attached to the gold record
  // but not typed on EnrichedSilverRecord (they are added in-place by run-track-c)
  type GoldRecord = EnrichedSilverRecord & {
    readonly alcoholPct?: number | null;
    readonly producerPrestige?: number | null;
    readonly criticProxy?: { readonly proxyScore?: number } | null;
    readonly drinkingWindow?: unknown;
    readonly giftSuitabilityClassification?: { readonly score?: number | null } | null;
    readonly beginnerSuitabilityClassification?: { readonly score?: number | null } | null;
  };
  const gold = records as readonly GoldRecord[];

  // Field coverage
  const fieldCoverage: Record<string, number> = {
    producer: ratio(records.filter((r) => r.producer.length > 0).length),
    country: ratio(records.filter((r) => r.country.length > 0).length),
    region: ratio(records.filter((r) => r.region.length > 0).length),
    grapePrimary: ratio(records.filter((r) => r.grapePrimary !== null).length),
    priceUsd: ratio(records.filter((r) => r.priceUsd !== null).length),
    searchTextEn: ratio(records.filter((r) => r.searchTextEn.length > 30).length),
    flavorProfiles: ratio(records.filter((r) => r.flavorProfiles.length > 0).length),
    pairingTags: ratio(records.filter((r) => r.pairingTags.length > 0).length),
    vintageYear: ratio(records.filter((r) => r.vintageYear !== null).length),
    // SOTA++ fields
    alcoholPct: ratio(gold.filter((r) => r.alcoholPct != null).length),
    producerPrestige: ratio(gold.filter((r) => r.producerPrestige != null).length),
    criticProxy: ratio(gold.filter((r) => r.criticProxy?.proxyScore != null).length),
    drinkingWindow: ratio(gold.filter((r) => r.drinkingWindow != null).length),
    giftSuitability: ratio(gold.filter((r) => r.giftSuitabilityClassification != null).length),
    beginnerSuitability: ratio(gold.filter((r) => r.beginnerSuitabilityClassification != null).length),
  };

  const gateCoverage = (
    field: keyof typeof fieldCoverage,
    threshold: number | undefined,
    label: string,
    guidance: string,
  ): void => {
    if (threshold === undefined || threshold <= 0) {
      return;
    }
    const coverage = fieldCoverage[field] ?? 0;
    if (coverage >= threshold) {
      return;
    }
    const message = `${label} ${(coverage * 100).toFixed(1)}% < target ${(threshold * 100).toFixed(0)}% — ${guidance}`;
    if (options.allowPartialCoverage) {
      warnings.push(`${message} (allowed via --allow-partial)`);
      return;
    }
    blockers.push(message);
  };

  // Distribution checks
  const bodyValues = records
    .map((r) => r.body)
    .filter((value): value is number => typeof value === 'number');
  const bodyMean = mean(bodyValues);
  const bodyStd = stdDev(bodyValues);
  const priceCoverage = fieldCoverage['priceUsd'] ?? 0;
  const tastingNotesCoverage = fieldCoverage['searchTextEn'] ?? 0;
  const aliasMeanCount = mean(
    records.map((r) => r.aliases.proposed.length),
  );

  // Gate checks
  if (n < gates.minRecords) {
    blockers.push(
      `Record count ${n} < minimum ${gates.minRecords} (after dedup)`,
    );
  }

  if (tastingNotesCoverage < gates.minTastingNotesCoverage) {
    blockers.push(
      `Tasting notes coverage ${(tastingNotesCoverage * 100).toFixed(1)}% < minimum ${gates.minTastingNotesCoverage * 100}% — semantic search will be severely degraded`,
    );
  }

  if (aliasMeanCount < gates.minAliasMeanCount) {
    blockers.push(
      `Mean alias count ${aliasMeanCount.toFixed(1)} < minimum ${gates.minAliasMeanCount} — alias search will fail`,
    );
  }

  if (bodyMean < gates.bodyMinMean || bodyMean > gates.bodyMaxMean) {
    blockers.push(
      `Body mean ${bodyMean.toFixed(3)} outside expected range [${gates.bodyMinMean}, ${gates.bodyMaxMean}] — possible normalisation bug`,
    );
  }

  if (bodyStd < 0.01) {
    warnings.push(
      `Body std dev ${bodyStd.toFixed(4)} is low (< 0.01) — Vivino payloads often lack body variance; verify transform if you expect spread`,
    );
  }

  gateCoverage(
    'alcoholPct',
    gates.minAlcoholPctCoverage,
    'alcohol_pct coverage',
    'many Vivino records lack ABV; run with --allow-partial only if you explicitly accept that loss',
  );
  gateCoverage(
    'producerPrestige',
    gates.minProducerPrestigeCoverage,
    'producer_prestige coverage',
    'winery_rating absent for some records; run with --allow-partial only if you explicitly accept that loss',
  );
  gateCoverage(
    'criticProxy',
    gates.minCriticProxyCoverage,
    'criticProxy coverage',
    'run Track C step 1 to generate LLM critic scores',
  );
  gateCoverage(
    'drinkingWindow',
    gates.minDrinkingWindowCoverage,
    'drinkingWindow coverage',
    'drinkingWindow is experimental-only and is not required for canonical validation',
  );
  gateCoverage(
    'giftSuitability',
    gates.minGiftSuitabilityCoverage,
    'giftSuitability coverage',
    'run Track C step 6 to generate provenance-backed gift suitability scores',
  );
  gateCoverage(
    'beginnerSuitability',
    gates.minBeginnerSuitabilityCoverage,
    'beginnerSuitability coverage',
    'run Track C step 7 to generate provenance-backed beginner suitability scores',
  );

  const validateNormalizedScore = (
    label: string,
    recordId: string,
    value: number | null | undefined,
  ): void => {
    if (value == null) {
      return;
    }
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      blockers.push(
        `${label} for ${recordId} = ${value} outside [0, 1] — expected normalized score`,
      );
    }
  };

  for (const record of gold) {
    validateNormalizedScore(
      'giftSuitabilityClassification.score',
      record.sourceId,
      record.giftSuitabilityClassification?.score,
    );
    validateNormalizedScore(
      'beginnerSuitabilityClassification.score',
      record.sourceId,
      record.beginnerSuitabilityClassification?.score,
    );
  }

  const report: SilverQualityReport = {
    totalBronzeRows: n, // already deduped at this point
    afterDedup: n,
    afterTransform: n,
    fieldCoverage,
    distributionChecks: {
      bodyMean,
      bodyStdDev: bodyStd,
      priceCoverage,
      tastingNotesCoverage,
      aliasMeanCount,
    },
    blockers,
    warnings,
    passed: blockers.length === 0,
  };

  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const trackCLane = classifyTrackCArtifactPath(args.input);
  if (trackCLane === 'experimental' && !args.allowPartialCoverage) {
    throw new Error(
      `validate-silver refuses experimental Track C input without --allow-partial: ${args.input}`,
    );
  }

  console.log(`Validating Silver records from ${args.input} …`);
  const content = await fs.readFile(args.input, 'utf8');
  const { records } = parseNdjson<EnrichedSilverRecord>(content, args.input);

  const report = validateSilverRecords(records, SILVER_QUALITY_GATES, {
    allowPartialCoverage: args.allowPartialCoverage,
  });

  // Write report (atomic)
  await atomicWriteFile(
    REPORT_OUTPUT,
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(`  Report written to: ${REPORT_OUTPUT}`);

  // Print summary
  console.log(`\n  Records: ${report.afterTransform}`);
  console.log('  Field coverage:');
  for (const [field, cov] of Object.entries(report.fieldCoverage)) {
    console.log(`    ${field}: ${(cov * 100).toFixed(1)}%`);
  }
  console.log(`  Body: mean=${report.distributionChecks.bodyMean.toFixed(3)} std=${report.distributionChecks.bodyStdDev.toFixed(3)}`);
  console.log(`  Alias mean: ${report.distributionChecks.aliasMeanCount.toFixed(1)}`);

  if (report.warnings.length > 0) {
    console.log('\n  Warnings:');
    for (const w of report.warnings) {
      console.log(`    - ${w}`);
    }
  }

  if (report.passed) {
    console.log('\n  ✅ Quality gate PASSED');
  } else {
    console.log('\n  ❌ Quality gate FAILED:');
    for (const blocker of report.blockers) {
      console.log(`    - ${blocker}`);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
