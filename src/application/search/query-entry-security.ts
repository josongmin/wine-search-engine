import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import {
  POLICY_BLOCKED_CODE,
  PolicyBlockedError,
} from '../../domain/shared/error/policy-blocked.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';

export type QueryEntrySecurityLayer = 'LAYER_1_BLOCKED' | 'LAYER_2_BLOCKED';

export interface QueryEntrySecurityRejection {
  readonly layer: QueryEntrySecurityLayer;
  readonly reason: string;
}

export interface QueryEntrySecurityResult {
  readonly sanitizedQuery: string;
  readonly rejection?: QueryEntrySecurityRejection | undefined;
}

export type QueryEntrySecuritySearchResult =
  | { readonly sanitizedQuery: string }
  | { readonly rejection: SearchResponseV1 };

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

export function buildPolicyBlockedSearchResponse(
  requestId: string,
  startTime: number,
  rejection: QueryEntrySecurityRejection,
): SearchResponseV1 {
  const queryTimeMs = Date.now() - startTime;

  const snapshot = {
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1',
    threshold_profile_id: 'default',
    planner_version: 'security_gate',
    feature_flags: {},
  } as const;

  return {
    queryType: 'search' as const,
    engineDecision: {
      decisionStatus: 'failed' as const,
      nextAction: 'fail' as const,
      route: 'security_gate',
      decisionConfidence: 0,
      confidenceSemantics: 'calibrated_decision_confidence' as const,
      decisionTraceRef: `injection_reject_${rejection.layer}_${Date.now()}`,
      decisionSnapshot: snapshot,
      failure_reason: POLICY_BLOCKED_CODE,
    },
    results: [],
    meta: {
      requestId,
      queryTimeMs,
      route: 'security_gate',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: snapshot,
      response_hash: 'security_rejection',
      debugRefs: [`injection_defense:${rejection.layer}:${rejection.reason}`],
    },
  };
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

  async getSafeQueryOrSearchRejection(
    query: string,
    requestId: string,
    startTime: number,
  ): Promise<QueryEntrySecuritySearchResult> {
    const result = await evaluateQueryEntrySecurity(query, this.deps);
    if (result.rejection !== undefined) {
      return {
        rejection: buildPolicyBlockedSearchResponse(requestId, startTime, result.rejection),
      };
    }

    return {
      sanitizedQuery: result.sanitizedQuery,
    };
  }
}
