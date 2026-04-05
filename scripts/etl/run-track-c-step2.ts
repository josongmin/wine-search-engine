#!/usr/bin/env tsx

/**
 * Track C Step 2: Enrich Certifications
 *
 * Reads silver-docquery.ndjson with critic proxies, enriches with
 * organic/biodynamic/vegan/natural certification data via Wikidata SPARQL + LLM fallback.
 *
 * Usage: npx tsx --env-file=.env scripts/etl/run-track-c-step2.ts
 *
 * Input: data/silver-docquery.ndjson (with criticProxy field)
 * Output: data/silver-docquery.ndjson (with certifications field added)
 * Error handling: LLM fallback for SPARQL failures, continues processing
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseNdjson } from './ndjson';
import { enrichWineCertificationsBatch } from './enrich-certifications';

interface SilverRecord {
  readonly externalId: string;
  readonly producer: string;
  readonly searchTextEn: string;
  [key: string]: unknown;
}

interface EnrichedRecord extends SilverRecord {
  readonly certifications?: {
    readonly organic: boolean;
    readonly biodynamic: boolean;
    readonly vegan: boolean;
    readonly naturalWine: boolean;
    readonly certificationSource: string;
    readonly certificationConfidence: string;
  };
}

const DATA_FILE = path.resolve('./data/silver-docquery.ndjson');
const BATCH_SIZE = 100;

async function main() {
  console.log('🍷 Track C Step 2: Enrich Certifications (Wikidata + LLM)');
  console.log(`📄 Input: ${DATA_FILE}`);

  // Load data
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ File not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(DATA_FILE, 'utf-8');
  const { records, skipped } = parseNdjson<SilverRecord>(content, DATA_FILE);

  console.log(`📊 Loaded: ${records.length} records (${skipped} malformed lines)`);

  // Process in batches
  let processed = 0;
  let failed = 0;
  const enrichedRecords: EnrichedRecord[] = [];

  let wikidata_count = 0;
  let llm_inferred_count = 0;
  let none_count = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    console.log(`\n⏳ Batch ${batchNum}/${totalBatches} (${batch.length} wines)...`);

    // Enrich certifications for batch
    const certMap = await enrichWineCertificationsBatch(
      batch.map((r) => ({
        entityId: r.externalId,
        producer: r.producer,
        searchTextEn: r.searchTextEn,
      })),
      10,
    );

    // Merge results back
    for (const record of batch) {
      const cert = certMap.get(record.externalId);
      if (cert) {
        enrichedRecords.push({
          ...record,
          certifications: {
            organic: cert.organic,
            biodynamic: cert.biodynamic,
            vegan: cert.vegan,
            naturalWine: cert.naturalWine,
            certificationSource: cert.certificationSource,
            certificationConfidence: cert.certificationConfidence,
          },
        });

        if (cert.certificationSource === 'wikidata') {
          wikidata_count++;
        } else if (cert.certificationSource === 'llm_inferred') {
          llm_inferred_count++;
        } else {
          none_count++;
        }
        processed++;
      } else {
        enrichedRecords.push(record);
        failed++;
        console.warn(`  ⚠️  No certifications for: ${record.externalId}`);
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
  console.log('✅ Step 2 Complete: Certification Enrichment');
  console.log('='.repeat(60));
  console.log(`Total records: ${enrichedRecords.length}`);
  console.log(`Successfully enriched: ${processed}`);
  console.log(`  - Wikidata: ${wikidata_count}`);
  console.log(`  - LLM inferred: ${llm_inferred_count}`);
  console.log(`  - None found: ${none_count}`);
  console.log(`Failed: ${failed}`);
  console.log(`New field: certifications (added to ${processed} records)`);
  console.log(`Output: ${DATA_FILE}`);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
