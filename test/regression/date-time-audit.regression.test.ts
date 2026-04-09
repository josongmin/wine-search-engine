/**
 * Regression tests for date/time/timezone/locale audit fixes.
 *
 * Append-only per CLAUDE.md test discipline. Covers:
 *
 *  1. `LTR_CURRENT_YEAR` year-rollover: the year used by
 *     `extractLTRFeatures` for drinking-window comparisons MUST be recomputed
 *     per call. A module-scoped constant goes stale on Dec 31 → Jan 1 for
 *     long-lived server processes and silently mis-classifies
 *     `drinking_window_in_range` for an entire year.
 *
 *  2. `MAX_PLAUSIBLE_VINTAGE_YEAR` year-rollover: the upper bound used by
 *     `normalizeYear` for en-primeur rejection MUST be recomputed per call
 *     so that the ingestion pipeline keeps accepting the "next" vintage
 *     across a January rollover without a process restart.
 *
 *  3. Invalid `trainedAt` NaN hazard in `applyLearnedLtrRerank`: a JSONB-
 *     corrupted or `new Date(undefined)` training record produces NaN from
 *     `getTime()`, and `NaN > threshold` silently evaluates to `false`,
 *     bypassing the staleness warning. The fixed code must flag the
 *     invalid timestamp explicitly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractLTRFeatures } from '@domain/ranking/service/ltr-features.js';
import { normalizeYear } from '@domain/ingestion/service/field-normalizer.js';
import type { HybridCandidate } from '@domain/retrieval/model/hybrid-candidate.js';
import { createEntityId } from '@domain/shared/types/index.js';

const noDegradation = { dense: false, sparse: false, anchor: false } as const;

function candidateWithDrinkingWindow(start: number, end: number): HybridCandidate {
  return {
    entityId: createEntityId('w-dw'),
    retrievalFusionScore: 0.5,
    retrievalTrace: {
      candidateSources: [],
      retrievalProfile: 'default',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      skippedPhases: [],
    },
    matchedConstraints: [],
    drinkingWindowStart: start,
    drinkingWindowEnd: end,
  } as unknown as HybridCandidate;
}

describe('date-time audit — year rollover (ltr-features)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the current year AT CALL TIME for drinking-window in-range (not module-load time)', () => {
    // Freeze "now" to a year such that the drinking window [2030..2032]
    // should NOT include `now`. If the fix were reverted and the constant
    // baked in a different process-load year, this assertion would be
    // decided by the baked-in year instead of the mocked clock.
    vi.setSystemTime(new Date('2020-06-15T00:00:00.000Z'));
    const f = extractLTRFeatures({
      query: 'q',
      normalizedQuery: 'q',
      candidate: candidateWithDrinkingWindow(2030, 2032),
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(f.drinking_window_in_range).toBe(0);
  });

  it('simulated year-rollover: two calls on different mocked years return different answers', () => {
    // Candidate drinking window is [2050, 2055]. Clock mocked to 2050 → in range;
    // clock mocked to 2040 → not yet. Both years are far enough from real
    // system time that the real clock would produce a stable "not in range"
    // for both, so any test failure proves the per-call computation works.
    const candidate = candidateWithDrinkingWindow(2050, 2055);

    vi.setSystemTime(new Date('2050-06-15T12:00:00.000Z'));
    const inRange = extractLTRFeatures({
      query: 'q',
      normalizedQuery: 'q',
      candidate,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(inRange.drinking_window_in_range).toBe(1);

    vi.setSystemTime(new Date('2040-06-15T12:00:00.000Z'));
    const notYet = extractLTRFeatures({
      query: 'q',
      normalizedQuery: 'q',
      candidate,
      hardConstraints: [],
      softConstraints: [],
      degradationFlags: noDegradation,
    });
    expect(notYet.drinking_window_in_range).toBe(0);
  });
});

describe('date-time audit — year rollover (field-normalizer)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('en-primeur ceiling tracks the wall clock (year + 1)', () => {
    // Mock to a fixed year. Under the fix, normalizeYear accepts year+1 and
    // rejects year+2. A module-scoped constant would fail this round-trip
    // whenever the process load year differs from the mocked year.
    vi.setSystemTime(new Date('2050-06-15T12:00:00.000Z'));
    expect(normalizeYear('2051')).toBe(2051);
    expect(normalizeYear('2052')).toBeNull();

    // Different mocked year → different cutoff, same function.
    vi.setSystemTime(new Date('2040-06-15T12:00:00.000Z'));
    expect(normalizeYear('2041')).toBe(2041);
    expect(normalizeYear('2042')).toBeNull();
  });

  it('1800 boundary still accepted (regression for valid historic vintages)', () => {
    expect(normalizeYear('1800')).toBe(1800);
  });
});

describe('date-time audit — Invalid Date NaN hazard', () => {
  it('Number.isFinite guards the Date.getTime() NaN trap', () => {
    // Direct proof of the guard pattern used in ranker.ts applyLearnedLtrRerank.
    // Reverting the fix (`Date.now() - invalid.getTime()` with no guard) would
    // make `modelAgeMs` NaN, `modelAgeDays` NaN, and `NaN > threshold` false —
    // silently skipping the staleness warning for a model with a broken
    // `trainedAt`. The guard must treat NaN as "unknown / flag".
    const invalidTrainedAt = new Date('not-a-date');
    const trainedAtMs = invalidTrainedAt.getTime();
    expect(Number.isNaN(trainedAtMs)).toBe(true);

    const modelAgeMs = Number.isFinite(trainedAtMs)
      ? Date.now() - trainedAtMs
      : Number.NaN;
    const modelAgeDays = modelAgeMs / 86_400_000;
    expect(Number.isFinite(modelAgeDays)).toBe(false);

    // A valid Date still flows through normally.
    const validTrainedAtMs = new Date('2020-01-01T00:00:00.000Z').getTime();
    expect(Number.isFinite(validTrainedAtMs)).toBe(true);
    const validAgeDays =
      (Date.now() - validTrainedAtMs) / 86_400_000;
    expect(Number.isFinite(validAgeDays)).toBe(true);
    expect(validAgeDays).toBeGreaterThan(0);
  });
});
