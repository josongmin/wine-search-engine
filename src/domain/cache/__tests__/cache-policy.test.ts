import { describe, expect, it } from 'vitest';
import {
  RESPONSE_CACHE_READ_BYPASS_REASONS,
  decideResponseCachePolicy,
  decideResponseCacheReadPolicy,
  isDestructiveResponseCacheBypassReason,
} from '../cache-policy.js';

describe('cache-policy', () => {
  describe('decideResponseCachePolicy', () => {
    it('keeps degraded write responses non-cacheable', () => {
      expect(
        decideResponseCachePolicy({
          executionMode: 'degraded',
          snapshotId: 'default:1:1',
          blockingEligible: false,
        }),
      ).toEqual({
        eligibility: 'non_cacheable',
        reason: 'degraded_response',
      });
    });

    it('rejects authoritative responses with blockingEligible=false', () => {
      // An authoritative response with blockingEligible=false would be bypassed
      // unconditionally on every read (reason: cached_not_blocking_eligible).
      // The write policy must short-circuit it to avoid wasted Redis writes.
      expect(
        decideResponseCachePolicy({
          executionMode: 'authoritative',
          snapshotId: 'default:1:1',
          blockingEligible: false,
        }),
      ).toEqual({
        eligibility: 'non_cacheable',
        reason: 'not_blocking_eligible',
      });
    });

    it('accepts authoritative responses with blockingEligible=true', () => {
      expect(
        decideResponseCachePolicy({
          executionMode: 'authoritative',
          snapshotId: 'default:1:1',
          blockingEligible: true,
        }),
      ).toEqual({
        eligibility: 'cacheable_but_snapshot_bound',
      });
    });

    it('accepts authoritative responses when blockingEligible is omitted', () => {
      // blockingEligible absent means the feature flag is off; we cache normally.
      expect(
        decideResponseCachePolicy({
          executionMode: 'authoritative',
          snapshotId: 'default:1:1',
        }),
      ).toEqual({
        eligibility: 'cacheable_but_snapshot_bound',
      });
    });
  });

  describe('decideResponseCacheReadPolicy', () => {
    const healthyInput = {
      cachedExecutionMode: 'authoritative' as const,
      cachedBlockingEligible: true,
      cachedSnapshotId: 'default:1:1',
      cachedContractVersion: 'search_response_v1',
      cachedModelVersions: { embedding: 'v1' },
      currentSnapshotId: 'default:1:1',
      currentContractVersion: 'search_response_v1',
      currentModelVersions: { embedding: 'v1' },
    };

    it('returns cache_hit for authoritative matching entries', () => {
      expect(decideResponseCacheReadPolicy(healthyInput)).toEqual({
        eligibility: 'cache_hit',
      });
    });

    it('bypasses degraded cached responses with stable reason', () => {
      expect(
        decideResponseCacheReadPolicy({
          ...healthyInput,
          cachedExecutionMode: 'degraded',
        }),
      ).toEqual({
        eligibility: 'bypass',
        reason: 'cached_execution_mode_degraded',
      });
    });

    it('bypasses contract-version drift with stable reason', () => {
      expect(
        decideResponseCacheReadPolicy({
          ...healthyInput,
          cachedContractVersion: 'search_response_v0',
        }),
      ).toEqual({
        eligibility: 'bypass',
        reason: 'contract_version_drift',
      });
    });

    it('bypasses snapshot drift with stable reason', () => {
      expect(
        decideResponseCacheReadPolicy({
          ...healthyInput,
          currentSnapshotId: 'default:2:1',
        }),
      ).toEqual({
        eligibility: 'bypass',
        reason: 'snapshot_id_drift',
      });
    });

    it('bypasses model drift with stable reason', () => {
      expect(
        decideResponseCacheReadPolicy({
          ...healthyInput,
          currentModelVersions: { embedding: 'v2' },
        }),
      ).toEqual({
        eligibility: 'bypass',
        reason: 'model_version_drift',
      });
    });

    it('fails closed when cached model versions are missing', () => {
      expect(
        decideResponseCacheReadPolicy({
          ...healthyInput,
          cachedModelVersions: undefined,
        }),
      ).toEqual({
        eligibility: 'bypass',
        reason: 'model_version_drift',
      });
    });

    it('bypasses runtime availability degradation with stable reasons', () => {
      expect(
        decideResponseCacheReadPolicy({
          ...healthyInput,
          runtimeState: {
            learningKillSwitchEnabled: true,
            denseRetrievalEnabled: true,
            rerankerAvailable: true,
            currentExecutionModeHint: 'degraded',
          },
        }),
      ).toEqual({
        eligibility: 'bypass',
        reason: 'learning_disabled',
      });

      expect(
        decideResponseCacheReadPolicy({
          ...healthyInput,
          runtimeState: {
            learningKillSwitchEnabled: false,
            denseRetrievalEnabled: false,
            rerankerAvailable: true,
            currentExecutionModeHint: 'degraded',
          },
        }),
      ).toEqual({
        eligibility: 'bypass',
        reason: 'dense_retrieval_disabled',
      });

      expect(
        decideResponseCacheReadPolicy({
          ...healthyInput,
          runtimeState: {
            learningKillSwitchEnabled: false,
            denseRetrievalEnabled: true,
            rerankerAvailable: false,
            currentExecutionModeHint: 'degraded',
          },
        }),
      ).toEqual({
        eligibility: 'bypass',
        reason: 'reranker_unavailable',
      });

      expect(
        decideResponseCacheReadPolicy({
          ...healthyInput,
          runtimeState: {
            learningKillSwitchEnabled: false,
            denseRetrievalEnabled: true,
            rerankerAvailable: true,
            currentExecutionModeHint: 'degraded',
          },
        }),
      ).toEqual({
        eligibility: 'bypass',
        reason: 'runtime_degraded',
      });
    });

    it('keeps the reason enum stable', () => {
      expect(RESPONSE_CACHE_READ_BYPASS_REASONS).toMatchInlineSnapshot(`
        [
          "cached_not_blocking_eligible",
          "cached_execution_mode_degraded",
          "cached_execution_mode_heuristic",
          "cached_execution_mode_advisory",
          "learning_disabled",
          "dense_retrieval_disabled",
          "reranker_unavailable",
          "runtime_degraded",
          "missing_cached_snapshot_id",
          "missing_cached_contract_version",
          "snapshot_id_drift",
          "contract_version_drift",
          "model_version_drift",
        ]
      `);
    });

    it('treats runtime-only bypass reasons as non-destructive', () => {
      expect(isDestructiveResponseCacheBypassReason('learning_disabled')).toBe(false);
      expect(isDestructiveResponseCacheBypassReason('runtime_degraded')).toBe(false);
      expect(isDestructiveResponseCacheBypassReason('snapshot_id_drift')).toBe(true);
    });
  });
});
