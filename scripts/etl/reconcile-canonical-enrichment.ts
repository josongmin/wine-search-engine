#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { atomicWriteFile } from './etl-utils.js';
import { parseNdjson } from './ndjson.js';
import {
  applyCanonicalEnrichmentOverlay,
  loadCanonicalEnrichmentOverlay,
} from './canonical-enrichment-overlay.js';
import type { EnrichedSilverRecord } from './types.js';
import {
  buildTrackCSourceState,
  TRACK_C_SOURCE_STATE_FILE,
} from './run-track-c.js';

const DEFAULT_TARGETS = [
  resolveDataPath('data/silver-enriched-ko.ndjson'),
  resolveDataPath('data/silver-docquery.ndjson'),
  resolveDataPath('data/silver-trackc.ndjson'),
] as const;

async function refreshTrackCSourceState(): Promise<void> {
  const docqueryPath = resolveDataPath('data/silver-docquery.ndjson');
  if (!existsSync(docqueryPath)) {
    return;
  }
  const raw = await fs.readFile(docqueryPath, 'utf8');
  const state = buildTrackCSourceState(docqueryPath, raw);
  await atomicWriteFile(TRACK_C_SOURCE_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function main(): Promise<void> {
  const overlay = await loadCanonicalEnrichmentOverlay({ required: true });
  const results = [];
  for (const target of DEFAULT_TARGETS) {
    if (!existsSync(target)) {
      continue;
    }
    const raw = await fs.readFile(target, 'utf8');
    const records = parseNdjson<EnrichedSilverRecord>(raw, target).records;
    let changedRecords = 0;
    const nextRecords = records.map((record) => {
      const next = applyCanonicalEnrichmentOverlay(record, overlay);
      if (JSON.stringify(next) !== JSON.stringify(record)) {
        changedRecords += 1;
      }
      return next;
    });
    if (changedRecords > 0) {
      await atomicWriteFile(
        target,
        `${nextRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    }
    results.push({ targetPath: target, changedRecords });
  }
  await refreshTrackCSourceState();
  for (const result of results) {
    console.log(`${result.targetPath}: changed_records=${result.changedRecords}`);
  }
  console.log(`track_c_source_state=${TRACK_C_SOURCE_STATE_FILE}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
