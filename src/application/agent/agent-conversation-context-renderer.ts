/**
 * Multi-turn conversation-context renderer.
 *
 * Single responsibility: turn a {@link ConversationContext} (prior CLI turns +
 * the entities surfaced each turn) into a compact, budget-bounded prompt block
 * that is folded into the FIRST planner step's user message. Split out of
 * agent-prompt.ts (which owns system-prompt authoring) so the two concerns —
 * "what the agent IS" vs "how prior conversation is summarized" — change
 * independently.
 *
 * Budget constants are module-scope named consts (no magic numbers). Mutual
 * consistency (CLAUDE.md rule 22): CONVERSATION_CONTEXT_MAX_CHARS (1800) <<
 * DEFAULT_AGENT_CONFIG.maxContextChars (8000). The block is injected only on
 * step 0 and competes with step-observation history (truncated separately to
 * maxContextChars), so the ~1800-char (~600-token) ceiling leaves ample room
 * for system prompt + query + observations within the ~10k-token/step budget.
 */
import type {
  ConversationContext,
  ConversationTurnContext,
  PriorEntityRef,
} from '../../domain/agent/model/conversation-context.js';

/** Most recent N turns eligible for injection (older turns are dropped). */
const CONVERSATION_MAX_TURNS = 4;
/** Entity rows kept for the most recent turn (the likely follow-up referent). */
export const CONVERSATION_MAX_ENTITIES_RECENT = 8;
/** Entity rows kept for each older turn. */
export const CONVERSATION_MAX_ENTITIES_OLDER = 3;
/** Per-turn answer-summary character cap. */
const CONVERSATION_ANSWER_CLIP_CHARS = 240;
/** Approx char allowance per included turn (label + answer summary + entity rows). */
const CONVERSATION_PER_TURN_CHARS = 450;
/** Hard ceiling on the entire rendered context block (≈ turns × per-turn budget). */
export const CONVERSATION_CONTEXT_MAX_CHARS =
  CONVERSATION_MAX_TURNS * CONVERSATION_PER_TURN_CHARS;

const CONVERSATION_BLOCK_HEADER = '=== 이전 대화 맥락 (참고용; 실제 현재 질문은 맨 아래) ===';
const CONVERSATION_BLOCK_FOOTER = '=== 이전 대화 맥락 끝 ===';
const CONVERSATION_ELLIPSIS = '…';

function clipPromptText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(0, max - CONVERSATION_ELLIPSIS.length)) + CONVERSATION_ELLIPSIS;
}

function renderPriorEntity(entity: PriorEntityRef, ordinal: number): string {
  const facets: string[] = [entity.label];
  if (entity.vintage !== undefined) facets.push(String(entity.vintage));
  if (entity.producer !== undefined) facets.push(entity.producer);
  if (entity.region !== undefined) facets.push(entity.region);
  if (entity.wineType !== undefined) facets.push(entity.wineType);
  if (entity.priceRange !== undefined) facets.push(entity.priceRange);
  const head = `        ${ordinal}. ${facets.join(' · ')}`;
  return entity.relevanceScore !== undefined
    ? `${head} (rel ${entity.relevanceScore.toFixed(2)})`
    : head;
}

function renderTurn(
  turn: ConversationTurnContext,
  recencyLabel: string,
  entityCap: number,
): string {
  const lines: string[] = [];
  lines.push(`${recencyLabel} 사용자: ${clipPromptText(turn.userQuery, CONVERSATION_ANSWER_CLIP_CHARS)}`);
  if (turn.answerSummary.length > 0) {
    lines.push(`      답변요약: ${clipPromptText(turn.answerSummary, CONVERSATION_ANSWER_CLIP_CHARS)}`);
  }
  if (turn.entities.length > 0) {
    lines.push('      검색결과:');
    const shown = turn.entities.slice(0, entityCap);
    for (let i = 0; i < shown.length; i += 1) {
      lines.push(renderPriorEntity(shown[i]!, i + 1));
    }
  }
  return lines.join('\n');
}

/**
 * Render a compact prompt block from prior conversation turns, bounded to
 * `maxChars`. Returns '' for empty context (caller then injects nothing).
 *
 * Selection is a deterministic newest-first sliding window at TWO granularities:
 *  - the most recent turn keeps more entity rows than older turns (the follow-up
 *    referent is almost always in the latest result set);
 *  - turns are accumulated newest → oldest until the char budget is exhausted,
 *    then emitted oldest → newest so the model reads them chronologically.
 * This is conversation context management, not a scoring heuristic.
 */
export function buildConversationContextBlock(
  context: ConversationContext,
  maxChars: number = CONVERSATION_CONTEXT_MAX_CHARS,
): string {
  if (context.turns.length === 0) return '';

  // Newest-first slice of eligible turns.
  const eligible = context.turns.slice(-CONVERSATION_MAX_TURNS);
  const overhead = CONVERSATION_BLOCK_HEADER.length + CONVERSATION_BLOCK_FOOTER.length + 2;
  const turnBudget = maxChars - overhead;
  if (turnBudget <= 0) return '';

  const rendered: string[] = [];
  let used = 0;
  for (let i = eligible.length - 1; i >= 0; i -= 1) {
    const turn = eligible[i]!;
    const fromNewest = eligible.length - 1 - i; // 0 == newest
    const recencyLabel = `[T-${fromNewest + 1}]`;
    const entityCap = fromNewest === 0
      ? CONVERSATION_MAX_ENTITIES_RECENT
      : CONVERSATION_MAX_ENTITIES_OLDER;
    const entry = renderTurn(turn, recencyLabel, entityCap);
    const cost = entry.length + 1; // newline join
    if (used + cost > turnBudget) break;
    rendered.push(entry);
    used += cost;
  }

  if (rendered.length === 0) return '';
  rendered.reverse();
  return [CONVERSATION_BLOCK_HEADER, ...rendered, CONVERSATION_BLOCK_FOOTER].join('\n');
}
