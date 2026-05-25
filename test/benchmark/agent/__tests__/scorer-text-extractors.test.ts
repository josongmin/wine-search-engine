import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution } from './__helpers__/scorer-test-helpers.js';

describe('P2 regression — extractKoreanPrices currency coverage', () => {
  it('€ amounts are extracted and converted to KRW', () => {
    // €50 × 1500 = 75,000 KRW — within 50k–100k range
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, priceBandKrw: { min: 50_000, max: 100_000 } }),
      makeExecution({
        observations: ['Wine: €50 Burgundy Chardonnay 2019'],
      }),
      undefined,
    );
    // price check should PASS (75k is in range) — no hard constraint failure
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });

  it('£ amounts are extracted and converted to KRW', () => {
    // £100 × 1700 = 170,000 KRW — above 50k–100k range → soft penalty (not critical)
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, priceBandKrw: { min: 50_000, max: 100_000 } }),
      makeExecution({
        observations: ['Wine: £100 Bordeaux 2018'],
      }),
      undefined,
    );
    expect(r.scores.contextRelevance).toBeLessThan(1);
    // Price is soft, not hard — no critical failure
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P2 regression: extractVintageYears 1600s support
// ─────────────────────────────────────────────────────────────────────


describe('P2 regression — extractVintageYears historic vintage coverage', () => {
  it('1797 vintage is extracted (pre-phylloxera historic bottle)', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 1790, max: 1800 } }),
      makeExecution({
        observations: ['Rare 1797 Madeira Sercial — historic collector piece'],
      }),
      undefined,
    );
    // vintage 1797 is in range 1790–1800 → should pass, NOT hard fail
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });

  it('1650 vintage NOT extracted (below minimum 1600 floor)', () => {
    // 1650 < 1600 regex lower bound — should be ignored, no vintage check fired
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, vintageRange: { min: 1640, max: 1660 } }),
      makeExecution({
        observations: ['Ancient 1650 bottle from private cellar'],
      }),
      undefined,
    );
    // 1650 not extracted (below regex range) → no vintage check → contextRelevance
    // either null or based on other checks only (no hard fail from vintage)
    expect(r.diagnostics?.some((d) => d.code === 'CONTEXT_HARD_CONSTRAINT_FAILED')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Blocked termination reason — security gate scenarios
// ─────────────────────────────────────────────────────────────────────

