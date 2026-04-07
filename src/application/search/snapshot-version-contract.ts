/**
 * Snapshot version contracts for the query execution comparison basis.
 *
 * V1 uses `QueryPlanV1` fields (plannerVersion, policyRuleVersion, thresholdProfileId).
 * V2 extends V1 with `CompiledWineQuery` execution fields (executionRoute, retrievalMode).
 *
 * Migration compatibility: when comparing v1 vs v2, only the 3 shared fields are checked.
 */

// The fields that define a comparable snapshot in V2
export interface SnapshotVersionContractV2 {
  readonly plannerVersion: string;
  readonly policyRuleVersion: string;
  readonly thresholdProfileId: string;
  readonly executionRoute: string; // from CompiledWineQuery.execution.effectiveRoute
  readonly retrievalMode: string; // from CompiledWineQuery.execution.effectiveRetrievalMode
}

// Migration bridge: V1 snapshot key fields
export interface SnapshotVersionContractV1 {
  readonly plannerVersion: string;
  readonly policyRuleVersion: string;
  readonly thresholdProfileId: string;
}

export type SnapshotVersionContract =
  | { readonly version: 'v1'; readonly contract: SnapshotVersionContractV1 }
  | { readonly version: 'v2'; readonly contract: SnapshotVersionContractV2 };

/**
 * Compares two {@link SnapshotVersionContract} values for compatibility.
 *
 * Rules:
 * - v1 vs v1: all three shared fields must match.
 * - v2 vs v2: all five fields must match.
 * - v1 vs v2 (or v2 vs v1): only the three shared fields are compared
 *   (migration compatibility — the v2-only fields are ignored).
 */
export function snapshotVersionContractsMatch(
  a: SnapshotVersionContract,
  b: SnapshotVersionContract,
): boolean {
  // Always compare the three shared fields
  const sharedMatch =
    a.contract.plannerVersion === b.contract.plannerVersion &&
    a.contract.policyRuleVersion === b.contract.policyRuleVersion &&
    a.contract.thresholdProfileId === b.contract.thresholdProfileId;

  if (!sharedMatch) {
    return false;
  }

  // When both are v2, also compare the execution-specific fields
  if (a.version === 'v2' && b.version === 'v2') {
    return (
      a.contract.executionRoute === b.contract.executionRoute &&
      a.contract.retrievalMode === b.contract.retrievalMode
    );
  }

  // v1 vs v1 — shared fields already matched above
  // v1 vs v2 or v2 vs v1 — migration compat: shared fields only
  return true;
}
