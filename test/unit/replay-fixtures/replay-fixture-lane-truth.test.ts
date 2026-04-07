import { describe, expect, it } from 'vitest';
import {
  isFullRuntimeSearchReplayFixture,
  isInMemoryRuntimeSearchReplayFixture,
  loadSearchReplayFixtures,
} from '../../replay-fixtures/search/run-search-fixture.js';

describe('replay fixture lane truth', () => {
  const fixtures = loadSearchReplayFixtures();

  it('keeps drinking-window runtime replay split between shadow and full-runtime honesty lanes', () => {
    const drinkingWindowFixtures = fixtures.filter(({ fixture }) =>
      fixture.requires_runtime_capability?.includes('drinking_window_runtime'),
    );

    expect(drinkingWindowFixtures.map(({ file }) => file)).toEqual([
      'heuristic-drinking-window-full-runtime.json',
      'heuristic-drinking-window.json',
    ]);
    expect(isFullRuntimeSearchReplayFixture(drinkingWindowFixtures[0]!.fixture)).toBe(true);
    expect(isInMemoryRuntimeSearchReplayFixture(drinkingWindowFixtures[0]!.fixture)).toBe(false);
    expect(isInMemoryRuntimeSearchReplayFixture(drinkingWindowFixtures[1]!.fixture)).toBe(true);
    expect(isFullRuntimeSearchReplayFixture(drinkingWindowFixtures[1]!.fixture)).toBe(false);
  });

  it('keeps learned matcher and reranker timeout replay in the full-runtime lane', () => {
    const fullRuntimeCapabilityFixtures = fixtures.filter(({ fixture }) =>
      fixture.requires_runtime_capability?.some((capability) =>
        capability === 'learned_matcher_runtime' || capability === 'reranker_runtime',
      ),
    );

    expect(fullRuntimeCapabilityFixtures.map(({ file }) => file)).toEqual([
      'learned-matcher-timeout.json',
      'reranker-timeout.json',
    ]);
    expect(fullRuntimeCapabilityFixtures.every(({ fixture }) =>
      isFullRuntimeSearchReplayFixture(fixture))).toBe(true);
  });
});
