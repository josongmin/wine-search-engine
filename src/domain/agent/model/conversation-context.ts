/**
 * Conversation context for multi-turn agent runs.
 *
 * The agent orchestrator is single-turn and stateless: `execute(query, …)` has
 * no memory of prior turns. A multi-turn caller (the agent CLI) owns the
 * conversation and passes a compact, already-summarized {@link ConversationContext}
 * into `execute` so the planner can resolve follow-up referents
 * ("그중에 5만원 이하는?") against the entities it returned earlier.
 *
 * This is a PROMPT-CONTEXT object, not a query: it is injected at the
 * prompt-assembly layer (buildPlannerLoopMessages), so — unlike the user query —
 * it is NOT bounded by MAX_QUERY_LENGTH or screened by the query sanitizer. Its
 * size is bounded by the renderer's own budget (see agent-prompt.ts).
 *
 * All fields are already trimmed/clipped by the caller; the model carries no
 * behavior. Keep this leaf pure (domain layer): no imports outside domain.
 */
import type { CanonicalEntityId } from '../../shared/types/entity-id.js';

/**
 * A compact reference to a wine the agent surfaced in a prior turn. Derived
 * from a prior turn's search results — just enough for the planner to anchor a
 * follow-up ("the second one", "the Napa cab", "cheaper than that").
 */
export interface PriorEntityRef {
  /**
   * Branded canonical entity id (not a raw string) so consumers can feed this
   * back into ports like `entityLookup(id: CanonicalEntityId)` without an
   * unsafe re-cast. The brand flows through from the result-item shape.
   */
  readonly entityId: CanonicalEntityId;
  readonly label: string;
  readonly vintage?: number | undefined;
  readonly producer?: string | undefined;
  readonly region?: string | undefined;
  readonly wineType?: string | undefined;
  /** Human-readable price band (e.g. "$20-$30"), as surfaced to the user. */
  readonly priceRange?: string | undefined;
  /** Ranking score [0,1] from the prior turn, for ordering/anchoring. */
  readonly relevanceScore?: number | undefined;
}

/** One completed turn of the conversation, summarized for prompt injection. */
export interface ConversationTurnContext {
  readonly userQuery: string;
  /** Clipped summary of the answer the agent gave that turn. */
  readonly answerSummary: string;
  /** Entities surfaced that turn, most-relevant first. May be empty. */
  readonly entities: readonly PriorEntityRef[];
}

/** Ordered oldest → newest. May be empty (first turn). */
export interface ConversationContext {
  readonly turns: readonly ConversationTurnContext[];
}
