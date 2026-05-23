/**
 * Step-transcript serializer.
 *
 * Single responsibility: render the agent's prior {@link AgentStep}s into the
 * `assistant`/`user` `ChatMessage` transcript the planner LLM sees on
 * continuation steps, applying observation compaction to older steps. Split out
 * of agent-prompt.ts (system-prompt authoring) so transcript-format changes are
 * isolated from prompt-wording changes.
 */
import type { ChatMessage } from '../../domain/ai/port/chat-llm.port.js';
import type { AgentStep } from '../../domain/agent/model/agent-step.js';

/** How many of the most recent steps keep their FULL observation text. */
const FULL_OBSERVATION_HISTORY_STEPS = 1;
/** Older steps' observations are compacted to this many chars. */
const COMPACT_HISTORY_OBSERVATION_MAX_CHARS = 320;
/** Characters reserved for the truncation suffix string `\n... [truncated]`. */
const TRUNCATION_SUFFIX_LEN = 20;

export function buildStepMessages(steps: readonly AgentStep[]): readonly ChatMessage[] {
  const messages: ChatMessage[] = [];
  const fullObservationStartIndex = Math.max(0, steps.length - FULL_OBSERVATION_HISTORY_STEPS);
  const renderObservation = (observation: string, stepIndex: number): string =>
    stepIndex >= fullObservationStartIndex
      ? observation
      : truncateObservation(observation, COMPACT_HISTORY_OBSERVATION_MAX_CHARS);

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]!;
    if (step.actionPairs !== undefined) {
      // Parallel batch step (preferred path) — uses paired type to guarantee
      // 1:1 action↔observation alignment; no index drift possible.
      messages.push({
        role: 'assistant',
        content: JSON.stringify({
          thought: step.thought,
          actions: step.actionPairs.map((p) => ({ tool: p.action.tool, input: p.action.input })),
        }),
      });
      for (const pair of step.actionPairs) {
        messages.push({
          role: 'user',
          content: `[Tool Result: ${pair.action.tool}]\n${renderObservation(pair.observation, stepIndex)}`,
        });
      }
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy path: actions/observations kept for backward-compat when actionPairs is absent
    } else if (step.actions !== undefined) {
      // Parallel batch step (legacy path — no actionPairs, fall back to parallel arrays).
      messages.push({
        role: 'assistant',
        content: JSON.stringify({
          thought: step.thought,
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          actions: step.actions.map((a) => ({ tool: a.tool, input: a.input })),
        }),
      });
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const observations = step.observations ?? [];
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      for (let i = 0; i < step.actions.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        const toolName = step.actions[i]?.tool ?? `tool_${i}`;
        const obs = observations[i] ?? '(no result)';
        messages.push({
          role: 'user',
          content: `[Tool Result: ${toolName}]\n${renderObservation(obs, stepIndex)}`,
        });
      }
    } else if (step.action !== undefined) {
      // Sequential single tool call
      messages.push({
        role: 'assistant',
        content: JSON.stringify({
          thought: step.thought,
          action: { tool: step.action.tool, input: step.action.input },
        }),
      });
      if (step.observation !== undefined) {
        messages.push({
          role: 'user',
          content: `[Tool Result]\n${renderObservation(step.observation, stepIndex)}`,
        });
      }
    } else if (step.answer !== undefined) {
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ thought: step.thought, answer: step.answer }),
      });
    }
  }

  return messages;
}

/**
 * Truncates observation text to fit within context budget.
 */
export function truncateObservation(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // When maxChars >= TRUNCATION_SUFFIX_LEN: cutAt = maxChars - suffix → output
  // is exactly maxChars chars (postcondition satisfied).
  // When maxChars < TRUNCATION_SUFFIX_LEN: the suffix alone would exceed maxChars,
  // so we return just the raw slice capped at maxChars (no suffix appended) —
  // the truncation is still visible because the text is shorter than the original.
  if (maxChars < TRUNCATION_SUFFIX_LEN) {
    return text.slice(0, maxChars);
  }
  const cutAt = maxChars - TRUNCATION_SUFFIX_LEN;
  return text.slice(0, cutAt) + '\n... [truncated]';
}
