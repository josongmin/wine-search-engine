import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import {
  PolicyBlockedError,
} from '../../domain/shared/error/policy-blocked.js';

export type QueryEntrySecurityLayer = 'LAYER_1_BLOCKED' | 'LAYER_2_BLOCKED';

export interface QueryEntrySecurityRejection {
  readonly layer: QueryEntrySecurityLayer;
  readonly reason: string;
}

export interface QueryEntrySecurityResult {
  readonly sanitizedQuery: string;
  readonly rejection?: QueryEntrySecurityRejection | undefined;
}

export interface QueryEntrySecurityDeps {
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: InjectionJudgePort | undefined;
}

export function createPolicyBlockedDomainError(): PolicyBlockedError {
  return new PolicyBlockedError();
}

export async function evaluateQueryEntrySecurity(
  query: string,
  deps: QueryEntrySecurityDeps,
): Promise<QueryEntrySecurityResult> {
  const sanitizationResult = deps.querySanitizer.sanitize(query);
  if (!sanitizationResult.safe) {
    return {
      sanitizedQuery: query.trim(),
      rejection: {
        layer: 'LAYER_1_BLOCKED',
        reason: sanitizationResult.reason,
      },
    };
  }

  const sanitizedQuery = sanitizationResult.sanitizedQuery;
  const judge = deps.injectionJudge;
  if (judge !== undefined) {
    try {
      const isInjection = await judge.judge(sanitizedQuery);
      if (isInjection) {
        return {
          sanitizedQuery,
          rejection: {
            layer: 'LAYER_2_BLOCKED',
            reason: 'LLM_JUDGE_REJECTION',
          },
        };
      }
    } catch (err) {
      console.error('[QueryEntrySecurity] LLM judge error:', err);
    }
  }

  return { sanitizedQuery };
}

export class QueryEntrySecurityGate {
  constructor(private readonly deps: QueryEntrySecurityDeps) {}

  async getSafeQueryOrThrow(query: string): Promise<string> {
    const result = await evaluateQueryEntrySecurity(query, this.deps);
    if (result.rejection !== undefined) {
      throw createPolicyBlockedDomainError();
    }

    return result.sanitizedQuery;
  }
}
