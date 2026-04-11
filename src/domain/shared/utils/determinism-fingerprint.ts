import { createHash } from 'node:crypto';

/**
 * E1-T5: Determinism fingerprint for search responses.
 *
 * A stable, short hex digest that identifies the exact configuration that
 * produced a result set. Two responses with identical fingerprints MUST
 * produce identical rankings given the same index state.
 *
 * Purpose:
 *  - Detect result drift across identical inputs (LTR non-determinism, config
 *    change, model rollout)
 *  - Enable offline replay comparison without full result diff
 *  - Distinguish A/B experiment arms in logs without leaking query content
 *
 * Stability contract:
 *  - All inputs are stringified with sorted keys so JS object insertion order
 *    does not affect the hash (JSON.stringify key order is V8 insertion order,
 *    not spec-guaranteed across runtimes).
 *  - Only configuration-level inputs are hashed — not the query text itself,
 *    which would make every unique query produce a unique fingerprint.
 *  - Output is the first 16 hex chars of SHA-256 (64 bits of collision
 *    resistance — sufficient for drift detection, not for cryptographic use).
 */

/**
 * Output length of buildDeterminismFingerprint() in hex characters.
 * 16 hex chars = 64 bits — sufficient for drift detection, not cryptographic use.
 * SHA-256 produces 64 hex chars; we take the first 16 as a compact fingerprint.
 */
export const DETERMINISM_FINGERPRINT_HEX_LENGTH = 16;

export interface DeterminismFingerprintParams {
  /** Planner version string (e.g. "v2.3.1"). */
  readonly plannerVersion: string;
  /** LLM model ID used for query understanding / rerank. */
  readonly modelId: string;
  /** Canonical hash of the full model_versions snapshot. */
  readonly modelVersionsHash?: string | undefined;
  /** Canonical hash of the full feature_flags snapshot. */
  readonly featureFlagsHash?: string | undefined;
  /** Stable hash of fusion configuration (RRF k, channel weights). */
  readonly fusionConfigHash: string;
  /** Canonical hash of the full index_versions snapshot. */
  readonly indexVersionsHash?: string | undefined;
  /** Stable hash of ranking configuration (weight vector, mode weights). */
  readonly rankingConfigHash: string;
  /** Retrieval plan builder version used for this execution. */
  readonly retrievalPlanVersion?: string | undefined;
  /** Ranking / rerank safety policy version used for this execution. */
  readonly rankingPolicyVersion?: string | undefined;

  // E8: Extended fields — sourced from DecisionSnapshot when available.
  // All optional to preserve backward compatibility with existing callers.

  /** Policy rule version (from DecisionSnapshot.policy_rule_version). */
  readonly policyRuleVersion?: string | undefined;
  /** Threshold profile ID (from DecisionSnapshot.threshold_profile_id). */
  readonly thresholdProfileId?: string | undefined;
  /** Response contract version (from DecisionSnapshot.response_contract_version). */
  readonly responseContractVersion?: string | undefined;
  /** Whether LTR reranking was applied in this execution. */
  readonly rerankApplied?: boolean | undefined;
  /** LTR model ID, when reranking was applied. */
  readonly rerankModelId?: string | undefined;
}

/**
 * Build a 16-char hex determinism fingerprint from configuration params.
 *
 * The fingerprint does NOT include query text, session ID, or request ID —
 * only the engine configuration. Two requests with the same configuration
 * (same planner version, model/index snapshots, fusion config, ranking config)
 * will produce the same fingerprint, allowing drift detection across identical setups.
 *
 * @returns 16-character lowercase hex string (64-bit prefix of SHA-256).
 */
export function buildDeterminismFingerprint(params: DeterminismFingerprintParams): string {
  // Sort keys deterministically — JSON.stringify does not guarantee key order
  const sortedKeys = Object.keys(params).sort() as (keyof DeterminismFingerprintParams)[];
  const stable = sortedKeys.reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {});
  return createHash('sha256')
    .update(JSON.stringify(stable))
    .digest('hex')
    .slice(0, DETERMINISM_FINGERPRINT_HEX_LENGTH);
}
