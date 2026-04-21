import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import {
  isKnownAgentToolName,
  parseKnownAgentToolAttemptInputWithRepair,
  parseUnknownAgentToolAttemptInput,
  type AgentToolAttempt,
} from './agent-tool-attempt-schema.js';

const log = bootstrapLogger.child({ component: 'AgentLlmOutput' });
const LOG_PREVIEW_CHARS = 200;
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Parsed LLM output — either a tool call, a parallel batch, or a final answer.
 *
 * `action` / `actions` carry the discriminated `AgentToolAttempt` type so that
 * known tools' input shape is typed from parse through execution and
 * serialization.  Unknown tools use the `UnknownAgentToolAttempt` variant
 * (open `Record<string, unknown>` input) for recovery semantics.
 */
export interface LlmAction {
  readonly thought: string;
  readonly action?: AgentToolAttempt;
  readonly actions?: readonly AgentToolAttempt[];
  readonly answer?: string;
  readonly plannerDefect?: PlannerDefect;
}

export interface PlannerDefect {
  readonly code:
    | 'mixed_answer_and_tool'
    | 'invalid_tool_input'
    | 'json_without_action_or_answer';
  readonly observation: string;
  readonly rawText: string;
}

export interface LlmResult {
  readonly text: string;
  readonly model: string;
  readonly finishReason?: string | null;
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function isValidLlmResult(value: unknown): value is LlmResult {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec['text'] === 'string' && typeof rec['model'] === 'string';
}

function cleanLlmJsonText(text: string): string {
  return text
    .trim()
    .replace(/^```[\w-]*\s*\n?/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractFirstJsonObject(text: string): string {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) return text.slice(start, i + 1);
    }
  }
  return text;
}

function extractFirstParsableJsonObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed: unknown = JSON.parse(candidate);
          if (typeof parsed === 'object' && parsed !== null) {
            return candidate;
          }
        } catch (err) {
          void err;
          // Continue scanning so concatenated/truncated later payloads do not
          // poison an otherwise valid earlier JSON object boundary.
        }
      }
    }
  }

  return null;
}

export function parseLlmJsonObject(text: string): Record<string, unknown> | null {
  try {
    const cleaned = cleanLlmJsonText(text);
    const firstObject = extractFirstParsableJsonObject(cleaned) ?? extractFirstJsonObject(cleaned);
    const rawParsed: unknown = JSON.parse(firstObject);
    return typeof rawParsed === 'object' && rawParsed !== null
      ? rawParsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function isLikelyJsonAttempt(text: string): boolean {
  const cleaned = cleanLlmJsonText(text);
  return cleaned.startsWith('{') || cleaned.startsWith('[');
}

interface ToolCallCandidateParseResult {
  readonly attempt: AgentToolAttempt | null;
  readonly plannerDefect?: PlannerDefect | undefined;
}

function buildInvalidToolInputObservation(
  tool: string,
  issues: readonly string[],
  removedUnknownKeys: readonly string[],
): string {
  const issueText = issues.length > 0 ? issues.join('; ') : 'unknown validation error';
  const repairedUnknownKeys = removedUnknownKeys.length > 0
    ? ` Removed unsupported keys: ${removedUnknownKeys.join(', ')}.`
    : '';
  return `Planner output invalid for ${tool}: ${issueText}.${repairedUnknownKeys} Re-emit a valid JSON tool call using only the allowed schema fields.`;
}

function parseToolCallCandidate(candidate: Record<string, unknown>): ToolCallCandidateParseResult {
  const tool = typeof candidate['tool'] === 'string' ? candidate['tool'] : '';
  if (tool.length === 0) {
    return { attempt: null };
  }

  if (isKnownAgentToolName(tool)) {
    const parsed = parseKnownAgentToolAttemptInputWithRepair(tool, candidate['input']);
    if (parsed.attempt !== null) {
      if (parsed.repair !== undefined) {
        log.info(
          { tool, removedUnknownKeys: parsed.repair.removedUnknownKeys },
          'agent LLM tool input repaired by dropping unknown schema fields',
        );
      }
      return { attempt: parsed.attempt };
    }
    return {
      attempt: null,
      plannerDefect: {
        code: 'invalid_tool_input',
        observation: buildInvalidToolInputObservation(
          tool,
          parsed.issues.map((issue) => issue.message),
          parsed.repair?.removedUnknownKeys ?? [],
        ),
        rawText: JSON.stringify(candidate),
      },
    };
  }

  if (typeof candidate['input'] !== 'undefined') {
    const unknownInput = parseUnknownAgentToolAttemptInput(candidate['input']);
    return { attempt: { tool, input: unknownInput } };
  }

  return { attempt: { tool, input: {} } };
}

export function parseLlmOutput(text: string): LlmAction {
  try {
    const trimmed = text.trim();
    const parsed = parseLlmJsonObject(text);
    if (parsed === null) {
      log.warn(
        { textPreview: text.slice(0, LOG_PREVIEW_CHARS) },
        'agent LLM produced non-JSON output; falling back to raw text',
      );
      return { thought: '[unparseable LLM output]', answer: trimmed };
    }
    const thought = typeof parsed['thought'] === 'string' ? parsed['thought'] : '';
    const hasAnswer = typeof parsed['answer'] === 'string';
    const hasActionObject = typeof parsed['action'] === 'object' && parsed['action'] !== null && !Array.isArray(parsed['action']);
    const hasActionsArray = Array.isArray(parsed['actions']) && parsed['actions'].length > 0;
    const hasBareTool = typeof parsed['tool'] === 'string' && parsed['tool'].length > 0;

    if (hasAnswer && (hasActionObject || hasActionsArray || hasBareTool)) {
      log.warn(
        { textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
        'agent LLM produced mixed answer+tool JSON; routing to planner defect recovery',
      );
      return {
        thought,
        plannerDefect: {
          code: 'mixed_answer_and_tool',
          observation: 'Planner output mixed a final answer with tool instructions. Re-emit exactly one JSON shape: either {"thought":"...","answer":"..."} or {"thought":"...","action":{...}}.',
          rawText: trimmed,
        },
      };
    }

    if (hasAnswer) {
      return { thought, answer: parsed['answer'] as string };
    }

    const actionsRaw = parsed['actions'];
    if (Array.isArray(actionsRaw) && actionsRaw.length > 0) {
      const parsedActions = (actionsRaw as unknown[])
        .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
        .map(parseToolCallCandidate)
      const validActions = parsedActions
        .map((entry) => entry.attempt)
        .filter((a): a is NonNullable<typeof a> => a !== null);
      if (validActions.length > 0) {
        return { thought, actions: validActions };
      }
      const plannerDefect = parsedActions.find((entry) => entry.plannerDefect !== undefined)?.plannerDefect;
      if (plannerDefect !== undefined) {
        return { thought, plannerDefect };
      }
    }

    const rawAction = parsed['action'];
    const action =
      typeof rawAction === 'object' && rawAction !== null && !Array.isArray(rawAction)
        ? (rawAction as Record<string, unknown>)
        : undefined;
    if (action !== undefined) {
      const parsedAction = parseToolCallCandidate(action);
      if (parsedAction.attempt !== null) {
        return { thought, action: parsedAction.attempt };
      }
      if (parsedAction.plannerDefect !== undefined) {
        return { thought, plannerDefect: parsedAction.plannerDefect };
      }
    }

    if (typeof parsed['tool'] === 'string' && parsed['tool'].length > 0) {
      const bareAction = parseToolCallCandidate(parsed);
      if (bareAction.attempt === null) {
        log.warn(
          { tool: parsed['tool'], textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
          'agent LLM emitted invalid bare tool input; routing to planner defect recovery',
        );
        return {
          thought,
          plannerDefect: bareAction.plannerDefect ?? {
            code: 'invalid_tool_input',
            observation: 'Planner emitted a bare tool call with invalid input. Re-emit a valid wrapped JSON action object.',
            rawText: trimmed,
          },
        };
      }
      log.warn(
        { tool: parsed['tool'], textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
        'agent LLM emitted bare tool call (missing action wrapper); recovered',
      );
      return { thought, action: bareAction.attempt };
    }

    log.warn(
      { textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
      'agent LLM produced JSON without action or answer; routing to planner defect recovery',
    );
    return {
      thought,
      plannerDefect: {
        code: 'json_without_action_or_answer',
        observation: 'Planner output JSON without a usable answer or tool call. Re-emit a valid final answer JSON or a valid tool action JSON.',
        rawText: trimmed,
      },
    };
  } catch {
    log.warn(
      { textPreview: text.slice(0, LOG_PREVIEW_CHARS) },
      'agent LLM produced non-JSON output; falling back to raw text',
    );
    return { thought: '[unparseable LLM output]', answer: text.trim() };
  }
}
