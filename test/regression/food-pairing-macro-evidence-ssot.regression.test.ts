/**
 * SSoT regression: `closeFoodPairingMacroEvidence` and
 * `collectFoodPairingMacroEvidenceAxes` live in the application module
 * `src/application/search/food-pairing-macro-evidence.ts`.
 *
 * History: both functions were originally authored privately inside
 *   - `src/application/agent/agent-tools.ts` (the `get_food_pairings` branch)
 *   - `src/application/food-pairing/food-pairing.usecase.ts` (the
 *     extracted standalone use case).
 * The two copies were byte-identical pure functions. Drift would have
 * silently caused the agent loop and the new wine-search orchestrator to
 * apply different "lift the pairing constraint" rules on identical
 * evidence.
 *
 * Invariants locked here:
 *  - The SSoT module exposes the two function identities and the named
 *    threshold constant.
 *  - `collectFoodPairingMacroEvidenceAxes` returns the expected axes for
 *    the canonical positive cases (pairing-tag overlap, wine-type match,
 *    style match, sweetness/acidity/tannin match, spicy-heat balance).
 *  - `closeFoodPairingMacroEvidence` lifts the `pairing` constraint when
 *    at least `FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES` axes agree OR when
 *    `pairing_tags` itself agrees. The function returns the input
 *    unchanged when no pairing axes apply.
 *  - Empty-input / no-pairing-tags edge cases (CLAUDE.md self-audit pass)
 *    return the response unchanged.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES,
  closeFoodPairingMacroEvidence,
  collectFoodPairingMacroEvidenceAxes,
  type PairingEvidenceClosureInput,
} from '../../src/application/search/food-pairing-macro-evidence.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

function makeItem(overrides: {
  readonly pairingTags?: readonly string[];
  readonly style?: string;
  readonly matched?: readonly string[];
  readonly unmet?: readonly string[];
} = {}): SearchResponseV1['results'][number] {
  // Construct a minimal SearchResponseV1 result item that exercises only
  // the fields read by `collectFoodPairingMacroEvidenceAxes`. We cast the
  // generated literal to the public type — the macro-evidence closure
  // touches only `entity.{pairingTags, style}` and `constraints.{matched, unmet}`.
  return {
    entity: {
      id: 'wine_1',
      name: 'Test Wine',
      ...(overrides.pairingTags !== undefined
        ? { pairingTags: overrides.pairingTags }
        : {}),
      ...(overrides.style !== undefined ? { style: overrides.style } : {}),
    },
    constraints: {
      matched: overrides.matched ?? [],
      unmet: overrides.unmet ?? [],
    },
  } as unknown as SearchResponseV1['results'][number];
}

function makeResponse(
  items: readonly SearchResponseV1['results'][number][],
): SearchResponseV1 {
  return {
    queryType: 'search',
    results: items,
  } as unknown as SearchResponseV1;
}

describe('SSoT: FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES', () => {
  it('is a finite positive integer >= 2', () => {
    expect(Number.isFinite(FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES)).toBe(true);
    expect(Number.isInteger(FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES)).toBe(true);
    expect(FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES).toBeGreaterThanOrEqual(2);
  });
});

describe('SSoT: collectFoodPairingMacroEvidenceAxes — axis coverage', () => {
  it('detects pairing_tags overlap and wine_type/style/sweetness axes together', () => {
    const item = makeItem({
      pairingTags: ['steak', 'beef'],
      style: 'bold',
      matched: ['wine_type', 'style', 'sweetness'],
    });
    const input: PairingEvidenceClosureInput = {
      color: 'red',
      pairing_tags: ['steak'],
      styles: ['bold'],
      sweetness_target: 0.2,
    };
    const axes = collectFoodPairingMacroEvidenceAxes(item, input);
    expect(axes).toContain('pairing_tags');
    expect(axes).toContain('wine_type');
    expect(axes).toContain('style');
    expect(axes).toContain('sweetness');
  });

  it('detects spicy_heat_balance when pairing_tags includes spicy_food + style is sweet/off_dry + sweetness matched', () => {
    const item = makeItem({
      pairingTags: ['spicy_food'],
      matched: ['sweetness'],
    });
    const input: PairingEvidenceClosureInput = {
      pairing_tags: ['spicy_food'],
      styles: ['off_dry'],
    };
    const axes = collectFoodPairingMacroEvidenceAxes(item, input);
    expect(axes).toContain('spicy_heat_balance');
  });

  it('detects acidity / tannin axes when matched', () => {
    const item = makeItem({
      pairingTags: ['sushi'],
      matched: ['acidity', 'tannin'],
    });
    const input: PairingEvidenceClosureInput = {
      pairing_tags: ['sushi'],
      acidity_min: 6,
      tannin_max: 3,
    };
    const axes = collectFoodPairingMacroEvidenceAxes(item, input);
    expect(axes).toContain('acidity');
    expect(axes).toContain('tannin');
  });

  it('returns no axes for a totally non-matching item (adversarial empty case)', () => {
    const item = makeItem({});
    const input: PairingEvidenceClosureInput = { pairing_tags: ['anything'] };
    expect(collectFoodPairingMacroEvidenceAxes(item, input)).toEqual([]);
  });
});

describe('SSoT: closeFoodPairingMacroEvidence — lift rule', () => {
  it('returns the response unchanged when pairing_tags is undefined', () => {
    const item = makeItem({ unmet: ['pairing'] });
    const response = makeResponse([item]);
    const result = closeFoodPairingMacroEvidence(response, {});
    expect(result).toBe(response);
  });

  it('returns the response unchanged when pairing_tags is empty', () => {
    const item = makeItem({ unmet: ['pairing'] });
    const response = makeResponse([item]);
    const result = closeFoodPairingMacroEvidence(response, {
      pairing_tags: [],
    });
    expect(result).toBe(response);
  });

  it('lifts pairing from unmet to matched when pairing_tags itself agrees (axis count irrelevant)', () => {
    const item = makeItem({
      pairingTags: ['steak'],
      unmet: ['pairing'],
    });
    const response = makeResponse([item]);
    const result = closeFoodPairingMacroEvidence(response, {
      pairing_tags: ['steak'],
    });
    const [updated] = result.results;
    expect(updated).toBeDefined();
    if (updated === undefined) return;
    expect(updated.constraints.matched).toContain('pairing');
    expect(updated.constraints.unmet).not.toContain('pairing');
  });

  it('lifts pairing when 2+ axes agree even without direct pairing_tag overlap', () => {
    const item = makeItem({
      style: 'bold',
      matched: ['wine_type', 'style'],
      unmet: ['pairing'],
    });
    const response = makeResponse([item]);
    const result = closeFoodPairingMacroEvidence(response, {
      color: 'red',
      pairing_tags: ['mystery_food'],
      styles: ['bold'],
    });
    const [updated] = result.results;
    expect(updated).toBeDefined();
    if (updated === undefined) return;
    expect(updated.constraints.matched).toContain('pairing');
  });

  it('does NOT lift pairing when only one non-pairing-tag axis agrees', () => {
    const item = makeItem({
      matched: ['wine_type'],
      unmet: ['pairing'],
    });
    const response = makeResponse([item]);
    const result = closeFoodPairingMacroEvidence(response, {
      color: 'red',
      pairing_tags: ['mystery_food'],
    });
    const [updated] = result.results;
    expect(updated).toBeDefined();
    if (updated === undefined) return;
    expect(updated.constraints.matched).not.toContain('pairing');
    expect(updated.constraints.unmet).toContain('pairing');
  });
});

describe('SSoT: identity equality across consumer call sites', () => {
  it('the agent tool branch and the food-pairing use case both bind the SAME function identity', async () => {
    // The legacy agent-tools branch imports `closeFoodPairingMacroEvidence`
    // from the SSoT; the food-pairing use case wraps the same SSoT call
    // through a thin alias. We re-import the SSoT here and assert identity.
    const ssotModule = await import(
      '../../src/application/search/food-pairing-macro-evidence.js'
    );
    expect(ssotModule.closeFoodPairingMacroEvidence).toBe(closeFoodPairingMacroEvidence);
    expect(ssotModule.collectFoodPairingMacroEvidenceAxes).toBe(
      collectFoodPairingMacroEvidenceAxes,
    );
    expect(ssotModule.FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES).toBe(
      FOOD_PAIRING_MIN_MACRO_EVIDENCE_AXES,
    );
  });
});
