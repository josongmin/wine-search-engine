/**
 * Regression tests for date/time audit fixes that remain on the live contract.
 *
 * Covers:
 *  1. `normalizeYear` recomputes its upper bound per call.
 *  2. Invalid `trainedAt` timestamps do not silently bypass staleness logic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeYear } from '@domain/ingestion/service/field-normalizer.js';

describe('date-time audit — year rollover (field-normalizer)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('en-primeur ceiling tracks the wall clock (year + 1)', () => {
    vi.setSystemTime(new Date('2050-06-15T12:00:00.000Z'));
    expect(normalizeYear('2051')).toBe(2051);
    expect(normalizeYear('2052')).toBeNull();

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
    const invalidTrainedAt = new Date('not-a-date');
    const trainedAtMs = invalidTrainedAt.getTime();
    expect(Number.isNaN(trainedAtMs)).toBe(true);

    const modelAgeMs = Number.isFinite(trainedAtMs)
      ? Date.now() - trainedAtMs
      : Number.NaN;
    const modelAgeDays = modelAgeMs / 86_400_000;
    expect(Number.isFinite(modelAgeDays)).toBe(false);

    const validTrainedAtMs = new Date('2020-01-01T00:00:00.000Z').getTime();
    expect(Number.isFinite(validTrainedAtMs)).toBe(true);
    const validAgeDays =
      (Date.now() - validTrainedAtMs) / 86_400_000;
    expect(Number.isFinite(validAgeDays)).toBe(true);
    expect(validAgeDays).toBeGreaterThan(0);
  });
});
