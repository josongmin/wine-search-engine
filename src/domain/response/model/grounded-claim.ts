/**
 * ADR-016 Axis 3 — grounded claim model.
 *
 * Defines the V2 sidecar `grounded` payload:
 *   - `ProseSegment`    — chunk of natural-language response.
 *   - `AtomicClaim`     — atomic claim with dual classification
 *                         (9-class `type` + 5-class `category`) and
 *                         provenance refs pointing at
 *                         `ToolCallEvidenceFrame.toolCallId` (ADR-009).
 *   - `ProvenanceRef`   — tool-call-level provenance anchor.
 *   - `GroundedPayload` — the sidecar envelope.
 *
 * Schema is `.strict()`; every `AtomicClaim` carries per-claim
 * `claimSchemaVersion='claim_schema_v1'` (blocking cutover gate).
 */

import { z } from 'zod';
import {
  ATOMIC_CLAIM_TYPES,
  AtomicClaimTypeSchema,
  DEFAULT_TYPE_TO_CATEGORY_MAPPING,
} from './atomic-claim-type.js';
import type { AtomicClaimType } from './atomic-claim-type.js';
import type { ClaimCategory } from '../../evaluation/model/claim.js';

/** Schema version carried on every emitted claim. Blocking cutover
 *  gate — when v2 ships, every claim is upgraded or dropped. */
export const GROUNDED_CLAIM_SCHEMA_VERSION = 'claim_schema_v1' as const;
export type GroundedClaimSchemaVersion = typeof GROUNDED_CLAIM_SCHEMA_VERSION;

/** 5-class routing axis (RFC-020). Mirrored here for schema use so
 *  the Zod refine can reference the same literal set without pulling
 *  the whole evaluation model. */
const CLAIM_CATEGORY_VALUES = [
  'identity_claim',
  'core_structured_claim',
  'derived_structured_claim',
  'semantic_claim',
  'comparative_claim',
] as const;
const ClaimCategorySchema = z.enum(CLAIM_CATEGORY_VALUES);

/** Max length for a prose segment — matches the machine evidence
 *  observation cap (ADR-009) so that a single prose segment never
 *  exceeds one frame's worth of payload. */
const PROSE_SEGMENT_MAX_LEN = 2_200;

/** Max prose segments per response. Domain fact: `MAX_SEARCH_RESULTS_PER_RESPONSE`
 *  is 50; three sentences per result is plenty. */
const PROSE_SEGMENTS_MAX = 150;

/** Max claims per response — same envelope as the prose cap. */
const CLAIMS_MAX = 150;

/** Max provenance refs per claim — empirically one claim points at
 *  one tool call, but we allow a small fan-out for comparative
 *  claims that cross two entities. */
const PROVENANCE_REFS_MAX_PER_CLAIM = 8;

/** Max length of `evidencePath` — JSON-pointer-like path into the
 *  tool-call's `structuredOutput`. 256 matches `toolCallId` cap. */
const EVIDENCE_PATH_MAX_LEN = 256;

/** Max length of a claim's text. Matches the prose segment cap. */
const CLAIM_TEXT_MAX_LEN = 2_200;

/** Max length of `toolCallId` — mirrored from
 *  `tool-call-evidence-frame.ts` so validation is consistent. */
const TOOL_CALL_ID_MAX_LEN = 256;

/** Max number of degradation reasons per response. */
const DEGRADATION_REASONS_MAX = 32;

/** Max length of one degradation reason. */
const DEGRADATION_REASON_MAX_LEN = 128;

// ─── Provenance ───────────────────────────────────────────────────────────────

export const ProvenanceRefSchema = z
  .object({
    /** Stable `ToolCallEvidenceFrame.toolCallId`. */
    toolCallId: z.string().min(1).max(TOOL_CALL_ID_MAX_LEN),
    /** Optional JSON-pointer-like path into the tool's
     *  `structuredOutput` identifying the exact field the claim was
     *  derived from (e.g. `/resultSet/0/vintageYear`). */
    evidencePath: z.string().min(1).max(EVIDENCE_PATH_MAX_LEN).optional(),
  })
  .strict();

export type ProvenanceRef = z.infer<typeof ProvenanceRefSchema>;

// ─── ProseSegment ─────────────────────────────────────────────────────────────

export const ProseSegmentSchema = z
  .object({
    id: z.string().min(1).max(TOOL_CALL_ID_MAX_LEN),
    text: z.string().min(1).max(PROSE_SEGMENT_MAX_LEN),
  })
  .strict();

export type ProseSegment = z.infer<typeof ProseSegmentSchema>;

// ─── AtomicClaim ──────────────────────────────────────────────────────────────

/** Allowed `(type, category)` pairs. Derived once from the default
 *  mapping table so schema validation never drifts from the ADR-016
 *  mapping table. */
const ALLOWED_TYPE_CATEGORY_PAIRS = new Set<string>(
  ATOMIC_CLAIM_TYPES.map((t) => `${t}|${DEFAULT_TYPE_TO_CATEGORY_MAPPING[t]}`),
);

export const AtomicClaimSchema = z
  .object({
    id: z.string().min(1).max(TOOL_CALL_ID_MAX_LEN),
    /** 9-class field-level type (ADR-016 Axis 3). */
    type: AtomicClaimTypeSchema,
    /** 5-class routing axis (RFC-020). */
    category: ClaimCategorySchema,
    /** Natural-language text of the claim. */
    text: z.string().min(1).max(CLAIM_TEXT_MAX_LEN),
    /** Provenance refs — every ref MUST point at a
     *  `ToolCallEvidenceFrame.toolCallId` present in the frame set
     *  that was passed to the builder. Validated at emission time,
     *  not at schema level (schema has no access to the frame set). */
    provenance: z
      .array(ProvenanceRefSchema)
      .min(1)
      .max(PROVENANCE_REFS_MAX_PER_CLAIM),
    /** Optional entity reference (canonical entity id). */
    entityId: z.string().min(1).optional(),
    /** Per-claim schema version. Non-optional — blocking cutover gate. */
    claimSchemaVersion: z.literal(GROUNDED_CLAIM_SCHEMA_VERSION),
  })
  .strict()
  .refine(
    (c) => ALLOWED_TYPE_CATEGORY_PAIRS.has(`${c.type}|${c.category}`),
    {
      message:
        '(type, category) pair is not in ADR-016 §2.1 mapping table — drift not allowed',
      path: ['category'],
    },
  );

export type AtomicClaim = z.infer<typeof AtomicClaimSchema>;

// ─── GroundedPayload ──────────────────────────────────────────────────────────

export const GroundedPayloadSchema = z
  .object({
    proseSegments: z.array(ProseSegmentSchema).max(PROSE_SEGMENTS_MAX),
    claims: z.array(AtomicClaimSchema).max(CLAIMS_MAX),
    /** Degradation reasons surfaced from the emitter, BundleSelector,
     *  and the retrieval critic. Human-facing UI may render these as
     *  "we relaxed X" / "we stopped retrying" banners. */
    degradationReasons: z
      .array(z.string().min(1).max(DEGRADATION_REASON_MAX_LEN))
      .max(DEGRADATION_REASONS_MAX)
      .optional(),
    /** Envelope-level schema version — optional (backward-compat) but
     *  always emitted by the current builder. */
    claimSchemaVersion: z.literal(GROUNDED_CLAIM_SCHEMA_VERSION),
  })
  .strict();

export type GroundedPayload = z.infer<typeof GroundedPayloadSchema>;

// ─── Constructors ─────────────────────────────────────────────────────────────

/** Build an empty fail-closed payload with explicit degradation reasons. */
export function emptyGroundedPayload(
  degradationReasons: readonly string[],
): GroundedPayload {
  return {
    proseSegments: [],
    claims: [],
    ...(degradationReasons.length > 0
      ? { degradationReasons: [...degradationReasons] }
      : {}),
    claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
  };
}

/** Resolve the default `ClaimCategory` for a given 9-class type. */
export function defaultCategoryFor(type: AtomicClaimType): ClaimCategory {
  return DEFAULT_TYPE_TO_CATEGORY_MAPPING[type];
}

export { ATOMIC_CLAIM_TYPES } from './atomic-claim-type.js';
export type { AtomicClaimType } from './atomic-claim-type.js';
