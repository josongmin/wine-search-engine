import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import {
  isKnownAgentToolName,
  parseKnownAgentToolAttemptInput,
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

function parseToolCallCandidate(candidate: Record<string, unknown>): AgentToolAttempt | null {
  const tool = typeof candidate['tool'] === 'string' ? candidate['tool'] : '';
  if (tool.length === 0) {
    return null;
  }

  if (isKnownAgentToolName(tool)) {
    return parseKnownAgentToolAttemptInput(tool, candidate['input']);
  }

  if (typeof candidate['input'] !== 'undefined') {
    const unknownInput = parseUnknownAgentToolAttemptInput(candidate['input']);
    return { tool, input: unknownInput };
  }

  return { tool, input: {} };
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
        'agent LLM produced mixed answer+tool JSON; failing closed to prevent ambiguous execution',
      );
      return { thought: '[invalid mixed LLM output]', answer: trimmed };
    }

    if (hasAnswer) {
      return { thought, answer: parsed['answer'] as string };
    }

    const actionsRaw = parsed['actions'];
    if (Array.isArray(actionsRaw) && actionsRaw.length > 0) {
      const validActions = (actionsRaw as unknown[])
        .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
        .map(parseToolCallCandidate)
        .filter((a): a is NonNullable<typeof a> => a !== null);
      if (validActions.length > 0) {
        return { thought, actions: validActions };
      }
    }

    const rawAction = parsed['action'];
    const action =
      typeof rawAction === 'object' && rawAction !== null && !Array.isArray(rawAction)
        ? (rawAction as Record<string, unknown>)
        : undefined;
    if (action !== undefined) {
      const parsedAction = parseToolCallCandidate(action);
      if (parsedAction !== null) {
        return { thought, action: parsedAction };
      }
    }

    if (typeof parsed['tool'] === 'string' && parsed['tool'].length > 0) {
      const bareAction = parseToolCallCandidate(parsed);
      if (bareAction === null) {
        log.warn(
          { tool: parsed['tool'], textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
          'agent LLM emitted invalid bare tool input; failing closed',
        );
        return { thought: '[unparseable LLM structure]', answer: trimmed };
      }
      log.warn(
        { tool: parsed['tool'], textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
        'agent LLM emitted bare tool call (missing action wrapper); recovered',
      );
      return { thought, action: bareAction };
    }

    log.warn(
      { textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
      'agent LLM produced JSON without action or answer; falling back to raw text',
    );
    return { thought: '[unparseable LLM structure]', answer: trimmed };
  } catch {
    log.warn(
      { textPreview: text.slice(0, LOG_PREVIEW_CHARS) },
      'agent LLM produced non-JSON output; falling back to raw text',
    );
    return { thought: '[unparseable LLM output]', answer: text.trim() };
  }
}
