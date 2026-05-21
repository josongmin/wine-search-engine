/**
 * Regression: nested `withRetry` calls must NOT double-count throttle backoff.
 *
 * The bench runner's `withRetry` wraps `orchestrator.execute()` once. If a
 * higher-level retry (e.g. test harness or composite use-case) ever wraps
 * the same call with ANOTHER `withRetry`, each leaf backoff sleep must still
 * be counted EXACTLY ONCE - never summed into both the parent and child
 * accumulators. Double-counting would UNDER-report `agentWorkMs` (because
 * `agentWorkMs = wall - throttleWaitMs`) and OVER-report the wall delta,
 * making the bench falsely report slow agent work when the source was infra.
 *
 * L1.B contract: when `fn()` returns a `WithRetryOutcome<T>` (i.e. is itself
 * a withRetry-wrapped call), the outer wrapper folds the child's
 * `throttleWaitMs` exactly once and returns the combined outcome to its
 * caller. The caller MUST consume the OUTER outcome only.
 */

import { describe, it, expect, vi } from 'vitest';
import { withRetry, type WithRetryOutcome } from '../../test/benchmark/agent/runner.js';

describe('L1.B - withRetry no double-count on nested retries', () => {
  it('single-attempt success records zero throttle wait', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, 0, () => true);
    expect(result.value).toBe('ok');
    expect(result.throttleWaitMs).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('nested withRetry folds the child throttleWaitMs exactly once', async () => {
    const innerSentinelMs = 1_234;
    const innerOutcome: WithRetryOutcome<string> = {
      value: 'inner-ok',
      throttleWaitMs: innerSentinelMs,
    };

    const outer = await withRetry(async () => innerOutcome, 0, () => true);

    expect(outer.value).toBe('inner-ok');
    expect(outer.throttleWaitMs).toBe(innerSentinelMs);
  });

  it('outer retry on top of an inner outcome sums leaf sleeps once each', async () => {
    const innerChildWaitMs = 999;
    const child: WithRetryOutcome<string> = { value: 'recovered', throttleWaitMs: innerChildWaitMs };

    const fn = vi
      .fn<() => Promise<WithRetryOutcome<string>>>()
      // Use a transient non-rate-limit error so the outer backoff is short
      // (RUNNER_TRANSIENT_BASE_MS=500 * 1 = 500ms) rather than the 5s+
      // rate-limit backoff. The contract under test is "child wait counted
      // exactly once" — bigger sleeps just slow the test down.
      .mockRejectedValueOnce(new Error('timeout while reading upstream'))
      .mockResolvedValueOnce(child);

    const start = Date.now();
    const outer = await withRetry(fn, 1, (err) => err instanceof Error && err.message.includes('timeout'));
    const elapsed = Date.now() - start;

    expect(outer.value).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(outer.throttleWaitMs).toBeGreaterThanOrEqual(innerChildWaitMs);
    // Upper bound: child wait + the outer leaf sleep we actually slept for,
    // plus generous slack for CI scheduler jitter.
    expect(outer.throttleWaitMs).toBeLessThanOrEqual(innerChildWaitMs + elapsed + 500);
  });

  it('a fn returning a raw value (not WithRetryOutcome) is unwrapped without double-counting', async () => {
    const outer = await withRetry(async () => 42, 0, () => true);
    expect(outer.value).toBe(42);
    expect(outer.throttleWaitMs).toBe(0);
  });
});
