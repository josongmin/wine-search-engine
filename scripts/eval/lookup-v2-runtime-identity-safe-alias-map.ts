import { readFileSync } from 'node:fs';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';

export const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');

interface RuntimeStateLike {
  readonly lookupEntityProjectionPath?: unknown;
}

interface LookupEntityProjectionRuntimeDocument {
  readonly entityId?: unknown;
  readonly aliasesIdentitySafe?: unknown;
}

interface LookupEntityProjectionRuntimeLike {
  readonly documents?: unknown;
}

function parseRuntimeState(raw: unknown): { readonly lookupEntityProjectionPath: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime identity-safe alias map: runtime state must be an object');
  }
  const parsed = raw as RuntimeStateLike;
  if (
    typeof parsed.lookupEntityProjectionPath !== 'string'
    || parsed.lookupEntityProjectionPath.trim().length === 0
  ) {
    throw new Error('runtime identity-safe alias map: runtime state missing lookupEntityProjectionPath');
  }
  return {
    lookupEntityProjectionPath: parsed.lookupEntityProjectionPath,
  };
}

function parseProjectionDocuments(raw: unknown): readonly LookupEntityProjectionRuntimeDocument[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime identity-safe alias map: entity projection must be an object');
  }
  const parsed = raw as LookupEntityProjectionRuntimeLike;
  if (!Array.isArray(parsed.documents)) {
    throw new Error('runtime identity-safe alias map: entity projection missing documents');
  }
  return parsed.documents as readonly LookupEntityProjectionRuntimeDocument[];
}

export function buildLookupV2RuntimeIdentitySafeAliasMap(
  documents: readonly LookupEntityProjectionRuntimeDocument[],
): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  const collisions = new Set<string>();

  for (const document of documents) {
    if (typeof document.entityId !== 'string' || document.entityId.trim().length === 0) {
      continue;
    }
    if (!Array.isArray(document.aliasesIdentitySafe)) {
      continue;
    }
    for (const alias of document.aliasesIdentitySafe) {
      if (typeof alias !== 'string') {
        continue;
      }
      const normalized = normalizeForMatch(alias);
      if (normalized.length === 0 || collisions.has(normalized)) {
        continue;
      }
      const existing = owners.get(normalized);
      if (existing === undefined) {
        owners.set(normalized, document.entityId);
        continue;
      }
      if (existing !== document.entityId) {
        owners.delete(normalized);
        collisions.add(normalized);
      }
    }
  }

  return owners;
}

export function loadLookupV2RuntimeIdentitySafeAliasMapSync(
  runtimeStatePath: string = DEFAULT_RUNTIME_STATE_PATH,
): ReadonlyMap<string, string> {
  const runtimeState = parseRuntimeState(JSON.parse(readFileSync(runtimeStatePath, 'utf8')) as unknown);
  const projectionDocuments = parseProjectionDocuments(
    JSON.parse(readFileSync(runtimeState.lookupEntityProjectionPath, 'utf8')) as unknown,
  );
  return buildLookupV2RuntimeIdentitySafeAliasMap(projectionDocuments);
}
