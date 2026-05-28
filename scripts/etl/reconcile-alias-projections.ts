#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { atomicWriteFile } from './etl-utils.js';
import { parseNdjson } from './ndjson.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';
import type { AliasBundle, EnrichedSilverRecord, ProposedAlias } from './types.js';
import { isKoreanHangulAliasCandidate } from './generate-korean-aliases.js';
import { generateAliases } from './generate-aliases.js';
import {
  buildTrackCSourceState,
  TRACK_C_SOURCE_STATE_FILE,
} from './run-track-c.js';

const IDENTITY_SAFE_THRESHOLD = 0.8;
const KOREAN_ALIAS_SOURCE = 'llm:ko_translit_v1';

const DEFAULT_TARGETS = [
  ETL_ARTIFACT_FILES.ko,
  ETL_ARTIFACT_FILES.docquery,
  ETL_ARTIFACT_FILES.trackc,
] as const;

function aliasNaturalKey(alias: ProposedAlias): string {
  return [
    alias.type,
    alias.source,
    alias.value.trim().normalize('NFC'),
  ].join('\n');
}

function shouldPreserveCurrentProposal(alias: ProposedAlias): boolean {
  return alias.source === KOREAN_ALIAS_SOURCE && isKoreanHangulAliasCandidate(alias.value);
}

function isVivinoSourceRecord(record: EnrichedSilverRecord): boolean {
  return record.sourceId.startsWith('vivino-');
}

export function reconcileAliasBundle(
  authoritative: AliasBundle,
  current: AliasBundle,
): AliasBundle {
  const proposed: ProposedAlias[] = [];
  const seen = new Set<string>();

  for (const alias of authoritative.proposed) {
    const key = aliasNaturalKey(alias);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    proposed.push(alias);
  }

  for (const alias of current.proposed) {
    if (!shouldPreserveCurrentProposal(alias)) {
      continue;
    }
    const key = aliasNaturalKey(alias);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    proposed.push(alias);
  }

  const identitySafeProjection = [...new Set(
    proposed
      .filter((alias) => alias.confidencePrior >= IDENTITY_SAFE_THRESHOLD && !alias.needsReview)
      .map((alias) => alias.value),
  )];

  const noisyRecallProjection = [...new Set(
    proposed
      .filter((alias) => alias.confidencePrior < IDENTITY_SAFE_THRESHOLD || alias.needsReview)
      .map((alias) => alias.value),
  )];

  return {
    proposed,
    identitySafeProjection,
    noisyRecallProjection,
  };
}

export function reconcileAliasProjectionRecord(
  record: EnrichedSilverRecord,
  authoritativeBySourceId: ReadonlyMap<string, AliasBundle>,
): EnrichedSilverRecord {
  const authoritative = authoritativeBySourceId.get(record.sourceId)
    ?? (isVivinoSourceRecord(record) ? generateAliases(record) : undefined);
  if (authoritative === undefined) {
    return record;
  }

  const nextAliases = reconcileAliasBundle(authoritative, record.aliases);
  if (JSON.stringify(nextAliases) === JSON.stringify(record.aliases)) {
    return record;
  }

  return {
    ...record,
    aliases: nextAliases,
  };
}

async function refreshTrackCSourceState(): Promise<void> {
  if (!existsSync(ETL_ARTIFACT_FILES.docquery)) {
    return;
  }
  const raw = await fs.readFile(ETL_ARTIFACT_FILES.docquery, 'utf8');
  const state = buildTrackCSourceState(ETL_ARTIFACT_FILES.docquery, raw);
  await atomicWriteFile(TRACK_C_SOURCE_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function main(): Promise<void> {
  const authoritativeRaw = await fs.readFile(ETL_ARTIFACT_FILES.aliases, 'utf8');
  const authoritativeRecords = parseNdjson<EnrichedSilverRecord>(
    authoritativeRaw,
    ETL_ARTIFACT_FILES.aliases,
  ).records;
  const authoritativeBySourceId = new Map(
    authoritativeRecords.map((record) => [record.sourceId, record.aliases] as const),
  );

  const results: Array<{ targetPath: string; changedRecords: number }> = [];

  for (const targetPath of DEFAULT_TARGETS) {
    if (!existsSync(targetPath)) {
      continue;
    }
    const raw = await fs.readFile(targetPath, 'utf8');
    const records = parseNdjson<EnrichedSilverRecord>(raw, targetPath).records;
    let changedRecords = 0;
    const nextRecords = records.map((record) => {
      const next = reconcileAliasProjectionRecord(record, authoritativeBySourceId);
      if (JSON.stringify(next) !== JSON.stringify(record)) {
        changedRecords += 1;
      }
      return next;
    });

    if (changedRecords > 0) {
      await atomicWriteFile(
        targetPath,
        `${nextRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    }
    results.push({ targetPath, changedRecords });
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
