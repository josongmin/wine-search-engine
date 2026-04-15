export {
  type CanonicalEntityId,
  type DocumentId,
  type EntityId,
  type SourceRecordId,
  createCanonicalEntityId,
  createDocumentId,
  createEntityId,
  createSourceRecordId,
  isCanonicalPublicEntityId,
  isEntityId,
} from './entity-id.js';
export { DECISION_STATUSES, type DecisionStatus } from './decision-status.js';
export { NEXT_ACTIONS, type NextAction } from './next-action.js';
export { QUERY_CLASSES, type QueryClass } from './query-class.js';
export {
  type ConstraintOperator,
  type NormalizedConstraint,
  type ConstraintBundle,
} from './constraint-bundle.js';
export { type EvidenceStrength, type EvidenceItem } from './evidence-item.js';
export {
  type ConstraintAtom,
  type ConstraintTier,
  type ConstraintSourceKind,
  type ConstraintSemanticScope,
  type ConstraintConflictPolicy,
  CONSTRAINT_AUTHORITY_BY_SOURCE_KIND,
  liftToAtom,
  liftBundleToAtoms,
} from './constraint-atom.js';
export {
  type DecisionSnapshot,
  CORRUPTED_SNAPSHOT_ID,
  isCorruptedSnapshot,
} from './decision-snapshot.js';
export { type SignalSet } from './signal-set.js';
export {
  type ProvenanceShortfallCode,
  type ShortfallLayer,
  type RetrievalProvenanceShortfall,
  type DenseChannelShortfall,
  type EntityResolverShortfall,
  type ProvenanceClosureShortfall,
  type RerankerShortfall,
  type RerankQualityShortfall,
  type LtrShortfall,
  type ConstraintRelaxationShortfall,
  type LearnedMatcherShortfall,
  type SpecializedRouteShortfall,
  type MixedRouteShortfall,
  classifyShortfallLayer,
} from './provenance-shortfall-taxonomy.js';
