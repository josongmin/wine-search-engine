import { readFileSync } from 'node:fs';
import type { LookupEntityProjectionDocument } from '../../src/domain/shared/types/search-snapshot-lookup-runtime.js';
import {
  buildLookupV2RuntimeSemanticDescriptorMapFromDocuments,
  type LookupV2RuntimeSemanticDescriptor,
} from './lookup-v2-runtime-semantic-descriptors.js';
import { DEFAULT_RUNTIME_STATE_PATH } from './lookup-v2-runtime-known-entity-ids.js';

interface RuntimeStateLike {
  readonly lookupEntityProjectionPath?: unknown;
}

interface LookupEntityProjectionRuntimeLike {
  readonly documents?: unknown;
}

function parseRuntimeState(raw: unknown): { readonly lookupEntityProjectionPath: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime registry context: runtime state must be an object');
  }
  const parsed = raw as RuntimeStateLike;
  if (
    typeof parsed.lookupEntityProjectionPath !== 'string'
    || parsed.lookupEntityProjectionPath.trim().length === 0
  ) {
    throw new Error('runtime registry context: runtime state missing lookupEntityProjectionPath');
  }
  return {
    lookupEntityProjectionPath: parsed.lookupEntityProjectionPath,
  };
}

function parseProjectionDocuments(raw: unknown): readonly LookupEntityProjectionDocument[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime registry context: entity projection must be an object');
  }
  const parsed = raw as LookupEntityProjectionRuntimeLike;
  if (!Array.isArray(parsed.documents)) {
    throw new Error('runtime registry context: entity projection missing documents');
  }
  return parsed.documents as readonly LookupEntityProjectionDocument[];
}

export interface LookupV2RuntimeRegistryContext {
  readonly runtimeStatePath: string;
  readonly knownEntityIds: ReadonlySet<string>;
  readonly runtimeDescriptorMap: ReadonlyMap<string, LookupV2RuntimeSemanticDescriptor>;
}

export function loadLookupV2RuntimeRegistryContextSync(
  runtimeStatePath: string = DEFAULT_RUNTIME_STATE_PATH,
): LookupV2RuntimeRegistryContext {
  const runtimeState = parseRuntimeState(JSON.parse(readFileSync(runtimeStatePath, 'utf8')) as unknown);
  const projectionDocuments = parseProjectionDocuments(
    JSON.parse(readFileSync(runtimeState.lookupEntityProjectionPath, 'utf8')) as unknown,
  );
  return {
    runtimeStatePath,
    knownEntityIds: new Set(
      projectionDocuments
        .map((document) => document.entityId.trim())
        .filter((entityId) => entityId.length > 0),
    ),
    runtimeDescriptorMap: buildLookupV2RuntimeSemanticDescriptorMapFromDocuments(projectionDocuments),
  };
}
