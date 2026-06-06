import { readFileSync } from 'node:fs';
import type { LookupEntityProjectionDocument } from '../../src/domain/shared/types/search-snapshot-lookup-runtime.js';
import {
  buildLookupSemanticDescriptorMapFromProjectionDocuments,
} from '../../src/domain/resolver/v2/lookup-semantic-scope.js';
import { DEFAULT_RUNTIME_STATE_PATH } from './lookup-v2-runtime-known-entity-ids.js';

interface RuntimeStateLike {
  readonly lookupEntityProjectionPath?: unknown;
}

interface LookupEntityProjectionRuntimeLike {
  readonly documents?: unknown;
}

function parseRuntimeState(raw: unknown): { readonly lookupEntityProjectionPath: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime semantic descriptors: runtime state must be an object');
  }
  const parsed = raw as RuntimeStateLike;
  if (
    typeof parsed.lookupEntityProjectionPath !== 'string'
    || parsed.lookupEntityProjectionPath.trim().length === 0
  ) {
    throw new Error('runtime semantic descriptors: runtime state missing lookupEntityProjectionPath');
  }
  return {
    lookupEntityProjectionPath: parsed.lookupEntityProjectionPath,
  };
}

function parseProjectionDocuments(raw: unknown): readonly LookupEntityProjectionDocument[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('runtime semantic descriptors: entity projection must be an object');
  }
  const parsed = raw as LookupEntityProjectionRuntimeLike;
  if (!Array.isArray(parsed.documents)) {
    throw new Error('runtime semantic descriptors: entity projection missing documents');
  }
  return parsed.documents as readonly LookupEntityProjectionDocument[];
}

export interface LookupV2RuntimeSemanticDescriptor {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly familyKey: string;
  readonly producerKey?: string | undefined;
  readonly lineKey?: string | undefined;
  readonly regionKey?: string | undefined;
  readonly appellationKey?: string | undefined;
  readonly vintage?: number | undefined;
}

export function buildLookupV2RuntimeSemanticDescriptorMapFromDocuments(
  projectionDocuments: readonly LookupEntityProjectionDocument[],
): ReadonlyMap<string, LookupV2RuntimeSemanticDescriptor> {
  const descriptors = new Map<string, LookupV2RuntimeSemanticDescriptor>();
  const descriptorMap = buildLookupSemanticDescriptorMapFromProjectionDocuments(projectionDocuments);
  for (const document of projectionDocuments) {
    const entityId = document.entityId.trim();
    const descriptor = descriptorMap.get(entityId);
    if (entityId.length === 0 || descriptor === undefined) {
      continue;
    }
    descriptors.set(entityId, {
      entityId,
      canonicalLabel: document.canonicalLabel,
      ...descriptor,
    });
  }
  return descriptors;
}

export function loadLookupV2RuntimeSemanticDescriptorMapSync(
  runtimeStatePath: string = DEFAULT_RUNTIME_STATE_PATH,
): ReadonlyMap<string, LookupV2RuntimeSemanticDescriptor> {
  const runtimeState = parseRuntimeState(JSON.parse(readFileSync(runtimeStatePath, 'utf8')) as unknown);
  const projectionDocuments = parseProjectionDocuments(
    JSON.parse(readFileSync(runtimeState.lookupEntityProjectionPath, 'utf8')) as unknown,
  );
  return buildLookupV2RuntimeSemanticDescriptorMapFromDocuments(projectionDocuments);
}
