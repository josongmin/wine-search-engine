import { describe, it, expect, beforeEach } from 'vitest';
import { applyRelativeFilter } from '../relative-filter-policy.js';
import { RETRIEVAL_CHANNEL_RELATIVE_FILTER } from '../../model/retrieval-channel.js';
import { globalSilentSkipCounter } from '../../../observability/silent-skip-counters.js';
import { createEntityId } from '../../../shared/types/index.js';
import { makeHybridCandidate } from '../../../../../test/support/hybrid-candidate-test-factory.js';

describe('applyRelativeFilter — anchor-not-found degradation observability', () => {
  beforeEach(() => {
    globalSilentSkipCounter.reset();
  });

  it('returns the UNFILTERED pool when the anchor is absent (behaviour preserved)', () => {
    const candidates = [
      makeHybridCandidate({ entityId: createEntityId('a'), region: 'tuscany' }),
      makeHybridCandidate({ entityId: createEntityId('b'), region: 'rioja' }),
    ];

    const result = applyRelativeFilter(candidates, {
      anchorEntityId: createEntityId('missing-anchor'),
      constraints: ['style:bold'],
    });

    // Degradation contract: full pool passes through, nothing dropped.
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.entityId)).toEqual([
      createEntityId('a'),
      createEntityId('b'),
    ]);
  });

  it('increments the relative_filter_anchor_not_found counter on the silent fallback', () => {
    const candidates = [
      makeHybridCandidate({ entityId: createEntityId('a'), region: 'tuscany' }),
    ];

    expect(
      globalSilentSkipCounter.snapshot().relative_filter_anchor_not_found,
    ).toBe(0);

    applyRelativeFilter(candidates, {
      anchorEntityId: createEntityId('missing-anchor'),
      constraints: [],
    });

    expect(
      globalSilentSkipCounter.snapshot().relative_filter_anchor_not_found,
    ).toBe(1);
  });

  it('does NOT fire the degradation counter when the anchor IS present', () => {
    const anchorId = createEntityId('anchor');
    const candidates = [
      makeHybridCandidate({ entityId: anchorId, region: 'tuscany' }),
      makeHybridCandidate({ entityId: createEntityId('match'), region: 'tuscany' }),
      makeHybridCandidate({ entityId: createEntityId('nomatch'), region: 'rioja' }),
    ];

    const result = applyRelativeFilter(candidates, {
      anchorEntityId: anchorId,
      constraints: [],
    });

    // Anchor excluded, only the region-sharing candidate survives.
    expect(result.map((c) => c.entityId)).toEqual([createEntityId('match')]);
    expect(
      result[0]?.retrievalTrace.candidateSources,
    ).toContain(RETRIEVAL_CHANNEL_RELATIVE_FILTER);
    expect(
      globalSilentSkipCounter.snapshot().relative_filter_anchor_not_found,
    ).toBe(0);
  });

  it('does NOT fire the counter when an anchorDocument is supplied directly (no resolution failure)', () => {
    const candidates = [
      makeHybridCandidate({ entityId: createEntityId('match'), region: 'tuscany' }),
      makeHybridCandidate({ entityId: createEntityId('nomatch'), region: 'rioja' }),
    ];

    const result = applyRelativeFilter(candidates, {
      anchorEntityId: createEntityId('external-anchor'),
      constraints: [],
      anchorDocument: { region: 'tuscany' } as never,
    });

    expect(result.map((c) => c.entityId)).toEqual([createEntityId('match')]);
    expect(
      globalSilentSkipCounter.snapshot().relative_filter_anchor_not_found,
    ).toBe(0);
  });

  it('empty candidate pool with missing anchor still degrades observably (edge: empty input)', () => {
    const result = applyRelativeFilter([], {
      anchorEntityId: createEntityId('missing-anchor'),
      constraints: [],
    });

    expect(result).toEqual([]);
    // Empty result here is the genuine input being empty, NOT silent filtering —
    // the counter must still fire so ops can distinguish the two.
    expect(
      globalSilentSkipCounter.snapshot().relative_filter_anchor_not_found,
    ).toBe(1);
  });
});
