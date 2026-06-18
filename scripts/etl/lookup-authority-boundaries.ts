import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import type { LookupPolicyConflictRegistryRow } from '../eval/lookup-v2-policy-conflict-registry.js';
import type { LookupV2PolicyFamilyDecisionRegistryRow } from '../eval/lookup-v2-policy-family-decision-registry.js';
import { buildLookupV2PolicyFamilyDecisionKey } from '../eval/lookup-v2-policy-family-decision-registry.js';
import type { LookupAmbiguityRegistryRow } from './lookup-authority-registries.js';
import type { LookupExactSafeRegistryRow } from './lookup-exact-safe-registry.js';

export function assertLookupAuthorityBoundaryConsistency(args: {
  readonly exactSafeRows: readonly LookupExactSafeRegistryRow[];
  readonly ambiguityRows: readonly LookupAmbiguityRegistryRow[];
  readonly policyConflictRows: readonly LookupPolicyConflictRegistryRow[];
  readonly policyFamilyDecisionRows: readonly LookupV2PolicyFamilyDecisionRegistryRow[];
}): void {
  const exactSafeOwners = new Map<string, LookupExactSafeRegistryRow>();
  for (const row of args.exactSafeRows) {
    exactSafeOwners.set(normalizeForMatch(row.surface), row);
  }

  const ambiguityOwners = new Map<string, LookupAmbiguityRegistryRow>();
  for (const row of args.ambiguityRows) {
    ambiguityOwners.set(normalizeForMatch(row.surface), row);
  }

  const decisionOwners = new Map<string, LookupV2PolicyFamilyDecisionRegistryRow>();
  for (const row of args.policyFamilyDecisionRows) {
    decisionOwners.set(
      buildLookupV2PolicyFamilyDecisionKey(row.policyConflictSurface, row.entityId),
      row,
    );
  }

  for (const row of args.policyConflictRows) {
    const normalizedSurface = normalizeForMatch(row.surface);
    const exactSafeOwner = exactSafeOwners.get(normalizedSurface);
    const ambiguityOwner = ambiguityOwners.get(normalizedSurface);
    const decision = decisionOwners.get(
      buildLookupV2PolicyFamilyDecisionKey(row.surface, row.authorityEntityId),
    );

    if (decision?.decision === 'promote_exact_safe') {
      if (exactSafeOwner?.entityId !== row.authorityEntityId) {
        throw new Error(
          `lookup authority boundary requires exact-safe owner for promoted policy surface=${JSON.stringify(row.surface)} entityId=${JSON.stringify(row.authorityEntityId)}`,
        );
      }
      if (ambiguityOwner !== undefined) {
        throw new Error(
          `lookup authority boundary conflict: promoted policy surface=${JSON.stringify(row.surface)} also exists in ambiguity registry`,
        );
      }
      continue;
    }

    if (exactSafeOwner?.entityId === row.authorityEntityId) {
      throw new Error(
        `lookup authority boundary conflict: policy surface=${JSON.stringify(row.surface)} decision=${JSON.stringify(decision?.decision ?? 'missing')} still exact-safe to entityId=${JSON.stringify(row.authorityEntityId)}`,
      );
    }

    if (decision?.decision === 'keep_policy_conflict' && ambiguityOwner === undefined) {
      throw new Error(
        `lookup authority boundary requires ambiguity registry owner for keep_policy_conflict surface=${JSON.stringify(row.surface)}`,
      );
    }
  }
}
