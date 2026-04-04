import type { EntityId } from '../../shared/types/index.js';
import type { AliasType, AliasScope } from './alias.js';

/**
 * An entry representing one entity that claims an alias value.
 */
export interface AliasConflictEntry {
  /** The entity claiming this alias. */
  readonly entityId: EntityId;
  /** How the alias was derived for this entity. */
  readonly aliasType: AliasType;
  /**
   * Prior confidence that this alias maps to this entity.
   * Range [0, 1]. NOT a calibrated decision confidence C.
   */
  readonly confidencePrior: number;
  /** Scope in which this alias is active. */
  readonly scope: AliasScope;
  /**
   * Trust score of the source that produced this alias.
   * Range [0, 1].
   */
  readonly sourceTrust: number;
}

/**
 * The outcome of conflict resolution: which entity wins the alias.
 */
export interface AliasConflictResolution {
  /** The entity that retains the alias. */
  readonly winnerId: EntityId;
  /** The winning entity's computed score. */
  readonly score: number;
  /** Difference between winner and runner-up scores. */
  readonly margin: number;
  /** Whether the resolution was automatic or required human review. */
  readonly method: 'auto' | 'manual';
}

/**
 * Records a conflict where multiple entities claim the same alias surface form.
 * See RFC-003 §4.4.1.
 */
export interface AliasConflict {
  /** The raw surface form that is in conflict. */
  readonly value: string;
  /** Normalized form of the conflicting value. */
  readonly normalizedValue: string;
  /** The set of entities claiming this alias. */
  readonly conflictingEntities: readonly AliasConflictEntry[];
  /** Classification of the conflict (e.g. 'homonym', 'near_duplicate', 'scope_overlap'). */
  readonly conflictType: string;
  /** Whether the conflict can be resolved without human intervention. */
  readonly autoResolvable: boolean;
  /** Resolution outcome, if resolved. */
  readonly resolution?: AliasConflictResolution;
}
