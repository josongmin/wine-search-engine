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
  readonly plannerRepair?: PlannerRepair;
}

export interface PlannerToolCandidateIssue {
  readonly location: 'action' | 'actions' | 'bare_tool' | 'embedded_json';
  readonly index?: number | undefined;
  readonly tool?: string | undefined;
  readonly reason: 'invalid_tool_input' | 'missing_tool_name' | 'non_object_action';
  readonly rawCandidate: string;
  readonly issues?: readonly string[] | undefined;
  readonly removedUnknownKeys?: readonly string[] | undefined;
}

export interface PlannerToolCandidateRepair {
  readonly location: 'action' | 'actions' | 'bare_tool' | 'embedded_json';
  readonly index?: number | undefined;
  readonly tool: string;
  readonly removedUnknownKeys: readonly string[];
}

export interface PlannerRepair {
  readonly code:
    | 'tool_input_repaired'
    | 'partial_actions_batch'
    | 'embedded_tool_recovery';
  readonly observation: string;
  readonly rawText: string;
  readonly recoveredFrom: 'action' | 'actions' | 'bare_tool' | 'embedded_json' | 'thought_string';
  readonly repairedCandidates?: readonly PlannerToolCandidateRepair[] | undefined;
  readonly droppedCandidates?: readonly PlannerToolCandidateIssue[] | undefined;
}

export interface PlannerDefect {
  readonly code:
    | 'mixed_answer_and_tool'
    | 'invalid_tool_input'
    | 'json_without_action_or_answer'
    | 'malformed_json_output';
  readonly observation: string;
  readonly rawText: string;
  readonly recoveredAnswer?: string | undefined;
  readonly recoveredAction?: AgentToolAttempt | undefined;
  readonly recoveredActions?: readonly AgentToolAttempt[] | undefined;
  readonly candidateIssues?: readonly PlannerToolCandidateIssue[] | undefined;
  readonly repairedCandidates?: readonly PlannerToolCandidateRepair[] | undefined;
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

function extractBalancedJsonObjectAt(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

function extractParsableJsonObjectsFromAnyStart(text: string): readonly Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const candidate = extractBalancedJsonObjectAt(text, i);
    if (candidate === null) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch (err) {
      void err;
    }
  }
  return objects;
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
  readonly issue?: PlannerToolCandidateIssue | undefined;
  readonly repair?: PlannerToolCandidateRepair | undefined;
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

function parseToolCallCandidate(
  candidate: Record<string, unknown>,
  location: PlannerToolCandidateIssue['location'],
  index?: number,
): ToolCallCandidateParseResult {
  const tool = typeof candidate['tool'] === 'string' ? candidate['tool'] : '';
  if (tool.length === 0) {
    return {
      attempt: null,
      issue: {
        location,
        ...(index !== undefined ? { index } : {}),
        reason: 'missing_tool_name',
        rawCandidate: JSON.stringify(candidate),
      },
    };
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
      return {
        attempt: parsed.attempt,
        ...(parsed.repair !== undefined
          ? {
              repair: {
                location,
                ...(index !== undefined ? { index } : {}),
                tool,
                removedUnknownKeys: parsed.repair.removedUnknownKeys,
              },
            }
          : {}),
      };
    }
    return {
      attempt: null,
      issue: {
        location,
        ...(index !== undefined ? { index } : {}),
        tool,
        reason: 'invalid_tool_input',
        rawCandidate: JSON.stringify(candidate),
        issues: parsed.issues.map((issue) => issue.message),
        ...(parsed.repair?.removedUnknownKeys !== undefined
          ? { removedUnknownKeys: parsed.repair.removedUnknownKeys }
          : {}),
      },
    };
  }

  if (typeof candidate['input'] !== 'undefined') {
    const unknownInput = parseUnknownAgentToolAttemptInput(candidate['input']);
    return { attempt: { tool, input: unknownInput } };
  }

  return { attempt: { tool, input: {} } };
}

function buildInvalidToolInputDefect(
  rawText: string,
  issue: PlannerToolCandidateIssue,
): PlannerDefect {
  return {
    code: 'invalid_tool_input',
    observation: buildInvalidToolInputObservation(
      issue.tool ?? 'unknown_tool',
      issue.issues ?? [],
      issue.removedUnknownKeys ?? [],
    ),
    rawText,
    candidateIssues: [issue],
  };
}

function buildMalformedJsonPlannerDefect(rawText: string): PlannerDefect {
  return {
    code: 'malformed_json_output',
    observation: 'Planner output looked like JSON but could not be parsed. Re-emit exactly one valid JSON object with "thought" plus exactly one of "answer", "action", or "actions".',
    rawText,
  };
}

function extractLooseJsonStringField(text: string, field: string): string | undefined {
  const fieldPattern = new RegExp(`"${field}"\\s*:\\s*"`, 'u');
  const match = fieldPattern.exec(text);
  if (match?.index === undefined) {
    return undefined;
  }

  const start = match.index + match[0].length;
  let value = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) {
        value += ch;
        continue;
      }
      switch (next) {
        case 'n':
          value += '\n';
          break;
        case 'r':
          value += '\r';
          break;
        case 't':
          value += '\t';
          break;
        case '"':
        case '\\':
          value += next;
          break;
        default:
          value += next;
          break;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      const rest = text.slice(i + 1);
      if (/^\s*(?:,|\})/u.test(rest)) {
        return value;
      }
    }
    value += ch;
  }
  return undefined;
}

function recoverMalformedJsonAnswer(text: string): LlmAction | null {
  const answer = extractLooseJsonStringField(text, 'answer')?.trim();
  if (answer === undefined || answer.length === 0) {
    return null;
  }

  const hasActionSurface = /"(?:action|actions|tool)"\s*:/u.test(text);
  if (hasActionSurface) {
    return {
      thought: extractLooseJsonStringField(text, 'thought')?.trim() ?? 'malformed planner output',
      plannerDefect: {
        code: 'mixed_answer_and_tool',
        observation: 'Planner output mixed a final answer with tool instructions. Re-emit exactly one JSON shape: either {"thought":"...","answer":"..."} or {"thought":"...","action":{...}}.',
        rawText: text,
        recoveredAnswer: answer,
      },
    };
  }

  return {
    thought: extractLooseJsonStringField(text, 'thought')?.trim() ?? 'recovered malformed answer',
    answer,
  };
}

function summarizeRepairObservation(
  code: PlannerRepair['code'],
  validCount: number,
  repairedCandidates: readonly PlannerToolCandidateRepair[],
  droppedCandidates: readonly PlannerToolCandidateIssue[],
): string {
  switch (code) {
    case 'embedded_tool_recovery':
      return 'Recovered a valid embedded tool call from malformed planner JSON.';
    case 'partial_actions_batch':
      return `Recovered ${validCount} valid action(s) while dropping ${droppedCandidates.length} invalid batch item(s).`;
    case 'tool_input_repaired':
      return `Repaired tool input by dropping unsupported keys on ${repairedCandidates.length} candidate(s).`;
  }
}

interface ParsedActionBatchResult {
  readonly validActions: readonly AgentToolAttempt[];
  readonly droppedCandidates: readonly PlannerToolCandidateIssue[];
  readonly repairedCandidates: readonly PlannerToolCandidateRepair[];
}

function parseActionsBatch(
  actionsRaw: readonly unknown[],
): ParsedActionBatchResult {
  const parsedEntries = actionsRaw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return {
        attempt: null,
        issue: {
          location: 'actions' as const,
          index,
          reason: 'non_object_action' as const,
          rawCandidate: JSON.stringify(entry),
        },
      } satisfies ToolCallCandidateParseResult;
    }
    return parseToolCallCandidate(entry as Record<string, unknown>, 'actions', index);
  });

  return {
    validActions: parsedEntries
      .map((entry) => entry.attempt)
      .filter((attempt): attempt is AgentToolAttempt => attempt !== null),
    droppedCandidates: parsedEntries
      .map((entry) => entry.issue)
      .filter((issue): issue is PlannerToolCandidateIssue => issue !== undefined),
    repairedCandidates: parsedEntries
      .map((entry) => entry.repair)
      .filter((repair): repair is PlannerToolCandidateRepair => repair !== undefined),
  };
}

function recoverEmbeddedToolCall(
  text: string,
  source: PlannerRepair['recoveredFrom'] = 'embedded_json',
): LlmAction | null {
  const candidates = extractParsableJsonObjectsFromAnyStart(cleanLlmJsonText(text));
  let firstIssue: PlannerToolCandidateIssue | undefined;
  for (const candidate of candidates) {
    if (typeof candidate['tool'] !== 'string' || candidate['tool'].length === 0) {
      continue;
    }
    const parsed = parseToolCallCandidate(candidate, 'embedded_json');
    const thought = 'recovered embedded tool call';
    if (parsed.attempt !== null) {
      log.warn(
        { tool: parsed.attempt.tool },
        'agent LLM embedded a bare tool JSON object inside malformed output; recovered',
      );
      const repairedCandidates = parsed.repair !== undefined ? [parsed.repair] : [];
      return {
        thought,
        action: parsed.attempt,
        plannerRepair: {
          code: 'embedded_tool_recovery',
          observation: summarizeRepairObservation('embedded_tool_recovery', 1, repairedCandidates, []),
          rawText: text,
          recoveredFrom: source,
          ...(repairedCandidates.length > 0 ? { repairedCandidates } : {}),
        },
      };
    }
    if (parsed.issue !== undefined && firstIssue === undefined) {
      firstIssue = parsed.issue;
    }
  }
  if (firstIssue !== undefined) {
    return { thought: 'recovered embedded tool call', plannerDefect: buildInvalidToolInputDefect(text, firstIssue) };
  }
  return null;
}

function buildNonObjectActionIssue(
  location: PlannerToolCandidateIssue['location'],
  rawCandidate: unknown,
  index?: number,
): PlannerToolCandidateIssue {
  return {
    location,
    ...(index !== undefined ? { index } : {}),
    reason: 'non_object_action',
    rawCandidate: JSON.stringify(rawCandidate),
  };
}

export function parseLlmOutput(text: string): LlmAction {
  try {
    const trimmed = text.trim();
    const parsed = parseLlmJsonObject(text);
    if (parsed === null) {
      const recovered = recoverEmbeddedToolCall(text);
      if (recovered !== null) {
        return recovered;
      }
      if (isLikelyJsonAttempt(text)) {
        const recoveredAnswer = recoverMalformedJsonAnswer(trimmed);
        if (recoveredAnswer !== null) {
          return recoveredAnswer;
        }
        log.warn(
          { textPreview: text.slice(0, LOG_PREVIEW_CHARS) },
          'agent LLM produced JSON-like but unparseable output; routing to planner defect recovery',
        );
        return {
          thought: 'malformed planner output',
          plannerDefect: buildMalformedJsonPlannerDefect(trimmed),
        };
      }
      log.warn(
        { textPreview: text.slice(0, LOG_PREVIEW_CHARS) },
        'agent LLM produced non-JSON output; falling back to raw text',
      );
      return { thought: '[unparseable LLM output]', answer: trimmed };
    }
    const thought = typeof parsed['thought'] === 'string' ? parsed['thought'] : '';
    const hasAnswer = typeof parsed['answer'] === 'string';
    const hasActionKey = Object.prototype.hasOwnProperty.call(parsed, 'action');
    const hasActionsKey = Object.prototype.hasOwnProperty.call(parsed, 'actions');
    const hasBareToolKey = Object.prototype.hasOwnProperty.call(parsed, 'tool');
    const hasActionObject = typeof parsed['action'] === 'object' && parsed['action'] !== null && !Array.isArray(parsed['action']);
    const hasActionsArray = Array.isArray(parsed['actions']) && parsed['actions'].length > 0;
    const hasBareTool = typeof parsed['tool'] === 'string' && parsed['tool'].length > 0;

    if (hasAnswer && (hasActionKey || hasActionsKey || hasBareToolKey)) {
      const recoveredAction = actionFromRecord(parsed['action']);
      const recoveredActions = actionsFromRecord(parsed['actions']);
      const bareActionParse = typeof parsed['tool'] === 'string' && parsed['tool'].length > 0
        ? parseToolCallCandidate(parsed, 'bare_tool')
        : null;
      const chosenAction = recoveredAction?.attempt ?? bareActionParse?.attempt ?? undefined;
      const chosenActions = recoveredActions?.validActions;
      const malformedActionIssue =
        hasActionKey && recoveredAction === null
          ? buildNonObjectActionIssue('action', parsed['action'])
          : undefined;
      const malformedActionsIssue =
        hasActionsKey && recoveredActions === null
          ? buildNonObjectActionIssue('actions', parsed['actions'])
          : undefined;
      const malformedBareToolIssue =
        hasBareToolKey && bareActionParse === null
          ? {
              location: 'bare_tool' as const,
              reason: 'missing_tool_name' as const,
              rawCandidate: JSON.stringify(parsed['tool']),
            }
          : undefined;
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
          recoveredAnswer: parsed['answer'] as string,
          ...(chosenAction !== undefined ? { recoveredAction: chosenAction } : {}),
          ...(chosenActions !== undefined && chosenActions.length > 0 ? { recoveredActions: chosenActions } : {}),
          ...(recoveredAction?.issue !== undefined
            || malformedActionIssue !== undefined
            || malformedActionsIssue !== undefined
            || bareActionParse?.issue !== undefined
            || malformedBareToolIssue !== undefined
            || (recoveredActions?.droppedCandidates.length ?? 0) > 0
            ? {
                candidateIssues: [
                  ...(malformedActionIssue !== undefined ? [malformedActionIssue] : []),
                  ...(recoveredAction?.issue !== undefined ? [recoveredAction.issue] : []),
                  ...(malformedActionsIssue !== undefined ? [malformedActionsIssue] : []),
                  ...(bareActionParse?.issue !== undefined ? [bareActionParse.issue] : []),
                  ...(malformedBareToolIssue !== undefined ? [malformedBareToolIssue] : []),
                  ...(recoveredActions?.droppedCandidates ?? []),
                ],
              }
            : {}),
          ...(recoveredAction?.repair !== undefined
            || bareActionParse?.repair !== undefined
            || (recoveredActions?.repairedCandidates.length ?? 0) > 0
            ? {
                repairedCandidates: [
                  ...(recoveredAction?.repair !== undefined ? [recoveredAction.repair] : []),
                  ...(bareActionParse?.repair !== undefined ? [bareActionParse.repair] : []),
                  ...(recoveredActions?.repairedCandidates ?? []),
                ],
              }
            : {}),
        },
      };
    }

    if (hasAnswer) {
      return { thought, answer: parsed['answer'] as string };
    }

    const actionsRaw = parsed['actions'];
    if (Array.isArray(actionsRaw) && actionsRaw.length > 0) {
      const batch = parseActionsBatch(actionsRaw as unknown[]);
      if (batch.validActions.length > 0) {
        const repairCode: PlannerRepair['code'] =
          batch.droppedCandidates.length > 0 ? 'partial_actions_batch' : 'tool_input_repaired';
        return {
          thought,
          actions: batch.validActions,
          ...(
            batch.droppedCandidates.length > 0 || batch.repairedCandidates.length > 0
              ? {
                  plannerRepair: {
                    code: repairCode,
                    observation: summarizeRepairObservation(
                      repairCode,
                      batch.validActions.length,
                      batch.repairedCandidates,
                      batch.droppedCandidates,
                    ),
                    rawText: trimmed,
                    recoveredFrom: 'actions',
                    ...(batch.repairedCandidates.length > 0
                      ? { repairedCandidates: batch.repairedCandidates }
                      : {}),
                    ...(batch.droppedCandidates.length > 0
                      ? { droppedCandidates: batch.droppedCandidates }
                      : {}),
                  },
                }
              : {}
          ),
        };
      }
      if (batch.droppedCandidates.length > 0) {
        return {
          thought,
          plannerDefect: {
            code: 'invalid_tool_input',
            observation: buildInvalidToolInputObservation(
              batch.droppedCandidates[0]!.tool ?? 'unknown_tool',
              batch.droppedCandidates.flatMap((issue) => issue.issues ?? []),
              batch.droppedCandidates.flatMap((issue) => issue.removedUnknownKeys ?? []),
            ),
            rawText: trimmed,
            candidateIssues: batch.droppedCandidates,
          },
        };
      }
    }

    const rawAction = parsed['action'];
    const action =
      typeof rawAction === 'object' && rawAction !== null && !Array.isArray(rawAction)
        ? (rawAction as Record<string, unknown>)
        : undefined;
    if (action !== undefined) {
      const parsedAction = parseToolCallCandidate(action, 'action');
      if (parsedAction.attempt !== null) {
        return {
          thought,
          action: parsedAction.attempt,
          ...(parsedAction.repair !== undefined
            ? {
                plannerRepair: {
                  code: 'tool_input_repaired',
                  observation: summarizeRepairObservation('tool_input_repaired', 1, [parsedAction.repair], []),
                  rawText: trimmed,
                  recoveredFrom: 'action',
                  repairedCandidates: [parsedAction.repair],
                },
              }
            : {}),
        };
      }
      if (parsedAction.issue !== undefined) {
        return { thought, plannerDefect: buildInvalidToolInputDefect(trimmed, parsedAction.issue) };
      }
    }

    if (typeof parsed['tool'] === 'string' && parsed['tool'].length > 0) {
      const bareAction = parseToolCallCandidate(parsed, 'bare_tool');
      if (bareAction.attempt === null) {
        log.warn(
          { tool: parsed['tool'], textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
          'agent LLM emitted invalid bare tool input; routing to planner defect recovery',
        );
        return {
          thought,
          plannerDefect: bareAction.issue !== undefined
            ? buildInvalidToolInputDefect(trimmed, bareAction.issue)
            : {
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
      return {
        thought,
        action: bareAction.attempt,
        plannerRepair: {
          code: bareAction.repair !== undefined ? 'tool_input_repaired' : 'embedded_tool_recovery',
          observation: bareAction.repair !== undefined
            ? summarizeRepairObservation('tool_input_repaired', 1, [bareAction.repair], [])
            : 'Recovered a bare tool call that omitted the action wrapper.',
          rawText: trimmed,
          recoveredFrom: 'bare_tool',
          ...(bareAction.repair !== undefined ? { repairedCandidates: [bareAction.repair] } : {}),
        },
      };
    }

    const embeddedThoughtToolCall = recoverEmbeddedToolCall(thought, 'thought_string');
    if (
      embeddedThoughtToolCall !== null
      && !hasAnswer
      && !hasActionObject
      && !hasActionsArray
      && !hasBareTool
    ) {
      return embeddedThoughtToolCall;
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
    if (isLikelyJsonAttempt(text)) {
      log.warn(
        { textPreview: text.slice(0, LOG_PREVIEW_CHARS) },
        'agent LLM threw while parsing JSON-like output; routing to planner defect recovery',
      );
      return {
        thought: 'malformed planner output',
        plannerDefect: buildMalformedJsonPlannerDefect(text.trim()),
      };
    }
    log.warn(
      { textPreview: text.slice(0, LOG_PREVIEW_CHARS) },
      'agent LLM produced non-JSON output; falling back to raw text',
    );
    return { thought: '[unparseable LLM output]', answer: text.trim() };
  }
}

function actionFromRecord(
  rawAction: unknown,
): {
  readonly attempt: AgentToolAttempt | null;
  readonly issue?: PlannerToolCandidateIssue | undefined;
  readonly repair?: PlannerToolCandidateRepair | undefined;
} | null {
  if (typeof rawAction !== 'object' || rawAction === null || Array.isArray(rawAction)) {
    return null;
  }
  return parseToolCallCandidate(rawAction as Record<string, unknown>, 'action');
}

function actionsFromRecord(
  rawActions: unknown,
): ParsedActionBatchResult | null {
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    return null;
  }
  return parseActionsBatch(rawActions);
}
