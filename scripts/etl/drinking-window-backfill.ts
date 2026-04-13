#!/usr/bin/env tsx

/**
 * Track C Step 4: Drinking Window Backfill
 *
 * Predicts optimal drinking windows using feature-weighted heuristic model.
 *
 * SOTA++ improvements:
 * - Idempotent: skips records that already have drinkingWindow
 * - Atomic writes
 * - Confidence thresholds use normalised [0,1] scores (not raw Vivino 1-5)
 * - Documented that this is a heuristic stub — not a real LightGBM model
 *
 * Usage: npx tsx --env-file=.env scripts/etl/drinking-window-backfill.ts
 */

import 'dotenv/config';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseNdjson } from './ndjson.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { atomicWriteFileSync } from './etl-utils.js';

const DATA_FILE = resolveDataPath('data/silver-docquery.ndjson');

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
  readonly body?: number;
  readonly tannin?: number;
  readonly acidity?: number;
  readonly sweetness?: number;
  readonly criticProxy?: {
    readonly proxyScore?: number;
  };
  readonly drinkingWindow?: DrinkingWindowPrediction;
  [key: string]: unknown;
}

interface EnrichedRecord extends SilverRecord {
  readonly drinkingWindow?: DrinkingWindowPrediction;
}

const MODEL_VERSION = 'v1.0-heuristic-20260405';

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
    record.body === undefined ||
    record.tannin === undefined ||
    record.acidity === undefined ||
    record.sweetness === undefined
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

export async function main() {
  console.log('Track C Step 4: Drinking Window Backfill');
  console.log(`  Input: ${DATA_FILE}`);

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`  File not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(DATA_FILE, 'utf-8');
  const { records, skipped } = parseNdjson<SilverRecord>(content, DATA_FILE);

  console.log(`  Loaded: ${records.length} records (${skipped} malformed lines)`);

  // Idempotency: skip records that already have drinking window
  const alreadyDone = records.filter((r) => r.drinkingWindow != null).length;
  if (alreadyDone > 0) {
    console.log(`  Idempotency: ${alreadyDone} records already have drinkingWindow, skipping those`);
  }

  let processed = 0;
  let failed = 0;
  let skippedIdempotent = 0;
  const enrichedRecords: EnrichedRecord[] = [];

  let highConfidence = 0;
  let mediumConfidence = 0;
  let lowConfidence = 0;

  const BATCH_SIZE = 500;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    console.log(`\n  Batch ${batchNum}/${totalBatches} (${batch.length} wines)...`);

    for (const record of batch) {
      // Idempotency: skip already-enriched
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

    const pct = Math.round(enrichedRecords.length / records.length * 100);
    console.log(
      `  Processed: ${processed}/${records.length} (${pct}%) | Skipped: ${failed + skippedIdempotent}`,
    );
  }

  // Atomic write
  const output = enrichedRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
  atomicWriteFileSync(DATA_FILE, output);

  console.log('\n' + '='.repeat(60));
  console.log('Step 4 Complete: Drinking Window Backfill');
  console.log('='.repeat(60));
  console.log(`Total records: ${enrichedRecords.length}`);
  console.log(`New predictions: ${processed}`);
  console.log(`  - High confidence: ${highConfidence}`);
  console.log(`  - Medium confidence: ${mediumConfidence}`);
  console.log(`  - Low confidence: ${lowConfidence}`);
  console.log(`Already had drinkingWindow: ${skippedIdempotent}`);
  console.log(`Skipped (missing attributes): ${failed}`);
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
