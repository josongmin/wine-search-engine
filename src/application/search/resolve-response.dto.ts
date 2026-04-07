import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';

export interface ResolveResponse {
  readonly status: string;
  readonly candidates: EntityResolveResult['candidates'];
  readonly topEntity: EntityResolveResult['topEntity'];
  readonly decision_trace_ref: string;
  readonly authority_trace_ref: string;
  readonly request_id?: string | undefined;
}
