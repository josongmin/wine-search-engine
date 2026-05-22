/**
 * Regression: the ranker's `availability` signal MUST NOT bury an
 * exact-identity-protected candidate (the entity the user named explicitly).
 *
 * Root cause:
 *   A named-entity query ("romanee conti", "Petrus 2000") surfaces the
 *   exact wine through BM25 as a `known_item_lookup` / `exact_alias_match`
 *   protected inclusion (sparse rank 1). That candidate carries the
 *   strongest identity + semantic signal in the set. But if the wine is
 *   out of stock (`availability=false → 0`), the ranker's availability
 *   signal (~0.07 weight) docks it ~0.07, while in-stock popularity
 *   neighbours keep their +0.07 — enough to overtake the exact match's
 *   ~0.03 semantic lead and drop the explicitly-named wine out of the
 *   hybrid top-K entirely (the `romanee conti` hybrid-mode failure:
 *   romanee-conti-2019 buried under opus-one-2018).
 *
 *   Showing a wine the user named by its exact name is correct even when
 *   it's out of stock; hiding it is wrong. Availability is a
 *   discovery-time preference, not a filter for named-entity lookups.
 *
 * Contract under test:
 *   `computeAvailability` returns the MAX availability signal (1) for any
 *   candidate whose `retrievalProvenance.protectedInclusionReason` is
 *   `exact_alias_match` or `known_item_lookup`, regardless of the raw
 *   `availability` boolean. Non-protected candidates keep the literal
 *   0/1 mapping (and `undefined` when the field is absent).
 */

import { describe, expect, it } from 'vitest';
import { SignalComputer } from '../../src/domain/ranking/service/signal-computer.js';
import { makeHybridCandidate } from '../support/hybrid-candidate-test-factory.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

const signalComputer = new SignalComputer();

describe('ranker availability — exact-identity protection floor', () => {
  it('floors availability to 1 for an OUT-OF-STOCK known_item_lookup exact match', () => {
    const candidate = makeHybridCandidate({
      entityId: createEntityId('romanee-conti-2019'),
      availability: false,
      retrievalProvenance: {
        channels: ['sparse_bm25'],
        channelScores: [{ channel: 'sparse_bm25', rank: 1, score: 6 }],
        queryViewMatches: [],
        anchorConditioned: false,
        matchedFilterConstraints: [],
        fusionProfile: 'specific_wine',
        fusionScore: 0.29,
        protectedInclusionReason: 'known_item_lookup',
      },
    });

    expect(signalComputer.computeAvailability(candidate)).toBe(1);
  });

  it('floors availability to 1 for an OUT-OF-STOCK exact_alias_match candidate', () => {
    const candidate = makeHybridCandidate({
      entityId: createEntityId('petrus-2000'),
      availability: false,
      retrievalProvenance: {
        channels: ['sparse_bm25'],
        channelScores: [],
        queryViewMatches: [],
        anchorConditioned: false,
        matchedFilterConstraints: [],
        fusionProfile: 'specific_wine',
        fusionScore: 0.2,
        protectedInclusionReason: 'exact_alias_match',
      },
    });

    expect(signalComputer.computeAvailability(candidate)).toBe(1);
  });

  it('keeps the literal 0 mapping for a non-protected out-of-stock candidate', () => {
    const candidate = makeHybridCandidate({
      entityId: createEntityId('some-other-wine'),
      availability: false,
      retrievalProvenance: {
        channels: ['dense_ann'],
        channelScores: [],
        queryViewMatches: [],
        anchorConditioned: true,
        matchedFilterConstraints: [],
        fusionProfile: 'browse',
        fusionScore: 0.1,
      },
    });

    expect(signalComputer.computeAvailability(candidate)).toBe(0);
  });

  it('keeps the literal 1 mapping for a non-protected in-stock candidate', () => {
    const candidate = makeHybridCandidate({
      entityId: createEntityId('in-stock-wine'),
      availability: true,
    });

    expect(signalComputer.computeAvailability(candidate)).toBe(1);
  });

  it('preserves undefined when availability is absent and not exact-identity protected', () => {
    const candidate = makeHybridCandidate({
      entityId: createEntityId('no-availability-field'),
    });

    expect(signalComputer.computeAvailability(candidate)).toBeUndefined();
  });
});
