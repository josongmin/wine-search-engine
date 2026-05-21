/**
 * Property-based regression suite for gold catalog coverage (ADR-007 gate).
 *
 * Pins SOTA++ set-theoretic invariants for {@link computeCatalogCoverage}, the
 * pure core of scripts/etl/verify-gold-catalog-coverage.ts. The verifier asserts
 * that every golden ground-truth entity_id is present in the published snapshot
 * (golden ⊆ snapshot). These properties lock the invariants that the coverage
 * computation must satisfy for ANY golden/snapshot sets:
 *
 *   1. Bounded ratio — coverageRatio ∈ [0, 1] for arbitrary sets.
 *   2. Full coverage — golden ⊆ snapshot ⇒ missing = [], ratio = 1.0.
 *   3. Missing detection — a golden id absent from snapshot appears in missing[].
 *   4. Vacuous coverage — empty golden ⇒ ratio = 1.0, missing = [].
 *   5. Determinism — identical inputs yield identical results (5x).
 *   6. Korean id fidelity — Korean canonical entity_id surfaces verbatim (NFC).
 *   7. Monotonicity — adding snapshot entities never decreases coverage.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { computeCatalogCoverage } from '../../scripts/etl/verify-gold-catalog-coverage.js';

const NUM_RUNS = 100;

// Arbitrary entity-id strings, including ASCII, Korean syllables, and accents.
const entityIdArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
  fc.constantFrom('wine-001', 'producer-42', 'region-bordeaux'),
  fc.constantFrom('와인-001', '생산자-보르도', '품종-까베르네', 'région-côte'),
);

const idSetArb = fc.array(entityIdArb, { maxLength: 20 }).map((arr) => arr);

describe('computeCatalogCoverage — property-based set-coverage invariants', () => {
  it('coverage ratio is always within [0, 1]', () => {
    fc.assert(
      fc.property(idSetArb, idSetArb, (golden, snapshot) => {
        const { coverageRatio } = computeCatalogCoverage(golden, snapshot);
        expect(coverageRatio).toBeGreaterThanOrEqual(0);
        expect(coverageRatio).toBeLessThanOrEqual(1);
        expect(Number.isFinite(coverageRatio)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('golden ⊆ snapshot ⇒ missing is empty and ratio is exactly 1.0', () => {
    fc.assert(
      fc.property(idSetArb, idSetArb, (golden, extra) => {
        // snapshot is a superset of golden by construction.
        const snapshot = [...golden, ...extra];
        const { missing, coverageRatio, covered } = computeCatalogCoverage(golden, snapshot);
        expect(missing).toEqual([]);
        expect(coverageRatio).toBe(1);
        const uniqueGolden = new Set(golden).size;
        expect(covered).toBe(uniqueGolden);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a golden id absent from snapshot is reported in missing[]', () => {
    fc.assert(
      fc.property(idSetArb, idSetArb, entityIdArb, (golden, snapshot, orphan) => {
        // Guarantee orphan is in golden but NOT in snapshot.
        const goldenWithOrphan = [...golden, orphan];
        const snapshotWithoutOrphan = snapshot.filter((id) => id !== orphan);
        const { missing } = computeCatalogCoverage(goldenWithOrphan, snapshotWithoutOrphan);
        expect(missing).toContain(orphan);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('empty golden set ⇒ vacuous full coverage (ratio 1.0, no missing)', () => {
    fc.assert(
      fc.property(idSetArb, (snapshot) => {
        const { missing, coverageRatio, covered } = computeCatalogCoverage([], snapshot);
        expect(missing).toEqual([]);
        expect(coverageRatio).toBe(1);
        expect(covered).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic — same sets yield byte-identical results across 5 calls', () => {
    fc.assert(
      fc.property(idSetArb, idSetArb, (golden, snapshot) => {
        const first = JSON.stringify(computeCatalogCoverage(golden, snapshot));
        for (let i = 0; i < 4; i += 1) {
          expect(JSON.stringify(computeCatalogCoverage(golden, snapshot))).toBe(first);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves Korean canonical entity_id verbatim in missing[]', () => {
    const koreanIds = ['와인-보르도-2018', '생산자-샤또-마고', '품종-까베르네-소비뇽'];
    fc.assert(
      fc.property(fc.constantFrom(...koreanIds), idSetArb, (koreanId, snapshot) => {
        const golden = [koreanId];
        // Ensure the Korean id is not present in the snapshot.
        const cleanSnapshot = snapshot.filter((id) => id !== koreanId);
        const { missing } = computeCatalogCoverage(golden, cleanSnapshot);
        expect(missing).toContain(koreanId);
        // Verbatim: the exact NFC bytes survive (no transliteration / mangling).
        const surfaced = missing.find((m) => m === koreanId);
        expect(surfaced).toBe(koreanId);
        expect(surfaced?.normalize('NFC')).toBe(koreanId.normalize('NFC'));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is monotone — adding snapshot entities never decreases coverage', () => {
    fc.assert(
      fc.property(idSetArb, idSetArb, idSetArb, (golden, snapshot, additions) => {
        const before = computeCatalogCoverage(golden, snapshot);
        const after = computeCatalogCoverage(golden, [...snapshot, ...additions]);
        expect(after.coverageRatio).toBeGreaterThanOrEqual(before.coverageRatio);
        expect(after.covered).toBeGreaterThanOrEqual(before.covered);
        // missing set only shrinks (every still-missing id was missing before).
        for (const id of after.missing) {
          expect(before.missing).toContain(id);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
