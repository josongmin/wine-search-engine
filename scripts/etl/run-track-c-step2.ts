#!/usr/bin/env tsx

/**
 * Track C Step 2: Enrich Certifications
 *
 * SOTA++ improvements: idempotent (skips already-enriched), atomic writes,
 * dead-letter queue for failures, periodic checkpoint flush.
 *
 * Usage: npx tsx --env-file=.env scripts/etl/run-track-c-step2.ts
 */

import 'dotenv/config';
import fs from 'node:fs';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { parseNdjson } from './ndjson.js';
import { enrichWineCertificationsBatch } from './enrich-certifications.js';
import { atomicWriteFileSync, appendDeadLetter, backupFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

interface SilverRecord {
  readonly sourceId?: string;
  readonly externalId: string;
  readonly producer: string;
  readonly searchTextEn: string;
  [key: string]: unknown;
}

interface CertificationResult {
  readonly organic: boolean;
  readonly biodynamic: boolean;
  readonly vegan: boolean;
  readonly naturalWine: boolean;
  readonly certificationSource: string;
  readonly certificationConfidence: string;
}

interface EnrichedRecord extends SilverRecord {
  readonly certifications?: CertificationResult;
  readonly certificationsExperimental?: CertificationResult;
}

export const DATA_FILE = ETL_ARTIFACT_FILES.trackc;
const DEAD_LETTER_FILE = resolveDataPath('.dead-letter-step2.ndjson');
const BATCH_SIZE = 100;
const FLUSH_INTERVAL = 5;

async function main() {
  console.log('Track C Step 2: Enrich Certifications (verified + experimental provenance split)');
  console.log(`  Input: ${DATA_FILE}`);

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`  File not found: ${DATA_FILE}`);
    throw new Error(`File not found: ${DATA_FILE}`);
  }

  const backupPath = await backupFile(DATA_FILE);
  try {
    const content = fs.readFileSync(DATA_FILE, 'utf-8');
    const { records, skipped } = parseNdjson<SilverRecord>(content, DATA_FILE);

    console.log(`  Loaded: ${records.length} records (${skipped} malformed lines)`);

    const alreadyDone = records.filter((r) => (r as EnrichedRecord).certifications != null).length;
    if (alreadyDone > 0) {
      console.log(`  Idempotency: ${alreadyDone} records already have certifications, skipping those`);
    }

    let processed = 0;
    let failed = 0;
    let skippedIdempotent = 0;
    const enrichedRecords: EnrichedRecord[] = [];

    let wikidataCount = 0;
    let keywordInferredCount = 0;
    let noneCount = 0;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(records.length / BATCH_SIZE);

      const toDo: SilverRecord[] = [];
      const done: EnrichedRecord[] = [];
      for (const r of batch) {
        if ((r as EnrichedRecord).certifications != null) {
          done.push(r as EnrichedRecord);
          skippedIdempotent++;
        } else {
          toDo.push(r);
        }
      }

      enrichedRecords.push(...done);

      if (toDo.length === 0) continue;

      console.log(`\n  Batch ${batchNum}/${totalBatches} (${toDo.length} to process)...`);

      const certMap = await enrichWineCertificationsBatch(
        toDo.map((r) => ({
          entityId: r.externalId,
          producer: r.producer,
          searchTextEn: r.searchTextEn,
        })),
        10,
      );

      for (const record of toDo) {
        const cert = certMap.get(record.externalId);
        if (cert) {
          const canonicalCertification: CertificationResult = cert.certificationSource === 'wikidata_verified'
            ? {
                organic: cert.organic,
                biodynamic: cert.biodynamic,
                vegan: cert.vegan,
                naturalWine: cert.naturalWine,
                certificationSource: cert.certificationSource,
                certificationConfidence: cert.certificationConfidence,
              }
            : {
                organic: false,
                biodynamic: false,
                vegan: false,
                naturalWine: false,
                certificationSource: 'none',
                certificationConfidence: 'none',
              };
          enrichedRecords.push({
            ...record,
            certifications: canonicalCertification,
            ...(cert.certificationSource === 'keyword_inferred'
              ? {
                  certificationsExperimental: {
                    organic: cert.organic,
                    biodynamic: cert.biodynamic,
                    vegan: cert.vegan,
                    naturalWine: cert.naturalWine,
                    certificationSource: cert.certificationSource,
                    certificationConfidence: cert.certificationConfidence,
                  },
                }
              : {}),
          });

          if (cert.certificationSource === 'wikidata_verified') wikidataCount++;
          else if (cert.certificationSource === 'keyword_inferred') keywordInferredCount++;
          else noneCount++;
          processed++;
        } else {
          enrichedRecords.push(record);
          failed++;
          const id = record.sourceId ?? record.externalId;
          await appendDeadLetter(DEAD_LETTER_FILE, {
            sourceId: id,
            step: 'certifications',
            error: 'No certification result',
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

    if (failed > 0) {
      throw new Error(`Refusing final write: ${failed} record(s) failed step 2`);
    }
    const output = enrichedRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
    atomicWriteFileSync(DATA_FILE, output);

    console.log('\n' + '='.repeat(60));
    console.log('Step 2 Complete: Certification Enrichment');
    console.log('='.repeat(60));
    console.log(`Total records: ${enrichedRecords.length}`);
    console.log(`New enrichments: ${processed}`);
    console.log(`  - Wikidata verified: ${wikidataCount}`);
    console.log(`  - Keyword inferred (experimental): ${keywordInferredCount}`);
    console.log(`  - None found: ${noneCount}`);
    console.log(`Already had certifications: ${skippedIdempotent}`);
    console.log(`Failed: ${failed}`);
    if (failed > 0) console.log(`Dead-letter log: ${DEAD_LETTER_FILE}`);
    console.log(`Output: ${DATA_FILE}`);
  } catch (error) {
    if (backupPath !== null) {
      fs.copyFileSync(backupPath, DATA_FILE);
    }
    throw error;
  } finally {
    if (backupPath !== null) {
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // best-effort cleanup only
      }
    }
  }
}

// Only execute when invoked directly as a CLI (not when imported by tests).
import { fileURLToPath as _fileURLToPath } from 'node:url';
const _invokedAsMain = process.argv[1] != null
  && _fileURLToPath(import.meta.url) === process.argv[1];
if (_invokedAsMain) {
  void main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
