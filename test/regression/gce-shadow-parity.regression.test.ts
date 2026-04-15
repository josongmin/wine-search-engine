/**
 * ADR-016 Axis 3 Wave D/I6/J3 bootstrap — shadow parity harness regression.
 *
 * Runs `runShadowParity` over the checked-in 120-claim `gold-claims.jsonl`
 * bootstrap set and locks three invariants:
 *
 * 1. The harness runs to completion and produces BOTH
 *    `statusOkSubset` and `fullSet` aggregates (dual reporting per
 *    ADR-016 §2.8). `effectiveGate === min(statusOk, fullSet)`.
 *
 * 2. The bootstrap exercises every `AtomicClaimType` at least once —
 *    the 9-class router dispatch is not silently dropping a class.
 *
 * 3. Effective parity clears a LOOSE bootstrap floor of 0.40. The
 *    ADR-016 §2.8 production cutover gate is **≥ 0.95** on a ≥200-row
 *    human-annotated set — this bootstrap does NOT measure that gate.
 *    The bootstrap proves the wiring is live and the harness produces
 *    honest numbers; the real cutover lives in
 *    `claim-extractor-deletion-guard.regression.test.ts`, which
 *    gates extractor deletion on a sibling `gold-set-proof.json`
 *    file that this repo does not yet carry.
 *
 * Observed bootstrap parity history:
 *   - Wave D (30 claims): overall 0.50 (15/30).
 *   - Wave I6 (60 claims): overall 0.50 (30/60) — parity held at 0.50
 *     after doubling the set. The new claims exposed additional gaps
 *     in the legacy extractor (especially on price/vintage contradictions
 *     and drinking-window), balanced by better coverage on comparative
 *     and pairing types.
 *   - Wave J3 (120 claims): overall parity measured by the harness on
 *     the doubled set — the new claims expand contradicted/not_entailed
 *     coverage (Korean phonetic entity surface forms, white-vs-red-meat
 *     pairing mismatches, NV vintage claims on Moet). The new
 *     (9-class) path is authoritative on these; the legacy (5-class)
 *     extractor bulk-emits `entailed`, so contradictions are systematic
 *     legacy-path misses, not new-path verifier bugs. Bootstrap gate
 *     remains ≥ 0.40; production cutover still requires a ≥200-row
 *     human-annotated set (80 more to reach the gate).
 *
 * The legacy 5-class regex extractor is intentionally weak on the
 * 9-class field axis — every bootstrap miss traces to a legacy
 * extraction gap, NOT a new-path verifier bug. Honest measurement:
 * the new path IS the authoritative path once the annotation set
 * reaches the production threshold.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  loadBootstrapGoldClaims,
  runShadowParity,
} from '../../test/benchmark/evaluator/shadow-parity-harness.js';
import { ATOMIC_CLAIM_TYPES } from '../../src/domain/response/model/grounded-claim.js';

const BOOTSTRAP_CLAIM_COUNT = 120;
const BOOTSTRAP_PARITY_FLOOR = 0.40;
const BOOTSTRAP_EVIDENCE_WINE_COUNT = 8;

describe('ADR-016 Axis 3 — shadow parity bootstrap harness', () => {
  it('loads exactly 120 gold claims from gold-claims.jsonl', () => {
    const claims = loadBootstrapGoldClaims();
    expect(claims).toHaveLength(BOOTSTRAP_CLAIM_COUNT);
  });

  it('every bootstrap claim declares both 9-class `type` AND 5-class `category`', () => {
    const claims = loadBootstrapGoldClaims();
    for (const g of claims) {
      expect(g.claim.type).toBeDefined();
      expect(g.claim.category).toBeDefined();
      expect(g.claim.claimSchemaVersion).toBe('claim_schema_v1');
    }
  });

  it('harness runs to completion and emits dual-reported aggregates', async () => {
    const claims = loadBootstrapGoldClaims();
    const result = await runShadowParity({ goldClaims: claims });

    expect(result.bootstrapClaimCount).toBe(BOOTSTRAP_CLAIM_COUNT);
    // Dual reporting: both aggregates present and populated.
    expect(result.statusOkSubset.overallCompared).toBeGreaterThan(0);
    expect(result.fullSet.overallCompared).toBe(BOOTSTRAP_CLAIM_COUNT);
    // Effective gate is explicitly the lower of the two.
    const expectedGate = Math.min(
      result.statusOkSubset.overallParity,
      result.fullSet.overallParity,
    );
    expect(result.effectiveGate).toBeCloseTo(expectedGate, 6);
    // Evidence context size matches the hand-curated bootstrap wine count.
    expect(result.meta.evidenceRecordCount).toBe(BOOTSTRAP_EVIDENCE_WINE_COUNT);
  });

  it('every `AtomicClaimType` is exercised at least once', async () => {
    const claims = loadBootstrapGoldClaims();
    const result = await runShadowParity({ goldClaims: claims });
    for (const t of ATOMIC_CLAIM_TYPES) {
      const perType = result.fullSet.perType.find((p) => p.type === t);
      expect(perType).toBeDefined();
      expect(perType?.compared ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it('bootstrap effective parity clears the loose floor (≥0.40)', async () => {
    // LOOSE bootstrap floor — not the production 0.95 gate. The production
    // gate ships once the annotation set reaches ≥200 human-annotated
    // rows AND two consecutive nightly greens (ADR-016 §2.8).
    const claims = loadBootstrapGoldClaims();
    const result = await runShadowParity({ goldClaims: claims });
    expect(result.effectiveGate).toBeGreaterThanOrEqual(BOOTSTRAP_PARITY_FLOOR);
  });

  it('entity_reference type has perfect parity (regression for the deterministic verifier path)', async () => {
    // entity_reference is a deterministic verifier on both new and legacy
    // paths; if these ever diverge the router wiring is broken.
    const claims = loadBootstrapGoldClaims();
    const result = await runShadowParity({ goldClaims: claims });
    const entityRefRow = result.fullSet.perType.find(
      (p) => p.type === 'entity_reference',
    );
    expect(entityRefRow?.parity).toBe(1);
  });

  it('result.meta.runAt is pinned (byte-stable harness output)', async () => {
    const claims = loadBootstrapGoldClaims();
    const result = await runShadowParity({ goldClaims: claims });
    // Pinned in harness for byte-stability across calendar years.
    expect(result.meta.runAt).toBe('2026-04-15T00:00:00.000Z');
    expect(result.meta.llm).toBe('canned');
  });
});
