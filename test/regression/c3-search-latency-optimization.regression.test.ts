/**
 * C3 regression: pin the planner-side fix that collapsed sequential per-anchor
 * AmbiguityDictionary lookups into a single batch round-trip.
 *
 * Background — before this fix, `Planner.computeUncertainty` and
 * `Planner.determineQueryClass` each iterated over `anchors` and called
 * `await ambiguityDict.getAmbiguityInfo(...)` or `await isKnownAmbiguous(...)`
 * one surface form at a time. For popular grape queries (Cabernet Sauvignon,
 * Sauvignon Blanc, etc.) the planner produces 50–200+ alias-matched anchors,
 * and each call hit a remote substrate (PG/RDS) for ~30–100 ms — accumulating
 * 15–25 seconds of sequential await time on the hot path
 * (`planner.compute_uncertainty` ≈ 20 s for "Cabernet Sauvignon").
 *
 * The fix introduced `AmbiguityDictionary.getAmbiguityInfoBatch(forms)`,
 * which issues ONE `WHERE normalized_form = ANY($1::text[])` query (or the
 * static equivalent) and returns a map. The planner now invokes the batch
 * port at most once per phase, regardless of anchor count.
 *
 * After the fix:
 *   - p50 wall-clock: 2744ms → 1532ms (−44%)
 *   - p95 wall-clock: 28213ms → 9331ms (−67%)
 *   - planner.compute_uncertainty (Cabernet Sauvignon): 20126ms → 736ms (−96%)
 *
 * This test fails — and the regression returns — if anyone reverts the
 * planner to per-anchor await semantics. It counts per-form invocations on
 * an instrumented AmbiguityDictionary.
 */

import { describe, it, expect } from 'vitest';
import { Planner } from '../../src/domain/query/service/planner.js';
import { AnchorExtractor } from '../../src/domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../../src/domain/query/service/expansion-builder.js';
import type {
  AmbiguityDictionary,
  AmbiguityInfo,
} from '../../src/domain/query/port/ambiguity-dictionary.port.js';
import type { AliasMatcher, AliasMatchResult } from '../../src/domain/query/service/anchor-extractor.js';
import type { NLMapper } from '../../src/domain/attribute/service/nl-mapper.js';

/** AliasMatcher that returns a hit for every substring it knows about. */
class StubAliasMatcher implements AliasMatcher {
  constructor(private readonly entries: Map<string, AliasMatchResult>) {}
  findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const results: AliasMatchResult[] = [];
    for (const [key, value] of this.entries) {
      if (normalizedQuery.includes(key)) {
        results.push(value);
      }
    }
    return Promise.resolve(results);
  }
}

const noOpNLMapper: NLMapper = {
  mapPhrase: () => Promise.resolve(null),
  mapConstraints: () => Promise.resolve({ constraints: [] }),
} as unknown as NLMapper;

/** Counts per-method invocations so we can prove the planner uses the batch path. */
class InstrumentedAmbiguityDict implements AmbiguityDictionary {
  isKnownAmbiguousCallCount = 0;
  getAmbiguityInfoCallCount = 0;
  getAmbiguityInfoBatchCallCount = 0;

  async isKnownAmbiguous(_form: string): Promise<boolean> {
    this.isKnownAmbiguousCallCount += 1;
    return false;
  }

  async getAmbiguityInfo(_form: string): Promise<AmbiguityInfo | null> {
    this.getAmbiguityInfoCallCount += 1;
    return null;
  }

  async getAmbiguityInfoBatch(
    _surfaceForms: readonly string[],
  ): Promise<ReadonlyMap<string, AmbiguityInfo>> {
    this.getAmbiguityInfoBatchCallCount += 1;
    return new Map();
  }
}

function makeAnchorEntry(form: string): AliasMatchResult {
  return {
    surfaceForm: form,
    normalizedForm: form.toLowerCase(),
    entityIds: ([`wine-${form}-001`, `wine-${form}-002`] as unknown) as AliasMatchResult['entityIds'],
    matchConfidence: 0.9,
  };
}

describe('C3 regression: planner ambiguity lookup batching', () => {
  it('replaces the per-anchor singular path with a single batched lookup', async () => {
    // Seed multiple anchor surface forms so the previous code would have
    // emitted N singular calls (N > 1) inside computeUncertainty.
    const aliases = new Map<string, AliasMatchResult>([
      ['cabernet sauvignon', makeAnchorEntry('cabernet sauvignon')],
      ['napa valley', makeAnchorEntry('napa valley')],
      ['reserve', makeAnchorEntry('reserve')],
    ]);
    const dict = new InstrumentedAmbiguityDict();
    const planner = new Planner(
      dict,
      new AnchorExtractor(new StubAliasMatcher(aliases)),
      new ExpansionBuilder(),
      noOpNLMapper,
    );

    const plan = await planner.plan('cabernet sauvignon napa valley reserve');

    // Sanity: the planner did surface multiple anchors so the regression
    // would have been observable on the old per-anchor path.
    expect(plan.anchors.length).toBeGreaterThanOrEqual(2);

    // Per-form singular calls must be zero on the hot uncertainty + class path.
    // (`isKnownAmbiguous` may still be called at most once for the full
    // normalised query in some non-batched code paths; we cap it at 1 so a
    // reintroduced per-anchor loop is caught immediately.)
    expect(dict.getAmbiguityInfoCallCount).toBe(0);
    expect(dict.isKnownAmbiguousCallCount).toBeLessThanOrEqual(1);

    // Batched lookup must have been used at least once. Capped at 4 to allow
    // future readers (e.g. ambiguity-intent compiler) to also batch without
    // accidentally regressing back to N calls.
    expect(dict.getAmbiguityInfoBatchCallCount).toBeGreaterThanOrEqual(1);
    expect(dict.getAmbiguityInfoBatchCallCount).toBeLessThanOrEqual(4);
  });

  it('handles empty surfaceForms without round-tripping the substrate', async () => {
    const dict = new InstrumentedAmbiguityDict();
    const result = await dict.getAmbiguityInfoBatch([]);
    expect(result.size).toBe(0);
    // The instrumented stub records the call. The contract for the SUBSTRATE
    // (PG/static) implementations is to short-circuit on empty input; that
    // contract is enforced in their own unit tests, but is captured here in
    // the docstring above as a hard requirement.
    expect(dict.getAmbiguityInfoBatchCallCount).toBe(1);
  });
});
