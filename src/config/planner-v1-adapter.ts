/**
 * T1.2 backward-compat shim.
 *
 * Wraps the concrete {@link Planner} (which now emits {@link QueryPlanV2}) and
 * adapts it to the {@link QueryPlannerPort} contract (which still types the
 * return as {@link QueryPlanV1}).
 *
 * Responsibility: compile the `policy` field (dropped from QueryPlanV2) and
 * expose `route` / `retrievalMode` under the V1 field names.
 *
 * T1.5 will remove this adapter once all consumers migrate to QueryPlanV2.
 */
import type { QueryPlanV1 } from '../domain/query/model/query-plan.js';
import type { Planner, PlannerContext } from '../domain/query/service/planner.js';
import { PolicyCompiler } from '../domain/query/service/policy-compiler.js';

export class PlannerV1Adapter {
  private readonly policyCompiler = new PolicyCompiler();

  constructor(private readonly planner: Planner) {}

  async plan(query: string, context?: PlannerContext): Promise<QueryPlanV1> {
    const v2 = await this.planner.plan(query, context);

    const policy = this.policyCompiler.compile(
      v2.intent,
      v2.queryClass,
      v2.anchors,
      v2.uncertainty,
    );

    return {
      rawQuery: v2.rawQuery,
      normalizedQuery: v2.normalizedQuery,
      ...(v2.normalizedQueryViews !== undefined && { normalizedQueryViews: v2.normalizedQueryViews }),
      intent: v2.intent,
      ...(v2.secondaryIntents !== undefined && { secondaryIntents: v2.secondaryIntents }),
      route: v2.suggestedRoute,
      retrievalMode: v2.suggestedRetrievalMode,
      queryClass: v2.queryClass,
      anchors: v2.anchors,
      constraints: v2.constraints,
      expansions: v2.expansions,
      policy,
      uncertainty: v2.uncertainty,
      plannerVersion: v2.plannerVersion,
      policyRuleVersion: v2.policyRuleVersion,
      thresholdProfileId: v2.thresholdProfileId,
      ...(v2.admission_context !== undefined && { admission_context: v2.admission_context }),
      ...(v2.sessionContext !== undefined && { sessionContext: v2.sessionContext }),
      queryBudget: v2.queryBudget,
      ...(v2.targetEntityType !== undefined && { targetEntityType: v2.targetEntityType }),
    };
  }
}
