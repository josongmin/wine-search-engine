#!/usr/bin/env tsx

/**
 * Track C Step 1: Generate Critic Proxy Scores
 *
 * Reads silver-trackc.ndjson, generates LLM-based critic proxy scores,
 * and writes back enriched records with `criticProxy` field.
 *
 * SOTA++ improvements:
 * - Idempotent: skips records that already have criticProxy
 * - Atomic writes: tmp+rename prevents corruption on crash
 * - Dead-letter queue: failed records logged for retry
 * - Per-batch flush: progress is preserved even on mid-run crash
 *
 * Usage: npx tsx --env-file=.env scripts/etl/run-track-c-step1.ts
 */

import 'dotenv/config';
import fs from 'node:fs';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { Anthropic } from '@anthropic-ai/sdk';
import { parseNdjson } from './ndjson.js';
import { generateCriticProxiesBatch } from './generate-critic-proxy.js';
import { atomicWriteFileSync, appendDeadLetter, backupFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

interface SilverRecord {
  readonly sourceId?: string;
  readonly externalId?: string;
  readonly canonicalLabel: string;
  readonly searchTextEn: string;
  readonly body?: number;
  readonly acidity?: number;
  readonly tannin?: number;
  readonly region?: string;
  readonly grapePrimary?: string;
  [key: string]: unknown;
}

interface CriticProxyResult {
  readonly proxyScore: number;
  readonly scoreTier: string;
  readonly confidence: string;
  readonly reasoningSignals: string[];
  readonly isSynthetic: boolean;
}

interface EnrichedRecord extends SilverRecord {
  readonly criticProxy?: CriticProxyResult;
}

export const DATA_FILE = ETL_ARTIFACT_FILES.trackc;
const DEAD_LETTER_FILE = resolveDataPath('.dead-letter-step1.ndjson');
const BATCH_SIZE = 100;
const FLUSH_INTERVAL = 5; // flush every N batches

async function main() {
  console.log('Track C Step 1: Generate Critic Proxy Scores');
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

    // Idempotency: count already-processed records
    const alreadyDone = records.filter((r) => (r as EnrichedRecord).criticProxy != null).length;
    if (alreadyDone > 0) {
      console.log(`  Idempotency: ${alreadyDone} records already have criticProxy, skipping those`);
    }

    const client = new Anthropic({
      apiKey: process.env['ANTHROPIC_API_KEY'],
    });

    let processed = 0;
    let failed = 0;
    let skippedIdempotent = 0;
    const enrichedRecords: EnrichedRecord[] = [];

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(records.length / BATCH_SIZE);

      // Separate already-done from to-process
      const toDo: SilverRecord[] = [];
      const done: EnrichedRecord[] = [];
      for (const r of batch) {
        if ((r as EnrichedRecord).criticProxy != null) {
          done.push(r as EnrichedRecord);
          skippedIdempotent++;
        } else {
          toDo.push(r);
        }
      }

      // Pass through already-enriched records
      enrichedRecords.push(...done);

      if (toDo.length === 0) {
        continue;
      }

      console.log(`\n  Batch ${batchNum}/${totalBatches} (${toDo.length} to process, ${done.length} already done)...`);

      let proxyMap = new Map<string, CriticProxyResult>();
      let retries = 0;
      const maxRetries = 3;

      while (retries < maxRetries) {
        try {
          proxyMap = await generateCriticProxiesBatch(
            toDo.map((r) => ({
              canonicalLabel: r.canonicalLabel,
              searchTextEn: r.searchTextEn,
              ...(r.body !== undefined ? { body: String(r.body) } : {}),
              ...(r.acidity !== undefined ? { acidity: String(r.acidity) } : {}),
              ...(r.tannin !== undefined ? { tannin: String(r.tannin) } : {}),
              ...(r.region !== undefined ? { region: r.region } : {}),
              ...(r.grapePrimary !== undefined ? { grapePrimary: r.grapePrimary } : {}),
            })),
            client,
            5,
          );
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('rate_limit') || msg.includes('429') || msg.includes('overloaded')) {
            retries++;
            if (retries < maxRetries) {
              const backoffMs = Math.pow(2, retries) * 30000;
              console.warn(`  Rate limited. Waiting ${backoffMs / 1000}s before retry ${retries}/${maxRetries}...`);
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            } else {
              console.error(`  Max retries exceeded for batch ${batchNum}`);
            }
          } else {
            throw error;
          }
        }
      }

      // Merge results back
      for (const record of toDo) {
        const proxy = proxyMap.get(record.canonicalLabel);
        if (proxy) {
          enrichedRecords.push({ ...record, criticProxy: proxy });
          processed++;
        } else {
          enrichedRecords.push(record);
          failed++;
          // Log to dead-letter queue for later analysis
          const id = record.sourceId ?? record.externalId ?? record.canonicalLabel;
          await appendDeadLetter(DEAD_LETTER_FILE, {
            sourceId: id,
            step: 'critic-proxy',
            error: 'No proxy generated by LLM',
          });
        }
      }

      // Periodic flush: save progress every N batches
      if (batchNum % FLUSH_INTERVAL === 0) {
        const output = enrichedRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
        atomicWriteFileSync(DATA_FILE, output);
        console.log(`  [checkpoint] Flushed ${enrichedRecords.length} records to disk`);
      }

      const pct = Math.round((enrichedRecords.length) / records.length * 100);
      console.log(
        `  Processed: ${processed}/${records.length} (${pct}%) | Failed: ${failed} | Skipped: ${skippedIdempotent}`,
      );
    }

    // Final write (atomic)
    if (failed > 0) {
      throw new Error(`Refusing final write: ${failed} record(s) failed step 1`);
    }
    const output = enrichedRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
    atomicWriteFileSync(DATA_FILE, output);

    console.log('\n' + '='.repeat(60));
    console.log('Step 1 Complete: Critic Proxy Generation');
    console.log('='.repeat(60));
    console.log(`Total records: ${enrichedRecords.length}`);
    console.log(`New enrichments: ${processed}`);
    console.log(`Already had criticProxy: ${skippedIdempotent}`);
    console.log(`Failed: ${failed}`);
    if (failed > 0) {
      console.log(`Dead-letter log: ${DEAD_LETTER_FILE}`);
    }
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
