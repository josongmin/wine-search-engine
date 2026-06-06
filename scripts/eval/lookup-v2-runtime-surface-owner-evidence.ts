import { readFileSync } from 'node:fs';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';

export const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');

interface RuntimeStateLike {
  readonly lookupEntityProjectionPath?: unknown;
}

interface LookupEntityProjectionRuntimeDocument {
  readonly entityId?: unknown;
  readonly canonicalLabel?: unknown;
  readonly producer?: unknown;
  readonly familyCoreKeys?: unknown;
  readonly aliasesIdentitySafe?: unknown;
  readonly aliasesNoisyRecall?: unknown;
}

interface LookupEntityProjectionRuntimeLike {
  readonly documents?: unknown;
}

export type LookupV2RuntimeSurfaceOwnerWitnessSource =
  | 'canonical_label'
  | 'producer'
  | 'family_core_key'
  | 'aliases_identity_safe'
  | 'aliases_noisy_recall';

export interface LookupV2RuntimeSurfaceOwnerWitness {
  readonly entityId: string;
  readonly witnessSurface: string;
  readonly witnessSource: LookupV2RuntimeSurfaceOwnerWitnessSource;
}

export interface LookupV2RuntimeSurfaceOwnerEvidence {
  readonly uniqueOwners: ReadonlyMap<string, string>;
  readonly collidingOwners: ReadonlyMap<string, readonly string[]>;
  readonly entityLabels: ReadonlyMap<string, string>;
  readonly uniqueOwnerWitnesses: ReadonlyMap<string, readonly LookupV2RuntimeSurfaceOwnerWitness[]>;
  readonly collidingOwnerWitnesses: ReadonlyMap<string, readonly LookupV2RuntimeSurfaceOwnerWitness[]>;
}

function parseRuntimeState(raw: unknown): { readonly lookupEntityProjectionPath: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime surface owner evidence: runtime state must be an object');
  }
  const parsed = raw as RuntimeStateLike;
  if (
    typeof parsed.lookupEntityProjectionPath !== 'string'
    || parsed.lookupEntityProjectionPath.trim().length === 0
  ) {
    throw new Error('runtime surface owner evidence: runtime state missing lookupEntityProjectionPath');
  }
  return {
    lookupEntityProjectionPath: parsed.lookupEntityProjectionPath,
  };
}

function parseProjectionDocuments(raw: unknown): readonly LookupEntityProjectionRuntimeDocument[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime surface owner evidence: entity projection must be an object');
  }
  const parsed = raw as LookupEntityProjectionRuntimeLike;
  if (!Array.isArray(parsed.documents)) {
    throw new Error('runtime surface owner evidence: entity projection missing documents');
  }
  return parsed.documents as readonly LookupEntityProjectionRuntimeDocument[];
}

export function buildLookupV2RuntimeSurfaceOwnerEvidence(
  documents: readonly LookupEntityProjectionRuntimeDocument[],
): LookupV2RuntimeSurfaceOwnerEvidence {
  const uniqueOwners = new Map<string, string>();
  const collidingOwners = new Map<string, Set<string>>();
  const entityLabels = new Map<string, string>();
  const witnessBuckets = new Map<string, LookupV2RuntimeSurfaceOwnerWitness[]>();

  const appendWitness = (
    normalized: string,
    witness: LookupV2RuntimeSurfaceOwnerWitness,
  ): void => {
    const existing = witnessBuckets.get(normalized) ?? [];
    if (
      existing.some((candidate) =>
        candidate.entityId === witness.entityId
        && candidate.witnessSurface === witness.witnessSurface
        && candidate.witnessSource === witness.witnessSource,
      )
    ) {
      witnessBuckets.set(normalized, existing);
      return;
    }
    witnessBuckets.set(normalized, [...existing, witness]);
  };

  for (const document of documents) {
    if (typeof document.entityId !== 'string' || document.entityId.trim().length === 0) {
      continue;
    }
    if (typeof document.canonicalLabel === 'string' && document.canonicalLabel.trim().length > 0) {
      entityLabels.set(document.entityId, document.canonicalLabel);
    }
    const surfaces: readonly {
      readonly value: unknown;
      readonly source: LookupV2RuntimeSurfaceOwnerWitnessSource;
    }[] = [
      { value: document.canonicalLabel, source: 'canonical_label' },
      { value: document.producer, source: 'producer' },
      ...(Array.isArray(document.familyCoreKeys)
        ? document.familyCoreKeys.map((value) => ({
            value,
            source: 'family_core_key' as const,
          }))
        : []),
      ...(Array.isArray(document.aliasesIdentitySafe)
        ? document.aliasesIdentitySafe.map((value) => ({
            value,
            source: 'aliases_identity_safe' as const,
          }))
        : []),
      ...(Array.isArray(document.aliasesNoisyRecall)
        ? document.aliasesNoisyRecall.map((value) => ({
            value,
            source: 'aliases_noisy_recall' as const,
          }))
        : []),
    ];
    for (const surface of surfaces) {
      if (typeof surface.value !== 'string') {
        continue;
      }
      const normalized = normalizeForMatch(surface.value);
      if (normalized.length === 0) {
        continue;
      }
      appendWitness(normalized, {
        entityId: document.entityId,
        witnessSurface: surface.value,
        witnessSource: surface.source,
      });
      const existingCollision = collidingOwners.get(normalized);
      if (existingCollision !== undefined) {
        existingCollision.add(document.entityId);
        continue;
      }
      const existingOwner = uniqueOwners.get(normalized);
      if (existingOwner === undefined) {
        uniqueOwners.set(normalized, document.entityId);
        continue;
      }
      if (existingOwner !== document.entityId) {
        uniqueOwners.delete(normalized);
        collidingOwners.set(normalized, new Set([existingOwner, document.entityId]));
      }
    }
  }

  const sortWitnesses = (
    witnesses: readonly LookupV2RuntimeSurfaceOwnerWitness[],
  ): readonly LookupV2RuntimeSurfaceOwnerWitness[] =>
    [...witnesses].sort((left, right) =>
      left.entityId.localeCompare(right.entityId)
      || left.witnessSource.localeCompare(right.witnessSource)
      || left.witnessSurface.localeCompare(right.witnessSurface),
    );

  const uniqueOwnerWitnesses = new Map<string, readonly LookupV2RuntimeSurfaceOwnerWitness[]>();
  for (const [normalized, entityId] of uniqueOwners.entries()) {
    const witnesses = witnessBuckets.get(normalized) ?? [];
    uniqueOwnerWitnesses.set(
      normalized,
      sortWitnesses(witnesses.filter((witness) => witness.entityId === entityId)),
    );
  }

  const collidingOwnerWitnesses = new Map<string, readonly LookupV2RuntimeSurfaceOwnerWitness[]>();
  for (const [normalized, owners] of collidingOwners.entries()) {
    const ownerSet = owners;
    const witnesses = witnessBuckets.get(normalized) ?? [];
    collidingOwnerWitnesses.set(
      normalized,
      sortWitnesses(witnesses.filter((witness) => ownerSet.has(witness.entityId))),
    );
  }

  return {
    uniqueOwners,
    collidingOwners: new Map(
      [...collidingOwners.entries()].map(([normalized, owners]) => [normalized, [...owners].sort((l, r) => l.localeCompare(r))]),
    ),
    entityLabels,
    uniqueOwnerWitnesses,
    collidingOwnerWitnesses,
  };
}

export function loadLookupV2RuntimeSurfaceOwnerEvidenceSync(
  runtimeStatePath: string = DEFAULT_RUNTIME_STATE_PATH,
): LookupV2RuntimeSurfaceOwnerEvidence {
  const runtimeState = parseRuntimeState(JSON.parse(readFileSync(runtimeStatePath, 'utf8')) as unknown);
  const projectionDocuments = parseProjectionDocuments(
    JSON.parse(readFileSync(runtimeState.lookupEntityProjectionPath, 'utf8')) as unknown,
  );
  return buildLookupV2RuntimeSurfaceOwnerEvidence(projectionDocuments);
}
