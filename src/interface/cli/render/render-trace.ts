/**
 * Renders the agent's ReAct step trace for `--verbose` / `/trace`. Shows each
 * step's thought, the tool action(s) it took, and a clipped observation.
 *
 * Handles both step shapes: legacy single `action`/`observation` and the
 * parallel-batch `actionPairs` (falls back to deprecated `actions`/
 * `observations` only when `actionPairs` is absent — migration pattern).
 */
import type { AgentResult } from '../../../domain/agent/model/agent-result.js';
import type { AgentStep, AgentToolCall } from '../../../domain/agent/model/agent-step.js';
import { color } from './colors.js';

const OBSERVATION_CLIP_CHARS = 500;
const ELLIPSIS = '…';

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - ELLIPSIS.length)) + ELLIPSIS;
}

function renderAction(action: AgentToolCall): string {
  return `${color.magenta(action.tool)}(${JSON.stringify(action.input)})`;
}

function renderStep(step: AgentStep): string {
  const lines: string[] = [];
  lines.push(color.bold(color.blue(`── step ${step.index} ──`)));

  if (step.thought.trim().length > 0) {
    lines.push(color.dim('💭 ') + step.thought.trim());
  }

  // Parallel batch (preferred) → fall back to deprecated parallel arrays.
  if (step.actionPairs !== undefined && step.actionPairs.length > 0) {
    for (const pair of step.actionPairs) {
      lines.push('🔧 ' + renderAction(pair.action));
      lines.push(color.gray('   → ' + clip(pair.observation, OBSERVATION_CLIP_CHARS)));
    }
  } else if (step.action !== undefined) {
    lines.push('🔧 ' + renderAction(step.action));
    if (step.observation !== undefined) {
      lines.push(color.gray('   → ' + clip(step.observation, OBSERVATION_CLIP_CHARS)));
    }
  }

  if (step.answer !== undefined) {
    lines.push(color.green('✓ ') + clip(step.answer.trim(), OBSERVATION_CLIP_CHARS));
  }

  const stepTokens = step.tokenCount.input + step.tokenCount.output;
  lines.push(color.gray(`   (${step.durationMs}ms · ${stepTokens} tok)`));
  return lines.join('\n');
}

export function renderTrace(result: AgentResult): string {
  if (result.steps.length === 0) {
    return color.gray('(no steps — agent answered without tool calls)');
  }
  return result.steps.map(renderStep).join('\n');
}
