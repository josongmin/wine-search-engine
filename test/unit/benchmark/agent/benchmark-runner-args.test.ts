import { describe, expect, it } from 'vitest';
import { parseRunnerArgs } from '../../../../test/benchmark/agent/runner.js';
import {
  entityIdsMatch,
  gradedRelevance,
  parseRetrievalRunnerArgs,
} from '../../../../test/benchmark/agent/retrieval-runner.js';

describe('parseRunnerArgs', () => {
  it('preserves an explicit max-retries=0', () => {
    const args = parseRunnerArgs(['--max-retries', '0']);
    expect(args.maxRetries).toBe(0);
  });

  it('drops invalid ids instead of producing NaN filters', () => {
    const args = parseRunnerArgs(['--id', '1,foo,3']);
    expect(args.idFilter).toEqual([1, 3]);
  });
});

describe('parseRetrievalRunnerArgs', () => {
  it('parses basic flags without a profile compatibility field', () => {
    const args = parseRetrievalRunnerArgs(['--limit', '20', '--tier', 'single_shot', '--verbose']);
    expect(args.limit).toBe(20);
    expect(args.tierFilter).toBe('single_shot');
    expect(args.verbose).toBe(true);
    expect('profile' in args).toBe(false);
  });
});

describe('retrieval entity-id matching', () => {
  it('requires exact opaque ID matches', () => {
    expect(entityIdsMatch('wine-123', 'wine-123')).toBe(true);
    expect(entityIdsMatch('wine-123', 'wine-12')).toBe(false);
  });

  it('does not award partial graded relevance for substring IDs', () => {
    expect(gradedRelevance('wine-123', ['wine-12'])).toBe(0);
    expect(gradedRelevance('wine-123', ['wine-123'])).toBe(3);
  });
});
