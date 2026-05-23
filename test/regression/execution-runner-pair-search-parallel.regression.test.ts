/**
 * Regression: `food-pairing-then-search` plan runs the pairing AND search
 * legs in PARALLEL (F2).
 *
 * Pre-fix: `pairing = await ...; search = await ...;` — strictly serial.
 * Yet `pairingInput` and `searchInput` are BOTH pre-baked at plan time
 * (DeterministicRouter), so the search does not consume the pairing
 * outcome. Sequential execution doubled wall-clock unnecessarily.
 *
 * This regression pins the parallel contract: both legs start before
 * either resolves.
 */

import { describe, it, expect, vi } from 'vitest';
import { ExecutionRunner } from '../../src/application/wine-search/execution-runner.js';
import type {
  ExecutionPlan,
} from '../../src/application/wine-search/execution-plan-schemas.js';

describe('execution-runner food-pairing-then-search parallel legs (F2 regression)', () => {
  it('dispatches pairing and search concurrently when both inputs are pre-baked', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const release: Array<() => void> = [];

    const stubSearchResp = {
      queryType: 'search' as const,
      intent: 'search' as const,
      executionTimeMs: 1,
      candidateCount: 0,
      results: [],
      metadata: {},
    };
    const stubPairingResp = {
      food: 'steak',
      results: stubSearchResp,
    };

    const gated = async <T,>(value: T): Promise<T> => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return value;
    };

    const searchUseCase = { execute: vi.fn(() => gated(stubSearchResp)) };
    const foodPairingUseCase = { execute: vi.fn(() => gated(stubPairingResp)) };

    const runner = new ExecutionRunner({
      searchUseCase: searchUseCase as never,
      foodPairingUseCase: foodPairingUseCase as never,
    });

    const plan: ExecutionPlan = {
      kind: 'food-pairing-then-search',
      pairingInput: { food: 'steak' } as never,
      searchInput: { query: 'red wine' } as never,
    } as ExecutionPlan;

    const releaseAfter = (): Promise<void> => new Promise((resolve) => {
      setTimeout(() => {
        while (release.length > 0) release.shift()?.();
        resolve();
      }, 25);
    });

    const [outcome] = await Promise.all([
      runner.run(plan, { requestId: 'req-pair', perStepTimeoutMs: 1000 }),
      releaseAfter(),
    ]);

    expect(foodPairingUseCase.execute).toHaveBeenCalledTimes(1);
    expect(searchUseCase.execute).toHaveBeenCalledTimes(1);
    // PARALLEL contract: both legs in flight at peak.
    expect(peakInFlight).toBe(2);
    expect(outcome.kind).toBe('food-pairing-result');
  });
});
