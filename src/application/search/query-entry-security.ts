import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { QueryEntrySecurityObserver } from '../../domain/security/port/security-observer.port.js';
import {
  PolicyBlockedError,
} from '../../domain/shared/error/policy-blocked.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

type QueryEntrySecurityLayer = 'LAYER_1_BLOCKED' | 'LAYER_2_BLOCKED';

interface QueryEntrySecurityRejection {
  readonly layer: QueryEntrySecurityLayer;
  readonly reason: string;
}

interface QueryEntrySecurityResult {
  readonly sanitizedQuery: string;
  readonly rejection?: QueryEntrySecurityRejection | undefined;
}

interface QueryEntrySecurityDeps {
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly observer?: QueryEntrySecurityObserver | undefined;
}

function createPolicyBlockedDomainError(
  rejection?: QueryEntrySecurityRejection,
): PolicyBlockedError {
  return new PolicyBlockedError(undefined, rejection);
}

async function evaluateQueryEntrySecurity(
  query: string,
  deps: QueryEntrySecurityDeps,
): Promise<QueryEntrySecurityResult> {
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

  const sanitizedQuery = sanitizationResult.sanitizedQuery;
  const judge = deps.injectionJudge;
  const judgeFailureMode = deps.judgeFailureMode ?? 'fail_closed';
  if (judge !== undefined) {
    const JUDGE_TIMEOUT_MS = 5_000;
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const isInjection = await Promise.race([
        judge.judge(sanitizedQuery, { abortSignal: abortController.signal }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            abortController.abort();
            reject(new Error('injection_judge_timeout'));
          }, JUDGE_TIMEOUT_MS);
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
      const isTimeout = err instanceof Error && err.message === 'injection_judge_timeout';
      bootstrapLogger.warn(
        {
          err,
          judgeFailureMode,
          ...(isTimeout ? { timeout_ms: JUDGE_TIMEOUT_MS } : {}),
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
  }

  return { sanitizedQuery };
}

export class QueryEntrySecurityGate {
  constructor(private readonly deps: QueryEntrySecurityDeps) {}

  async getSafeQueryOrThrow(query: string): Promise<string> {
    const result = await evaluateQueryEntrySecurity(query, this.deps);
    if (result.rejection !== undefined) {
      throw createPolicyBlockedDomainError(result.rejection);
    }

    return result.sanitizedQuery;
  }
}
