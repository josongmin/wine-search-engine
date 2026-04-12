#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import { parseNdjson } from './ndjson.js';
import type { EnrichedSilverRecord } from './types.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { ConflictResolver } from '../../src/domain/alias/service/conflict-resolver.js';
import type { AliasConflict, AliasConflictEntry } from '../../src/domain/alias/model/alias-conflict.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import {
  hashStableJson,
  serializeNdjson,
  type AliasSnapshotRecord,
  type AmbiguityRegistrySnapshotRow,
} from './search-snapshot-schema.js';
import { atomicWriteFile } from './etl-utils.js';
import { buildAliasArtifact } from './build-alias-artifact.js';
import { buildEntityIdBySourceId, loadGoldCanonicalLookupForBuild } from './snapshot-entity-identity.js';

const DEFAULT_INPUT = resolveDataPath('data/silver-ko.ndjson');
const DEFAULT_OUTPUT = resolveDataPath('data/ambiguity-registry.ndjson');

const TYPE_PRIORITY_WEIGHTS: Readonly<Record<string, number>> = {
  canonical: 1.0,
  translation: 0.95,
  phonetic: 0.85,
  misspelling: 0.6,
  observed_query_alias: 0.7,
  catalog_noise_alias: 0.4,
};

interface Args {
  readonly input: string;
  readonly output: string;
}

interface AliasClaim extends AliasSnapshotRecord {
  readonly sourceTrust: number;
}

function parseArgs(argv: readonly string[]): Args {
  let input = DEFAULT_INPUT;
  let output = DEFAULT_OUTPUT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      input = argv[i + 1] ?? DEFAULT_INPUT;
      i += 1;
    } else if (arg === '--output' || arg === '-o') {
      output = argv[i + 1] ?? DEFAULT_OUTPUT;
      i += 1;
    }
  }
  return { input, output };
}

function computeEntryScore(entry: AliasConflictEntry): number {
  const typeWeight = TYPE_PRIORITY_WEIGHTS[entry.aliasType] ?? 0;
  return typeWeight * entry.confidencePrior * entry.sourceTrust;
}

function chooseBestClaimPerEntity(claims: readonly AliasClaim[]): readonly AliasClaim[] {
  const grouped = new Map<string, AliasClaim>();
  for (const claim of claims) {
    const current = grouped.get(claim.entityId);
    if (current === undefined) {
      grouped.set(claim.entityId, claim);
      continue;
    }

    const candidateScore = computeEntryScore({
      entityId: createCanonicalEntityId(claim.entityId),
      aliasType: claim.type as AliasConflictEntry['aliasType'],
      confidencePrior: claim.confidencePrior,
      scope: claim.scope as AliasConflictEntry['scope'],
      sourceTrust: claim.sourceTrust,
    });
    const currentScore = computeEntryScore({
      entityId: createCanonicalEntityId(current.entityId),
      aliasType: current.type as AliasConflictEntry['aliasType'],
      confidencePrior: current.confidencePrior,
      scope: current.scope as AliasConflictEntry['scope'],
      sourceTrust: current.sourceTrust,
    });

    if (
      candidateScore > currentScore
      || (
        candidateScore === currentScore
        && (
          claim.aliasId.localeCompare(current.aliasId) < 0
          || (
            claim.aliasId === current.aliasId
            && claim.entityId.localeCompare(current.entityId) < 0
          )
        )
      )
    ) {
      grouped.set(claim.entityId, claim);
    }
  }

  return [...grouped.values()].sort((left, right) =>
    left.entityId.localeCompare(right.entityId) || left.aliasId.localeCompare(right.aliasId),
  );
}

function inferConflictTags(claims: readonly AliasClaim[]): readonly string[] {
  const tags = new Set<string>(['surface_form_collision']);
  for (const claim of claims) {
    if (claim.type === 'canonical' || claim.type === 'translation') {
      tags.add('high_authority_collision');
    }
    if (claim.type === 'phonetic') {
      tags.add('phonetic_collision');
    }
    if (claim.type === 'catalog_noise_alias') {
      tags.add('catalog_noise_collision');
    }
    if (claim.source.includes('short_name')) {
      tags.add('producer_short_name_collision');
    }
    if (claim.source.includes('no_vintage')) {
      tags.add('vintage_elided_collision');
    }
    if (claim.source.includes('translit')) {
      tags.add('transliteration_collision');
    }
  }
  return [...tags].sort((left, right) => left.localeCompare(right));
}

function inferSeverity(claims: readonly AliasClaim[]): 'low' | 'medium' | 'high' {
  const hasHighAuthority = claims.some((claim) => claim.type === 'canonical' || claim.type === 'translation');
  const entityCount = new Set(claims.map((claim) => claim.entityId)).size;
  if (hasHighAuthority || entityCount >= 3) {
    return 'high';
  }
  if (claims.some((claim) => claim.type === 'phonetic')) {
    return 'medium';
  }
  return 'medium';
}

function buildConflict(normalizedValue: string, claims: readonly AliasClaim[]): AliasConflict {
  const perEntityBest = chooseBestClaimPerEntity(claims);
  const conflictingEntities: readonly AliasConflictEntry[] = perEntityBest.map((claim) => ({
    entityId: createCanonicalEntityId(claim.entityId),
    aliasType: claim.type as AliasConflictEntry['aliasType'],
    confidencePrior: claim.confidencePrior,
    scope: claim.scope as AliasConflictEntry['scope'],
    sourceTrust: claim.sourceTrust,
  }));
  return {
    value: claims[0]?.value ?? normalizedValue,
    normalizedValue,
    conflictingEntities,
    conflictType: 'surface_form_collision',
    autoResolvable: false,
  };
}

export interface AliasConflictBuildResult {
  readonly resolvedAliases: readonly AliasSnapshotRecord[];
  readonly ambiguityRows: readonly AmbiguityRegistrySnapshotRow[];
}

export function resolveAliasClaimsAndBuildAmbiguityRegistry(
  aliases: readonly AliasSnapshotRecord[],
): AliasConflictBuildResult {
  const grouped = new Map<string, AliasClaim[]>();

  for (const alias of aliases) {
    const claim: AliasClaim = { ...alias, sourceTrust: 1.0 };
    const existing = grouped.get(alias.normalizedValue);
    if (existing === undefined) {
      grouped.set(alias.normalizedValue, [claim]);
    } else {
      existing.push(claim);
    }
  }

  const resolver = new ConflictResolver();
  const resolvedAliases: AliasSnapshotRecord[] = [];
  const ambiguityRows: AmbiguityRegistrySnapshotRow[] = [];

  const sortedKeys = [...grouped.keys()].sort((left, right) => left.localeCompare(right));
  for (const normalizedValue of sortedKeys) {
    const claims = grouped.get(normalizedValue) ?? [];
    const entityIds = [...new Set(claims.map((claim) => claim.entityId))].sort((left, right) =>
      left.localeCompare(right),
    );
    if (entityIds.length <= 1) {
      resolvedAliases.push(...claims);
      continue;
    }

    const conflict = buildConflict(normalizedValue, claims);
    const resolution = resolver.resolveConflict(conflict);
    if (resolution !== null) {
      resolvedAliases.push(
        ...claims.filter((claim) => claim.entityId === resolution.winnerId),
      );
      continue;
    }

    resolvedAliases.push(...claims);
    const tags = inferConflictTags(claims);
    const contentHash = hashStableJson({
      normalizedValue,
      entityIds,
      tags,
    });
    ambiguityRows.push({
      registryId: buildAmbiguityRegistryId(contentHash),
      normalizedForm: normalizedValue,
      entityIds,
      ambiguityTypes: tags,
      severity: inferSeverity(claims),
    });
  }

  resolvedAliases.sort((left, right) =>
    left.normalizedValue.localeCompare(right.normalizedValue)
    || left.entityId.localeCompare(right.entityId)
    || left.aliasId.localeCompare(right.aliasId),
  );
  ambiguityRows.sort((left, right) =>
    left.normalizedForm.localeCompare(right.normalizedForm)
    || left.registryId.localeCompare(right.registryId),
  );

  return { resolvedAliases, ambiguityRows };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const content = await fs.readFile(args.input, 'utf8');
  const { records } = parseNdjson<EnrichedSilverRecord>(content, args.input);
  const goldLookup = await loadGoldCanonicalLookupForBuild({});
  const entityIdBySourceId = buildEntityIdBySourceId(records, goldLookup);
  const aliases = buildAliasArtifact(records, entityIdBySourceId);
  const { ambiguityRows } = resolveAliasClaimsAndBuildAmbiguityRegistry(aliases);
  await atomicWriteFile(args.output, serializeNdjson(ambiguityRows));
  console.log(`Built ${ambiguityRows.length} ambiguity rows → ${args.output}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
function buildAmbiguityRegistryId(contentHash: string): string {
  return `ambiguity-registry:v1:${contentHash.slice(0, 16)}`;
}
