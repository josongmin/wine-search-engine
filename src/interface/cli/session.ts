/**
 * CLI conversation session — owns multi-turn state so the agent orchestrator
 * stays single-turn. Instead of stuffing prior turns into the query STRING
 * (which would compete with the user's words for the MAX_QUERY_LENGTH budget
 * and get re-screened as a query), the session captures a STRUCTURED
 * {@link ConversationContext} — including the entities the agent surfaced each
 * turn — and the REPL passes it to `orchestrator.execute(query, …, context)`.
 * The orchestrator injects it at the prompt-assembly layer, outside the query
 * sanitizer/length gate.
 *
 * Follow-ups ("그중에 5만원 이하는?", "두번째 거 더 알려줘") then resolve against
 * the actual prior result set, not just the answer text.
 */
import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import type {
  ConversationContext,
  ConversationTurnContext,
  PriorEntityRef,
} from '../../domain/agent/model/conversation-context.js';

/**
 * Max entities captured per turn from the search results. The prompt renderer
 * (agent-prompt.ts) caps how many it actually shows; capturing a few extra here
 * gives the renderer room without bloating session memory.
 */
const CAPTURE_MAX_ENTITIES_PER_TURN = 10;

interface SessionTurn {
  readonly user: string;
  readonly answer: string;
  readonly entities: readonly PriorEntityRef[];
}

function extractEntities(result: AgentResult): PriorEntityRef[] {
  const items = result.searchResults?.results;
  if (items === undefined || items.length === 0) return [];
  const refs: PriorEntityRef[] = [];
  for (const item of items.slice(0, CAPTURE_MAX_ENTITIES_PER_TURN)) {
    const e = item.entity;
    refs.push({
      entityId: e.entityId,
      label: e.canonicalLabel,
      ...(e.vintage !== undefined ? { vintage: e.vintage } : {}),
      ...(e.producer !== undefined ? { producer: e.producer } : {}),
      ...(e.region !== undefined ? { region: e.region } : {}),
      ...(e.wineType !== undefined ? { wineType: e.wineType } : {}),
      ...(e.priceRange !== undefined ? { priceRange: e.priceRange } : {}),
      ...(Number.isFinite(item.relevanceScore) ? { relevanceScore: item.relevanceScore } : {}),
    });
  }
  return refs;
}

export class ReplSession {
  private readonly history: SessionTurn[] = [];

  /** Record a completed turn: the user's input + the agent's full result. */
  record(user: string, result: AgentResult): void {
    this.history.push({
      user: user.trim(),
      answer: result.answer.trim(),
      entities: extractEntities(result),
    });
  }

  /** Number of completed turns so far. */
  get turnCount(): number {
    return this.history.length;
  }

  /** Drop all history (e.g. a `/reset` command). */
  reset(): void {
    this.history.length = 0;
  }

  /**
   * Snapshot the conversation as a {@link ConversationContext} for injection.
   * Returns `undefined` when there is no history yet, so the first turn sends
   * no context (the orchestrator then behaves exactly like the HTTP path).
   */
  toConversationContext(): ConversationContext | undefined {
    if (this.history.length === 0) return undefined;
    const turns: ConversationTurnContext[] = this.history.map((t) => ({
      userQuery: t.user,
      answerSummary: t.answer,
      entities: t.entities,
    }));
    return { turns };
  }
}
