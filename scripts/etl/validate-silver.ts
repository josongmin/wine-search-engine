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
import type { EnrichedSilverRecord, SilverQualityReport } from './types.js';
import { parseNdjson } from './ndjson.js';
import { atomicWriteFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

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
  minDrinkingWindowCoverage: 0.60,   // ≥60% from Track C step 4
  minCriticProxyCoverage: 0.80,      // ≥80% from Track C step 1
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
    'run Track C step 4 (drinking-window-backfill)',
  );

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
