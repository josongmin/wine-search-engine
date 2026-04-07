// ── Models ──────────────────────────────────────────────────────────────────
export { ENTITY_TYPES, type EntityType, isEntityType } from './model/entity-type.js';
export type { Relations } from './model/relations.js';
export type { EntityAttributes } from './model/attributes.js';
export {
  type Entity,
  type EntityMetadata,
  type CreateEntityParams,
  EntityInvariantError,
  createEntity,
} from './model/entity.js';
export {
  computeIdentitySignature,
  type SignatureParams,
} from './model/identity-signature.js';

// ── Ports ───────────────────────────────────────────────────────────────────
export type { EntityRepository } from './port/entity-repository.port.js';

// ── Services ────────────────────────────────────────────────────────────────
export {
  canMerge,
  merge,
  canSplit,
  type MergeDecision,
} from './service/merge.service.js';
export {
  computeValidatedSignature,
  type SignatureResult,
} from './service/identity-signature.service.js';
export {
  TraversalService,
  type TraversalOptions,
  type TraversalEdge,
  type TraversalResult,
} from './service/traversal.service.js';
export {
  buildProjection,
  type AliasSet,
  type RetrievalDocumentInput,
  type RetrievalFacets,
} from './service/projection-builder.js';
