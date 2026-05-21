/**
 * Retrieval cache-policy regression tests (maturity 2 → 3).
 *
 * Covers the two decision functions exposed by `src/domain/cache/cache-policy.ts`:
 *
 *   - `decideResponseCachePolicy` — write-side eligibility.
 *   - `decideResponseCacheReadPolicy` — read-side bypass/hit.
 *
 * Plus the hit-distribution observability counter
 * (`createCachePolicyDistributionCounter` / `globalCachePolicyDistributionCounter`)
 * that wraps these decisions so ops can answer "what fraction of responses
 * were ineligible to cache last hour, broken down by reason?".
 *
 * Append-only — never delete a regression test.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createCachePolicyDistributionCounter,
  decideResponseCachePolicy,
  decideResponseCacheReadPolicy,
  globalCachePolicyDistributionCounter,
  recordResponseCachePolicyDecision,
  recordResponseCacheReadDecision,
} from '../../src/domain/cache/cache-policy.js';

const baseWriteInput = {
  executionMode: 'authoritative' as const,
  snapshotId: 'default:1:1',
  blockingEligible: true,
};

const baseReadInput = {
  cachedExecutionMode: 'authoritative' as const,
  cachedBlockingEligible: true,
  cachedSnapshotId: 'default:1:1',
  cachedContractVersion: 'search_response_v1',
  cachedModelVersions: { embedding: 'v1' },
  currentSnapshotId: 'default:1:1',
  currentContractVersion: 'search_response_v1',
  currentModelVersions: { embedding: 'v1' },
};

describe('cache-policy regression', () => {
  describe('write-side eligibility', () => {
    it('marks a stable authoritative response as cacheable', () => {
      const decision = decideResponseCachePolicy(baseWriteInput);
      expect(decision.eligibility).toBe('cacheable_but_snapshot_bound');
      expect(decision.reason).toBeUndefined();
    });

    it('marks a heuristic ("dynamic") response as non-cacheable with reason', () => {
      // A heuristic response is the cache-policy analogue of a "dynamic"
      // query: the answer depends on runtime fallback shape, not the
      // snapshot, so caching it would poison subsequent reads.
      const decision = decideResponseCachePolicy({
        ...baseWriteInput,
        executionMode: 'heuristic',
      });
      expect(decision.eligibility).toBe('non_cacheable');
      expect(decision.reason).toBe('heuristic_response');
    });

    it('treats a missing snapshotId (e.g. empty query path) as non-cacheable without throwing', () => {
      const fn = (): ReturnType<typeof decideResponseCachePolicy> =>
        decideResponseCachePolicy({
          executionMode: 'authoritative',
          snapshotId: '',
          blockingEligible: true,
        });
      expect(fn).not.toThrow();
      expect(fn()).toEqual({
        eligibility: 'non_cacheable',
        reason: 'missing_snapshot_id',
      });
    });

    it('is deterministic: same input yields same eligibility across 5 calls', () => {
      const results = Array.from({ length: 5 }, () =>
        decideResponseCachePolicy(baseWriteInput),
      );
      const first = results[0];
      expect(first).toBeDefined();
      for (const r of results) {
        expect(r).toEqual(first);
      }
    });
  });

  describe('read-side decision', () => {
    it('returns cache_hit for a stable matching entry (idempotent over 5 calls)', () => {
      const results = Array.from({ length: 5 }, () =>
        decideResponseCacheReadPolicy(baseReadInput),
      );
      for (const r of results) {
        expect(r).toEqual({ eligibility: 'cache_hit' });
      }
    });

    it('bypasses snapshot drift with a stable reason', () => {
      const decision = decideResponseCacheReadPolicy({
        ...baseReadInput,
        currentSnapshotId: 'default:2:1',
      });
      expect(decision).toEqual({
        eligibility: 'bypass',
        reason: 'snapshot_id_drift',
      });
    });
  });

  describe('Korean & Unicode-shape stability', () => {
    // The cache-policy decision functions are intentionally string-content
    // agnostic — they key off snapshotId/contractVersion/etc. We still
    // assert that callers feeding Korean snapshot tags or NFC/NFD-variant
    // identifiers receive the same decision so a downstream rename to a
    // Unicode-bearing snapshot tag cannot silently flip eligibility.

    it('accepts a snapshot tag containing 한글 as cacheable', () => {
      const decision = decideResponseCachePolicy({
        ...baseWriteInput,
        snapshotId: '스냅샷:1:1',
      });
      expect(decision).toEqual({ eligibility: 'cacheable_but_snapshot_bound' });
    });

    it('treats NFC and NFD forms of the same Korean snapshot tag identically on the write side', () => {
      const nfc = '한글:1:1'.normalize('NFC');
      const nfd = '한글:1:1'.normalize('NFD');
      const a = decideResponseCachePolicy({ ...baseWriteInput, snapshotId: nfc });
      const b = decideResponseCachePolicy({ ...baseWriteInput, snapshotId: nfd });
      expect(a.eligibility).toBe('cacheable_but_snapshot_bound');
      expect(b.eligibility).toBe('cacheable_but_snapshot_bound');
      expect(a.eligibility).toBe(b.eligibility);
    });

    it('treats a whitespace-only snapshot tag as a valid (non-empty) string on the write side', () => {
      // Whitespace-only is intentionally NOT the empty string: the policy
      // gate is `snapshotId === ''`. We pin this behavior so a downstream
      // change cannot silently broaden the empty-string check to a trim.
      const decision = decideResponseCachePolicy({
        ...baseWriteInput,
        snapshotId: '   ',
      });
      expect(decision.eligibility).toBe('cacheable_but_snapshot_bound');
    });
  });

  describe('hit-distribution counter (observability)', () => {
    beforeEach(() => {
      globalCachePolicyDistributionCounter.reset();
    });

    it('records eligibility decisions with by-reason breakdown', () => {
      const counter = createCachePolicyDistributionCounter();

      recordResponseCachePolicyDecision(
        decideResponseCachePolicy(baseWriteInput),
        counter,
      );
      recordResponseCachePolicyDecision(
        decideResponseCachePolicy({ ...baseWriteInput, executionMode: 'heuristic' }),
        counter,
      );
      recordResponseCachePolicyDecision(
        decideResponseCachePolicy({ ...baseWriteInput, executionMode: 'degraded' }),
        counter,
      );
      recordResponseCachePolicyDecision(
        decideResponseCachePolicy({ ...baseWriteInput, executionMode: 'heuristic' }),
        counter,
      );

      const stats = counter.getStats();
      expect(stats.evaluations).toBe(4);
      expect(stats.eligible_count).toBe(1);
      expect(stats.ineligible_count).toBe(3);
      expect(stats.by_reason.heuristic_response).toBe(2);
      expect(stats.by_reason.degraded_response).toBe(1);
      // Cacheable decisions carry no reason; the "eligible" bucket captures them.
      expect(stats.by_reason.heuristic_response).toBeGreaterThan(0);
    });

    it('records read-side cache_hit vs bypass with reason breakdown', () => {
      const counter = createCachePolicyDistributionCounter();

      // 3 hits, 1 snapshot drift, 1 model drift.
      recordResponseCacheReadDecision(
        decideResponseCacheReadPolicy(baseReadInput),
        counter,
      );
      recordResponseCacheReadDecision(
        decideResponseCacheReadPolicy(baseReadInput),
        counter,
      );
      recordResponseCacheReadDecision(
        decideResponseCacheReadPolicy(baseReadInput),
        counter,
      );
      recordResponseCacheReadDecision(
        decideResponseCacheReadPolicy({
          ...baseReadInput,
          currentSnapshotId: 'default:2:1',
        }),
        counter,
      );
      recordResponseCacheReadDecision(
        decideResponseCacheReadPolicy({
          ...baseReadInput,
          currentModelVersions: { embedding: 'v2' },
        }),
        counter,
      );

      const stats = counter.getReadStats();
      expect(stats.evaluations).toBe(5);
      expect(stats.hit_count).toBe(3);
      expect(stats.bypass_count).toBe(2);
      expect(stats.by_reason.snapshot_id_drift).toBe(1);
      expect(stats.by_reason.model_version_drift).toBe(1);
    });

    it('reset() clears all counters back to zero', () => {
      const counter = createCachePolicyDistributionCounter();
      recordResponseCachePolicyDecision(
        decideResponseCachePolicy({ ...baseWriteInput, executionMode: 'degraded' }),
        counter,
      );
      recordResponseCacheReadDecision(
        decideResponseCacheReadPolicy({
          ...baseReadInput,
          currentSnapshotId: 'default:2:1',
        }),
        counter,
      );

      counter.reset();

      const writeStats = counter.getStats();
      const readStats = counter.getReadStats();
      expect(writeStats.evaluations).toBe(0);
      expect(writeStats.eligible_count).toBe(0);
      expect(writeStats.ineligible_count).toBe(0);
      expect(Object.values(writeStats.by_reason).every((v) => v === 0)).toBe(true);
      expect(readStats.evaluations).toBe(0);
      expect(readStats.hit_count).toBe(0);
      expect(readStats.bypass_count).toBe(0);
      expect(Object.values(readStats.by_reason).every((v) => v === 0)).toBe(true);
    });

    it('globalCachePolicyDistributionCounter is a shared singleton', () => {
      recordResponseCachePolicyDecision(
        decideResponseCachePolicy({ ...baseWriteInput, executionMode: 'heuristic' }),
        globalCachePolicyDistributionCounter,
      );
      recordResponseCachePolicyDecision(
        decideResponseCachePolicy({ ...baseWriteInput, executionMode: 'heuristic' }),
        globalCachePolicyDistributionCounter,
      );
      const stats = globalCachePolicyDistributionCounter.getStats();
      expect(stats.evaluations).toBe(2);
      expect(stats.ineligible_count).toBe(2);
      expect(stats.by_reason.heuristic_response).toBe(2);
    });

    it('getStats() returns a frozen snapshot that does not reflect later increments', () => {
      const counter = createCachePolicyDistributionCounter();
      recordResponseCachePolicyDecision(
        decideResponseCachePolicy({ ...baseWriteInput, executionMode: 'degraded' }),
        counter,
      );
      const snap = counter.getStats();
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(snap.by_reason)).toBe(true);

      recordResponseCachePolicyDecision(
        decideResponseCachePolicy({ ...baseWriteInput, executionMode: 'degraded' }),
        counter,
      );
      expect(snap.evaluations).toBe(1);
      expect(counter.getStats().evaluations).toBe(2);
    });
  });
});
