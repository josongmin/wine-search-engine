/**
 * Application-owned wire-shape contract for the agent / wine-search HTTP
 * response family.
 *
 * DIP / layering: the orchestrator result schema, the presentation mappers,
 * and the agent use case (all application layer) own the SNAKE-cased wire
 * shapes they project into. The HTTP interface layer's Zod schemas
 * (`interface/http/schemas/wine-search.schema.ts`,
 * `interface/http/schemas/agent.schema.ts`) re-state the SAME shapes at
 * runtime and pin assignability against THESE types at compile time, so the
 * wire bytes cannot drift from the application contract. The dependency arrow
 * therefore points interface → application (inward), never the reverse.
 *
 * These are STRUCTURAL type mirrors of the Zod-inferred bodies. Field names,
 * optionality, and (mutable) array variance are identical to `z.infer<...>` so
 * the interface schemas can pin them with a MUTUAL `extends` assertion (arrays
 * are invariant under that pin — readonly would break the symmetric check).
 * They carry no runtime validation (that stays in the interface layer where
 * the HTTP boundary is enforced).
 */

/**
 * Token accounting block — SNAKE-cased wire projection of `TokenUsage`
 * (`src/domain/ai/port/structured-llm.port.ts`).
 */
export interface TokenUsageBody {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/** Single tool call (uniform shape across known and unknown tools). */
export interface WineSearchToolCallBody {
  name: string;
  arguments: Record<string, unknown>;
}

/** Source stage that emitted a step. */
export type WineSearchStepSource =
  | 'analyzer'
  | 'router'
  | 'runner'
  | 'wine_agent_loop'
  | 'synthesizer';

/** A single per-phase entry in the unified execution trace. */
export interface WineSearchStepBody {
  index: number;
  source: WineSearchStepSource;
  summary: string;
  tool_calls?: WineSearchToolCallBody[] | undefined;
  observations?: string[] | undefined;
  duration_ms: number;
  token_usage?: TokenUsageBody | undefined;
}

/** Top-level reason the orchestrator stopped. */
export type WineSearchTerminationReason =
  | 'answer'
  | 'max_steps'
  | 'timeout'
  | 'budget'
  | 'error'
  | 'loop_detected'
  | 'fallback'
  | 'blocked'
  | 'aborted';

/** Which synthesis layer produced the final answer. */
export type WineSearchAnswerLayer = 'primary' | 'layer2' | 'layer3' | 'layer4';

/** Optional degradation tag — populated only when the runner fell back. */
export type WineSearchDegradedReason =
  | 'malformed_llm_output'
  | 'timeout'
  | 'circuit_open'
  | 'no_results'
  | 'policy_blocked'
  | 'unexpected_error'
  | 'ungrounded_claim'
  | 'no_corpus_match'
  | 'llm_unavailable';

/** Query intent classifier output (wire form). */
export type WineSearchQueryIntent =
  | 'search'
  | 'compare'
  | 'pair'
  | 'drinkability'
  | 'unknown'
  | 'rejected';

/** Plan kind selected by the deterministic router (wire form). */
export type WineSearchPlanKind =
  | 'single-search'
  | 'parallel-search'
  | 'comparison'
  | 'food-pairing-then-search'
  | 'search-then-drinkability'
  | 'multi-step'
  | 'reject';

/** S1 semantic-split discriminant (wire form). Present only when
 *  `termination.reason === 'blocked'`. */
export type WineSearchTerminationKind = 'security_block' | 'unsupported_intent';

export interface WineSearchTerminationBody {
  reason: WineSearchTerminationReason;
  layer: WineSearchAnswerLayer;
  /** Present only when `reason === 'blocked'`; omitted otherwise. */
  kind?: WineSearchTerminationKind | undefined;
  degraded_reason?: WineSearchDegradedReason | undefined;
}

/** Top-level `POST /v1/agent` response body. */
export interface WineSearchResponseBody {
  query_type: 'wine_search';
  answer: string;
  execution: {
    steps: WineSearchStepBody[];
    tool_call_count: number;
  };
  meta: {
    request_id: string;
    total_duration_ms: number;
    total_tokens: TokenUsageBody;
    intent: WineSearchQueryIntent;
    plan_kind: WineSearchPlanKind;
    termination: WineSearchTerminationBody;
    policy_blocked: boolean;
  };
}

// ---------------------------------------------------------------------------
// Server-managed session descriptors (agent.schema.ts wire shapes)
// ---------------------------------------------------------------------------

export interface AgentSessionDescriptorBody {
  session_id: string;
  session_version: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface AgentSessionTurnDescriptorBody {
  turn_index: number;
  client_turn_id: string;
  created_at: string;
  replayed: boolean;
}

/** A single message in the applied/persisted history (wire form). Mirrors
 *  `AgentHistoryMessage` from `agent.schema.ts`. */
export interface AgentHistoryMessageBody {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string | undefined;
  timestamp?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** `POST /v1/agent/sessions/:sessionId/turns` response body — the wine-search
 *  response plus session/turn descriptors and the applied history. */
export interface AgentSessionTurnResponseBody extends WineSearchResponseBody {
  session: AgentSessionDescriptorBody;
  turn: AgentSessionTurnDescriptorBody;
  history_applied: AgentHistoryMessageBody[];
}
