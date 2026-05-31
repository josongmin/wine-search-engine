import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreAdapterServices } from '../container-adapters.js';
import { buildEntityResolver, buildQueryPlanner } from '../container-core-builders.js';
import type { Config } from '../env.js';
import type { AliasMatcher } from '../../domain/query/service/anchor-extractor.js';
import type { MappingTablePort } from '../../domain/attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../domain/attribute/model/nl-mapping.js';
import { LazyFuzzyMatcher } from '../../infrastructure/adapter/lazy-fuzzy-matcher.js';
import {
  FallbackAmbiguityDictionary,
  StaticAmbiguityDictionary,
} from '../../domain/query/service/static-ambiguity-dictionary.js';

class NoopAliasMatcher implements AliasMatcher {
  findMatches(): Promise<readonly []> {
    return Promise.resolve([]);
  }
}

class NoopMappingTable implements MappingTablePort {
  findMapping(): Promise<NLMapping | null> {
    return Promise.resolve(null);
  }
  findMappingsByAttribute(): Promise<readonly NLMapping[]> {
    return Promise.resolve([]);
  }
  getCurrentVersion(): Promise<string> {
    return Promise.resolve('v-test');
  }
}

function makeAdapters(overrides: Partial<CoreAdapterServices> = {}): CoreAdapterServices {
  return {
    ambiguityDict: new FallbackAmbiguityDictionary(
      {
        isKnownAmbiguous: () => Promise.resolve(false),
        getAmbiguityInfo: () => Promise.resolve(null),
        getAmbiguityInfoBatch: () => Promise.resolve(new Map()),
      },
      new StaticAmbiguityDictionary(),
    ),
    aliasMatcher: new NoopAliasMatcher(),
    mappingTable: new NoopMappingTable(),
    ...overrides,
  } as unknown as CoreAdapterServices;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'production',
    calibration: { ttlDays: 14 },
    killSwitch: {
      learning: false,
      aliasOverlay: false,
      denseRetrieval: false,
      injectionJudge: false,
      queryCache: false,
    },
    ...overrides,
  } as Config;
}

describe('buildQueryPlanner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the adapter-provided fuzzy matcher without scanning aliases again', async () => {
    const pool = { query: vi.fn() } as never;
    const fuzzyMatcher = { match: vi.fn(() => []) };

    await buildQueryPlanner(makeAdapters({ fuzzyMatcher }), pool);

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('warms the startup-built fuzzy matcher before returning the planner', async () => {
    const warmSpy = vi.spyOn(LazyFuzzyMatcher.prototype, 'warm');
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ surface_form: 'opus one' }],
      }),
    } as never;

    await buildQueryPlanner(makeAdapters(), pool, undefined, undefined, undefined, undefined, 'search-snapshot:v1:test');

    expect(warmSpy).toHaveBeenCalledTimes(1);
  });
});

describe('buildEntityResolver', () => {
  it('does not hard-fail production requests when calibration params are missing', () => {
    const resolver = buildEntityResolver(makeAdapters(), makeConfig());
    const calibrator = (resolver as unknown as { calibrator: { options: { requireTrainedParams?: boolean } } }).calibrator;

    expect(calibrator.options.requireTrainedParams).toBe(false);
  });
});
