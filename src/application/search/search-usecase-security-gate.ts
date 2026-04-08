import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { QueryEntrySecurityObserver } from '../../domain/security/port/security-observer.port.js';
import { QueryEntrySecurityGate } from './query-entry-security.js';

export interface SearchSecurityGateDeps {
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly queryEntrySecurityObserver?: QueryEntrySecurityObserver | undefined;
}

export function createSearchQuerySecurityGate(deps: SearchSecurityGateDeps): QueryEntrySecurityGate {
  return new QueryEntrySecurityGate({
    querySanitizer: deps.querySanitizer,
    injectionJudge: deps.injectionJudge,
    judgeFailureMode: deps.judgeFailureMode,
    ...(deps.queryEntrySecurityObserver !== undefined
      ? { observer: deps.queryEntrySecurityObserver }
      : {}),
  });
}
