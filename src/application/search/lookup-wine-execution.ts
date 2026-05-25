/**
 * Shared lookup-wine execution helper (SOLID H2 — single source of truth
 * for the `lookup_wine` tool's input contract + dispatch).
 *
 * Before this module existed, the `lookup_wine` semantics were duplicated
 * across `agent-tools.ts` (full schema + dispatch) and `mini-loop.ts` /
 * `mini-loop-tool-bundle.ts` (a permissive schema + a separate inline
 * dispatch that skipped placeholder/trim guards). The mini-loop path could
 * silently accept inputs the agent-tools path rejected — producing two
 * subtly different "lookup_wine" tools.
 *
 * Two exports:
 *  - {@link LookupWineInputSchema} — the canonical, strict-with-repair Zod
 *    schema used by every dispatcher.
 *  - {@link normalizeLookupWineInput} — pure input normalization (validate
 *    via the schema, clamp the limit). Dispatchers whose port surface
 *    differs from {@link SearchExecutorPort} (e.g. the mini-loop runner's
 *    `SearchUseCasePort` which takes the flatter `SearchUseCaseInput` shape)
 *    use this to inherit the SAME validation/clamp semantics without
 *    coupling to the executor port.
 *
 * Layer rule (CLAUDE.md): application-layer module — may import from
 * `domain/` and `application/search/...` only. NOT from `interface/`.
 */

import { z } from 'zod';
import { coercePositiveInt } from '../../domain/shared/utils/zod-coerce.js';
import { MAX_QUERY_LENGTH } from '../../domain/shared/constants.js';
import {
  LOOKUP_WINE_LIMIT_MAX,
  buildSearchToolQueryField,
  sanitizeOptionalToolNulls,
} from './search-tool-contract.js';

/**
 * Runtime input contract for the `lookup_wine` tool. Deliberately minimal:
 * a required wine name/identity + an optional small result cap.
 *
 * The query field uses {@link buildSearchToolQueryField} so the same trim +
 * placeholder + max-length guards apply uniformly across every dispatcher
 * (legacy agent-tools, mini-loop, future tool runners). The `limit` field is
 * intentionally unbounded at the schema layer — an LLM emitting `limit: 5`
 * should not fail the entire tool call; the dispatch helpers below clamp to
 * {@link LOOKUP_WINE_LIMIT_MAX}.
 */
export const LookupWineInputSchema = z.object({
  query: buildSearchToolQueryField({ maxLen: MAX_QUERY_LENGTH }),
  // No upper bound here on purpose: an LLM passing limit:5 should not hard-fail
  // the whole tool call. The dispatcher clamps to LOOKUP_WINE_LIMIT_MAX.
  limit: coercePositiveInt.pipe(z.number().int().min(1)).optional(),
});

/**
 * Successful normalization result. `clampedLimit` is always ≤
 * {@link LOOKUP_WINE_LIMIT_MAX}; pass it directly to whatever entity-route
 * dispatcher the caller uses.
 */
interface NormalizedLookupWineInput {
  readonly ok: true;
  readonly query: string;
  readonly clampedLimit: number;
}

/**
 * Validation failure — the dispatcher should surface this as the
 * `INVALID_INPUT` observation. Carrying the joined message keeps callers
 * simple ("...failed with X").
 */
interface InvalidLookupWineInput {
  readonly ok: false;
  readonly message: string;
}

type LookupWineInputNormalizationResult =
  | NormalizedLookupWineInput
  | InvalidLookupWineInput;

/**
 * Validate raw LLM-emitted tool input and clamp the result limit. Returns a
 * tagged union so callers do not have to re-implement the join-issues +
 * clamp pattern.
 *
 * Use this from dispatchers whose underlying port shape does NOT match
 * {@link SearchExecutorPort} (e.g. the mini-loop's `SearchUseCasePort`,
 * which takes `SearchUseCaseInput` rather than `SearchRequest`).
 */
export function normalizeLookupWineInput(
  rawInput: unknown,
): LookupWineInputNormalizationResult {
  const parseResult = LookupWineInputSchema.safeParse(sanitizeOptionalToolNulls(rawInput));
  if (!parseResult.success) {
    return {
      ok: false,
      message: parseResult.error.issues.map((issue) => issue.message).join(', '),
    };
  }
  const parsed = parseResult.data;
  const clampedLimit = Math.min(parsed.limit ?? LOOKUP_WINE_LIMIT_MAX, LOOKUP_WINE_LIMIT_MAX);
  return { ok: true, query: parsed.query, clampedLimit };
}

