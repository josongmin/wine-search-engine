/**
 * Renders an {@link AgentResult} into the terminal answer block + a one-line
 * meta footer. Pure string production — no I/O — so it is trivially testable
 * and the REPL loop owns all printing.
 */
import type { AgentResult } from '../../../domain/agent/model/agent-result.js';
import type { AgentTerminationReason } from '../../../domain/agent/model/agent-step.js';
import { color } from './colors.js';

/** Termination reasons that mean the run did NOT produce a clean answer. */
const DEGRADED_REASONS: ReadonlySet<AgentTerminationReason> = new Set([
  'max_steps',
  'timeout',
  'budget',
  'error',
  'loop_detected',
  'fallback',
  'blocked',
  'aborted',
]);

function reasonBadge(reason: AgentTerminationReason): string {
  if (reason === 'answer') return color.green('answer');
  if (reason === 'blocked' || reason === 'error') return color.red(reason);
  return color.yellow(reason);
}

export function renderAnswer(result: AgentResult): string {
  const lines: string[] = [];
  lines.push(color.bold(color.cyan('🍷 ')) + result.answer.trim());

  if (DEGRADED_REASONS.has(result.terminationReason)) {
    lines.push(
      color.yellow(`⚠ 완전한 답변이 아닐 수 있음 (termination=${result.terminationReason})`),
    );
  }

  const tokens = result.totalTokens.input + result.totalTokens.output;
  const meta =
    `${reasonBadge(result.terminationReason)} · ` +
    `${result.toolCallCount} tool calls · ` +
    `${result.steps.length} steps · ` +
    `${result.totalDurationMs}ms · ` +
    `${tokens} tok` +
    (result.fallbackApplied ? ' · ' + color.yellow('fallback') : '');
  lines.push(color.gray(meta));

  return lines.join('\n');
}
