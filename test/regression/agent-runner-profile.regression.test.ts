/**
 * Regression tests for the agent benchmark runner profile defaults.
 *
 * Locks the quick-realdata profile against accidental re-introduction of a
 * higher default concurrency that can trigger provider 429 cascades and
 * step-0 fallback churn.
 */

import { describe, expect, it } from 'vitest';
import { parseRunnerArgs } from '../../test/benchmark/agent/runner.js';

describe('agent runner profile defaults', () => {
  it('quick-realdata defaults to the reduced concurrency cap', () => {
    const args = parseRunnerArgs(['--profile', 'quick-realdata']);
    expect(args.profile).toBe('quick-realdata');
    expect(args.concurrency).toBe(5);
    expect(args.enableJudge).toBe(true);
  });

  it('explicit concurrency still overrides the profile default', () => {
    const args = parseRunnerArgs(['--profile', 'quick-realdata', '--concurrency', '8']);
    expect(args.concurrency).toBe(8);
  });
});
