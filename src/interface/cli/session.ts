/**
 * CLI conversation session — owns multi-turn state so the agent orchestrator
 * stays STATELESS (single-turn `execute(query)`).
 *
 * The orchestrator has no conversation-history parameter by design (loose
 * coupling: it is a pure single-turn use case). To get "티키타카" follow-ups
 * ("그중에 5만원 이하는?") the CLI composes prior turns into the next query
 * string itself, bounded to {@link MAX_QUERY_LENGTH} — the security gate's
 * regex-screening ceiling, so the composed query is still fully injection-
 * screened by the sanitizer inside `orchestrator.execute`.
 *
 * Context selection is a deterministic newest-first sliding window: the most
 * recent turns are included until the character budget is exhausted. This is
 * conversation context management, not a scoring heuristic.
 */
import { MAX_QUERY_LENGTH } from '../../domain/shared/constants.js';

export interface ConversationTurn {
  readonly user: string;
  readonly answer: string;
}

const CONTEXT_HEADER = '이전 대화:\n';
const CURRENT_HEADER = '\n\n현재 질문: ';

/**
 * Per-turn answer cap when folded into context. Keeps a single verbose answer
 * from crowding out older turns; the full answer still lives in {@link turns}
 * for display. 280 ≈ a few sentences — enough to anchor a follow-up referent.
 */
const PER_TURN_ANSWER_MAX_CHARS = 280;
const ELLIPSIS = '…';

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(0, max - ELLIPSIS.length)) + ELLIPSIS;
}

export class ReplSession {
  private readonly history: ConversationTurn[] = [];

  constructor(private readonly maxQueryChars: number = MAX_QUERY_LENGTH) {}

  /** Record a completed turn (user input + the answer the agent produced). */
  record(user: string, answer: string): void {
    this.history.push({ user: user.trim(), answer: answer.trim() });
  }

  /** Number of completed turns so far. */
  get turnCount(): number {
    return this.history.length;
  }

  /** Read-only view of all turns (for display / transcript). */
  get turns(): readonly ConversationTurn[] {
    return this.history;
  }

  /** Drop all history (e.g. a `/reset` command). */
  reset(): void {
    this.history.length = 0;
  }

  /**
   * Compose the query sent to `orchestrator.execute`, folding in as much recent
   * conversation context as fits under {@link maxQueryChars}.
   *
   * Guarantees:
   *  - The returned string never exceeds {@link maxQueryChars} UNLESS the
   *    current input alone already exceeds it (in which case the caller's
   *    sanitizer rejects it with a clear LENGTH_EXCEEDED — we do not silently
   *    truncate the user's own words).
   *  - With no prior turns, returns the current input unchanged.
   */
  buildQuery(currentInput: string): string {
    const current = currentInput.trim();
    if (this.history.length === 0) return current;

    // Budget left for the context block after reserving the current question.
    const fixedOverhead = CONTEXT_HEADER.length + CURRENT_HEADER.length + current.length;
    const contextBudget = this.maxQueryChars - fixedOverhead;
    if (contextBudget <= 0) {
      // No room for any context — send the current question alone.
      return current;
    }

    // Walk newest → oldest, accumulating entries until the budget runs out,
    // then emit them oldest → newest so the model reads them chronologically.
    const selected: string[] = [];
    let used = 0;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const turn = this.history[i];
      if (turn === undefined) continue;
      const ordinal = i + 1;
      const entry =
        `[${ordinal}] 사용자: ${turn.user}\n` +
        `    어시스턴트: ${clip(turn.answer, PER_TURN_ANSWER_MAX_CHARS)}\n`;
      if (used + entry.length > contextBudget) break;
      selected.push(entry);
      used += entry.length;
    }

    if (selected.length === 0) return current;

    selected.reverse();
    return CONTEXT_HEADER + selected.join('') + CURRENT_HEADER + current;
  }
}
