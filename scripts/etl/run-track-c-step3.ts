#!/usr/bin/env tsx

/**
 * Track C Step 3: Generate Food Pairings
 *
 * Reads silver-docquery.ndjson with certifications, generates normalized
 * food pairing tags using Claude-based taxonomy normalization.
 *
 * Usage: npx tsx --env-file=.env scripts/etl/run-track-c-step3.ts
 *
 * Input: data/silver-docquery.ndjson (with certifications field)
 * Output: data/silver-docquery.ndjson (with pairingTags enriched)
 * Error handling: Skip if Claude timeout, continue processing
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';
import { parseNdjson } from './ndjson';
import { normalizePairingsBatch } from './generate-pairings';

interface SilverRecord {
  readonly canonicalLabel: string;
  readonly searchTextEn: string;
  readonly pairingTags?: readonly string[];
  [key: string]: unknown;
}

interface EnrichedRecord extends SilverRecord {
  readonly pairingTags: readonly string[];
}

const DATA_FILE = path.resolve('./data/silver-docquery.ndjson');
const BATCH_SIZE = 100;

async function main() {
  console.log('🍷 Track C Step 3: Generate Food Pairings (Claude-based)');
  console.log(`📄 Input: ${DATA_FILE}`);

  // Load data
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ File not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(DATA_FILE, 'utf-8');
  const { records, skipped } = parseNdjson<SilverRecord>(content, DATA_FILE);

  console.log(`📊 Loaded: ${records.length} records (${skipped} malformed lines)`);

  // Initialize Anthropic client
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Process in batches
  let processed = 0;
  let failed = 0;
  const enrichedRecords: EnrichedRecord[] = [];

  let high_confidence = 0;
  let medium_confidence = 0;
  let low_confidence = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    console.log(`\n⏳ Batch ${batchNum}/${totalBatches} (${batch.length} wines)...`);

    // Normalize pairings for batch
    const pairingMap = await normalizePairingsBatch(
      batch.map((r) => ({
        canonicalLabel: r.canonicalLabel,
        searchTextEn: r.searchTextEn,
        foodPairings: (r.pairingTags as string[] | undefined) ?? [],
      })),
      client,
      10,
    );

    // Merge results back
    for (const record of batch) {
      const pairing = pairingMap.get(record.canonicalLabel);
      if (pairing) {
        enrichedRecords.push({
          ...record,
          pairingTags: pairing.tags,
        });

        if (pairing.confidence === 'high') {
          high_confidence++;
        } else if (pairing.confidence === 'medium') {
          medium_confidence++;
        } else {
          low_confidence++;
        }
        processed++;
      } else {
        enrichedRecords.push({
          ...record,
          pairingTags: record.pairingTags ?? [],
        });
        failed++;
        console.warn(
          `  ⚠️  Failed to normalize pairings for: ${record.canonicalLabel}`,
        );
      }
    }

    // Progress
    const pct = Math.round((processed + failed) / records.length * 100);
    console.log(
      `  ✓ Processed: ${processed}/${records.length} (${pct}%) | Failed: ${failed}`,
    );
  }

  // Write back
  const output = enrichedRecords
    .map((r) => JSON.stringify(r))
    .join('\n');

  fs.writeFileSync(DATA_FILE, output, 'utf-8');

  // Report
  console.log('\n' + '='.repeat(60));
  console.log('✅ Step 3 Complete: Food Pairing Generation');
  console.log('='.repeat(60));
  console.log(`Total records: ${enrichedRecords.length}`);
  console.log(`Successfully enriched: ${processed}`);
  console.log(`  - High confidence: ${high_confidence}`);
  console.log(`  - Medium confidence: ${medium_confidence}`);
  console.log(`  - Low confidence: ${low_confidence}`);
  console.log(`Failed: ${failed}`);
  console.log(`Field: pairingTags (enriched with ${processed} improved tags)`);
  console.log(`Output: ${DATA_FILE}`);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
