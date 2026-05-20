import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgeOptions, InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { QueryEntrySecurityObserver } from '../../domain/security/port/security-observer.port.js';
import {
  PolicyBlockedError,
} from '../../domain/shared/error/policy-blocked.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';

type QueryEntrySecurityLayer = 'LAYER_1_BLOCKED' | 'LAYER_2_BLOCKED';

interface QueryEntrySecurityRejection {
  readonly layer: QueryEntrySecurityLayer;
  readonly reason: string;
}

interface QueryEntrySecurityResult {
  readonly sanitizedQuery: string;
  readonly rejection?: QueryEntrySecurityRejection | undefined;
}

export interface QueryEntrySecurityCheck {
  readonly sanitizedQuery: string;
  readonly layer1Rejection: QueryEntrySecurityRejection | undefined;
  readonly layer2Result: Promise<QueryEntrySecurityResult>;
}

interface QueryEntrySecurityDeps {
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly judgeTimeoutMs?: number | undefined;
  readonly observer?: QueryEntrySecurityObserver | undefined;
}

type QueryEntrySecurityOptions = InjectionJudgeOptions;

function createPolicyBlockedDomainError(
  rejection?: QueryEntrySecurityRejection,
): PolicyBlockedError {
  return new PolicyBlockedError(undefined, rejection);
}

function evaluateQueryEntrySecurityLayer1(
  query: string,
  deps: QueryEntrySecurityDeps,
): QueryEntrySecurityResult {
  const sanitizationResult = deps.querySanitizer.sanitize(query);
  if (!sanitizationResult.safe) {
    deps.observer?.onLayer1Blocked(sanitizationResult.reason);
    return {
      sanitizedQuery: '',
      rejection: {
        layer: 'LAYER_1_BLOCKED',
        reason: sanitizationResult.reason,
      },
    };
  }

  return { sanitizedQuery: sanitizationResult.sanitizedQuery };
}

async function evaluateQueryEntrySecurityLayer2(
  sanitizedQuery: string,
  deps: QueryEntrySecurityDeps,
  options?: QueryEntrySecurityOptions,
): Promise<QueryEntrySecurityResult> {
  const judge = deps.injectionJudge;
  const judgeFailureMode = deps.judgeFailureMode ?? 'fail_closed';
  if (judge === undefined) {
    return { sanitizedQuery };
  }

  if (deps.judgeTimeoutMs === undefined) {
    throw new Error(
      'QueryEntrySecurityGate requires judgeTimeoutMs when injectionJudge is configured',
    );
  }

  const judgeTimeoutMs = deps.judgeTimeoutMs;
  const judgeAbortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const judgeAbortSignal =
    options?.abortSignal !== undefined
      ? AbortSignal.any([options.abortSignal, judgeAbortController.signal])
      : judgeAbortController.signal;

  try {
    const isInjection = await Promise.race([
      judge.judge(sanitizedQuery, { abortSignal: judgeAbortSignal }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          judgeAbortController.abort();
          reject(new Error('injection_judge_timeout'));
        }, judgeTimeoutMs);
      }),
    ]);
    if (isInjection) {
      deps.observer?.onLayer2Blocked('LLM_JUDGE_REJECTION');
      return {
        sanitizedQuery,
        rejection: {
          layer: 'LAYER_2_BLOCKED',
          reason: 'LLM_JUDGE_REJECTION',
        },
      };
    }
  } catch (err) {
    if (isAbortError(err) && options?.abortSignal?.aborted === true) {
      throw err;
    }

    const isTimeout = err instanceof Error && err.message === 'injection_judge_timeout';
    bootstrapLogger.warn(
      {
        err,
        judgeFailureMode,
        ...(isTimeout ? { timeout_ms: judgeTimeoutMs } : {}),
      },
      isTimeout
        ? '[QueryEntrySecurity] LLM judge timed out'
        : '[QueryEntrySecurity] LLM judge error',
    );
    deps.observer?.onJudgeError(err, judgeFailureMode);
    if (judgeFailureMode === 'fail_closed') {
      deps.observer?.onFailClosedBlock();
      return {
        sanitizedQuery,
        rejection: {
          layer: 'LAYER_2_BLOCKED',
          reason: isTimeout ? 'LLM_JUDGE_TIMEOUT_FAIL_CLOSED' : 'LLM_JUDGE_ERROR_FAIL_CLOSED',
        },
      };
    }
    deps.observer?.onFailOpenBypass();
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  return { sanitizedQuery };
}

export class QueryEntrySecurityGate {
  constructor(private readonly deps: QueryEntrySecurityDeps) {}

  startQuerySecurityCheck(
    query: string,
    options?: QueryEntrySecurityOptions,
  ): QueryEntrySecurityCheck {
    const layer1Result = evaluateQueryEntrySecurityLayer1(query, this.deps);
    if (layer1Result.rejection !== undefined) {
      return {
        sanitizedQuery: layer1Result.sanitizedQuery,
        layer1Rejection: layer1Result.rejection,
        layer2Result: Promise.resolve(layer1Result),
      };
    }

    return {
      sanitizedQuery: layer1Result.sanitizedQuery,
      layer1Rejection: undefined,
      layer2Result: evaluateQueryEntrySecurityLayer2(layer1Result.sanitizedQuery, this.deps, options),
    };
  }

  async getSafeQueryOrThrow(
    query: string,
    options?: QueryEntrySecurityOptions,
  ): Promise<string> {
    const check = this.startQuerySecurityCheck(query, options);
    if (check.layer1Rejection !== undefined) {
      throw createPolicyBlockedDomainError(check.layer1Rejection);
    }

    const result = await check.layer2Result;
    if (result.rejection !== undefined) {
      throw createPolicyBlockedDomainError(result.rejection);
    }

    return result.sanitizedQuery;
  }

  async getSafeQueryOrThrowFromSanitizedQuery(
    sanitizedQuery: string,
    options?: QueryEntrySecurityOptions,
  ): Promise<string> {
    const result = await evaluateQueryEntrySecurityLayer2(sanitizedQuery, this.deps, options);
    if (result.rejection !== undefined) {
      throw createPolicyBlockedDomainError(result.rejection);
    }

    return result.sanitizedQuery;
  }
}
