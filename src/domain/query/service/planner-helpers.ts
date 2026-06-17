import type {
  ConstraintBundle,
  NormalizedConstraint,
} from '../../shared/types/index.js';
import type { AmbiguousEntityHint } from '../../attribute/model/ambiguous-entity-hint.js';
import type { AmbiguityIntentInterpretation } from '../model/ambiguity-intent-interpretation.js';
import type { PolicyDecisionRecord, PlannerStage } from '../model/policy-decision-record.js';
import { parseSpans } from '../../attribute/service/span-parser.js';
import { isDirectEntityResolution, resolveEntity } from '../../attribute/service/entity-resolver.js';
import {
  SEMANTIC_DISCOVERY_SENSORY_ATTRIBUTES,
  SEMANTIC_DISCOVERY_ALLOWED_HARD_ATTRIBUTES,
} from './planner-constants.js';
import { ONTOLOGY_SPAN_SOFT_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';

function isPositivePreferenceConstraint(constraint: NormalizedConstraint): boolean {
  return constraint.operator === '='
    || constraint.operator === '>='
    || constraint.operator === '<='
    || constraint.operator === 'range'
    || constraint.operator === 'in';
}

export function hasSensoryPreferenceConstraint(bundle: ConstraintBundle): boolean {
  return bundle.soft.some((constraint) =>
    SEMANTIC_DISCOVERY_SENSORY_ATTRIBUTES.has(constraint.attribute)
    && isPositivePreferenceConstraint(constraint),
  );
}

export function hasOnlySemanticDiscoveryCompatibleHardConstraints(
  bundle: ConstraintBundle,
): boolean {
  return bundle.hard.every((constraint) =>
    SEMANTIC_DISCOVERY_ALLOWED_HARD_ATTRIBUTES.has(constraint.attribute),
  );
}

/**
 * True when soft constraints are only ontology spans (region/appellation/grape…)
 * extracted from an identity-shaped short surface — not sensory/pairing discovery.
 */
export function hasOntologyOnlySoftConstraintEvidence(
  bundle: ConstraintBundle,
): boolean {
  if (bundle.hard.length > 0 || bundle.inferred.length > 0) {
    return false;
  }
  if (bundle.soft.length === 0) {
    return false;
  }
  if (hasSensoryPreferenceConstraint(bundle)) {
    return false;
  }
  return bundle.soft.every((constraint) =>
    ONTOLOGY_SPAN_SOFT_ATTRIBUTES.has(constraint.attribute),
  );
}

// Vintage detection delegates to the vintage SSoT
// (`@domain/shared/utils/vintage`).

/** Region path: hierarchical "A / B / C" (Epic 7, golden `region_browse`). */
export function regionHierarchySlashCount(normalizedQuery: string): number {
  return (normalizedQuery.match(/\//g) ?? []).length;
}

export function hasDirectResolvableAttributeEntity(normalizedQuery: string): boolean {
  return parseSpans(normalizedQuery).some((span) => {
    const resolved = resolveEntity(span.text, { preferEntityOverStyle: true });
    return isDirectEntityResolution(resolved) && resolved.entityType !== 'wine_type';
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

export function applyAmbiguityIntentInterpretation(
  hints: readonly AmbiguousEntityHint[],
  interpretation: AmbiguityIntentInterpretation | undefined,
): readonly AmbiguousEntityHint[] {
  if (interpretation === undefined) {
    return hints;
  }

  return hints.map((hint) => {
    const selection = interpretation.branchSelections.find((entry) =>
      entry.surface === hint.surface
      && entry.entityType === hint.entityType,
    );
    if (selection === undefined || selection.decision !== 'select_branches') {
      return hint;
    }

    const selectedBranchSet = new Set(selection.selectedBranchLabels);
    const explorationBranches = hint.explorationBranches.filter((branch) => selectedBranchSet.has(branch.label));
    if (explorationBranches.length === 0) {
      return hint;
    }

    return {
      ...hint,
      clarifyOptions: hint.clarifyOptions.filter((label) => selectedBranchSet.has(label)),
      lexicalExpansions: uniqueStrings([
        ...hint.lexicalExpansions,
        ...explorationBranches.flatMap((branch) => branch.lexicalExpansions),
      ]),
      semanticExpansions: uniqueStrings([
        ...hint.semanticExpansions,
        ...explorationBranches.flatMap((branch) => branch.semanticExpansions),
      ]),
      explorationBranches,
    };
  });
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a PolicyDecisionRecord for a planner decision stage. */
export function buildDecisionRecord(
  stage: PlannerStage,
  inputFacts: Record<string, unknown>,
  rulesEvaluated: PolicyDecisionRecord['rulesEvaluated'],
  rejectedBranches: PolicyDecisionRecord['rejectedBranches'],
  decision: string,
  confidence: number,
  durationMs?: number,
): PolicyDecisionRecord {
  return {
    stage,
    inputFacts,
    rulesEvaluated,
    rejectedBranches,
    decision,
    confidence,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
