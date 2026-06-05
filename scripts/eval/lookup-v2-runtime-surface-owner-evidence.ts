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
  readonly aliasesIdentitySafe?: unknown;
  readonly aliasesNoisyRecall?: unknown;
}

interface LookupEntityProjectionRuntimeLike {
  readonly documents?: unknown;
}

export interface LookupV2RuntimeSurfaceOwnerEvidence {
  readonly uniqueOwners: ReadonlyMap<string, string>;
  readonly collidingOwners: ReadonlyMap<string, readonly string[]>;
  readonly entityLabels: ReadonlyMap<string, string>;
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

  for (const document of documents) {
    if (typeof document.entityId !== 'string' || document.entityId.trim().length === 0) {
      continue;
    }
    if (typeof document.canonicalLabel === 'string' && document.canonicalLabel.trim().length > 0) {
      entityLabels.set(document.entityId, document.canonicalLabel);
    }
    const surfaces = [
      document.canonicalLabel,
      ...(Array.isArray(document.aliasesIdentitySafe) ? document.aliasesIdentitySafe : []),
      ...(Array.isArray(document.aliasesNoisyRecall) ? document.aliasesNoisyRecall : []),
    ];
    for (const surface of surfaces) {
      if (typeof surface !== 'string') {
        continue;
      }
      const normalized = normalizeForMatch(surface);
      if (normalized.length === 0) {
        continue;
      }
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

  return {
    uniqueOwners,
    collidingOwners: new Map(
      [...collidingOwners.entries()].map(([normalized, owners]) => [normalized, [...owners].sort((l, r) => l.localeCompare(r))]),
    ),
    entityLabels,
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
