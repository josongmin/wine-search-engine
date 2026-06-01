/**
 * Shared `similar_to_entity` execution helper (RFC-021 T-PSA-01 — single
 * source of truth for the deterministic reference-similarity primitive's input
 * contract + structured-constraint compilation).
 *
 * `similar_to_entity` is the entity-id-authoritative sibling of `lookup_wine`
 * (see {@link ./lookup-wine-execution.ts}). Where `lookup_wine` resolves a
 * free-text wine name to a canonical entity, `similar_to_entity` takes an
 * ALREADY-resolved `entity_id` as its anchor authority and returns wines
 * similar to it. The anchor is NEVER a free-text string — callers must copy a
 * canonical `entity_id` from a prior `lookup_wine` / `search_*` result.
 *
 * Contract invariants (RFC-021 T-PSA-01 §"구조 규칙"):
 *  1. anchor authority is ALWAYS `entity_id` — never `query`/`anchor_query`/
 *     `anchor_name`. Those free-text anchor fields are explicitly rejected so a
 *     caller can never smuggle a name back into the similarity primitive and
 *     force an internal re-resolution.
 *  2. no lane override — `mode`/`retrieval_mode` are rejected. The execution
 *     lane is structurally fixed (similar_items / mixed route) by the plan
 *     builder, not by tool input.
 *  3. optional STRUCTURED filters/preferences only (price/region/style/…),
 *     reusing the search-tool field shape so "wines like X but under 50,000원"
 *     compiles to the same NormalizedConstraint bundle every other tool emits.
 *
 * Two exports mirror the `lookup_wine` SSoT shape:
 *  - {@link SimilarToEntityInputSchema} — the canonical permissive-with-repair
 *    Zod schema (CLAUDE.md rule 10: NO `.strict()` — LLM tool input).
 *  - {@link normalizeSimilarToEntityInput} — pure input normalization: validate,
 *    clamp the limit, and compile structured fields into hard/soft constraints.
 *
 * Layer rule (CLAUDE.md): application-layer module — may import from `domain/`
 * and `application/search/...` only. NOT from `interface/`.
 */

import { z } from 'zod';
import { coercePositiveInt } from '../../domain/shared/utils/zod-coerce.js';
import type { NormalizedConstraint } from '../../domain/shared/types/constraint-bundle.js';
import { isSourceRecordStylePublicEntityId } from '../../domain/shared/constants/public-entity-id-namespace.js';
import {
  buildEntityIdToolField,
  buildSearchToolFieldShape,
  buildSearchToolStructuredFilters,
  buildSearchToolStructuredPreferences,
  validateSearchToolVintageRange,
  sanitizeOptionalToolNulls,
} from './search-tool-contract.js';

/**
 * Hard cap on `similar_to_entity` results. Unlike `lookup_wine` (≤3 — a tight
 * identity set), reference similarity returns a SET of related wines, so the
 * ceiling is higher. Aligns with the `similar_items` execution budget
 * (`maxCandidates: 20`) in `execution-compiler.ts`.
 */
export const SIMILAR_TO_ENTITY_LIMIT_MAX = 20;

/**
 * Upper bound on the `entity_id` length. Canonical entity ids are short slugs
 * (e.g. `opus-one-2018`); 256 is a generous ceiling that still rejects an LLM
 * accidentally pasting a whole paragraph into the anchor field.
 */
export const SIMILAR_TO_ENTITY_ENTITY_ID_MAX_LEN = 256;

/**
 * Mapping-version tag stamped onto every NormalizedConstraint this module
 * compiles, so structured filters from the reference-similarity surface are
 * distinguishable in provenance from NL-extracted or other-tool constraints
 * (CLAUDE.md rule 30 — versioned, replayable constraint provenance).
 */
export const REFERENCE_SIMILARITY_TOOL_FILTER_MAPPING_VERSION =
  'reference_similarity_tool_v1' as const;

/**
 * `similar_to_entity` accepts the full structured price ceiling the agent/HTTP
 * surfaces already allow; the downstream constraint compiler / Vespa filter is
 * the authority on what is satisfiable, not this contract bound.
 */
const SIMILAR_TO_ENTITY_MAX_PRICE_KRW = Number.MAX_SAFE_INTEGER;

/**
 * Free-text anchor + lane-override fields that MUST NOT appear on
 * `similar_to_entity` input. Rejecting them at the contract boundary is the
 * structural guard behind RFC-021 T-PSA-01's "anchor authority is entity_id"
 * rule: a caller cannot re-introduce a name/lane and force the primitive to
 * behave like a free-text mixed query.
 */
const SIMILAR_TO_ENTITY_BANNED_ANCHOR_FIELDS = [
  'query',
  'anchor_query',
  'anchor_name',
  'name',
  'mode',
  'retrieval_mode',
] as const;

// The shared search-tool field shape carries `limit` (with a hard max) and
// `retrieval_mode`. Strip BOTH:
//   - `retrieval_mode` is a lane override and is structurally forbidden here.
//   - `limit` is re-declared below as a permissive field (clamped in
//     `normalizeSimilarToEntityInput`) so an LLM passing `limit: 50` does not
//     hard-fail the whole tool call — same posture as `lookup_wine`.
const {
  limit: _strippedSharedLimit,
  retrieval_mode: _strippedSharedRetrievalMode,
  ...SIMILAR_TO_ENTITY_STRUCTURED_FIELD_SHAPE
} = buildSearchToolFieldShape({
  limitMax: SIMILAR_TO_ENTITY_LIMIT_MAX,
  maxPriceKrwMax: SIMILAR_TO_ENTITY_MAX_PRICE_KRW,
});
void _strippedSharedLimit;
void _strippedSharedRetrievalMode;

/**
 * The anchor must be a CANONICAL PUBLIC entity_id (the form exposed in search
 * results), never a `vivino-` source-record id. The runtime projects
 * source-record ids away before they reach a caller (ADR-007), so a `vivino-`
 * anchor means the LLM copied an internal id by mistake — reject it at the
 * boundary with a clear message instead of letting `createCanonicalEntityId`
 * throw deep inside the adapter (RFC-021 T-PSA-04 audit C1/C2).
 */
const SimilarToEntityEntityIdField = buildEntityIdToolField({
  maxLen: SIMILAR_TO_ENTITY_ENTITY_ID_MAX_LEN,
}).refine((value) => !isSourceRecordStylePublicEntityId(value), {
  message:
    'entity_id must be a canonical public id from a prior lookup_wine result, ' +
    'not a source-record (vivino-) id.',
});

const SimilarToEntityInputSchemaBase = z
  .object({
    entity_id: SimilarToEntityEntityIdField,
    // Permissive on purpose (clamped by the dispatcher) — see comment above.
    limit: coercePositiveInt.pipe(z.number().int().min(1)).optional(),
    ...SIMILAR_TO_ENTITY_STRUCTURED_FIELD_SHAPE,
  })
  .superRefine((data, ctx) => {
    validateSearchToolVintageRange(data, ctx);
  });

/**
 * Reject free-text anchor / lane-override fields BEFORE the permissive base
 * schema drops them silently. Mirrors `rejectUnsupportedSearchFamilyFields` in
 * the agent tool bundle: an explicit issue tells the caller WHY the anchor was
 * refused instead of silently ignoring a name the LLM expected to be honoured.
 */
function rejectFreeTextAnchorFields<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodType<z.output<T>, z.ZodTypeDef, unknown> {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
        // Surface an actionable message for the positional-array / scalar forms
        // an LLM occasionally emits, instead of deferring to the base object
        // schema's generic "expected object" error.
        ctx.addIssue({
          code: 'custom',
          message: 'similar_to_entity input must be an object with a required entity_id field.',
        });
        return;
      }
      for (const field of SIMILAR_TO_ENTITY_BANNED_ANCHOR_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(value, field)) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message:
              `${field} is not accepted by similar_to_entity. The anchor authority is ` +
              `entity_id — copy the canonical entity_id from a prior lookup_wine result. ` +
              `Free-text anchors and lane overrides are rejected by contract.`,
          });
        }
      }
    })
    .pipe(schema);
}

/**
 * Canonical, permissive-with-repair input contract for the `similar_to_entity`
 * primitive. `entity_id` is required; everything else is optional structured
 * refinement. Free-text anchors / lane overrides are rejected.
 */
export const SimilarToEntityInputSchema = rejectFreeTextAnchorFields(
  SimilarToEntityInputSchemaBase,
);

/** Successful normalization result. */
interface NormalizedSimilarToEntityInput {
  readonly ok: true;
  /** The resolved canonical anchor entity id (validated, trimmed). */
  readonly entityId: string;
  /** Always ≤ {@link SIMILAR_TO_ENTITY_LIMIT_MAX}. */
  readonly clampedLimit: number;
  /** Structured hard constraints compiled from the tool input (may be empty). */
  readonly filters: readonly NormalizedConstraint[];
  /** Structured soft/preference constraints compiled from the tool input. */
  readonly preferences: readonly NormalizedConstraint[];
}

/** Validation failure — surfaced as the `INVALID_INPUT` observation. */
interface InvalidSimilarToEntityInput {
  readonly ok: false;
  readonly message: string;
}

type SimilarToEntityInputNormalizationResult =
  | NormalizedSimilarToEntityInput
  | InvalidSimilarToEntityInput;

interface NormalizeSimilarToEntityInputOptions {
  /** Override the constraint mapping-version tag (defaults to the module SSoT). */
  readonly mappingVersion?: string | undefined;
}

/**
 * Validate raw LLM/HTTP-emitted `similar_to_entity` input, clamp the limit, and
 * compile structured fields into hard (`filters`) / soft (`preferences`)
 * constraint bundles. Returns a tagged union so callers do not re-implement the
 * join-issues + clamp + constraint-build pattern.
 */
export function normalizeSimilarToEntityInput(
  rawInput: unknown,
  options?: NormalizeSimilarToEntityInputOptions,
): SimilarToEntityInputNormalizationResult {
  const parseResult = SimilarToEntityInputSchema.safeParse(
    sanitizeOptionalToolNulls(rawInput),
  );
  if (!parseResult.success) {
    return {
      ok: false,
      message: parseResult.error.issues.map((issue) => issue.message).join(', '),
    };
  }
  const parsed = parseResult.data;
  const mappingVersion =
    options?.mappingVersion ?? REFERENCE_SIMILARITY_TOOL_FILTER_MAPPING_VERSION;
  const clampedLimit = Math.min(
    parsed.limit ?? SIMILAR_TO_ENTITY_LIMIT_MAX,
    SIMILAR_TO_ENTITY_LIMIT_MAX,
  );
  const filters = buildSearchToolStructuredFilters(parsed, mappingVersion);
  const preferences = buildSearchToolStructuredPreferences(parsed, mappingVersion);
  return {
    ok: true,
    entityId: parsed.entity_id,
    clampedLimit,
    filters,
    preferences,
  };
}
