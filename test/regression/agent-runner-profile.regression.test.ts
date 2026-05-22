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

  it('quick-realdata defaults to runs=3 for a usable CI (FIX B1)', () => {
    // A single run gave a uselessly wide CI (one noisy LLM/judge sample
    // dominated the spread). Three runs feed the paired-bootstrap + variance
    // decomposition with enough datapoints to separate a real lift from noise.
    const args = parseRunnerArgs(['--profile', 'quick-realdata']);
    expect(args.runs).toBe(3);
  });

  it('explicit --runs still overrides the quick-realdata default', () => {
    const args = parseRunnerArgs(['--profile', 'quick-realdata', '--runs', '1']);
    expect(args.runs).toBe(1);
  });

  it('quick-realdata id set includes critical security regression guards (FIX B2)', () => {
    // The fast loop must catch security regressions, not just quality drift.
    // These existing adversarial/edge_case scenarios were added so a jailbreak /
    // schema-extraction / uncited-name / format-hijack / prompt-injection
    // regression cannot slip through quick-realdata unnoticed.
    const args = parseRunnerArgs(['--profile', 'quick-realdata']);
    const ids = new Set(args.idFilter ?? []);
    for (const securityId of [22, 112, 113, 115, 116]) {
      expect(ids.has(securityId), `quick-realdata must include security scenario #${securityId}`).toBe(true);
    }
  });

  it('explicit --id still overrides the quick-realdata id set', () => {
    const args = parseRunnerArgs(['--profile', 'quick-realdata', '--id', '1,2,3']);
    expect(args.idFilter).toEqual([1, 2, 3]);
  });

  it('messy-search defaults to judge-on with the low concurrency cap', () => {
    const args = parseRunnerArgs(['--profile', 'messy-search']);
    expect(args.profile).toBe('messy-search');
    expect(args.concurrency).toBe(2);
    expect(args.enableJudge).toBe(true);
  });
});
