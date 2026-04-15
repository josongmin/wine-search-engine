/**
 * ADR-016 Axis 3 — gold annotation schema (Zod).
 *
 * One row per line in `gold-claims.jsonl`. Each row is one
 * query + ranked-result fixture + the list of expected atomic claims.
 */

import { z } from 'zod';
import { AtomicClaimSchema } from '../../../../src/domain/response/model/grounded-claim.js';

/** Upper bound on row text-field lengths — matches MAX_SEARCH_QUERY_LEN
 *  as a fixture sanity ceiling. */
const FIXTURE_TEXT_MAX_LEN = 2_000;
/** Upper bound on expected-claim count per row. Matches the per-response
 *  claims cap in `grounded-claim.ts` (150) so the harness never encodes
 *  a ground-truth the production schema could not emit. */
const EXPECTED_CLAIMS_MAX_PER_ROW = 150;

export const GoldClaimRowSchema = z
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
export function parseGoldClaimRow(
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
