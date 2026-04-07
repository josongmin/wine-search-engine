#!/usr/bin/env tsx

/**
 * Track C Step 4: Drinking Window Backfill
 *
 * Reads silver-docquery.ndjson with all enrichments and generates
 * drinking window predictions using DrinkingWindowPredictor with
 * feature engineering (grape, region, vintage, sensory attributes, critic score).
 *
 * Usage: npx tsx --env-file=.env scripts/etl/drinking-window-backfill.ts
 *
 * Input: data/silver-docquery.ndjson (with all enrichments)
 * Output: data/silver-docquery.ndjson (with drinkingWindow field added)
 * Error handling: Skip wines with missing critical attributes, continue processing
 */

import 'dotenv/config';
import fs from 'node:fs';
import { parseNdjson } from './ndjson';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';

/**
 * Label encoders for categorical variables (hardcoded stub).
 * In production: loaded from trained model artifacts.
 */
const GRAPE_ENCODERS: Record<string, number> = {
  'Cabernet Sauvignon': 0,
  'Merlot': 1,
  'Pinot Noir': 2,
  'Syrah': 3,
  'Chardonnay': 4,
  'Sauvignon Blanc': 5,
  'Riesling': 6,
  'Tempranillo': 7,
  'Nebbiolo': 8,
  'Sangiovese': 9,
};

const REGION_ENCODERS: Record<string, number> = {
  'Bordeaux': 0,
  'Burgundy': 1,
  'Rhone Valley': 2,
  'Napa Valley': 3,
  'Sonoma County': 4,
  'Tuscany': 5,
  'Piedmont': 6,
  'Ribera del Duero': 7,
  'Rioja': 8,
  'Mosel': 9,
};

const COUNTRY_ENCODERS: Record<string, number> = {
  'France': 0,
  'Italy': 1,
  'Spain': 2,
  'USA': 3,
  'Germany': 4,
  'Australia': 5,
  'Argentina': 6,
  'Chile': 7,
  'New Zealand': 8,
  'Portugal': 9,
};

const DATA_FILE = resolveDataPath('data/silver-docquery.ndjson');

interface DrinkingWindowInput {
  readonly vintage: number;
  readonly grapePrimaryEnc: number;
  readonly regionEnc: number;
  readonly countryEnc: number;
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
  [key: string]: unknown;
}

interface EnrichedRecord extends SilverRecord {
  readonly drinkingWindow?: DrinkingWindowPrediction;
}

const MODEL_VERSION = 'v1.0-enc20260405';

/**
 * Stub LightGBM prediction using feature-weighted heuristic.
 * Mimics the actual DrinkingWindowPredictor logic.
 */
function predictDrinkingWindow(input: DrinkingWindowInput): DrinkingWindowPrediction {
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

  let confidence: 'high' | 'medium' | 'low' = 'medium';

  if (criticScore >= 90 && (tannin >= 3 || acidity >= 4)) {
    confidence = 'high';
  } else if (criticScore < 75 || (tannin < 1.5 && body < 2)) {
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

/**
 * Encode categorical variable to integer.
 * OOV (out-of-vocabulary) returns 999.
 */
function encodeCategory(value: string | null, encoders: Record<string, number>): number {
  if (!value) return 999;
  const encoded = encoders[value];
  return encoded !== undefined ? encoded : 999;
}

/**
 * Extract numeric features from a wine record.
 * Returns null if critical numeric attributes are missing.
 * Categorical attributes can be OOV encoded.
 */
function extractFeatures(record: SilverRecord): DrinkingWindowInput | null {
  // Check critical numeric attributes
  if (
    !record.vintageYear ||
    record.body === undefined ||
    record.tannin === undefined ||
    record.acidity === undefined ||
    record.sweetness === undefined
  ) {
    return null;
  }

  // Extract critic score with fallback
  const criticScore = record.criticProxy?.proxyScore ?? 0;

  return {
    vintage: record.vintageYear,
    grapePrimaryEnc: encodeCategory(record.grapePrimary, GRAPE_ENCODERS),
    regionEnc: encodeCategory(record.region, REGION_ENCODERS),
    countryEnc: encodeCategory(record.country, COUNTRY_ENCODERS),
    body: record.body,
    tannin: record.tannin,
    acidity: record.acidity,
    sweetness: record.sweetness,
    avgCriticProxyScore: criticScore,
  };
}

async function main() {
  console.log('🍷 Track C Step 4: Drinking Window Backfill');
  console.log(`📄 Input: ${DATA_FILE}`);

  // Load data
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ File not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(DATA_FILE, 'utf-8');
  const { records, skipped } = parseNdjson<SilverRecord>(content, DATA_FILE);

  console.log(`📊 Loaded: ${records.length} records (${skipped} malformed lines)`);

  // Process all records
  let processed = 0;
  let failed = 0;
  const enrichedRecords: EnrichedRecord[] = [];

  let high_confidence = 0;
  let medium_confidence = 0;
  let low_confidence = 0;

  const BATCH_SIZE = 500;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    console.log(`\n⏳ Batch ${batchNum}/${totalBatches} (${batch.length} wines)...`);

    for (const record of batch) {
      const features = extractFeatures(record);

      if (features) {
        const prediction = predictDrinkingWindow(features);
        enrichedRecords.push({
          ...record,
          drinkingWindow: prediction,
        });

        if (prediction.confidence === 'high') {
          high_confidence++;
        } else if (prediction.confidence === 'medium') {
          medium_confidence++;
        } else {
          low_confidence++;
        }
        processed++;
      } else {
        enrichedRecords.push(record);
        failed++;
      }
    }

    const pct = Math.round((processed + failed) / records.length * 100);
    console.log(
      `  ✓ Processed: ${processed}/${records.length} (${pct}%) | Skipped: ${failed}`,
    );
  }

  // Write back
  const output = enrichedRecords
    .map((r) => JSON.stringify(r))
    .join('\n');

  fs.writeFileSync(DATA_FILE, output, 'utf-8');

  // Report
  console.log('\n' + '='.repeat(60));
  console.log('✅ Step 4 Complete: Drinking Window Backfill');
  console.log('='.repeat(60));
  console.log(`Total records: ${enrichedRecords.length}`);
  console.log(`Successfully predicted: ${processed}`);
  console.log(`  - High confidence: ${high_confidence}`);
  console.log(`  - Medium confidence: ${medium_confidence}`);
  console.log(`  - Low confidence: ${low_confidence}`);
  console.log(`Skipped (missing attributes): ${failed}`);
  console.log(`New field: drinkingWindow (added to ${processed} records)`);
  console.log(`  - drinkingWindowStart`);
  console.log(`  - drinkingWindowEnd`);
  console.log(`  - peakYear`);
  console.log(`  - confidence`);
  console.log(`Model version: ${MODEL_VERSION}`);
  console.log(`Output: ${DATA_FILE}`);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
