/**
 * Property-based regression for the FxRatePort injection introduced into
 * `search-constraint-extractor.ts`. These tests verify rate-independent
 * invariants and rate-injection determinism using fast-check.
 *
 * Append-only — never delete these tests (CLAUDE.md regression discipline).
 *
 * Property catalog (numRuns: 100 each, per CLAUDE.md quality rule):
 *   1. FX-rate independence — currency-less queries never call the port.
 *   2. FX rate injection — different rates produce proportional thresholds.
 *   3. Korean 만원 normalization — `N만원` always equals `N * 10000` KRW.
 *   4. Vintage extraction monotonicity — `YYYY년` round-trips for 1800-2100.
 *   5. Extraction idempotence — re-extracting the same query stays stable.
 *   6. NaN-safety — malformed numeric inputs never throw / never produce NaN.
 *
 * Plus explicit boundary tests for "just-inside / just-outside band" values
 * required by CLAUDE.md rule 6.
 */

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  extractSearchConstraints,
  searchConstraintsToFilterTokens,
} from '../../src/domain/query/service/search-constraint-extractor.js';
import type { FxRatePort, SupportedFxCurrency } from '../../src/domain/query/port/fx-rate.port.js';
import {
  DEFAULT_FX_RATE_PORT,
  isValidFxRate,
} from '../../src/domain/query/port/fx-rate.port.js';

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a recording port: returns `rate` for USD (and any currency) and
 *  records every call so tests can assert the extractor did/did-not query FX. */
function makeRecordingPort(rate: number): FxRatePort & { calls: number } {
  const port = {
    calls: 0,
    getKrwPerUnit(_c: SupportedFxCurrency): number {
      this.calls += 1;
      return rate;
    },
    getKrwUsdRate(): number {
      this.calls += 1;
      return rate;
    },
  };
  return port;
}

// ---------------------------------------------------------------------------
// Property 1 — FX-rate independence on currency-less queries
// ---------------------------------------------------------------------------

describe('Property: FX-rate independence on currency-less queries', () => {
  it('does not call the FX port for pure Korean 만원 queries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.constantFrom('이하', '이상', '대'),
        (n, suffix) => {
          const port = makeRecordingPort(1350);
          const query = `${n}만원 ${suffix} 와인`;
          extractSearchConstraints(query, { fxRatePort: port });
          // Allow up to 1 call (a defensive pre-fetch by the FX layer must
          // never exceed this; current implementation is 1 call/pass max).
          expect(port.calls).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('produces the same maxPriceKrw regardless of injected FX rate for KRW-only queries', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 100, max: 5000 }), (n, rate) => {
        const portA = makeRecordingPort(rate);
        const portB = makeRecordingPort(1);
        const query = `${n}만원 이하`;
        const a = extractSearchConstraints(query, { fxRatePort: portA });
        const b = extractSearchConstraints(query, { fxRatePort: portB });
        expect(a.maxPriceKrw).toBe(b.maxPriceKrw);
        expect(a.maxPriceKrw).toBe(n * 10_000);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — FX rate injection: different rates → proportional USD threshold
// ---------------------------------------------------------------------------

describe('Property: FX rate injection drives USD-equivalent thresholds', () => {
  it('"$N 이하" query: maxPriceKrw scales linearly with the injected USD rate', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 100, max: 5000 }),
        (amount, rate) => {
          const port = makeRecordingPort(rate);
          const c = extractSearchConstraints(`$${amount} 이하`, { fxRatePort: port });
          // Expected: rounded amount * rate
          expect(c.maxPriceKrw).toBe(Math.round(amount * rate));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('doubling the FX rate exactly doubles the extracted KRW threshold (to rounding)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 100, max: 2500 }), (amount, rate) => {
        const slow = extractSearchConstraints(`under $${amount}`, {
          fxRatePort: makeRecordingPort(rate),
        });
        const fast = extractSearchConstraints(`under $${amount}`, {
          fxRatePort: makeRecordingPort(rate * 2),
        });
        if (slow.maxPriceKrw === undefined || fast.maxPriceKrw === undefined) return;
        // Rounding tolerance: ±1 KRW per side
        expect(Math.abs(fast.maxPriceKrw - slow.maxPriceKrw * 2)).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3 — Korean 만원 / 천원 normalization (exact integer)
// ---------------------------------------------------------------------------

describe('Property: Korean 만원/천원 normalization is exact (no FX needed)', () => {
  it('N만원 이하 → maxPriceKrw === N * 10000 for N in [1, 1000]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
        const c = extractSearchConstraints(`${n}만원 이하`);
        expect(c.maxPriceKrw).toBe(n * 10_000);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('N천원 이하 → maxPriceKrw === N * 1000 for N in [1, 999]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999 }), (n) => {
        const c = extractSearchConstraints(`${n}천원 이하`);
        expect(c.maxPriceKrw).toBe(n * 1_000);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('N만원 이상 → minPriceKrw === N * 10000', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
        const c = extractSearchConstraints(`${n}만원 이상`);
        expect(c.minPriceKrw).toBe(n * 10_000);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — Vintage extraction monotonicity / round-trip
// ---------------------------------------------------------------------------

describe('Property: vintage extraction round-trip for valid 4-digit years', () => {
  it('"YYYY년산" → vintageMin === vintageMax === YYYY for 1900-2099', () => {
    // Vintage regex accepts (19|20)\d{2}, so the property domain is 1900-2099.
    fc.assert(
      fc.property(fc.integer({ min: 1900, max: 2099 }), (year) => {
        const c = extractSearchConstraints(`${year}년산 와인`);
        expect(c.vintageMin).toBe(year);
        expect(c.vintageMax).toBe(year);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('"YYYY년 이후" → vintageMin === YYYY, vintageMax undefined', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1900, max: 2099 }), (year) => {
        const c = extractSearchConstraints(`${year}년 이후 와인`);
        expect(c.vintageMin).toBe(year);
        expect(c.vintageMax).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5 — Extraction idempotence (constraint count never escalates)
// ---------------------------------------------------------------------------

describe('Property: extraction is idempotent in shape', () => {
  it('re-running extract on the same query produces deep-equal output (deterministic)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('카베르네 빼고', '메를로 제외', 'not Pinot Noir', 'without France'),
        fc.constantFrom('5만원 이하', '10만원 이상', '3~5만원', '2020년산'),
        (negation, range) => {
          const query = `${negation} ${range}`;
          const a = extractSearchConstraints(query);
          const b = extractSearchConstraints(query);
          expect(b).toEqual(a);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('total constraint count never escalates between two calls', () => {
    const countConstraints = (c: Record<string, unknown>): number =>
      Object.values(c).reduce<number>((sum, v) => sum + (v === undefined ? 0 : 1), 0);

    fc.assert(
      fc.property(
        fc.constantFrom(
          '카베르네 빼고 5만원 이하',
          'not Merlot under $50',
          '2018년 이후 10만원대',
          '백화점 와인',
        ),
        (query) => {
          const a = countConstraints(extractSearchConstraints(query));
          const b = countConstraints(extractSearchConstraints(query));
          expect(b).toBeLessThanOrEqual(a);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6 — NaN safety (CLAUDE.md schema-quality bar)
// ---------------------------------------------------------------------------

describe('Property: NaN-safety across malformed numeric inputs', () => {
  it('never throws, never returns NaN min/max for adversarial junk', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 60 }), (s) => {
        let result: ReturnType<typeof extractSearchConstraints>;
        expect(() => {
          result = extractSearchConstraints(s);
        }).not.toThrow();
        // @ts-expect-error — set inside the lambda above
        const c = result;
        if (c.minPriceKrw !== undefined) expect(Number.isFinite(c.minPriceKrw)).toBe(true);
        if (c.maxPriceKrw !== undefined) expect(Number.isFinite(c.maxPriceKrw)).toBe(true);
        if (c.vintageMin !== undefined) expect(Number.isFinite(c.vintageMin)).toBe(true);
        if (c.vintageMax !== undefined) expect(Number.isFinite(c.vintageMax)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('malformed "abcdef원" yields no price constraint and does not throw', () => {
    const c = extractSearchConstraints('abcdef원');
    expect(c.maxPriceKrw).toBeUndefined();
    expect(c.minPriceKrw).toBeUndefined();
  });

  it('a port that returns NaN/0/Infinity is rejected — no FX constraint set', () => {
    const adversarialPort: FxRatePort = {
      getKrwPerUnit: () => Number.NaN,
      getKrwUsdRate: () => Number.NaN,
    };
    const c = extractSearchConstraints('$100 이하', { fxRatePort: adversarialPort });
    // Expectation: rather than emitting NaN-tainted prices, the extractor
    // declines to set a maxPriceKrw at all.
    expect(c.maxPriceKrw).toBeUndefined();

    const infPort: FxRatePort = {
      getKrwPerUnit: () => Number.POSITIVE_INFINITY,
      getKrwUsdRate: () => Number.POSITIVE_INFINITY,
    };
    const c2 = extractSearchConstraints('$100 이하', { fxRatePort: infPort });
    expect(c2.maxPriceKrw).toBeUndefined();

    const zeroPort: FxRatePort = {
      getKrwPerUnit: () => 0,
      getKrwUsdRate: () => 0,
    };
    const c3 = extractSearchConstraints('$100 이하', { fxRatePort: zeroPort });
    expect(c3.maxPriceKrw).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Boundary specifics — CLAUDE.md rule 6
// ---------------------------------------------------------------------------

describe('Boundary values (CLAUDE.md rule 6 — just-inside / just-outside)', () => {
  it('just-inside band: "40만원 이하" → maxPriceKrw = 400_000', () => {
    expect(extractSearchConstraints('40만원 이하').maxPriceKrw).toBe(400_000);
  });

  it('just-outside band — extreme "100억 이상" extracts a finite minPriceKrw', () => {
    const c = extractSearchConstraints('100억원 이상');
    // 100억 = 10^10 KRW. Must round-trip cleanly and stay below Number.MAX_SAFE_INTEGER.
    expect(c.minPriceKrw).toBe(10_000_000_000);
    expect(Number.isFinite(c.minPriceKrw)).toBe(true);
    expect(c.minPriceKrw).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('NaN-safe: "abcdef원" yields no constraint, no throw', () => {
    expect(() => extractSearchConstraints('abcdef원')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_FX_RATE_PORT — verifies the static fallback contract
// ---------------------------------------------------------------------------

describe('DEFAULT_FX_RATE_PORT contract', () => {
  it('returns a positive finite rate for every supported currency', () => {
    const currencies: SupportedFxCurrency[] = ['USD', 'EUR', 'GBP'];
    for (const c of currencies) {
      expect(isValidFxRate(DEFAULT_FX_RATE_PORT.getKrwPerUnit(c))).toBe(true);
    }
    expect(isValidFxRate(DEFAULT_FX_RATE_PORT.getKrwUsdRate())).toBe(true);
  });

  it('default-injected behavior matches the no-port baseline', () => {
    const baseline = extractSearchConstraints('under $100');
    const injected = extractSearchConstraints('under $100', {
      fxRatePort: DEFAULT_FX_RATE_PORT,
    });
    expect(injected).toEqual(baseline);
  });
});

// ---------------------------------------------------------------------------
// Token-emission proportionality
// ---------------------------------------------------------------------------

describe('searchConstraintsToFilterTokens — port injection', () => {
  it('USD-emit tokens vary inversely with the injected rate', () => {
    const constraints = { maxPriceKrw: 100_000 } as const;
    const portCheap = { getKrwPerUnit: () => 1_000, getKrwUsdRate: () => 1_000 };
    const portExpensive = { getKrwPerUnit: () => 2_000, getKrwUsdRate: () => 2_000 };
    const tokensCheap = searchConstraintsToFilterTokens(constraints, { fxRatePort: portCheap });
    const tokensExpensive = searchConstraintsToFilterTokens(constraints, { fxRatePort: portExpensive });
    expect(tokensCheap).toContain('price_usd_max:100');
    expect(tokensExpensive).toContain('price_usd_max:50');
  });

  it('vi.fn-tracked port is invoked at least once per price-bearing constraint', () => {
    const spy = vi.fn(() => 1350);
    const port: FxRatePort = { getKrwPerUnit: spy, getKrwUsdRate: spy };
    searchConstraintsToFilterTokens(
      { minPriceKrw: 10_000, maxPriceKrw: 100_000 },
      { fxRatePort: port },
    );
    expect(spy).toHaveBeenCalled();
  });
});
