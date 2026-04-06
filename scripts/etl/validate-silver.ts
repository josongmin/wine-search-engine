#!/usr/bin/env tsx
/**
 * Silver Data Quality Gate: validates enriched Silver records before Vespa
 * indexing. Blocks the pipeline if quality thresholds are not met.
 *
 * Usage:
 *   npx tsx scripts/etl/validate-silver.ts
 *   npx tsx scripts/etl/validate-silver.ts --input data/silver-enriched.ndjson
 */

import fs from 'node:fs/promises';
import type { EnrichedSilverRecord, SilverQualityReport } from './types.js';
import { parseNdjson } from './ndjson.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INPUT = 'data/silver-enriched.ndjson';
export const REPORT_OUTPUT = 'data/silver-quality-report.json';

/**
 * Quality gate thresholds (Epic 1).
 * `minRecords`: Current Vivino Bronze connector yields ~7K deduped rows; RFC target remains 8K+ / 10K when the feed grows.
 * Raise `minRecords` toward 8_000 as the snapshot expands (see epic-1-etl-pipeline.md).
 */
export const SILVER_QUALITY_GATES = {
  minRecords: 7_000,
  minTastingNotesCoverage: 0.30,
  minAliasMeanCount: 3,
  bodyMinMean: 0.1,
  bodyMaxMean: 0.9,
} as const;

export interface SilverQualityGateThresholds {
  readonly minRecords: number;
  readonly minTastingNotesCoverage: number;
  readonly minAliasMeanCount: number;
  readonly bodyMinMean: number;
  readonly bodyMaxMean: number;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { input: string } {
  let input = DEFAULT_INPUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') input = argv[++i] ?? DEFAULT_INPUT;
  }
  return { input };
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
): SilverQualityReport {
  const n = records.length;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const ratio = (count: number): number => (n === 0 ? 0 : count / n);

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
  };

  // Distribution checks
  const bodyValues = records.map((r) => r.body);
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

  const report = validateSilverRecords(records);

  // Write report
  await fs.writeFile(
    REPORT_OUTPUT,
    JSON.stringify(report, null, 2) + '\n',
    'utf8',
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
