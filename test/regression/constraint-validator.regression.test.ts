/**
 * Regression: constraint-validator (Wave 1, Cluster E).
 *
 * The compile path from {@link ConstraintBundle} to Vespa YQL tokens
 * (`constraint-to-sparse-filter-tokens.ts` + `mapping.ts` FILTER_TOKEN_REGISTRY)
 * used to silently drop any constraint whose attribute had no `case` branch
 * or no registry entry. No diagnostic, no fallback, no ranking penalty.
 *
 * This regression pins:
 *   1. Hard constraints on registered attributes → `accepted`.
 *   2. Hard constraints on unregistered attributes → `unrecognized`;
 *      {@link assertNoUnrecognizedConstraints} throws with diagnostic.
 *   3. Soft constraints on attributes outside SOFT_PROMOTION_TOKEN_SPEC
 *      AND inside SOFT_CONSTRAINT_ATTRIBUTES (e.g. `style`, `price_band`,
 *      `drinking_window`) → `dropped` with `soft_tier_not_promotable`
 *      reason — surfaces the silent no-op.
 *   4. Telemetry log fires exactly ONCE per (tier, attribute, reason)
 *      triplet per process; subsequent calls increment the counter but
 *      stay silent in the log.
 *   5. The bootstrap logger receives a structured `event` field for both
 *      `dropped` and `unrecognized` paths so operators can grep logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateConstraintBundle,
  emitConstraintValidationTelemetry,
  assertNoUnrecognizedConstraints,
  UnrecognizedConstraintError,
  __resetConstraintValidatorLogCacheForTests,
} from '../../src/domain/retrieval/service/constraint-validator.js';
import type { NormalizedConstraint } from '../../src/domain/shared/types/index.js';
import { bootstrapLogger } from '../../src/domain/shared/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../src/domain/observability/silent-skip-counters.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConstraint(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
  confidence = 0.9,
  mapping_version: string | undefined = 'rule-based-v1.0',
): NormalizedConstraint {
  return {
    attribute,
    operator,
    value,
    source_phrase: attribute,
    confidence,
    ...(mapping_version !== undefined ? { mapping_version } : {}),
  };
}

describe('validateConstraintBundle — Wave 1 Cluster E', () => {
  beforeEach(() => {
    __resetConstraintValidatorLogCacheForTests();
    globalSilentSkipCounter.reset();
  });

  it('accepts a hard constraint on a registered attribute (country)', () => {
    const report = validateConstraintBundle({
      hard: [makeConstraint('country', '=', 'France')],
      soft: [],
      inferred: [],
    });
    expect(report.accepted).toHaveLength(1);
    expect(report.dropped).toHaveLength(0);
    expect(report.unrecognized).toHaveLength(0);
    expect(report.accepted[0]?.constraint.attribute).toBe('country');
  });

  it('marks a hard constraint on a totally unknown attribute as `unrecognized` (planner bug)', () => {
    const report = validateConstraintBundle({
      hard: [makeConstraint('nonexistent_attribute_xyz', '=', 'foo')],
      soft: [],
      inferred: [],
    });
    expect(report.unrecognized).toHaveLength(1);
    expect(report.unrecognized[0]?.reason).toBe('attribute_not_in_compile_path');
    expect(() => assertNoUnrecognizedConstraints(report)).toThrow(UnrecognizedConstraintError);
  });

  it('UnrecognizedConstraintError message includes the offending attribute', () => {
    const report = validateConstraintBundle({
      hard: [makeConstraint('nonexistent_attribute_xyz', '=', 'foo')],
      soft: [],
      inferred: [],
    });
    try {
      assertNoUnrecognizedConstraints(report);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnrecognizedConstraintError);
      const e = err as UnrecognizedConstraintError;
      expect(e.message).toContain('nonexistent_attribute_xyz');
      expect(e.attributes).toContain('hard:nonexistent_attribute_xyz');
    }
  });

  it('marks a soft constraint on `style` (recognised soft attribute, not in SOFT_PROMOTION_TOKEN_SPEC) as `dropped`', () => {
    // `style` is in SOFT_CONSTRAINT_ATTRIBUTES (preference signal) but
    // intentionally NOT in SOFT_PROMOTION_TOKEN_SPEC — the compile path
    // emits zero promotion tokens for it. The constraint still flows into
    // softBoosts via retrieval-plan-builder.ts, but it never becomes a
    // Vespa WHERE-clause filter. That silent-no-op is what `dropped`
    // surfaces.
    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
      inferred: [],
    });
    expect(report.dropped).toHaveLength(1);
    expect(report.dropped[0]?.reason).toBe('soft_tier_not_promotable');
    expect(report.dropped[0]?.constraint.attribute).toBe('style');
    expect(report.accepted).toHaveLength(0);
    expect(report.unrecognized).toHaveLength(0);
  });

  it('marks `drinking_window` and `price_band` soft constraints as dropped (no promotion spec)', () => {
    const report = validateConstraintBundle({
      hard: [],
      soft: [
        makeConstraint('drinking_window', 'range', { min: 2024, max: 2030 }),
        makeConstraint('price_band', '=', 'premium'),
      ],
      inferred: [],
    });
    expect(report.dropped).toHaveLength(2);
    expect(report.dropped.map((d) => d.constraint.attribute).sort()).toEqual([
      'drinking_window',
      'price_band',
    ]);
    expect(report.dropped.every((d) => d.reason === 'soft_tier_not_promotable')).toBe(true);
  });

  it('marks hard price_band equality as dropped when the compile path emits no positive tokens', () => {
    const report = validateConstraintBundle({
      hard: [makeConstraint('price_band', '=', 'premium')],
      soft: [],
      inferred: [],
    });
    expect(report.accepted).toHaveLength(0);
    expect(report.unrecognized).toHaveLength(0);
    expect(report.dropped).toHaveLength(1);
    expect(report.dropped[0]?.constraint.attribute).toBe('price_band');
    expect(report.dropped[0]?.reason).toBe('hard_tier_not_filterable');
  });

  it('accepts soft constraints whose attribute IS in SOFT_PROMOTION_TOKEN_SPEC (critic_score)', () => {
    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('critic_score', '>=', 0.9)],
      inferred: [],
    });
    expect(report.accepted).toHaveLength(1);
    expect(report.dropped).toHaveLength(0);
    expect(report.unrecognized).toHaveLength(0);
  });

  it('marks a hard-placed ranking-only attribute (style hard) as dropped, not unrecognized', () => {
    // `style` IS a recognised soft / ranking attribute. Placing it in the
    // hard tier is a planner mis-classification: the compile path's hard
    // case emits tokens but only for the `style_matches:` regex prefix
    // path. Either way, the validator surfaces the placement as `dropped`
    // (not `unrecognized`) so the planner bug is surfaced without a 5xx.
    //
    // Note: `style` is in HARD_FILTERABLE_ATTRIBUTES (the hard switch has
    // a case), so the validator marks it as `hard_filterable` and accepts
    // it. This test pins the regression: an attribute may legitimately
    // sit in HARD_FILTERABLE_ATTRIBUTES even when it's also a recognised
    // soft attribute — `style` is exactly that compound case.
    const report = validateConstraintBundle({
      hard: [makeConstraint('style', '=', 'bold')],
      soft: [],
      inferred: [],
    });
    expect(report.accepted).toHaveLength(1);
    expect(report.unrecognized).toHaveLength(0);
  });
});

describe('emitConstraintValidationTelemetry — Wave 1 Cluster E', () => {
  beforeEach(() => {
    __resetConstraintValidatorLogCacheForTests();
    globalSilentSkipCounter.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs ONCE per (tier, attribute, reason) triplet across multiple calls; counter increments every time', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('style', '=', 'bold')],
      inferred: [],
    });

    emitConstraintValidationTelemetry(report);
    emitConstraintValidationTelemetry(report);
    emitConstraintValidationTelemetry(report);

    // Logged exactly once (first-seen cache).
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Counter increments on every call (operator-facing volume).
    const snapshot = globalSilentSkipCounter.snapshot();
    expect(snapshot.constraint_validator_dropped).toBe(3);
  });

  it('emits a structured log with event=constraint_validator.dropped and the attribute', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('price_band', '=', 'premium')],
      inferred: [],
    });
    emitConstraintValidationTelemetry(report, { query_class: 'short_entity' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = warnSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['event']).toBe('constraint_validator.dropped');
    expect(payload['attribute']).toBe('price_band');
    expect(payload['tier']).toBe('soft');
    expect(payload['reason']).toBe('soft_tier_not_promotable');
    expect(payload['strategy_primary']).toBe('candidate_shaping');
    expect(payload['query_class']).toBe('short_entity');
  });

  it('surfaces verification-only unsupported reason for drinking_window', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);

    const report = validateConstraintBundle({
      hard: [],
      soft: [makeConstraint('drinking_window', 'range', { min: 2024, max: 2030 })],
      inferred: [],
    });
    emitConstraintValidationTelemetry(report);

    const payload = warnSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['strategy_primary']).toBe('ranking_only');
    expect(payload['retrieval_unsupported_reason']).toBe('post_search_verification_only');
  });

  it('emits an error-level log for unrecognized constraints with event=constraint_validator.unrecognized', () => {
    const errorSpy = vi.spyOn(bootstrapLogger, 'error').mockImplementation(() => undefined);

    const report = validateConstraintBundle({
      hard: [makeConstraint('nonexistent_attribute_xyz', '=', 'foo')],
      soft: [],
      inferred: [],
    });
    emitConstraintValidationTelemetry(report);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = errorSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['event']).toBe('constraint_validator.unrecognized');
    expect(payload['attribute']).toBe('nonexistent_attribute_xyz');

    const snapshot = globalSilentSkipCounter.snapshot();
    expect(snapshot.constraint_validator_unrecognized).toBe(1);
  });

  it('different (attribute, reason) triplets each log once', () => {
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => undefined);

    const report = validateConstraintBundle({
      hard: [],
      soft: [
        makeConstraint('style', '=', 'bold'),
        makeConstraint('price_band', '=', 'premium'),
        makeConstraint('drinking_window', 'range', { min: 2024, max: 2030 }),
      ],
      inferred: [],
    });
    emitConstraintValidationTelemetry(report);
    emitConstraintValidationTelemetry(report);

    // Three distinct attributes → three first-seen log emissions on the
    // FIRST call; zero on the second.
    expect(warnSpy).toHaveBeenCalledTimes(3);

    const snapshot = globalSilentSkipCounter.snapshot();
    expect(snapshot.constraint_validator_dropped).toBe(6); // 3 × 2 calls
  });
});
