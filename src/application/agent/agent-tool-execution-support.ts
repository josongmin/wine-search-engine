import type { AgentToolCallPair } from '../../domain/agent/model/agent-step.js';
import type { DomainError } from '../../domain/shared/error/domain-error.js';
import { PolicyBlockedError } from '../../domain/shared/error/policy-blocked.js';
import type { ExpectedOutputSchema, ToolOutcome, ToolOutcomeKind } from '../../domain/agent/model/tool-outcome.js';
import { isAgentToolName } from '../../domain/agent/model/tool-outcome.js';

const DEFAULT_TOOL_TIMEOUT_MS = 8_000;
const DEFAULT_SEARCH_TOOL_TIMEOUT_MS = 18_000;
const DEFAULT_PARALLEL_BATCH_TIMEOUT_MS = 20_000;
export const MAX_TOOLS_PER_BATCH = 4;

function classifyToolOutcomeKind(
  observation: string,
  rawResult: unknown,
  execError: boolean,
  timedOut: boolean,
  policyBlocked: boolean,
): ToolOutcomeKind {
  if (timedOut) return 'timeout';
  if (policyBlocked) return 'policy_violation';
  if (execError) return 'tool_error';
  if (
    observation.startsWith('NO_MATCH:') ||
    observation.includes('0개') ||
    observation.includes('검색 결과가 없습니다')
  ) return 'empty_result';
  if (rawResult != null) return 'success';
  return 'tool_error';
}

function buildToolOutcomeStepId(
  requestId: string,
  stepIndex: number,
  toolPosition: number,
): string {
  return `${requestId}:${stepIndex}:${toolPosition}`;
}

function getExpectedOutputSchema(tool: string): ExpectedOutputSchema | undefined {
  if (tool === 'search_wines' || tool === 'get_food_pairings') {
    return {
      minResults: 1,
      requiredFields: ['entity.entityId', 'entity.canonicalLabel'],
    };
  }
  if (tool === 'compare_wines') {
    return {
      minResults: 2,
      requiredFields: ['topResult.entity.entityId', 'topResult.entity.canonicalLabel'],
    };
  }
  if (tool === 'check_drinking_window') {
    return {
      requiredFields: ['drinkingWindowStart', 'drinkingWindowEnd', 'currentlyDrinkable'],
    };
  }
  return undefined;
}

function getComparableResultItems(tool: string, rawResult: unknown): readonly unknown[] | undefined {
  if (typeof rawResult !== 'object' || rawResult === null) {
    return undefined;
  }
  const record = rawResult as Record<string, unknown>;
  if (
    (tool === 'search_wines' || tool === 'get_food_pairings') &&
    record['queryType'] === 'search' &&
    Array.isArray(record['results'])
  ) {
    return record['results'] as unknown[];
  }
  if (tool === 'compare_wines' && record['queryType'] === 'comparison' && Array.isArray(record['entities'])) {
    return record['entities']
      .filter((entity): entity is Record<string, unknown> => typeof entity === 'object' && entity !== null)
      .filter((entity) => entity['topResult'] !== null);
  }
  if (tool === 'check_drinking_window') {
    return [record];
  }
  return undefined;
}

function getValueAtPath(input: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = input;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validateToolPostconditions(tool: string, rawResult: unknown): readonly string[] {
  const expected = getExpectedOutputSchema(tool);
  const items = getComparableResultItems(tool, rawResult);
  if (expected === undefined || items === undefined) {
    return [];
  }

  const violations: string[] = [];
  if (expected.minResults !== undefined && items.length < expected.minResults) {
    violations.push(`minResults: expected >=${expected.minResults}, got ${items.length}`);
  }
  for (const field of expected.requiredFields ?? []) {
    if (items.some((item) => getValueAtPath(item, field) == null)) {
      violations.push(`requiredFields: missing ${field}`);
    }
  }
  return violations;
}

export function buildToolOutcome(
  requestId: string,
  stepIndex: number,
  toolPosition: number,
  tool: string,
  observation: string,
  rawResult: unknown,
  durationMs: number,
  execError: boolean,
  timedOut: boolean,
  policyViolation: boolean,
): ToolOutcome {
  const baseKind = classifyToolOutcomeKind(
    observation,
    rawResult,
    execError,
    timedOut,
    policyViolation,
  );
  const postconditionViolations =
    baseKind === 'success' && isAgentToolName(tool)
      ? validateToolPostconditions(tool, rawResult)
      : [];
  const kind =
    baseKind === 'success' && postconditionViolations.length > 0
      ? 'partial_result'
      : baseKind;
  return {
    stepId: buildToolOutcomeStepId(requestId, stepIndex, toolPosition),
    tool: isAgentToolName(tool) ? tool : tool,
    kind,
    ...(rawResult != null ? { result: rawResult } : {}),
    ...((kind === 'tool_error' || kind === 'timeout' || kind === 'policy_violation')
      ? { errorMessage: observation }
      : {}),
    ...(postconditionViolations.length > 0 ? { postconditionViolations } : {}),
    durationMs,
  };
}

export function formatPolicyBlockedObservation(err: DomainError): string {
  if (err instanceof PolicyBlockedError && err.rejection !== undefined) {
    const { layer, reason } = err.rejection;
    if (layer !== undefined || reason !== undefined) {
      return `Policy blocked: ${err.message} [${layer ?? 'UNKNOWN_LAYER'}:${reason ?? 'UNKNOWN_REASON'}]`;
    }
  }
  return `Policy blocked: ${err.message}`;
}

export interface TimeoutErrorLike extends Error {
  readonly code?: string;
}

function makeTimeoutError(message: string): TimeoutErrorLike {
  return Object.assign(new Error(message), { code: 'TIMEOUT' });
}

export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(makeTimeoutError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export function getToolTimeoutMs(
  tool: string,
  configuredTimeoutMs?: number,
): number {
  if (configuredTimeoutMs !== undefined) {
    return configuredTimeoutMs;
  }
  return tool === 'search_wines'
    ? DEFAULT_SEARCH_TOOL_TIMEOUT_MS
    : DEFAULT_TOOL_TIMEOUT_MS;
}

export function getParallelBatchTimeoutMs(
  tools: readonly { readonly tool: string }[],
  configuredTimeoutMs?: number,
): number {
  if (configuredTimeoutMs !== undefined) {
    return configuredTimeoutMs;
  }
  if (tools.some((tool) => tool.tool === 'search_wines')) {
    return DEFAULT_PARALLEL_BATCH_TIMEOUT_MS;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

export function buildObservationPairs(
  calls: readonly { readonly tool: string; readonly input: Record<string, unknown> }[],
  observation: string,
): { readonly actionPairs: AgentToolCallPair[]; readonly observations: string[] } {
  return {
    actionPairs: calls.map((action) => ({ action, observation })),
    observations: calls.map(() => observation),
  };
}
