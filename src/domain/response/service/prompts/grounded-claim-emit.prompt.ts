/**
 * ADR-016 Axis 3 — frozen prompt for the grounded claim emitter.
 *
 * Freezing discipline:
 *   - `PROMPT_VERSION` MUST be bumped whenever the instruction block,
 *     schema block, or examples change.
 *   - Tests pin the prompt version — drift breaks regression.
 *   - Temperature 0 and seed pinned on the caller side.
 *
 * Provider differences are handled at the caller layer
 * (grounded-claim-emitter.ts), not here. This prompt is provider-agnostic.
 */

const GROUNDED_CLAIM_EMIT_PROMPT_VERSION = 'claim_emit_v1';

/** System prompt: instructs the model to emit a JSON object that
 *  strictly matches {@link GroundedPayloadSchema}. */
export const GROUNDED_CLAIM_EMIT_SYSTEM_PROMPT = [
  'You are a claim extractor for a wine search response.',
  '',
  'Given a list of ranked results, tool-call evidence frames, and optional',
  'natural-language prose, emit a JSON object that conforms EXACTLY to the',
  'schema below. You MUST:',
  '  - Emit atomic claims (one fact per claim).',
  '  - Every claim MUST carry a provenance[].toolCallId that appears in the',
  '    input evidenceFrames. Claims without valid provenance MUST be omitted.',
  '  - Every claim MUST carry BOTH `type` (9-class) AND `category` (5-class).',
  '  - Use the (type → category) mapping:',
  '      entity_reference → identity_claim',
  '      attribute_assertion → derived_structured_claim',
  '      price_assertion → core_structured_claim',
  '      vintage_assertion → core_structured_claim',
  '      pairing_assertion → semantic_claim',
  '      comparative_assertion → comparative_claim',
  '      drinking_window_assertion → core_structured_claim',
  '      style_assertion → derived_structured_claim',
  '      recommendation → semantic_claim',
  '  - Use `claimSchemaVersion: "claim_schema_v1"` on every claim and at the envelope.',
  '  - Never emit a claim the evidence does not support.',
  '',
  'Respond ONLY with the JSON object. No prose, no markdown fences.',
].join('\n');

/** Builder for the user message — emits the input payload the model
 *  reasons over. Separated so tests can pin the exact shape. */
export function buildGroundedClaimEmitUserPrompt(input: {
  readonly resultsSummary: readonly {
    readonly entityId: string;
    readonly label: string;
    readonly rank: number;
  }[];
  readonly evidenceFrameSummary: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly kind: string;
  }[];
  readonly prose: string;
}): string {
  const payload = {
    promptVersion: GROUNDED_CLAIM_EMIT_PROMPT_VERSION,
    instructions: [
      'Emit ONE JSON object matching the grounded payload schema.',
      'Ground every claim in a toolCallId from evidenceFrameSummary.',
    ],
    results: input.resultsSummary,
    evidenceFrames: input.evidenceFrameSummary,
    prose: input.prose,
  };
  return JSON.stringify(payload);
}
