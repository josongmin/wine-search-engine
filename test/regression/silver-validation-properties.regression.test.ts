/**
 * Property-based regression tests for SilverWineRecord schema validation
 * (etl.silver-validation maturity 5 — SOTA++).
 *
 * The example-based suite in silver-validation.regression.test.ts pins
 * specific fixtures. This suite generalises those guarantees into universally
 * quantified invariants over fast-check-generated record spaces (numRuns:100),
 * exploring boundary values that hand-written fixtures miss.
 *
 * Invariants verified (append-only — never delete, never loosen the schema to
 * make a property pass):
 *  1. Validity closure — any record whose every field satisfies the documented
 *     bounds parses successfully.
 *  2. Negative price rejection — any priceUsd < 0 fails with path `priceUsd`.
 *  3. Alcohol over-range rejection — any alcoholPct ∈ (100, ∞) fails with path
 *     `alcoholPct`.
 *  4. Required-field omission rejection — omitting any one required field fails
 *     with an issue at that field's path.
 *  5. schema_version default — a record without schema_version defaults to the
 *     current version (backward-compat with pre-versioning NDJSON).
 *  6. Batch bad-index reporting — for N records with K invalid at known
 *     indices, the batch validator reports exactly those K indices.
 *  7. Korean NFC preservation — Korean canonicalLabel / producer survive
 *     validation byte-for-byte (no normalisation drift).
 *  8. Determinism — validating the same batch twice yields the same
 *     valid/invalid partition.
 *
 * Touch-policy: regression-only, append-only. Does NOT modify validate-silver.ts.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  CURRENT_SILVER_SCHEMA_VERSION,
  SilverWineRecordSchema,
  validateSilverRecordBatch,
} from '../../scripts/etl/validate-silver.js';

const NUM_RUNS = 100;

const WINE_TYPE_VALUES = [
  'red',
  'white',
  'rosé',
  'sparkling',
  'dessert',
  'fortified',
] as const;
const PRICE_BAND_VALUES = ['value', 'mid', 'premium', 'luxury'] as const;

// Required keys that, when omitted, MUST yield a validation failure at that
// key's path. (schema_version is intentionally excluded — it is optional with
// a default; appellation is .nullable().optional().)
const REQUIRED_KEYS = [
  'sourceId',
  'externalId',
  'canonicalLabel',
  'producer',
  'vintageYear',
  'country',
  'region',
  'wineType',
  'grapePrimary',
  'grapes',
  'body',
  'sweetness',
  'acidity',
  'tannin',
  'pairingTags',
  'flavorProfiles',
  'searchTextEn',
  'ratingAvg',
  'ratingsCount',
  'priceUsd',
  'priceBand',
  'popularityScore',
  'scrapedAt',
  'alcoholPct',
  'producerPrestige',
  'isTopRated',
] as const;

interface RawSilverRecord {
  sourceId: string;
  externalId: string;
  canonicalLabel: string;
  producer: string;
  vintageYear: number | null;
  country: string;
  region: string;
  appellation?: string | null;
  wineType: string;
  grapePrimary: string | null;
  grapes: string[];
  body: number | null;
  sweetness: number | null;
  acidity: number | null;
  tannin: number | null;
  pairingTags: string[];
  flavorProfiles: string[];
  searchTextEn: string;
  ratingAvg: number | null;
  ratingsCount: number;
  priceUsd: number | null;
  priceBand: string;
  popularityScore: number;
  scrapedAt: string | null;
  alcoholPct: number | null;
  producerPrestige: number | null;
  isTopRated: boolean;
}

// A normalised score arbitrary in the closed interval [0, 1], including the
// exact boundary values 0 and 1 (rule 6 / rule 18 — exercise the bounds).
const normalised = (): fc.Arbitrary<number> =>
  fc.oneof(
    fc.constant(0),
    fc.constant(1),
    fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  );

const nullableNormalised = (): fc.Arbitrary<number | null> =>
  fc.option(normalised(), { nil: null });

const nonEmptyString = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length >= 1);

/**
 * Generates a record that satisfies EVERY documented schema bound — the
 * positive space for invariant #1. All numeric fields are kept strictly inside
 * (or exactly on) their bounds; enums draw only from the closed value sets.
 */
function validRecordArb(): fc.Arbitrary<RawSilverRecord> {
  return fc.record({
    sourceId: nonEmptyString(),
    externalId: nonEmptyString(),
    canonicalLabel: nonEmptyString(),
    producer: fc.string({ maxLength: 40 }),
    vintageYear: fc.option(fc.integer({ min: 1800, max: 2100 }), { nil: null }),
    country: fc.string({ maxLength: 40 }),
    region: fc.string({ maxLength: 40 }),
    wineType: fc.constantFrom(...WINE_TYPE_VALUES),
    grapePrimary: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
    grapes: fc.array(fc.string({ maxLength: 20 }), { maxLength: 20 }),
    body: nullableNormalised(),
    sweetness: nullableNormalised(),
    acidity: nullableNormalised(),
    tannin: nullableNormalised(),
    pairingTags: fc.array(fc.string({ maxLength: 20 }), { maxLength: 50 }),
    flavorProfiles: fc.array(fc.string({ maxLength: 20 }), { maxLength: 50 }),
    searchTextEn: fc.string({ maxLength: 200 }),
    ratingAvg: fc.option(
      fc.float({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true }),
      { nil: null },
    ),
    ratingsCount: fc.nat({ max: 1_000_000 }),
    priceUsd: fc.option(
      fc.float({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
      { nil: null },
    ),
    priceBand: fc.constantFrom(...PRICE_BAND_VALUES),
    popularityScore: normalised(),
    scrapedAt: fc.option(
      // noInvalidDate: fc.date() can otherwise emit `Invalid Date`, whose
      // .toISOString() throws. The schema only requires string|null, so we
      // feed it well-formed ISO timestamps.
      fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
      { nil: null },
    ),
    alcoholPct: fc.option(
      fc.oneof(
        fc.constant(0),
        fc.constant(100),
        fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
      ),
      { nil: null },
    ),
    producerPrestige: nullableNormalised(),
    isTopRated: fc.boolean(),
  });
}

// ---------------------------------------------------------------------------
// Property 1: validity closure
// ---------------------------------------------------------------------------

describe('SilverWineRecordSchema property: validity closure', () => {
  it('accepts any record whose fields satisfy all documented bounds', () => {
    fc.assert(
      fc.property(validRecordArb(), (record) => {
        const parsed = SilverWineRecordSchema.safeParse(record);
        if (!parsed.success) {
          // Surface the failing record + issues for triage if this ever breaks.
          throw new Error(
            `expected valid record to pass; issues=${JSON.stringify(
              parsed.error.issues,
            )} record=${JSON.stringify(record)}`,
          );
        }
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: negative price rejected
// ---------------------------------------------------------------------------

describe('SilverWineRecordSchema property: negative price rejected', () => {
  it('rejects any negative priceUsd with a priceUsd path issue', () => {
    fc.assert(
      fc.property(
        validRecordArb(),
        fc
          .float({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true })
          .filter((n) => n > 0)
          .map((n) => -n),
        (base, negativePrice) => {
          const parsed = SilverWineRecordSchema.safeParse({
            ...base,
            priceUsd: negativePrice,
          });
          expect(parsed.success).toBe(false);
          if (!parsed.success) {
            const paths = parsed.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('priceUsd');
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: alcoholPct > 100 rejected
// ---------------------------------------------------------------------------

describe('SilverWineRecordSchema property: alcoholPct over-range rejected', () => {
  it('rejects any alcoholPct strictly above 100 with an alcoholPct path issue', () => {
    fc.assert(
      fc.property(
        validRecordArb(),
        // (100, ∞): any finite ABV above the physical maximum.
        fc
          .float({
            min: 100,
            max: 1_000_000,
            noNaN: true,
            noDefaultInfinity: true,
          })
          .filter((n) => n > 100),
        (base, overAlcohol) => {
          const parsed = SilverWineRecordSchema.safeParse({
            ...base,
            alcoholPct: overAlcohol,
          });
          expect(parsed.success).toBe(false);
          if (!parsed.success) {
            const paths = parsed.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain('alcoholPct');
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: missing required field rejected with that field's path
// ---------------------------------------------------------------------------

describe('SilverWineRecordSchema property: missing required field rejected', () => {
  it('rejects omission of any single required field at that field path', () => {
    fc.assert(
      fc.property(
        validRecordArb(),
        fc.constantFrom(...REQUIRED_KEYS),
        (base, keyToOmit) => {
          // Build a copy that omits exactly `keyToOmit` (avoid dynamic delete).
          const mutated = Object.fromEntries(
            Object.entries(base).filter(([k]) => k !== keyToOmit),
          );
          const parsed = SilverWineRecordSchema.safeParse(mutated);
          expect(parsed.success).toBe(false);
          if (!parsed.success) {
            const paths = parsed.error.issues.map((i) => i.path.join('.'));
            expect(paths).toContain(keyToOmit);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: schema_version default
// ---------------------------------------------------------------------------

describe('SilverWineRecordSchema property: schema_version default', () => {
  it('defaults schema_version to the current version when absent', () => {
    fc.assert(
      fc.property(validRecordArb(), (record) => {
        // record never carries schema_version → backward-compat default path.
        const parsed = SilverWineRecordSchema.safeParse(record);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.schema_version).toBe(CURRENT_SILVER_SCHEMA_VERSION);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: batch bad-index reporting
// ---------------------------------------------------------------------------

describe('validateSilverRecordBatch property: bad-index reporting', () => {
  it('reports exactly the indices of the records made invalid', () => {
    fc.assert(
      fc.property(
        // Build a batch of N valid records, then mark a known subset invalid.
        fc.array(validRecordArb(), { minLength: 1, maxLength: 12 }).chain((records) =>
          fc
            .uniqueArray(fc.nat({ max: records.length - 1 }), {
              minLength: 0,
              maxLength: records.length,
            })
            .map((badIndices) => ({ records, badIndices })),
        ),
        ({ records, badIndices }) => {
          const badSet = new Set(badIndices);
          const batch = records.map((r, idx) =>
            badSet.has(idx)
              ? // Inject an out-of-domain priceUsd to force a failure.
                { ...r, priceUsd: -1 }
              : r,
          );
          const result = validateSilverRecordBatch(batch);
          const reported = result.invalid
            .map((entry) => entry.index)
            .sort((a, b) => a - b);
          const expected = [...badSet].sort((a, b) => a - b);
          expect(reported).toEqual(expected);
          expect(result.valid.length).toBe(records.length - badSet.size);
          expect(result.passed).toBe(badSet.size === 0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Korean NFC preserved verbatim
// ---------------------------------------------------------------------------

describe('SilverWineRecordSchema property: Korean NFC preserved', () => {
  // Hangul syllable block U+AC00–U+D7A3.
  const hangulSyllable = (): fc.Arbitrary<string> =>
    fc
      .integer({ min: 0xac00, max: 0xd7a3 })
      .map((code) => String.fromCodePoint(code));

  const koreanString = (): fc.Arbitrary<string> =>
    fc
      .array(hangulSyllable(), { minLength: 1, maxLength: 12 })
      .map((chars) => chars.join('').normalize('NFC'));

  it('preserves Korean canonicalLabel and producer byte-for-byte (NFC)', () => {
    fc.assert(
      fc.property(
        validRecordArb(),
        koreanString(),
        koreanString(),
        (base, label, producer) => {
          const parsed = SilverWineRecordSchema.safeParse({
            ...base,
            canonicalLabel: label,
            producer,
          });
          expect(parsed.success).toBe(true);
          if (parsed.success) {
            expect(parsed.data.canonicalLabel).toBe(label);
            expect(parsed.data.producer).toBe(producer);
            // No normalisation drift: output is still NFC-stable.
            expect(parsed.data.canonicalLabel.normalize('NFC')).toBe(
              parsed.data.canonicalLabel,
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: determinism
// ---------------------------------------------------------------------------

describe('validateSilverRecordBatch property: determinism', () => {
  it('partitions the same batch identically on repeated runs', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            validRecordArb(),
            // Deliberately invalid: negative price.
            validRecordArb().map((r) => ({ ...r, priceUsd: -1 })),
          ),
          { maxLength: 12 },
        ),
        (batch) => {
          const first = validateSilverRecordBatch(batch);
          const second = validateSilverRecordBatch(batch);
          expect(first.passed).toBe(second.passed);
          expect(first.valid.length).toBe(second.valid.length);
          expect(first.invalid.map((e) => e.index)).toEqual(
            second.invalid.map((e) => e.index),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
