import type { StageTimer } from '../../../domain/shared/stage-timer.js';
import type { LookupQueryPlan } from './lookup-query-plan.js';

export interface LookupPlannerContext {
  readonly abortSignal?: AbortSignal | undefined;
  readonly stageTimer?: StageTimer | undefined;
}

export interface LookupPlannerPort {
  plan(query: string, context?: LookupPlannerContext): Promise<LookupQueryPlan>;
}
