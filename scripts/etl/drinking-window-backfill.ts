#!/usr/bin/env tsx

/**
 * Track C Step 4: Drinking Window Backfill
 *
 * Predicts optimal drinking windows using a heuristic stub.
 *
 * SOTA++ improvements:
 * - Idempotent: skips records that already have drinkingWindow
 * - Atomic writes only for complete outputs
 * - Confidence thresholds use normalised [0,1] scores (not raw Vivino 1-5)
 * - Explicit opt-in required so the stub cannot be promoted accidentally
 *
 * Usage: npx tsx --env-file=.env scripts/etl/drinking-window-backfill.ts
 */

import 'dotenv/config';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseNdjson } from './ndjson.js';
import { atomicWriteFileSync } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

export const DATA_FILE = ETL_ARTIFACT_FILES.trackcExperimental;
export const HEURISTIC_BACKFILL_OPT_IN_ENV = 'ALLOW_HEURISTIC_DRINKING_WINDOW_BACKFILL';

interface DrinkingWindowInput {
  readonly vintage: number;
  readonly body: number;
  readonly tannin: number;
  readonly acidity: number;
  readonly sweetness: number;
  readonly avgCriticProxyScore: number;
}

interface DrinkingWindowPrediction {
  readonly drinkingWindowStart: number;
  readonly drinkingWindowEnd: number;
  readonly peakYear: number;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly modelVersion: string;
}

interface SilverRecord {
  readonly sourceId?: string;
  readonly vintageYear?: number | null;
  readonly grapePrimary?: string | null;
  readonly region?: string;
  readonly country?: string;
  readonly body?: number | null;
  readonly tannin?: number | null;
  readonly acidity?: number | null;
  readonly sweetness?: number | null;
  readonly criticProxy?: {
    readonly proxyScore?: number;
  };
  readonly drinkingWindow?: DrinkingWindowPrediction;
  [key: string]: unknown;
}

interface EnrichedRecord extends SilverRecord {
  readonly drinkingWindow?: DrinkingWindowPrediction;
}

export interface DrinkingWindowBackfillResult {
  readonly records: EnrichedRecord[];
  readonly processed: number;
  readonly failed: number;
  readonly skippedIdempotent: number;
  readonly highConfidence: number;
  readonly mediumConfidence: number;
  readonly lowConfidence: number;
}

const MODEL_VERSION = 'v1.0-heuristic-20260405';

export function isHeuristicBackfillAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[HEURISTIC_BACKFILL_OPT_IN_ENV]?.trim();
  return value === '1' || value === 'true';
}

export function assertHeuristicBackfillAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (!isHeuristicBackfillAllowed(env)) {
    throw new Error(
      `drinking-window-backfill is a heuristic stub and refuses to run unless ${HEURISTIC_BACKFILL_OPT_IN_ENV}=1`,
    );
  }
}

/**
 * Heuristic prediction for drinking window.
 *
 * NOTE: This is NOT a real LightGBM model — it's a feature-weighted heuristic
 * that produces reasonable estimates. Replace with actual ONNX model loading
 * when trained model artifacts are available.
 *
 * All sensory inputs (body, tannin, acidity) are in [0, 1] normalised range.
 * criticScore is the raw LLM proxy score (0-100 scale).
 */
export function predictDrinkingWindow(input: DrinkingWindowInput): DrinkingWindowPrediction {
  const vintage = input.vintage;
  const body = input.body;
  const tannin = input.tannin;
  const acidity = input.acidity;
  const criticScore = Math.max(0, input.avgCriticProxyScore);

  const tanninAcidity = tannin * acidity;

  const startOffsetRaw =
    tannin * 0.8 + acidity * 0.5 + (criticScore / 100) * 3 - body * 0.2;
  const endOffsetRaw =
    tannin * 2.0 +
    acidity * 1.2 +
    (criticScore / 100) * 5 +
    tanninAcidity * 0.05 -
    body * 0.3;

  const startOffset = Math.max(0, Math.min(15, startOffsetRaw));
  const endOffset = Math.max(startOffset + 5, Math.min(50, endOffsetRaw));

  const drinkingWindowStart = Math.round(vintage + startOffset);
  const drinkingWindowEnd = Math.round(vintage + endOffset);
  const peakYear = Math.round(
    vintage + startOffset + (endOffset - startOffset) / 2,
  );

  // Confidence: criticScore is 0-100 scale (LLM proxy), tannin/acidity are [0,1] normalised
  let confidence: 'high' | 'medium' | 'low' = 'medium';
  if (criticScore >= 90 && (tannin >= 0.6 || acidity >= 0.8)) {
    confidence = 'high';
  } else if (criticScore < 75 || (tannin < 0.3 && body < 0.4)) {
    confidence = 'low';
  }

  return {
    drinkingWindowStart,
    drinkingWindowEnd,
    peakYear,
    confidence,
    modelVersion: MODEL_VERSION,
  };
}

export function extractFeatures(record: SilverRecord): DrinkingWindowInput | null {
  if (
    !record.vintageYear ||
    record.body == null ||
    record.tannin == null ||
    record.acidity == null ||
    record.sweetness == null
  ) {
    return null;
  }

  const criticScore = record.criticProxy?.proxyScore ?? 0;

  return {
    vintage: record.vintageYear,
    body: record.body,
    tannin: record.tannin,
    acidity: record.acidity,
    sweetness: record.sweetness,
    avgCriticProxyScore: criticScore,
  };
}

export function backfillDrinkingWindowRecords(
  records: readonly SilverRecord[],
): DrinkingWindowBackfillResult {
  let processed = 0;
  let failed = 0;
  let skippedIdempotent = 0;
  const enrichedRecords: EnrichedRecord[] = [];

  let highConfidence = 0;
  let mediumConfidence = 0;
  let lowConfidence = 0;

  for (const record of records) {
    if (record.drinkingWindow != null) {
      enrichedRecords.push(record);
      skippedIdempotent++;
      continue;
    }

    const features = extractFeatures(record);
    if (features) {
      const prediction = predictDrinkingWindow(features);
      enrichedRecords.push({ ...record, drinkingWindow: prediction });

      if (prediction.confidence === 'high') highConfidence++;
      else if (prediction.confidence === 'medium') mediumConfidence++;
      else lowConfidence++;
      processed++;
    } else {
      enrichedRecords.push(record);
      failed++;
    }
  }

  return {
    records: enrichedRecords,
    processed,
    failed,
    skippedIdempotent,
    highConfidence,
    mediumConfidence,
    lowConfidence,
  };
}

export function assertDrinkingWindowBackfillComplete(result: Pick<DrinkingWindowBackfillResult, 'failed'>): void {
  if (result.failed > 0) {
    throw new Error(
      `drinking-window-backfill refused to write partial output: ${result.failed} record(s) are missing required attributes`,
    );
  }
}

export async function main() {
  console.log('Track C Step 4: Drinking Window Backfill');
  console.log(`  Input: ${DATA_FILE}`);
  assertHeuristicBackfillAllowed();

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`  File not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(DATA_FILE, 'utf-8');
  const { records, skipped } = parseNdjson<SilverRecord>(content, DATA_FILE);

  console.log(`  Loaded: ${records.length} records (${skipped} malformed lines)`);
  const alreadyDone = records.filter((r) => r.drinkingWindow != null).length;
  if (alreadyDone > 0) {
    console.log(`  Idempotency: ${alreadyDone} records already have drinkingWindow, skipping those`);
  }

  const result = backfillDrinkingWindowRecords(records);
  const pct = records.length === 0 ? 0 : Math.round((result.records.length / records.length) * 100);
  console.log(`  Processed: ${result.processed}/${records.length} (${pct}%) | Skipped: ${result.failed + result.skippedIdempotent}`);

  // Partial outputs are forbidden: do not write the file unless every
  // record either already had a drinking window or received a prediction.
  assertDrinkingWindowBackfillComplete(result);

  const output = result.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  atomicWriteFileSync(DATA_FILE, output);

  console.log('\n' + '='.repeat(60));
  console.log('Step 4 Complete: Drinking Window Backfill');
  console.log('='.repeat(60));
  console.log(`Total records: ${result.records.length}`);
  console.log(`New predictions: ${result.processed}`);
  console.log(`  - High confidence: ${result.highConfidence}`);
  console.log(`  - Medium confidence: ${result.mediumConfidence}`);
  console.log(`  - Low confidence: ${result.lowConfidence}`);
  console.log(`Already had drinkingWindow: ${result.skippedIdempotent}`);
  console.log(`Skipped (missing attributes): ${result.failed}`);
  console.log(`Model version: ${MODEL_VERSION} (heuristic — not ML model)`);
  console.log(`Output: ${DATA_FILE}`);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  main().catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
}
