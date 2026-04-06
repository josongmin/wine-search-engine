import type { NormalizedConstraint } from '../../domain/shared/types/index.js';

/**
 * Human-readable description of constraint contradictions for API responses (Epic 13).
 */
export function formatConstraintConflictDescription(
  conflictPairs: ReadonlyArray<readonly [NormalizedConstraint, NormalizedConstraint]>,
): string {
  return conflictPairs
    .map(([a, b]) => `${a.attribute}: ${JSON.stringify(a.value)} vs ${JSON.stringify(b.value)}`)
    .join('; ');
}
