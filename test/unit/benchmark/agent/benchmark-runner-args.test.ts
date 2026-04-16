import { describe, expect, it } from 'vitest';
import {
  assertCriticalWineTypeCoverage,
  fetchCriticalWineTypeCoverage,
  parseRunnerArgs,
} from '../../../../test/benchmark/agent/runner.js';
import { MESSY_SEARCH_SCENARIO_IDS } from '../../../../test/benchmark/agent/scenarios.js';
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

  it('applies messy-search defaults for judge and scenario selection', () => {
    const args = parseRunnerArgs(['--profile', 'messy-search']);
    expect(args.profile).toBe('messy-search');
    expect(args.enableJudge).toBe(true);
    expect(args.concurrency).toBe(2);
    expect(args.idFilter).toEqual([...MESSY_SEARCH_SCENARIO_IDS]);
  });
});

describe('agent benchmark coverage preflight', () => {
  it('throws when a critical wine_type family is missing', () => {
    expect(() =>
      assertCriticalWineTypeCoverage({ red: 7040, white: 0, sparkling: 0 }),
    ).toThrow(/critical Vespa wine_type coverage missing \(white, sparkling\)/);
  });

  it('loads Vespa coverage counts through the client query contract', async () => {
    const seenYql: string[] = [];
    const client = {
      async query(yql: string) {
        seenYql.push(yql);
        if (yql.includes('"red"')) return { root: { fields: { totalCount: 7 } } };
        if (yql.includes('"white"')) return { root: { fields: { totalCount: 3 } } };
        return { root: { fields: { totalCount: 2 } } };
      },
    };

    await expect(fetchCriticalWineTypeCoverage(client)).resolves.toEqual({
      red: 7,
      white: 3,
      sparkling: 2,
    });
    expect(seenYql).toEqual([
      'select * from sources * where wine_type contains "red" limit 0',
      'select * from sources * where wine_type contains "white" limit 0',
      'select * from sources * where wine_type contains "sparkling" limit 0',
    ]);
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
