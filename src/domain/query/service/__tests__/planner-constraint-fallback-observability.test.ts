import { describe, it, expect, vi, afterEach } from 'vitest';

// The planner logs through `bootstrapLogger.child(...)`. Mock the module so the
// child logger exposes a vi.fn `warn` we can assert on directly. Other levels
// are stubbed; the parent keeps `.child()` returning the same tracked logger.
// `vi.hoisted` lets the mock factory (hoisted to file top) reference the spy.
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('../../../shared/bootstrap-logger.js', () => {
  const childLogger = {
    warn: warnMock,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => childLogger),
  };
  return {
    bootstrapLogger: {
      ...childLogger,
      child: vi.fn(() => childLogger),
    },
  };
});

import { Planner } from '../planner.js';
import { AnchorExtractor } from '../anchor-extractor.js';
import { ExpansionBuilder } from '../expansion-builder.js';
import type { AmbiguityDictionary } from '../../port/ambiguity-dictionary.port.js';
import type { AliasMatcher, AliasMatchResult } from '../anchor-extractor.js';
import type { NLMapper as NLMapperPort } from '../../../attribute/service/nl-mapper.js';
import type { ConstraintCompilerResult } from '../constraint-compiler.js';
import type { QueryIntent } from '../../model/query-intent.js';

// ── Stub helpers ────────────────────────────────────────────────────────────

class EmptyAliasMatcher implements AliasMatcher {
  findMatches(_normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return Promise.resolve([]);
  }
}

const noAmbiguityDict: AmbiguityDictionary = {
  isKnownAmbiguous: () => Promise.resolve(false),
  getAmbiguityInfo: () => Promise.resolve(null),
  getAmbiguityInfoBatch: () => Promise.resolve(new Map()),
};

/** NLMapper whose mapConstraints rejects — forces the primary compiler to throw. */
const throwingNLMapper: NLMapperPort = {
  mapPhrase: () => Promise.resolve(null),
  mapConstraints: () => Promise.reject(new Error('nl-mapper boom')),
} as unknown as NLMapperPort;

function makePlanner(nlMapper: NLMapperPort): Planner {
  const anchorExtractor = new AnchorExtractor(new EmptyAliasMatcher());
  const expansionBuilder = new ExpansionBuilder();
  return new Planner(noAmbiguityDict, anchorExtractor, expansionBuilder, nlMapper);
}

/** Bracket access to the private parseConstraints method for a narrow unit test. */
type PrivateParse = (
  normalizedQuery: string,
  intent: QueryIntent,
  abortSignal?: AbortSignal,
) => Promise<ConstraintCompilerResult>;

function callParseConstraints(planner: Planner): PrivateParse {
  return (
    planner as unknown as { parseConstraints: PrivateParse }
  ).parseConstraints.bind(planner);
}

describe('Planner constraint-compiler fallback observability', () => {
  afterEach(() => {
    warnMock.mockClear();
  });

  it('falls back to the deterministic compiler AND logs a warning when the primary compiler throws', async () => {
    const planner = makePlanner(throwingNLMapper);
    const result = await callParseConstraints(planner)('pinot noir', 'facet_search');

    // Fallback behavior preserved: a usable compiler result is returned.
    expect(result).toBeDefined();
    expect(result.bundle).toBeDefined();

    // The silent fallback is now observable.
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [payload, message] = warnMock.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ err: 'nl-mapper boom' });
    expect(String(message)).toContain('constraint compiler failed');
  });

  it('does not log a warning on the happy path when the primary compiler succeeds', async () => {
    const okNLMapper: NLMapperPort = {
      mapPhrase: () => Promise.resolve(null),
      mapConstraints: () => Promise.resolve({ constraints: [] }),
    } as unknown as NLMapperPort;

    const planner = makePlanner(okNLMapper);
    const result = await callParseConstraints(planner)('pinot noir', 'facet_search');

    expect(result.bundle).toBeDefined();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('re-throws abort errors instead of falling back or logging', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const abortingNLMapper: NLMapperPort = {
      mapPhrase: () => Promise.resolve(null),
      mapConstraints: () => Promise.reject(abortError),
    } as unknown as NLMapperPort;

    const planner = makePlanner(abortingNLMapper);

    await expect(
      callParseConstraints(planner)('pinot noir', 'facet_search'),
    ).rejects.toThrow(/aborted/);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
