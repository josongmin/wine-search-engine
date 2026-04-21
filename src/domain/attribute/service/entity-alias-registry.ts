import type { EntityType } from './entity-resolver.js';
import type { AmbiguousEntityHintSpec } from '../model/ambiguous-entity-hint.js';
import {
  CURATED_ENTITY_ALIAS_CATALOG,
  type EntityAliasProvenance,
  type EntityResolutionMode,
} from './entity-alias-catalog.js';

interface CuratedAlias {
  readonly surface: string;
  readonly canonicalValue: string;
  readonly entityType: EntityType;
  readonly confidence: number;
  readonly provenance: EntityAliasProvenance;
  readonly resolutionMode: EntityResolutionMode;
  readonly ambiguityHint?: AmbiguousEntityHintSpec | undefined;
}

export const CURATED_ENTITY_ALIASES: readonly CuratedAlias[] = CURATED_ENTITY_ALIAS_CATALOG.map((entry) => ({
  surface: entry.surface,
  canonicalValue: entry.canonicalValue,
  entityType: entry.mappedAttribute,
  confidence: entry.mappingConfidence,
  provenance: entry.provenance,
  resolutionMode: entry.resolutionMode,
  ...(entry.ambiguityHint !== undefined ? { ambiguityHint: entry.ambiguityHint } : {}),
}));
