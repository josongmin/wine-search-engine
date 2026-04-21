import type { EntityType } from '../service/entity-resolver.js';

export interface AmbiguousEntityHintConstraint {
  readonly attribute: 'grape_family';
  readonly operator: '=';
  readonly value: string;
}

export interface AmbiguousEntityHintBranchConstraint {
  readonly attribute: 'grape_primary';
  readonly operator: '=';
  readonly value: string;
}

export interface AmbiguousEntityHintBranch {
  readonly label: string;
  readonly softConstraint: AmbiguousEntityHintBranchConstraint;
  readonly matchValues: readonly string[];
  readonly lexicalExpansions: readonly string[];
  readonly semanticExpansions: readonly string[];
}

export interface AmbiguousEntityHintSpec {
  readonly entityType: EntityType;
  readonly retrievalConstraint: AmbiguousEntityHintConstraint;
  readonly lexicalExpansions: readonly string[];
  readonly semanticExpansions: readonly string[];
  readonly clarifyOptions: readonly string[];
  readonly explorationBranches: readonly AmbiguousEntityHintBranch[];
}

export interface AmbiguousEntityHint extends AmbiguousEntityHintSpec {
  readonly surface: string;
}
