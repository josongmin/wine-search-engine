/**
 * Regression: Silver record schema validation (etl.silver-validation maturity 4).
 *
 * This suite exercises the per-record Zod schema added to validate-silver.ts:
 *  - required field presence (id/name proxied via sourceId/canonicalLabel)
 *  - wine_type enum closure
 *  - numeric bounds (priceUsd ≥ 0, alcoholPct ∈ [0, 100])
 *  - Korean canonical fields preserved (NFC roundtrip)
 *  - schema_version field: explicit '1' + default fallback when absent
 *  - batch validation reports specific bad-record indices
 *
 * Append-only regression test — never delete.
 */
import { describe, expect, it } from 'vitest';
import {
  CURRENT_SILVER_SCHEMA_VERSION,
  SILVER_SCHEMA_VERSIONS,
  SilverWineRecordSchema,
  validateSilverRecordBatch,
} from '../../scripts/etl/validate-silver.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface RawSilverFixture {
  sourceId: string;
  externalId: string;
  canonicalLabel: string;
  producer: string;
  vintageYear: number | null;
  country: string;
  region: string;
  appellation: string | null;
  wineType: string;
  grapePrimary: string | null;
  grapes: readonly string[];
  body: number | null;
  sweetness: number | null;
  acidity: number | null;
  tannin: number | null;
  pairingTags: readonly string[];
  flavorProfiles: readonly string[];
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
  schema_version?: string;
}

function makeMinimalValid(overrides: Partial<RawSilverFixture> = {}): RawSilverFixture {
  return {
    sourceId: 'vivino:reg-1',
    externalId: 'reg-1',
    canonicalLabel: 'Château Margaux 2015',
    producer: 'Château Margaux',
    vintageYear: 2015,
    country: 'France',
    region: 'Bordeaux',
    appellation: 'Margaux',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    body: 0.85,
    sweetness: 0.05,
    acidity: 0.55,
    tannin: 0.75,
    pairingTags: ['lamb'],
    flavorProfiles: ['black-fruit'],
    searchTextEn: 'Deep cassis, graphite, cedar; structured tannins.',
    ratingAvg: 4.6,
    ratingsCount: 230,
    priceUsd: 850,
    priceBand: 'luxury',
    popularityScore: 0.95,
    scrapedAt: '2026-04-01T00:00:00.000Z',
    alcoholPct: 13.5,
    producerPrestige: 0.96,
    isTopRated: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Per-record schema
// ---------------------------------------------------------------------------

describe('SilverWineRecordSchema (regression)', () => {
  it('accepts a minimal valid SilverWineRecord', () => {
    const parsed = SilverWineRecordSchema.safeParse(makeMinimalValid());
    expect(parsed.success).toBe(true);
  });

  it('rejects a record missing the required canonicalLabel field with a specific path', () => {
    const { canonicalLabel: _omit, ...rest } = makeMinimalValid();
    const parsed = SilverWineRecordSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('canonicalLabel');
    }
  });

  it('rejects a record missing the required sourceId field with a specific path', () => {
    const { sourceId: _omit, ...rest } = makeMinimalValid();
    const parsed = SilverWineRecordSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('sourceId');
    }
  });

  it('rejects an invalid wineType enum value', () => {
    const parsed = SilverWineRecordSchema.safeParse(
      makeMinimalValid({ wineType: 'magenta' }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('wineType');
    }
  });

  it('rejects a negative priceUsd', () => {
    const parsed = SilverWineRecordSchema.safeParse(
      makeMinimalValid({ priceUsd: -10 }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('priceUsd');
    }
  });

  it('rejects alcoholPct above 100%', () => {
    const parsed = SilverWineRecordSchema.safeParse(
      makeMinimalValid({ alcoholPct: 120 }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('alcoholPct');
    }
  });

  it('preserves Korean canonical label in NFC', () => {
    const koreanName = '샤또 마고 2015'.normalize('NFC');
    const parsed = SilverWineRecordSchema.safeParse(
      makeMinimalValid({ canonicalLabel: koreanName }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.canonicalLabel).toBe(koreanName);
      // Round-trip safety: parsed value is still NFC-normalised.
      expect(parsed.data.canonicalLabel.normalize('NFC')).toBe(
        parsed.data.canonicalLabel,
      );
    }
  });

  it('preserves Korean producer name in NFC', () => {
    const koreanProducer = '샤또 마고'.normalize('NFC');
    const parsed = SilverWineRecordSchema.safeParse(
      makeMinimalValid({ producer: koreanProducer }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.producer).toBe(koreanProducer);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

describe('SilverWineRecordSchema schema_version', () => {
  it('exposes SILVER_SCHEMA_VERSIONS as a non-empty constant tuple', () => {
    expect(SILVER_SCHEMA_VERSIONS.length).toBeGreaterThan(0);
    expect(SILVER_SCHEMA_VERSIONS).toContain(CURRENT_SILVER_SCHEMA_VERSION);
  });

  it('accepts explicit schema_version="1"', () => {
    const parsed = SilverWineRecordSchema.safeParse(
      makeMinimalValid({ schema_version: '1' }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schema_version).toBe('1');
    }
  });

  it('defaults schema_version to "1" when the field is absent (backward-compat)', () => {
    const parsed = SilverWineRecordSchema.safeParse(makeMinimalValid());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schema_version).toBe(CURRENT_SILVER_SCHEMA_VERSION);
    }
  });

  it('rejects an unknown schema_version', () => {
    const parsed = SilverWineRecordSchema.safeParse(
      makeMinimalValid({ schema_version: '99' }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('schema_version');
    }
  });
});

// ---------------------------------------------------------------------------
// Batch validation
// ---------------------------------------------------------------------------

describe('validateSilverRecordBatch (regression)', () => {
  it('returns empty result for empty input without throwing', () => {
    const result = validateSilverRecordBatch([]);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('reports specific bad-record indices for a 10-record batch with 2 invalid', () => {
    const batch: readonly unknown[] = [
      makeMinimalValid({ sourceId: 'vivino:b-0', externalId: 'b-0' }),
      makeMinimalValid({ sourceId: 'vivino:b-1', externalId: 'b-1' }),
      makeMinimalValid({ sourceId: 'vivino:b-2', externalId: 'b-2', wineType: 'cyan' }), // invalid
      makeMinimalValid({ sourceId: 'vivino:b-3', externalId: 'b-3' }),
      makeMinimalValid({ sourceId: 'vivino:b-4', externalId: 'b-4' }),
      makeMinimalValid({ sourceId: 'vivino:b-5', externalId: 'b-5' }),
      makeMinimalValid({ sourceId: 'vivino:b-6', externalId: 'b-6' }),
      makeMinimalValid({ sourceId: 'vivino:b-7', externalId: 'b-7', priceUsd: -5 }), // invalid
      makeMinimalValid({ sourceId: 'vivino:b-8', externalId: 'b-8' }),
      makeMinimalValid({ sourceId: 'vivino:b-9', externalId: 'b-9' }),
    ];

    const result = validateSilverRecordBatch(batch);
    expect(result.passed).toBe(false);
    expect(result.valid.length).toBe(8);
    expect(result.invalid.length).toBe(2);
    const badIndices = result.invalid.map((entry) => entry.index).sort((a, b) => a - b);
    expect(badIndices).toEqual([2, 7]);
    // Specific error path assertions on the invalid entries.
    const issuePaths = result.invalid.flatMap((entry) =>
      entry.error.issues.map((issue) => issue.path.join('.')),
    );
    expect(issuePaths).toContain('wineType');
    expect(issuePaths).toContain('priceUsd');
  });

  it('reports all records when every record is invalid', () => {
    const batch: readonly unknown[] = [
      makeMinimalValid({ sourceId: 'vivino:all-bad-0', wineType: 'orange' }),
      makeMinimalValid({ sourceId: 'vivino:all-bad-1', priceUsd: -1 }),
      makeMinimalValid({ sourceId: 'vivino:all-bad-2', alcoholPct: 999 }),
    ];
    const result = validateSilverRecordBatch(batch);
    expect(result.passed).toBe(false);
    expect(result.valid.length).toBe(0);
    expect(result.invalid.length).toBe(3);
    expect(result.invalid.map((entry) => entry.index).sort((a, b) => a - b)).toEqual([
      0, 1, 2,
    ]);
  });
});
