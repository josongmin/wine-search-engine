/**
 * ADR-016 Axis 3 — gold annotation schemas (Zod).
 *
 * Two flavours live here:
 *
 *   1. `GoldClaimRowSchema` — the QUERY-LEVEL row used by the full
 *      gold-annotation set (one query + ranked results fixture + the
 *      full list of expected atomic claims). This is the shape the
 *      ≥200-annotation cutover gate will use once human annotators
 *      catch up (ADR-016 §2.9).
 *
 *   2. `GoldClaimSchema` — the FLAT single-claim row used by the
 *      Wave-D bootstrap annotation set. Each JSONL line is one atomic
 *      claim plus an annotator-expected verdict + confidence floor so
 *      a shadow-parity harness can run without a query-to-ranked-set
 *      fixture. The bootstrap is NOT the ADR-016 cutover gate — it's
 *      a stepping-stone until real human annotations arrive.
 *
 * Both shapes are Zod-validated; the harness and loaders pick the one
 * they need without cross-contamination.
 */

import { z } from 'zod';
import {
  AtomicClaimSchema,
  GROUNDED_CLAIM_SCHEMA_VERSION,
} from '../../../../src/domain/response/model/grounded-claim.js';

/** Upper bound on row text-field lengths — matches MAX_SEARCH_QUERY_LEN
 *  as a fixture sanity ceiling. */
const FIXTURE_TEXT_MAX_LEN = 2_000;
/** Upper bound on expected-claim count per row. Matches the per-response
 *  claims cap in `grounded-claim.ts` (150) so the harness never encodes
 *  a ground-truth the production schema could not emit. */
const EXPECTED_CLAIMS_MAX_PER_ROW = 150;

// ─── Query-level (future ≥200 gate) ───────────────────────────────────────────

const GoldClaimRowSchema = z
  .object({
    queryId: z.string().min(1).max(FIXTURE_TEXT_MAX_LEN),
    query: z.string().min(1).max(FIXTURE_TEXT_MAX_LEN),
    rankedResultsRef: z.string().min(1).max(FIXTURE_TEXT_MAX_LEN),
    expectedClaims: z.array(AtomicClaimSchema).max(EXPECTED_CLAIMS_MAX_PER_ROW),
    /** Optional free-text notes from the annotator. */
    annotatorNote: z.string().max(FIXTURE_TEXT_MAX_LEN).optional(),
  })
  .strict();

export type GoldClaimRow = z.infer<typeof GoldClaimRowSchema>;

/**
 * Parse one JSONL line into a {@link GoldClaimRow}. Returns the Zod
 * result so harnesses can distinguish malformed rows from row-level
 * semantic mismatches.
 */
function _parseGoldClaimRow(
  raw: string,
): z.SafeParseReturnType<unknown, GoldClaimRow> {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: [],
          message: 'row is not valid JSON',
        },
      ]),
    };
  }
  return GoldClaimRowSchema.safeParse(json);
}

// ─── Flat per-claim row (Wave-D bootstrap) ────────────────────────────────────

/** Four-valued verdict an annotator assigns to the gold claim. Matches
 *  the verdict enum in `atomic-claim-verifier.port.ts` so parity
 *  comparison against new/legacy verdicts is free of translation. */
export const GoldExpectedVerdictSchema = z.enum([
  'entailed',
  'partially_entailed',
  'not_entailed',
  'contradicted',
]);

export type GoldExpectedVerdict = z.infer<typeof GoldExpectedVerdictSchema>;

/**
 * Flat single-claim row for the bootstrap annotation set.
 *
 * Each JSONL line is one nested atomic claim plus annotator metadata.
 * `claim` validates against the production {@link AtomicClaimSchema}
 * — including its (type, category) refine — so the bootstrap cannot
 * encode a claim the production schema would reject.
 */
export const GoldClaimSchema = z
  .object({
    /** Stable row id — independent of `claim.id` so the harness can
     *  key reports even when inner claim ids are paraphrased. */
    claimId: z.string().min(1).max(FIXTURE_TEXT_MAX_LEN),
    /** The inner atomic claim — fully validated by the production
     *  {@link AtomicClaimSchema} including its (type, category) refine
     *  and per-claim `claimSchemaVersion` literal. */
    claim: AtomicClaimSchema,
    /** Verdict the annotator assigns against the wine referenced by
     *  `claim.entityId`. */
    expectedVerdict: GoldExpectedVerdictSchema,
    /** Minimum confidence the verifier should return when the verdict
     *  matches expectation. 0..1 inclusive; 0 means "no floor". */
    expectedConfidenceMin: z.number().min(0).max(1).finite(),
    /** Optional free-text note from the annotator. */
    annotatorNote: z.string().max(FIXTURE_TEXT_MAX_LEN).optional(),
    /** Canonical synthetic answer text used by the legacy extractor
     *  shadow path — the legacy extractor operates on prose, not on
     *  atomic claims, so the harness renders each bootstrap row into a
     *  short answer snippet and feeds it to the legacy extractor. */
    shadowAnswerText: z.string().min(1).max(FIXTURE_TEXT_MAX_LEN),
  })
  .strict()
  .refine(
    (row) => row.claim.claimSchemaVersion === GROUNDED_CLAIM_SCHEMA_VERSION,
    {
      message: `claim.claimSchemaVersion must equal '${GROUNDED_CLAIM_SCHEMA_VERSION}'`,
      path: ['claim', 'claimSchemaVersion'],
    },
  );

export type GoldClaim = z.infer<typeof GoldClaimSchema>;

/** Parse one JSONL line into a {@link GoldClaim}. */
function parseGoldClaim(
  raw: string,
): z.SafeParseReturnType<unknown, GoldClaim> {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: [],
          message: 'row is not valid JSON',
        },
      ]),
    };
  }
  return GoldClaimSchema.safeParse(json);
}

/** Parse a whole JSONL buffer into a list of {@link GoldClaim}s. Skips
 *  blank lines; throws on the first malformed line (by design — a silent
 *  skip would let annotation bugs pass shadow parity). */
export function parseGoldClaimsJsonl(buf: string): readonly GoldClaim[] {
  const out: GoldClaim[] = [];
  const lines = buf.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const parsed = parseGoldClaim(line);
    if (!parsed.success) {
      throw new Error(
        `gold-claims.jsonl line ${i + 1} invalid: ${parsed.error.message}`,
      );
    }
    out.push(parsed.data);
  }
  return out;
}
