/**
 * ADR-016 Axis 3 — claim-extractor deletion guard.
 *
 * The legacy regex-based `src/domain/evaluation/service/claim-extractor.ts`
 * is the shadow baseline that the grounded-claim emitter (GCE) is proving
 * parity against. Deleting it BEFORE the shadow-parity harness has shipped
 * a signed "gold-set proof" would silently turn off the baseline, leaving
 * the claim-level evaluator with no fallback and no evidence that the
 * emitter is at parity.
 *
 * This guard enforces the ADR-016 §2.9 deletion precondition: if
 * `claim-extractor.ts` is missing, then a sibling `gold-set-proof.json`
 * MUST exist in the same directory to prove the nightly-green cutover
 * criteria have been met (≥200 gold rows, ≥2 consecutive nightly greens
 * at parity ≥ 0.95 on BOTH the `status === 'ok'` subset AND the full set
 * per the §2.8 dual-report bias rule).
 *
 * Test matrix:
 *   1. `claim-extractor.ts` present → guard passes (current state).
 *   2. `claim-extractor.ts` absent + no sibling `gold-set-proof.json`
 *      → guard fails loudly with a descriptive message.
 *   3. `claim-extractor.ts` absent + sibling `gold-set-proof.json`
 *      present → guard passes and the proof is schema-validated.
 *
 * Append-only — never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const CLAIM_EXTRACTOR_PATH = fileURLToPath(
  new URL(
    '../../src/domain/evaluation/service/claim-extractor.ts',
    import.meta.url,
  ),
);
const GOLD_SET_PROOF_PATH = fileURLToPath(
  new URL(
    '../../src/domain/evaluation/service/gold-set-proof.json',
    import.meta.url,
  ),
);

/** Minimum nightly parity the proof must record. ADR-016 §2.9. */
const GOLD_SET_PROOF_MIN_PARITY = 0.95;
/** Minimum consecutive nightly-green count. */
const GOLD_SET_PROOF_MIN_NIGHTLY_GREENS = 2;

/**
 * Schema for the deletion-proof file. This MUST co-exist with the
 * deleted extractor and prove the ADR-016 §2.9 cutover invariants.
 *
 * Dual-report bias: every parity figure is reported twice (once on the
 * `status === 'ok'` subset, once on the full set). The LOWER of the two
 * is the effective gate — so both must clear 0.95.
 */
const GoldSetProofSchema = z
  .object({
    $schema: z.literal('adr-016-axis-3-gold-set-proof-v1'),
    goldRowCount: z.number().int().min(200).finite(),
    consecutiveNightlyGreens: z
      .number()
      .int()
      .min(GOLD_SET_PROOF_MIN_NIGHTLY_GREENS)
      .finite(),
    parity: z
      .object({
        statusOkSubset: z.number().min(GOLD_SET_PROOF_MIN_PARITY).max(1).finite(),
        fullSet: z.number().min(GOLD_SET_PROOF_MIN_PARITY).max(1).finite(),
      })
      .strict(),
    generatedAt: z.string().min(1),
  })
  .strict();

describe('ADR-016 claim-extractor deletion guard', () => {
  it('either `claim-extractor.ts` exists OR a sibling gold-set-proof.json proves cutover', () => {
    const extractorPresent = existsSync(CLAIM_EXTRACTOR_PATH);
    const proofPresent = existsSync(GOLD_SET_PROOF_PATH);

    if (extractorPresent) {
      // Happy-path: legacy extractor still in tree → guard passes.
      // Sanity-check that the file is non-empty so a future accidental
      // truncation-to-zero also trips this guard.
      const size = statSync(CLAIM_EXTRACTOR_PATH).size;
      expect(size).toBeGreaterThan(0);
      return;
    }

    // Extractor is gone — the sibling proof MUST exist.
    expect(proofPresent, [
      'claim-extractor.ts has been deleted without a sibling',
      'gold-set-proof.json at',
      GOLD_SET_PROOF_PATH,
      '— ADR-016 §2.9 forbids this. Restore the extractor or ship the',
      'shadow-parity cutover proof (≥200 gold rows, ≥2 nightly greens',
      'at parity ≥ 0.95 on BOTH status==ok subset AND full set).',
    ].join(' ')).toBe(true);

    // Proof must schema-validate and meet the ADR-016 §2.9 thresholds.
    const raw = readFileSync(GOLD_SET_PROOF_PATH, 'utf8');
    const parsedJson: unknown = JSON.parse(raw);
    const validation = GoldSetProofSchema.safeParse(parsedJson);
    expect(
      validation.success,
      validation.success
        ? 'ok'
        : `gold-set-proof.json failed schema: ${validation.error.message}`,
    ).toBe(true);
  });

  it('extractor path is co-located with the sibling proof slot', () => {
    // Locks the sibling relationship — any future refactor that moves
    // claim-extractor.ts without updating this test will trip here, so
    // the guard stays honest about what "sibling" means.
    expect(dirname(CLAIM_EXTRACTOR_PATH)).toBe(dirname(GOLD_SET_PROOF_PATH));
  });
});
