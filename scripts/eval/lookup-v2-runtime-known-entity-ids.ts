import { readFileSync } from 'node:fs';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';

export const DEFAULT_RUNTIME_STATE_PATH = resolveDataPath('data/runtime-search-snapshot.json');

interface RuntimeStateLike {
  readonly lookupEntityProjectionPath?: unknown;
}

interface LookupEntityProjectionRuntimeDocument {
  readonly entityId?: unknown;
}

interface LookupEntityProjectionRuntimeLike {
  readonly documents?: unknown;
}

function parseRuntimeState(raw: unknown): { readonly lookupEntityProjectionPath: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime known entity ids: runtime state must be an object');
  }
  const parsed = raw as RuntimeStateLike;
  if (
    typeof parsed.lookupEntityProjectionPath !== 'string'
    || parsed.lookupEntityProjectionPath.trim().length === 0
  ) {
    throw new Error('runtime known entity ids: runtime state missing lookupEntityProjectionPath');
  }
  return {
    lookupEntityProjectionPath: parsed.lookupEntityProjectionPath,
  };
}

function parseProjectionDocuments(raw: unknown): readonly LookupEntityProjectionRuntimeDocument[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime known entity ids: entity projection must be an object');
  }
  const parsed = raw as LookupEntityProjectionRuntimeLike;
  if (!Array.isArray(parsed.documents)) {
    throw new Error('runtime known entity ids: entity projection missing documents');
  }
  return parsed.documents as readonly LookupEntityProjectionRuntimeDocument[];
}

export function loadLookupV2RuntimeKnownEntityIdsSync(
  runtimeStatePath: string = DEFAULT_RUNTIME_STATE_PATH,
): ReadonlySet<string> {
  const runtimeState = parseRuntimeState(JSON.parse(readFileSync(runtimeStatePath, 'utf8')) as unknown);
  const projectionDocuments = parseProjectionDocuments(
    JSON.parse(readFileSync(runtimeState.lookupEntityProjectionPath, 'utf8')) as unknown,
  );

  return new Set(
    projectionDocuments
      .map((document) => typeof document.entityId === 'string' ? document.entityId.trim() : '')
      .filter((entityId) => entityId.length > 0),
  );
}
