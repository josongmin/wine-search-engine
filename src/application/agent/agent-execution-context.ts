import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import { StepBudget } from '../../domain/agent/service/step-budget.js';
import { classifyQueryBudget } from '../../domain/agent/service/adaptive-budget.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import {
  createAgentExecutionState,
  type AgentExecutionState,
} from './agent-execution-state.js';
import {
  buildAgentQueryExecutionContract,
  type AgentQueryExecutionContract,
} from './agent-query-execution-contract.js';

const log = bootstrapLogger.child({ component: 'AgentExecutionContext' });

interface AgentRequestAdmissionDeps {
  readonly querySanitizer?: QuerySanitizer | undefined;
}

interface AgentRequestAdmissionInput {
  readonly query: string;
  readonly requestId: string;
}

interface AgentExecutionContextInput {
  readonly query: string;
  readonly requestId: string;
  readonly baseConfig: AgentConfig;
  readonly overrides?: Partial<Pick<AgentConfig, 'maxSteps' | 'perStepTimeoutMs' | 'agentTimeoutMs'>> | undefined;
}

interface AgentExecutionContext {
  readonly effectiveConfig: AgentConfig;
  readonly queryExecutionContract: AgentQueryExecutionContract;
  readonly budget: StepBudget;
  readonly state: AgentExecutionState;
}

function emptyQueryResult(): AgentResult {
  return {
    answer: '검색어를 입력해주세요. 어떤 와인을 찾고 계신가요?',
    steps: [],
    totalDurationMs: 0,
    totalTokens: { input: 0, output: 0 },
    toolCallCount: 0,
    fallbackApplied: false,
    terminationReason: 'answer',
  };
}

function blockedQueryResult(): AgentResult {
  return {
    answer: '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.',
    steps: [],
    totalDurationMs: 0,
    totalTokens: { input: 0, output: 0 },
    toolCallCount: 0,
    fallbackApplied: false,
    terminationReason: 'blocked',
  };
}

export function admitAgentRequest(
  input: AgentRequestAdmissionInput,
  deps: AgentRequestAdmissionDeps,
): AgentResult | null {
  const { query, requestId } = input;

  if (query.trim().length === 0) {
    return emptyQueryResult();
  }

  if (deps.querySanitizer === undefined) {
    return null;
  }

  const sanitizeResult = deps.querySanitizer.sanitize(query);
  if (sanitizeResult.safe) {
    return null;
  }

  log.info(
    { requestId, reason: (sanitizeResult as { readonly reason?: string }).reason },
    'Agent pre-check blocked query before LLM call',
  );
  return blockedQueryResult();
}

export function buildAgentExecutionContext(
  input: AgentExecutionContextInput,
): AgentExecutionContext {
  const { query, requestId, baseConfig, overrides } = input;
  const adaptive = overrides?.maxSteps === undefined ? classifyQueryBudget(query) : undefined;
  const effectiveConfig = {
    ...baseConfig,
    ...(adaptive !== undefined ? { maxSteps: adaptive.maxSteps } : {}),
    ...(overrides ?? {}),
  };

  if (adaptive !== undefined) {
    log.info(
      { requestId, classification: adaptive.classification, maxSteps: adaptive.maxSteps, reason: adaptive.reason },
      'adaptive step budget applied',
    );
  }

  return {
    effectiveConfig,
    queryExecutionContract: buildAgentQueryExecutionContract(query),
    budget: new StepBudget(effectiveConfig),
    state: createAgentExecutionState(),
  };
}
