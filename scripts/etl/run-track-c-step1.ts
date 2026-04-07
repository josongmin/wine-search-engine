#!/usr/bin/env tsx

/**
 * Track C Step 1: Generate Critic Proxy Scores
 *
 * Reads silver-docquery.ndjson, generates LLM-based critic proxy scores,
 * and writes back enriched records with `criticProxy` field.
 *
 * Usage: npx tsx --env-file=.env scripts/etl/run-track-c-step1.ts
 *
 * Input: data/silver-docquery.ndjson (7040 docs)
 * Output: data/silver-docquery.ndjson (with criticProxy field added)
 * Error handling: Logs failures, skips failed wines, continues batch
 */

import 'dotenv/config';
import fs from 'node:fs';
import { Anthropic } from '@anthropic-ai/sdk';
import { parseNdjson } from './ndjson';
import { generateCriticProxiesBatch } from './generate-critic-proxy';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';

interface SilverRecord {
  readonly canonicalLabel: string;
  readonly searchTextEn: string;
  readonly body?: number;
  readonly acidity?: number;
  readonly tannin?: number;
  readonly region?: string;
  readonly grapePrimary?: string;
  [key: string]: unknown;
}

interface EnrichedRecord extends SilverRecord {
  readonly criticProxy?: {
    readonly proxyScore: number;
    readonly scoreTier: string;
    readonly confidence: string;
    readonly reasoningSignals: string[];
    readonly isSynthetic: boolean;
  };
}

const DATA_FILE = resolveDataPath('data/silver-docquery.ndjson');
const BATCH_SIZE = 100;

async function main() {
  console.log('🍷 Track C Step 1: Generate Critic Proxy Scores');
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

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    console.log(`\n⏳ Batch ${batchNum}/${totalBatches} (${batch.length} wines)...`);

    // Generate proxies for batch with rate limit handling
    let retries = 0;
    const maxRetries = 3;
    let proxyMap;

    while (retries < maxRetries) {
      try {
        proxyMap = await generateCriticProxiesBatch(
          batch.map((r) => ({
            canonicalLabel: r.canonicalLabel,
            searchTextEn: r.searchTextEn,
            body: r.body,
            acidity: r.acidity,
            tannin: r.tannin,
            region: r.region,
            grapePrimary: r.grapePrimary,
          })),
          client,
          5, // Reduce parallel requests to avoid rate limits
        );
        break;
      } catch (error) {
        // Check if it's a rate limit error
        if (error instanceof Error && error.message?.includes('rate_limit')) {
          retries++;
          if (retries < maxRetries) {
            const backoffMs = Math.pow(2, retries) * 30000; // 60s, 120s, 240s
            console.warn(`Rate limited. Waiting ${backoffMs / 1000}s before retry ${retries}/${maxRetries}...`);
            await new Promise((r) => setTimeout(r, backoffMs));
          } else {
            console.error(`Max retries exceeded for batch ${batchNum}`);
            proxyMap = new Map();
          }
        } else {
          throw error;
        }
      }
    }

    // Merge results back
    for (const record of batch) {
      const proxy = proxyMap.get(record.canonicalLabel);
      if (proxy) {
        enrichedRecords.push({
          ...record,
          criticProxy: proxy,
        });
        processed++;
      } else {
        enrichedRecords.push(record);
        failed++;
        console.warn(
          `  ⚠️  No proxy generated for: ${record.canonicalLabel}`,
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
  console.log('✅ Step 1 Complete: Critic Proxy Generation');
  console.log('='.repeat(60));
  console.log(`Total records: ${enrichedRecords.length}`);
  console.log(`Successfully enriched: ${processed}`);
  console.log(`Failed: ${failed}`);
  console.log(`New field: criticProxy (added to ${processed} records)`);
  console.log(`Output: ${DATA_FILE}`);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
