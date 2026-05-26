/**
 * ToolInputNormalizer — pure-function unit tests.
 *
 * Coverage:
 *  - Per-function control + mutation cases (Korean + English + accented Latin)
 *  - Empty / undefined / adversarial inputs (rule 5)
 *  - Vintage boundary (rule 18) at MIN/MAX_PRODUCED_VINTAGE_YEAR
 *  - End-to-end composition on 5 realistic scenarios (Korean appellation,
 *    English producer, vintage-specific, food pairing, total budget split)
 *  - Parallel-slot expansion: opposite-color strip, occasion preservation,
 *    total-budget split
 *
 * NB: These tests assert behavioral parity with the agent layer's
 * normalize* helpers. Every Korean string is copied character-for-character
 * from the source (`agent-tool-execution-policy.ts`) — never paraphrased.
 */

import { describe, expect, it } from 'vitest';
import type { NormalizedConstraint } from '@shared/types/index.js';
import { convertKrwToConstraintUsd } from '@shared/utils/canonical-price.js';
import {
  MIN_PRODUCED_VINTAGE_YEAR,
  MAX_PRODUCED_VINTAGE_YEAR,
} from '@shared/constants.js';
import {
  DefaultToolInputNormalizer,
  TOOL_INPUT_NORMALIZER_MAX_VINTAGE_YEAR,
  TOOL_INPUT_NORMALIZER_MIN_VINTAGE_YEAR,
  _internalApplyDrinkabilityStrip,
  _internalApplyParallelSlotOccasionFilter,
  _internalBuildSlotQueryAnchor,
  _internalFindTotalBudgetForParallelSlots,
} from '../tool-input-normalizer.js';
import type { SearchUseCaseInput } from '../execution-plan-schemas.js';
import type { WineSearchAnalysis } from '../wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeConstraint(
  attribute: string,
  value: NormalizedConstraint['value'],
  operator: NormalizedConstraint['operator'] = '=',
): NormalizedConstraint {
  return {
    attribute,
    operator,
    value,
    source_phrase: typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : attribute,
    confidence: 1.0,
  };
}

function makeAnalysis(overrides: Partial<WineSearchAnalysis> = {}): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    normalizedConstraints: [],
    contract: {
      requiresDrinkabilityCheck: false,
      requiresGroundedWineSearch: true,
      hasEntityMetadataSignal: false,
    },
    expectedMultiStep: false,
    recommendedBudget: { maxSteps: 4, perToolCap: 3 },
    hangulDominant: false,
    preservedSurface: 'wine',
    ...overrides,
  };
}

function makeInput(overrides: Partial<SearchUseCaseInput> = {}): SearchUseCaseInput {
  return {
    query: 'wine',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyExactMetadataNormalization
// ---------------------------------------------------------------------------

describe('applyExactMetadataNormalization', () => {
  it('control: hasEntityMetadataSignal=false → input unchanged', () => {
    const input = makeInput({
      query: 'Bordeaux 2018',
      filters: [makeConstraint('country', 'France')],
    });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      hasEntityMetadataSignal: false,
    } });
    const out = DefaultToolInputNormalizer.applyExactMetadataNormalization(input, analysis);
    expect(out).toBe(input);
  });

  it('strips over-constraint filters when hasEntityMetadataSignal=true', () => {
    const input = makeInput({
      query: 'Opus One 2018',
      filters: [
        makeConstraint('country', 'United States'),
        makeConstraint('region', 'Napa Valley'),
        makeConstraint('wine_type', 'red'),
        // The vintage_year should survive only if exactMetadataTargetVintage is set.
      ],
    });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      hasEntityMetadataSignal: true,
    } });
    const out = DefaultToolInputNormalizer.applyExactMetadataNormalization(input, analysis);
    expect(out.filters ?? []).toHaveLength(0);
    expect(out.limit).toBe(1);
  });

  it('applies exact vintage bound when exactMetadataTargetVintage is set', () => {
    const input = makeInput({
      query: '오퍼스 원 2018',
      filters: [makeConstraint('region', 'Napa Valley')],
    });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      hasEntityMetadataSignal: true,
      exactMetadataTargetVintage: 2018,
    } });
    const out = DefaultToolInputNormalizer.applyExactMetadataNormalization(input, analysis);
    const vintageConstraint = (out.filters ?? []).find(
      (c) => c.attribute === 'vintage_year',
    );
    expect(vintageConstraint).toBeDefined();
    expect(vintageConstraint?.value).toBe(2018);
    expect(vintageConstraint?.operator).toBe('=');
    expect(out.limit).toBe(1);
  });

  it('boundary: exactMetadataTargetVintage = MIN_PRODUCED_VINTAGE_YEAR (1700)', () => {
    const input = makeInput({ query: 'antique wine' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      hasEntityMetadataSignal: true,
      exactMetadataTargetVintage: MIN_PRODUCED_VINTAGE_YEAR,
    } });
    const out = DefaultToolInputNormalizer.applyExactMetadataNormalization(input, analysis);
    const vintageConstraint = (out.filters ?? []).find(
      (c) => c.attribute === 'vintage_year',
    );
    expect(vintageConstraint?.value).toBe(1700);
  });

  it('boundary: exactMetadataTargetVintage = MAX_PRODUCED_VINTAGE_YEAR (2200)', () => {
    const input = makeInput({ query: 'future wine' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      hasEntityMetadataSignal: true,
      exactMetadataTargetVintage: MAX_PRODUCED_VINTAGE_YEAR,
    } });
    const out = DefaultToolInputNormalizer.applyExactMetadataNormalization(input, analysis);
    const vintageConstraint = (out.filters ?? []).find(
      (c) => c.attribute === 'vintage_year',
    );
    expect(vintageConstraint?.value).toBe(2200);
  });

  it('exported MIN/MAX vintage bounds re-export the shared constants', () => {
    expect(TOOL_INPUT_NORMALIZER_MIN_VINTAGE_YEAR).toBe(MIN_PRODUCED_VINTAGE_YEAR);
    expect(TOOL_INPUT_NORMALIZER_MAX_VINTAGE_YEAR).toBe(MAX_PRODUCED_VINTAGE_YEAR);
  });

  it('empty input filters → no throw, limit set to 1', () => {
    const input = makeInput({ query: 'Château Pétrus' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      hasEntityMetadataSignal: true,
    } });
    const out = DefaultToolInputNormalizer.applyExactMetadataNormalization(input, analysis);
    expect(out.limit).toBe(1);
    expect(out.filters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stripDrinkabilityObjectiveFromQuery
// ---------------------------------------------------------------------------

describe('stripDrinkabilityObjectiveFromQuery', () => {
  it('control: requiresDrinkabilityCheck=false → input unchanged', () => {
    const input = makeInput({ query: '지금 마시기 좋은 와인' });
    const analysis = makeAnalysis();
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out).toBe(input);
  });

  it('strips Korean drinkability phrases (지금 마시기 좋은)', () => {
    const input = makeInput({ query: '지금 마시기 좋은 부르고뉴 피노누아' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out.query).not.toContain('지금');
    expect(out.query).not.toContain('마시기 좋은');
    expect(out.query).toContain('부르고뉴');
    expect(out.query).toContain('피노누아');
  });

  it('strips English drinkability phrases (drink now)', () => {
    const input = makeInput({ query: 'Napa Cabernet drink now' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out.query.toLowerCase()).not.toContain('drink now');
    expect(out.query).toContain('Napa Cabernet');
  });

  it('strips cellaring phrases (셀러에 넣어둘 만한)', () => {
    const input = makeInput({ query: '셀러에 넣어둘 만한 보르도' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out.query).not.toContain('셀러');
    expect(out.query).toContain('보르도');
  });

  it('strips trailing 추천해줘 / tell me suffix', () => {
    const input = makeInput({ query: '지금 마실 수 있는 와인 추천해줘' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out.query).not.toContain('추천해줘');
  });

  it('replaces bare-vintage stripped query with vintage-anchored fallback', () => {
    const input = makeInput({
      query: '지금 마실 수 있는 2018',
      filters: [makeConstraint('vintage_year', 2018)],
    });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out.query).toBe('2018년산 와인');
  });

  it('falls back to "와인" when strip empties a Korean query', () => {
    const input = makeInput({ query: '지금 마실 수 있는 와인' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out.query).toBe('와인');
  });

  it('falls back to "wine" when strip empties an English query', () => {
    const input = makeInput({ query: 'currently drinkable wine' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out.query).toBe('wine');
  });

  it('control: accented Latin query passes through (no drinkability keywords)', () => {
    const input = makeInput({ query: 'Château d\'Yquem 1996' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out.query).toContain('Château');
    expect(out.query).toContain('Yquem');
  });

  it('adversarial: emoji + mixed-script query without drinkability keywords passes through', () => {
    const input = makeInput({ query: '🍷 Opus One 오퍼스 원' });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    const out = DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis);
    expect(out.query).toContain('Opus One');
  });

  it('adversarial: very long query (>500 chars) does not crash', () => {
    const longQuery = '지금 마실 수 있는 ' + 'wine '.repeat(200);
    const input = makeInput({ query: longQuery });
    const analysis = makeAnalysis({ contract: {
      ...makeAnalysis().contract,
      requiresDrinkabilityCheck: true,
    } });
    expect(() =>
      DefaultToolInputNormalizer.stripDrinkabilityObjectiveFromQuery(input, analysis),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyAnalysisDefaults
// ---------------------------------------------------------------------------

describe('applyAnalysisDefaults', () => {
  it('control: empty analysis constraints → input unchanged', () => {
    const input = makeInput({ query: 'pinot noir' });
    const analysis = makeAnalysis();
    const out = DefaultToolInputNormalizer.applyAnalysisDefaults(input, analysis);
    expect(out).toBe(input);
  });

  it('merges analysis constraints not already in input', () => {
    const input = makeInput({
      query: '부르고뉴 피노누아',
      filters: [makeConstraint('region', 'Burgundy')],
    });
    const analysis = makeAnalysis({
      normalizedConstraints: [
        makeConstraint('region', 'Burgundy'),
        makeConstraint('grape_primary', 'pinot noir'),
        makeConstraint('max_price_krw', 50_000, '<='),
      ],
    });
    const out = DefaultToolInputNormalizer.applyAnalysisDefaults(input, analysis);
    expect((out.filters ?? []).map((c) => c.attribute)).toEqual(
      expect.arrayContaining(['region', 'grape_primary', 'max_price_krw']),
    );
    // Dedupe — `region` constraint should appear once (same attribute+operator+value).
    const regionCount = (out.filters ?? []).filter((c) => c.attribute === 'region').length;
    expect(regionCount).toBe(1);
  });

  it('suppresses defaults when hasEntityMetadataSignal=true', () => {
    const input = makeInput({ query: 'Opus One 2018' });
    const analysis = makeAnalysis({
      contract: {
        ...makeAnalysis().contract,
        hasEntityMetadataSignal: true,
      },
      normalizedConstraints: [makeConstraint('country', 'United States')],
    });
    const out = DefaultToolInputNormalizer.applyAnalysisDefaults(input, analysis);
    expect(out).toBe(input);
  });

  it('empty input filters + analysis constraints → input gains filters', () => {
    const input = makeInput({ query: 'red wine 50000원 이하' });
    const analysis = makeAnalysis({
      normalizedConstraints: [
        makeConstraint('wine_type', 'red'),
        makeConstraint('max_price_krw', 50_000, '<='),
      ],
    });
    const out = DefaultToolInputNormalizer.applyAnalysisDefaults(input, analysis);
    expect(out.filters).toHaveLength(2);
  });

  it('merges tiered defaults into filters and preferences when flat legacy constraints are empty', () => {
    const input = makeInput({ query: '선물용 프랑스 와인' });
    const analysis = makeAnalysis({
      constraints: {
        hard: [makeConstraint('country', 'France')],
        soft: [makeConstraint('sweetness_min', 0.5, '>=')],
        inferred: [makeConstraint('occasion', 'gift')],
      },
      normalizedConstraints: [],
    });
    const out = DefaultToolInputNormalizer.applyAnalysisDefaults(input, analysis);
    expect(out.filters).toEqual([makeConstraint('country', 'France')]);
    expect(out.preferences).toEqual([
      makeConstraint('sweetness_min', 0.5, '>='),
      makeConstraint('occasion', 'gift'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// normalizeParallelSlotInput
// ---------------------------------------------------------------------------

describe('normalizeParallelSlotInput', () => {
  it('strips opposite-color token (Korean) for red slot', () => {
    const input = makeInput({ query: '레드 화이트 반반' });
    const analysis = makeAnalysis();
    const out = DefaultToolInputNormalizer.normalizeParallelSlotInput(
      input,
      analysis,
      { wineType: 'red' },
      2,
    );
    expect(out.query).not.toContain('화이트');
    expect(out.query).not.toContain('반반');
  });

  it('strips opposite-color token (English) for white slot', () => {
    const input = makeInput({ query: 'red and white pairing' });
    const analysis = makeAnalysis();
    const out = DefaultToolInputNormalizer.normalizeParallelSlotInput(
      input,
      analysis,
      { wineType: 'white' },
      2,
    );
    expect(out.query?.toLowerCase()).not.toMatch(/\bred\b/u);
  });

  it('splits a total budget evenly across slots (floor)', () => {
    const input = makeInput({ query: '레드 와인' });
    const analysis = makeAnalysis({
      decomposition: {
        kind: 'parallel-slot',
        slots: [{ wineType: 'red' }, { wineType: 'white' }],
      },
      normalizedConstraints: [makeConstraint('max_price_krw', 100_000, '<=')],
    });
    const out = DefaultToolInputNormalizer.normalizeParallelSlotInput(
      input,
      analysis,
      { wineType: 'red' },
      2,
    );
    const budget = (out.filters ?? []).find((c) => c.attribute === 'price_usd');
    expect(budget?.value).toBe(convertKrwToConstraintUsd(50_000));
    expect(budget?.soft_promotion_authority).toBe('allow');
  });

  it('adds wine_type filter from the slot', () => {
    const input = makeInput({ query: '와인' });
    const analysis = makeAnalysis();
    const out = DefaultToolInputNormalizer.normalizeParallelSlotInput(
      input,
      analysis,
      { wineType: 'white' },
      2,
    );
    const wineType = (out.filters ?? []).find((c) => c.attribute === 'wine_type');
    expect(wineType?.value).toBe('white');
  });

  it('preserves gift occasion across slot expansion', () => {
    const input = makeInput({
      query: 'gift wines',
      filters: [makeConstraint('occasion', 'gift'), makeConstraint('occasion', 'casual')],
    });
    const analysis = makeAnalysis();
    const out = DefaultToolInputNormalizer.normalizeParallelSlotInput(
      input,
      analysis,
      { wineType: 'red' },
      2,
    );
    const occasions = (out.filters ?? []).filter((c) => c.attribute === 'occasion');
    expect(occasions.map((c) => c.value)).toContain('gift');
    expect(occasions.map((c) => c.value)).not.toContain('casual');
  });

  it('slotCount < 2 → no-op', () => {
    const input = makeInput({ query: '레드 화이트' });
    const analysis = makeAnalysis();
    const out = DefaultToolInputNormalizer.normalizeParallelSlotInput(
      input,
      analysis,
      { wineType: 'red' },
      1,
    );
    expect(out).toBe(input);
  });

  it('applies optional limit from the slot', () => {
    const input = makeInput({ query: '와인' });
    const analysis = makeAnalysis();
    const out = DefaultToolInputNormalizer.normalizeParallelSlotInput(
      input,
      analysis,
      { wineType: 'red', limit: 3 },
      2,
    );
    expect(out.limit).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Internal helpers — direct unit coverage
// ---------------------------------------------------------------------------

describe('_internalApplyDrinkabilityStrip', () => {
  it('handles empty string', () => {
    expect(_internalApplyDrinkabilityStrip('')).toBe('');
  });

  it('preserves whitespace-only after strip → empty', () => {
    expect(_internalApplyDrinkabilityStrip('drink now')).toBe('');
  });

  it('preserves a query with no drinkability keywords', () => {
    expect(_internalApplyDrinkabilityStrip('Bordeaux 2018')).toBe('Bordeaux 2018');
  });
});

describe('_internalBuildSlotQueryAnchor', () => {
  it('returns original query when wineType has no opposite color', () => {
    expect(_internalBuildSlotQueryAnchor('와인 추천', 'sparkling')).toBe('와인 추천');
  });

  it('falls back to original when strip empties the query', () => {
    // The Korean "레드" alone strips to empty for white slot, so falls back.
    expect(_internalBuildSlotQueryAnchor('레드', 'white')).toBe('레드');
  });
});

describe('_internalApplyParallelSlotOccasionFilter', () => {
  it('returns undefined for undefined input', () => {
    expect(_internalApplyParallelSlotOccasionFilter(undefined)).toBeUndefined();
  });

  it('returns identity when no occasion entries present', () => {
    const filters: NormalizedConstraint[] = [makeConstraint('country', 'France')];
    expect(_internalApplyParallelSlotOccasionFilter(filters)).toBe(filters);
  });
});

describe('_internalFindTotalBudgetForParallelSlots', () => {
  it('returns undefined when decomposition is not parallel-slot', () => {
    expect(_internalFindTotalBudgetForParallelSlots(makeAnalysis())).toBeUndefined();
  });

  it('reads max_price_krw from analysis constraints', () => {
    const analysis = makeAnalysis({
      decomposition: {
        kind: 'parallel-slot',
        slots: [{ wineType: 'red' }, { wineType: 'white' }],
      },
      normalizedConstraints: [makeConstraint('max_price_krw', 200_000, '<=')],
    });
    expect(_internalFindTotalBudgetForParallelSlots(analysis)).toBe(200_000);
  });

  it('reads tiered max_price_krw when flat legacy constraints are empty', () => {
    const analysis = makeAnalysis({
      constraints: {
        hard: [makeConstraint('max_price_krw', 120_000, '<=')],
        soft: [],
        inferred: [],
      },
      normalizedConstraints: [],
      decomposition: {
        kind: 'parallel-slot',
        slots: [{ wineType: 'red' }, { wineType: 'white' }],
      },
    });
    expect(_internalFindTotalBudgetForParallelSlots(analysis)).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// End-to-end composition
// ---------------------------------------------------------------------------

describe('normalizeSearchInput — end-to-end composition', () => {
  it('scenario 1: Korean appellation lookup (지금 마시기 좋은 2010년 오퍼스 원)', () => {
    const input = makeInput({
      query: '지금 마시기 좋은 2010년 오퍼스 원',
      filters: [
        makeConstraint('country', 'United States'),
        makeConstraint('region', 'Napa Valley'),
      ],
    });
    const analysis = makeAnalysis({
      contract: {
        requiresDrinkabilityCheck: true,
        requiresGroundedWineSearch: false,
        hasEntityMetadataSignal: true,
        exactMetadataTargetVintage: 2010,
      },
    });
    const out = DefaultToolInputNormalizer.normalizeSearchInput(input, analysis);
    expect(out.query).not.toContain('마시기 좋은');
    expect(out.query).toContain('오퍼스 원');
    expect(out.limit).toBe(1);
    const vintage = (out.filters ?? []).find((c) => c.attribute === 'vintage_year');
    expect(vintage?.value).toBe(2010);
    // Over-constraint filters stripped (country, region).
    expect((out.filters ?? []).find((c) => c.attribute === 'country')).toBeUndefined();
    expect((out.filters ?? []).find((c) => c.attribute === 'region')).toBeUndefined();
  });

  it('scenario 2: English producer name (Opus One 2018)', () => {
    const input = makeInput({
      query: 'Opus One 2018',
    });
    const analysis = makeAnalysis({
      contract: {
        requiresDrinkabilityCheck: false,
        requiresGroundedWineSearch: false,
        hasEntityMetadataSignal: true,
        exactMetadataTargetVintage: 2018,
      },
    });
    const out = DefaultToolInputNormalizer.normalizeSearchInput(input, analysis);
    expect(out.query).toBe('Opus One 2018');
    expect(out.limit).toBe(1);
    const vintage = (out.filters ?? []).find((c) => c.attribute === 'vintage_year');
    expect(vintage?.value).toBe(2018);
  });

  it('scenario 3: vintage-specific Korean (부르고뉴 피노누아 5만원 이하)', () => {
    const input = makeInput({
      query: '부르고뉴 피노누아 5만원 이하',
    });
    const analysis = makeAnalysis({
      contract: {
        requiresDrinkabilityCheck: false,
        requiresGroundedWineSearch: true,
        hasEntityMetadataSignal: false,
      },
      normalizedConstraints: [
        makeConstraint('region', 'Burgundy'),
        makeConstraint('grape_primary', 'pinot noir'),
        makeConstraint('max_price_krw', 50_000, '<='),
      ],
    });
    const out = DefaultToolInputNormalizer.normalizeSearchInput(input, analysis);
    // No drinkability keywords removed (none present).
    expect(out.query).toBe('부르고뉴 피노누아 5만원 이하');
    // Defaults from analysis merged.
    expect((out.filters ?? []).map((c) => c.attribute)).toEqual(
      expect.arrayContaining(['region', 'grape_primary', 'max_price_krw']),
    );
  });

  it('scenario 4: food pairing (no drinkability strip, no exact metadata)', () => {
    const input = makeInput({
      query: '한식과 어울리는 와인',
      filters: [],
    });
    const analysis = makeAnalysis({
      intent: 'pair',
      contract: {
        requiresDrinkabilityCheck: false,
        requiresGroundedWineSearch: false,
        hasEntityMetadataSignal: false,
        requiredTool: 'get_food_pairings',
      },
    });
    const out = DefaultToolInputNormalizer.normalizeSearchInput(input, analysis);
    expect(out.query).toBe('한식과 어울리는 와인');
  });

  it('scenario 5: total budget split (parallel-slot expansion via normalizeParallelSlotInput)', () => {
    const baseInput = makeInput({
      query: '총 10만원에 레드와 화이트 한 병씩',
    });
    const analysis = makeAnalysis({
      decomposition: {
        kind: 'parallel-slot',
        slots: [{ wineType: 'red' }, { wineType: 'white' }],
      },
      normalizedConstraints: [makeConstraint('max_price_krw', 100_000, '<=')],
    });
    const redSlot = DefaultToolInputNormalizer.normalizeParallelSlotInput(
      baseInput,
      analysis,
      { wineType: 'red' },
      2,
    );
    const whiteSlot = DefaultToolInputNormalizer.normalizeParallelSlotInput(
      baseInput,
      analysis,
      { wineType: 'white' },
      2,
    );
    expect(redSlot.query).not.toContain('화이트');
    expect(whiteSlot.query).not.toContain('레드');
    const redBudget = (redSlot.filters ?? []).find((c) => c.attribute === 'price_usd');
    const whiteBudget = (whiteSlot.filters ?? []).find((c) => c.attribute === 'price_usd');
    expect(redBudget?.value).toBe(convertKrwToConstraintUsd(50_000));
    expect(whiteBudget?.value).toBe(convertKrwToConstraintUsd(50_000));
    expect(redBudget?.soft_promotion_authority).toBe('allow');
    expect(whiteBudget?.soft_promotion_authority).toBe('allow');
    // wine_type set per slot.
    expect((redSlot.filters ?? []).find((c) => c.attribute === 'wine_type')?.value).toBe('red');
    expect((whiteSlot.filters ?? []).find((c) => c.attribute === 'wine_type')?.value).toBe('white');
  });
});

// ---------------------------------------------------------------------------
// Pureness invariant — same input must yield same output across calls
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('repeated calls produce structurally equal results', () => {
    const input = makeInput({
      query: '지금 마실 수 있는 2018년 보르도',
      filters: [
        makeConstraint('country', 'France'),
        makeConstraint('vintage_year', 2018),
      ],
    });
    const analysis = makeAnalysis({
      contract: {
        requiresDrinkabilityCheck: true,
        requiresGroundedWineSearch: false,
        hasEntityMetadataSignal: true,
        exactMetadataTargetVintage: 2018,
      },
    });
    const out1 = DefaultToolInputNormalizer.normalizeSearchInput(input, analysis);
    const out2 = DefaultToolInputNormalizer.normalizeSearchInput(input, analysis);
    expect(out1).toEqual(out2);
  });

  it('does not mutate the input', () => {
    const filters = [makeConstraint('country', 'France')];
    const input = makeInput({
      query: 'Bordeaux',
      filters: [...filters],
    });
    const analysis = makeAnalysis({
      contract: {
        ...makeAnalysis().contract,
        hasEntityMetadataSignal: true,
      },
    });
    DefaultToolInputNormalizer.normalizeSearchInput(input, analysis);
    expect(input.filters).toEqual(filters);
  });
});
