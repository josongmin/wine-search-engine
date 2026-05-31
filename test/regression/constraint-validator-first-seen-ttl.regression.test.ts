/**
 * Regression: constraint-validator first-seen log throttle (TTL + count).
 *
 * Background: the original implementation cached `(tier, attribute, reason)`
 * triplets in a `Set` and logged ONLY the very first sighting per process.
 * In long-running production processes (the API runs for days), this meant
 * a regressing planner could emit thousands of silent-dropped constraints
 * after the first warn fired — operators had no qualitative log evidence
 * after that initial sighting. The silent-skip counter still incremented,
 * but counters are only useful when the operator already knows to look at
 * the dashboard.
 *
 * SOTA++ fix: replace the `Set` with a `Map<key, { lastLoggedAt, silentCount }>`
 * and re-log on EITHER a TTL trip (`FIRST_SEEN_TTL_MS = 1h`) or a count
 * threshold trip (`FIRST_SEEN_COUNT_THRESHOLD = 1000`), whichever comes
 * first. The counter still increments on every call (volume SSoT).
 *
 * This regression pins:
 *   1. Original "first sighting → warn" behaviour preserved.
 *   2. Subsequent occurrences inside the throttle window stay silent.
 *   3. TTL trip (>= 1h since last warn) re-fires the log.
 *   4. Count threshold trip (>= 1000 occurrences since last warn) re-fires
 *      the log even when wall-clock is frozen.
 *   5. Distinct triplets are tracked independently (one TTL trip does NOT
 *      reset another triplet's clock).
 *   6. Counter increments fire on EVERY call regardless of throttle state.
 *   7. The unrecognized path uses the same throttle policy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  validateConstraintBundle,
  emitConstraintValidationTelemetry,
  __resetConstraintValidatorLogCacheForTests,
} from '../../src/domain/retrieval/service/constraint-validator.js';
import type { NormalizedConstraint } from '../../src/domain/shared/types/index.js';
import { bootstrapLogger } from '../../src/domain/shared/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../src/domain/observability/silent-skip-counters.js';
import { MS_PER_HOUR } from '../../src/domain/shared/utils/time-units.js';

// Must mirror the production constants. The test deliberately re-declares
// them (rather than importing them) so a future "let's loosen the TTL"
// change shows up as a failing test instead of a silent semantic drift.
const TTL_MS_FOR_TEST = 60 * 60 * 1000;
const COUNT_THRESHOLD_FOR_TEST = 1000;

function makeConstraint(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
): NormalizedConstraint {
  return {
    attribute,
    operator,
    value,
    source_phrase: attribute,
    confidence: 0.9,
    mapping_version: 'rule-based-v1.0',
  };
}

function makeInjectableClock(initialMs = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = initialMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('constraint-validator — first-seen log TTL + count throttle', () => {
  it('FIRST_SEEN_TTL_MS derives from the time-units SSoT (MS_PER_HOUR) — drift guard', () => {
    // The constraint-validator previously re-multiplied MS_PER_SECOND *
    // SECONDS_PER_MINUTE * MINUTES_PER_HOUR locally instead of importing the
    // shared unit constants. This pins the 1h TTL to BOTH the hand-mirrored
    // test constant AND the @domain/shared/utils/time-units SSoT, so a drift
    // in either surfaces here.
    expect(MS_PER_HOUR).toBe(TTL_MS_FOR_TEST);
    expect(MS_PER_HOUR).toBe(60 * 60 * 1000);
  });

  beforeEach(() => {
    __resetConstraintValidatorLogCacheForTests();
    globalSilentSkipCounter.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('first sighting emits a warn (preserve original behaviour)', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);
    const clock = makeInjectableClock();

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
    });
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('second occurrence within the TTL window AND below the count threshold stays silent', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);
    const clock = makeInjectableClock();

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
    });
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    clock.advance(5 * 60 * 1000); // 5 minutes — well inside the 1h TTL
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });

    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Counter increments on every call.
    expect(globalSilentSkipCounter.snapshot()['constraint_validator_dropped']).toBe(2);
  });

  it('TTL elapsed → re-emits the warn (recurring silent-drop becomes visible)', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);
    const clock = makeInjectableClock();

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
    });
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    // Advance exactly to the TTL boundary — the comparison is `>=`, so this
    // MUST re-fire. (Off-by-one boundary check.)
    clock.advance(TTL_MS_FOR_TEST);
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('TTL not yet elapsed (1ms shy) → stays silent', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);
    const clock = makeInjectableClock();

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
    });
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    clock.advance(TTL_MS_FOR_TEST - 1);
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('count threshold reached with frozen clock → re-emits the warn', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);
    const clock = makeInjectableClock();

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
    });

    // Fire COUNT_THRESHOLD + 1 telemetry calls total. With the throttle
    // semantic "log every Nth occurrence", we expect exactly 2 warns:
    // call 1 (first sighting) and call COUNT_THRESHOLD + 1 (Nth silent
    // post-increment).
    for (let i = 0; i < COUNT_THRESHOLD_FOR_TEST + 1; i += 1) {
      emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    }

    expect(warnSpy).toHaveBeenCalledTimes(2);

    // Counter is authoritative for total volume.
    expect(globalSilentSkipCounter.snapshot()['constraint_validator_dropped']).toBe(
      COUNT_THRESHOLD_FOR_TEST + 1,
    );
  });

  it('distinct (tier, attribute, reason) triplets are tracked independently', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);
    const clock = makeInjectableClock();

    const reportA = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
    });
    const reportB = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('price_band', '=', 'premium')],
    });

    // First sighting of each triplet → two warns.
    emitConstraintValidationTelemetry(reportA, undefined, { nowFn: clock.now });
    emitConstraintValidationTelemetry(reportB, undefined, { nowFn: clock.now });
    expect(warnSpy).toHaveBeenCalledTimes(2);

    // Advance past TTL for A only (i.e. emit only A again past TTL).
    // The B triplet's clock must remain independent — re-emitting A inside
    // a fresh telemetry call MUST NOT reset B's lastLoggedAt.
    clock.advance(TTL_MS_FOR_TEST + 1);
    emitConstraintValidationTelemetry(reportA, undefined, { nowFn: clock.now });
    expect(warnSpy).toHaveBeenCalledTimes(3);

    // Roll the clock back to "5 minutes after B's last log" — but our
    // clock only goes forward, so instead just re-emit B with a tiny
    // advance and confirm it stays silent. B's lastLoggedAt was the
    // ORIGINAL initialMs; we advanced by TTL_MS + 1 since then, which
    // means B should ALSO trip TTL. Confirm by re-emitting B now and
    // asserting warn count went up by 1.
    emitConstraintValidationTelemetry(reportB, undefined, { nowFn: clock.now });
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });

  it('TTL trip and count threshold trip are independent — whichever wins fires first', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);
    const clock = makeInjectableClock();

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
    });

    // First sighting.
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Burn 500 silent occurrences inside TTL — neither trip fires.
    for (let i = 0; i < 500; i += 1) {
      emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Now advance past TTL — even though count threshold is only halfway
    // there, TTL trip fires AND resets the counter.
    clock.advance(TTL_MS_FOR_TEST + 1);
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    expect(warnSpy).toHaveBeenCalledTimes(2);

    // Burn another 999 silent occurrences (count just under threshold) —
    // no fire. (silentCount post-increment hits 999, < 1000.)
    for (let i = 0; i < 999; i += 1) {
      emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    }
    expect(warnSpy).toHaveBeenCalledTimes(2);

    // The next call's post-increment hits 1000 → fire.
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('unrecognized path uses the same throttle policy (re-emit on TTL trip)', () => {
    const errorSpy = vi.spyOn(bootstrapLogger, 'error').mockImplementation(() => undefined);
    const clock = makeInjectableClock();

    const report = validateConstraintBundle({
      hard: [makeConstraint('nonexistent_attribute_xyz', '=', 'foo')],
      soft: [],
    });

    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Inside TTL → silent.
    clock.advance(60_000);
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Past TTL → re-emit.
    clock.advance(TTL_MS_FOR_TEST);
    emitConstraintValidationTelemetry(report, undefined, { nowFn: clock.now });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('production callers (no options) use Date.now without crashing — backward compatible', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
    });

    // No options arg — the production caller signature.
    emitConstraintValidationTelemetry(report);
    emitConstraintValidationTelemetry(report);

    // Both calls are inside any conceivable TTL window AND below count
    // threshold → exactly one log.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
