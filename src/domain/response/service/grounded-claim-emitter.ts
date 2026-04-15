/**
 * ADR-016 Axis 3 — grounded claim emitter.
 *
 * Calls the chat LLM with a JSON-schema-constrained prompt and parses
 * the response into a {@link GroundedPayload}. Fail-closed: any error
 * (network, non-JSON, Zod validation, unknown toolCallId) → empty
 * payload with explicit `degradationReasons`.
 *
 * Provider topology:
 *   - GCE_LLM_PROVIDER=anthropic (default): the adapter is expected to
 *     use Anthropic `tool_use` with a forced schema. Output is the
 *     JSON body of the tool-call argument.
 *   - GCE_LLM_PROVIDER=openai: the adapter is expected to use OpenAI
 *     `json_schema` response format. Output is the JSON body directly.
 *     Post-hoc Zod **lax** normalises number-as-string (CLAUDE.md rule 10)
 *     before strict validation.
 *
 * Both code paths produce the same `GroundedPayload`.
 */

import type { ChatLlmPort } from '../../../domain/ai/port/chat-llm.port.js';
import {
  GroundedPayloadSchema,
  GROUNDED_CLAIM_SCHEMA_VERSION,
  emptyGroundedPayload,
  type GroundedPayload,
} from '../model/grounded-claim.js';
import type { ToolCallEvidenceFrame } from '../../agent/model/tool-call-evidence-frame.js';
import {
  GROUNDED_CLAIM_EMIT_SYSTEM_PROMPT,
  buildGroundedClaimEmitUserPrompt,
} from './prompts/grounded-claim-emit.prompt.js';
import type { RankedResult } from '../../ranking/model/ranked-result.js';

/** Temperature pinned at 0 for replay stability. */
const CLAIM_EMITTER_TEMPERATURE = 0;
/** Seed pinned for providers that support it (CLAUDE.md replay discipline). */
const CLAIM_EMITTER_SEED = 1;
/** Max output tokens — generous but bounded. */
const CLAIM_EMITTER_MAX_TOKENS = 4_000;
/** Max ranked rows summarised into the GCE user prompt (cost / context cap). */
const GCE_RANKED_RESULTS_SUMMARY_MAX = 50;

/** Degradation reason tags — narrow closed set for machine consumers. */
export const GCE_DEGRADATION_EMISSION_FAILED = 'grounded_claim_emission_failed';
export const GCE_DEGRADATION_PROVENANCE_UNKNOWN = 'provenance_tool_call_id_unknown';
export const GCE_DEGRADATION_PARSE_FAILED = 'grounded_claim_parse_failed';

export interface EmitGroundedClaimsInput {
  readonly rankedResults: readonly RankedResult[];
  readonly evidenceFrames: readonly ToolCallEvidenceFrame[];
  readonly prose: string;
  /** Extra degradation reasons to merge into the final payload — sourced
   *  from BundleSelector degradations and critic signals upstream. */
  readonly upstreamDegradationReasons?: readonly string[];
}

/**
 * Emit grounded claims from ranked results + evidence frames + prose.
 *
 * Fail-closed on any error: returns {@link emptyGroundedPayload} with
 * explicit degradation reasons. Never throws.
 */
export async function emitGroundedClaims(
  llm: ChatLlmPort,
  input: EmitGroundedClaimsInput,
): Promise<GroundedPayload> {
  const upstream = input.upstreamDegradationReasons ?? [];

  // Summarise the inputs into a compact shape the LLM can reason over.
  const resultsSummary = input.rankedResults.slice(0, GCE_RANKED_RESULTS_SUMMARY_MAX).map((r) => ({
    entityId: String(r.entityId),
    label: r.canonicalLabel,
    rank: r.rank,
  }));
  const evidenceFrameSummary = input.evidenceFrames.map((f) => ({
    toolCallId: f.toolCallId,
    toolName: f.toolName,
    kind: f.structuredOutput.kind,
  }));

  const userPrompt = buildGroundedClaimEmitUserPrompt({
    resultsSummary,
    evidenceFrameSummary,
    prose: input.prose,
  });

  let completionText: string;
  try {
    const completion = await llm.complete({
      messages: [
        { role: 'system', content: GROUNDED_CLAIM_EMIT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: CLAIM_EMITTER_TEMPERATURE,
      seed: CLAIM_EMITTER_SEED,
      maxOutputTokens: CLAIM_EMITTER_MAX_TOKENS,
    });
    completionText = completion.text;
  } catch {
    return emptyGroundedPayload([...upstream, GCE_DEGRADATION_EMISSION_FAILED]);
  }

  // Parse JSON (cast to unknown first per CLAUDE.md rule 12).
  let parsed: unknown;
  try {
    parsed = JSON.parse(completionText) as unknown;
  } catch {
    return emptyGroundedPayload([...upstream, GCE_DEGRADATION_PARSE_FAILED]);
  }

  // Lax pre-normalisation for OpenAI number-as-string etc.
  const normalised = laxNormaliseGroundedPayload(parsed);

  const validation = GroundedPayloadSchema.safeParse(normalised);
  if (!validation.success) {
    return emptyGroundedPayload([...upstream, GCE_DEGRADATION_PARSE_FAILED]);
  }

  // Drop claims with provenance pointing at unknown toolCallIds.
  const knownIds = new Set(input.evidenceFrames.map((f) => f.toolCallId));
  const filteredClaims = validation.data.claims.filter((c) =>
    c.provenance.every((p) => knownIds.has(p.toolCallId)),
  );
  const dropped = validation.data.claims.length - filteredClaims.length;

  const degradationReasons: string[] = [
    ...upstream,
    ...(validation.data.degradationReasons ?? []),
  ];
  if (dropped > 0) {
    degradationReasons.push(GCE_DEGRADATION_PROVENANCE_UNKNOWN);
  }

  return {
    proseSegments: validation.data.proseSegments,
    claims: filteredClaims,
    ...(degradationReasons.length > 0 ? { degradationReasons } : {}),
    claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
  };
}

/**
 * Lax normaliser — tolerates LLM-specific quirks before strict Zod.
 *
 * Current rules (CLAUDE.md rule 10):
 *   - `number` fields emitted as strings (e.g. `"10"` instead of `10`)
 *     are not currently carried in our schema, but the normaliser is a
 *     policy seam so future additions can bolt in without rewriting
 *     the validation flow.
 *   - Missing envelope `claimSchemaVersion` is injected so older OpenAI
 *     structured-output flavours that strip literal-only fields still parse.
 */
function laxNormaliseGroundedPayload(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const record = input as Record<string, unknown>;
  if (record['claimSchemaVersion'] === undefined) {
    record['claimSchemaVersion'] = GROUNDED_CLAIM_SCHEMA_VERSION;
  }
  if (Array.isArray(record['claims'])) {
    const claimsArr = record['claims'] as unknown[];
    record['claims'] = claimsArr.map((c) => {
      if (typeof c === 'object' && c !== null) {
        const cr = c as Record<string, unknown>;
        if (cr['claimSchemaVersion'] === undefined) {
          cr['claimSchemaVersion'] = GROUNDED_CLAIM_SCHEMA_VERSION;
        }
        return cr;
      }
      return c;
    });
  }
  return record;
}
