#!/usr/bin/env tsx

/**
 * Track C Step 3: Generate Food Pairings
 *
 * SOTA++ improvements: idempotent (skips already-enriched via _pairingsNormalized marker),
 * atomic writes, dead-letter queue, periodic checkpoint flush.
 *
 * Usage: npx tsx --env-file=.env scripts/etl/run-track-c-step3.ts
 */

import 'dotenv/config';
import fs from 'node:fs';
import { Anthropic } from '@anthropic-ai/sdk';
import { parseNdjson } from './ndjson.js';
import { normalizePairingsBatch } from './generate-pairings.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { atomicWriteFileSync, appendDeadLetter } from './etl-utils.js';

interface SilverRecord {
  readonly sourceId?: string;
  readonly canonicalLabel: string;
  readonly searchTextEn: string;
  readonly pairingTags?: readonly string[];
  /** Marker field: true after pairings have been normalized by this step. */
  readonly _pairingsNormalized?: boolean;
  [key: string]: unknown;
}

interface EnrichedRecord extends SilverRecord {
  readonly pairingTags: readonly string[];
  readonly _pairingsNormalized: boolean;
}

const DATA_FILE = resolveDataPath('data/silver-docquery.ndjson');
const DEAD_LETTER_FILE = resolveDataPath('.dead-letter-step3.ndjson');
const BATCH_SIZE = 100;
const FLUSH_INTERVAL = 5;

async function main() {
  console.log('Track C Step 3: Generate Food Pairings (Claude-based)');
  console.log(`  Input: ${DATA_FILE}`);

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`  File not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(DATA_FILE, 'utf-8');
  const { records, skipped } = parseNdjson<SilverRecord>(content, DATA_FILE);

  console.log(`  Loaded: ${records.length} records (${skipped} malformed lines)`);

  const alreadyDone = records.filter((r) => r._pairingsNormalized === true).length;
  if (alreadyDone > 0) {
    console.log(`  Idempotency: ${alreadyDone} records already normalized, skipping those`);
  }

  const client = new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
  });

  let processed = 0;
  let failed = 0;
  let skippedIdempotent = 0;
  const enrichedRecords: EnrichedRecord[] = [];

  let highConfidence = 0;
  let mediumConfidence = 0;
  let lowConfidence = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    const toDo: SilverRecord[] = [];
    const done: EnrichedRecord[] = [];
    for (const r of batch) {
      if (r._pairingsNormalized === true) {
        done.push(r as EnrichedRecord);
        skippedIdempotent++;
      } else {
        toDo.push(r);
      }
    }

    enrichedRecords.push(...done);

    if (toDo.length === 0) continue;

    console.log(`\n  Batch ${batchNum}/${totalBatches} (${toDo.length} to process)...`);

    const pairingMap = await normalizePairingsBatch(
      toDo.map((r) => ({
        canonicalLabel: r.canonicalLabel,
        searchTextEn: r.searchTextEn,
        foodPairings: (r.pairingTags as string[] | undefined) ?? [],
      })),
      client,
      10,
    );

    for (const record of toDo) {
      const pairing = pairingMap.get(record.canonicalLabel);
      if (pairing) {
        enrichedRecords.push({
          ...record,
          pairingTags: pairing.tags,
          _pairingsNormalized: true,
        });

        if (pairing.confidence === 'high') highConfidence++;
        else if (pairing.confidence === 'medium') mediumConfidence++;
        else lowConfidence++;
        processed++;
      } else {
        enrichedRecords.push({
          ...record,
          pairingTags: record.pairingTags ?? [],
          _pairingsNormalized: false,
        });
        failed++;
        const id = record.sourceId ?? record.canonicalLabel;
        await appendDeadLetter(DEAD_LETTER_FILE, {
          sourceId: id,
          step: 'pairings',
          error: 'Pairing normalization failed',
        });
      }
    }

    if (batchNum % FLUSH_INTERVAL === 0) {
      const output = enrichedRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
      atomicWriteFileSync(DATA_FILE, output);
      console.log(`  [checkpoint] Flushed ${enrichedRecords.length} records to disk`);
    }

    const pct = Math.round(enrichedRecords.length / records.length * 100);
    console.log(
      `  Processed: ${processed}/${records.length} (${pct}%) | Failed: ${failed}`,
    );
  }

  const output = enrichedRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
  atomicWriteFileSync(DATA_FILE, output);

  console.log('\n' + '='.repeat(60));
  console.log('Step 3 Complete: Food Pairing Generation');
  console.log('='.repeat(60));
  console.log(`Total records: ${enrichedRecords.length}`);
  console.log(`New enrichments: ${processed}`);
  console.log(`  - High confidence: ${highConfidence}`);
  console.log(`  - Medium confidence: ${mediumConfidence}`);
  console.log(`  - Low confidence: ${lowConfidence}`);
  console.log(`Already normalized: ${skippedIdempotent}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) console.log(`Dead-letter log: ${DEAD_LETTER_FILE}`);
  console.log(`Output: ${DATA_FILE}`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
