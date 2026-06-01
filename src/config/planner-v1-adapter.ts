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
 * Also implements the optional `planWithCompiled` extension so callers can get
 * the ExecutionCompiler-produced {@link CompiledWineQuery} without re-deriving
 * route/mode decisions downstream (E1-U2).
 *
 * T1.5 will remove this adapter once all consumers migrate to QueryPlanV2.
 *
 * Anchor-refresh hook (`anchorRefresh` constructor dep): wave-1 of the
 * entity-route structural fix (memory `project_entity_route_broken`). When
 * the compiled retrieval mode is `entity_lookup` and the planner produced
 * zero anchors, this adapter re-queries the alias overlay via the injected
 * callback to recover anchors before the entity route runs. Without this,
 * the entity route silently returns 0 results for known aliases, which led
 * to the now-removed `lookup_wine → mode='hybrid'` workaround.
 */
import type { QueryPlanV1, QueryPlanV2 } from '../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../domain/query/model/compiled-wine-query.js';
import type { Planner, PlannerContext } from '../domain/query/service/planner.js';
import type {
  PlanWithCompiledResult,
  QueryPlannerPort,
} from '../application/search/port/search-pipeline-deps.port.js';
import { PolicyCompiler } from '../domain/query/service/policy-compiler.js';
import { ExecutionCompiler } from '../domain/query/service/execution-compiler.js';
import {
  type AnchorRefreshCallback,
  type AnchorRefreshAliasOverlayPort,
  refreshAnchorsFromAliasOverlay,
} from '../domain/query/service/anchor-refresh.js';

/**
 * Build an {@link AnchorRefreshCallback} from an alias-overlay port.
 *
 * Pulled out so container wiring can hand the closure to PlannerV1Adapter
 * without the adapter knowing about the AliasMatcher interface.
 */
export function buildAnchorRefreshCallbackFromAliasOverlay(
  overlay: AnchorRefreshAliasOverlayPort,
): AnchorRefreshCallback {
  return (input) => refreshAnchorsFromAliasOverlay(input, overlay);
}

export interface PlannerV1AdapterOptions {
  /**
   * Optional anchor-refresh callback. When present, the adapter will invoke
   * it after the planner returns IF the compiled retrieval mode is
   * `entity_lookup` AND no anchors were extracted. Refreshed anchors are
   * merged into the plan (V1 + V2) and the plan is re-compiled so downstream
   * consumers see a consistent (anchors, route, mode) tuple.
   *
   * Omit to disable the hook entirely — useful for tests or environments
   * that bypass the alias overlay (e.g. snapshot-only fixtures).
   */
  readonly anchorRefresh?: AnchorRefreshCallback | undefined;
}

export class PlannerV1Adapter implements QueryPlannerPort {
  private readonly policyCompiler = new PolicyCompiler();
  private readonly executionCompiler = new ExecutionCompiler();
  private readonly anchorRefresh: AnchorRefreshCallback | undefined;

  constructor(
    private readonly planner: Planner,
    options?: PlannerV1AdapterOptions,
  ) {
    this.anchorRefresh = options?.anchorRefresh;
  }

  /**
   * Returns V1-shaped plan only. NL `constraintExtraction` is **not** on QueryPlanV1;
   * use `planWithCompiled()` and read `compiled.query.constraintExtraction`, or call
   * `planToObservabilitySlice` with the compiled object (it falls back to `compiled.query`).
   */
  async plan(query: string, context?: PlannerContext): Promise<QueryPlanV1> {
    const { v1 } = await this._planBoth(query, context);
    return v1;
  }

  async planWithCompiled(query: string, context?: PlannerContext): Promise<PlanWithCompiledResult> {
    return this._planBoth(query, context);
  }

  private async _planBoth(
    query: string,
    context?: PlannerContext,
  ): Promise<{ v1: QueryPlanV1; compiled: CompiledWineQuery }> {
    const v2 = await this.planner.plan(query, context);
    let { v1, compiled } = this.materializeFromV2(v2);

    // Anchor refresh: entity-route safety net. Only fires when the compiler
    // resolved to `entity_lookup` AND the planner produced zero anchors —
    // the exact failure shape that previously forced lookup_wine through the
    // hybrid workaround. Other modes intentionally proceed without anchors.
    if (
      this.anchorRefresh !== undefined
      && compiled.execution.effectiveRetrievalMode === 'entity_lookup'
      && v1.anchors.length === 0
    ) {
      const refreshResult = await this.anchorRefresh({
        normalizedQuery: v1.normalizedQuery,
        existingAnchors: v1.anchors,
      });
      if (refreshResult.status === 'refreshed') {
        // Re-emit V1 + recompile with the refreshed anchor set so anchors,
        // policy, and the compiled execution contract are mutually
        // consistent. Re-compilation is cheap (no I/O) and avoids subtle
        // bugs from updating one surface but not the other.
        const refreshedV2: QueryPlanV2 = { ...v2, anchors: refreshResult.anchors };
        ({ v1, compiled } = this.materializeFromV2(refreshedV2));
      }
      // status === 'no_match' → leave the original plan unchanged. The
      // entity route will produce its usual empty-anchor outcome; the
      // refresh attempt is observable via the lack of any anchor change.
    }

    return { v1, compiled };
  }

  /**
   * Compile a {@link QueryPlanV2} into the {@link QueryPlanV1} +
   * {@link CompiledWineQuery} pair. Extracted so the anchor-refresh path
   * can re-run the compile with mutated anchors without duplicating the
   * V2→V1 / policy / ExecutionCompiler wiring.
   */
  private materializeFromV2(v2: QueryPlanV2): { v1: QueryPlanV1; compiled: CompiledWineQuery } {
    const policy = this.policyCompiler.compile(
      v2.intent,
      v2.queryClass,
      v2.anchors,
      v2.uncertainty,
    );

    const v1: QueryPlanV1 = {
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
      ...(v2.queryBudget !== undefined ? { queryBudget: v2.queryBudget } : {}),
      ...(v2.targetEntityType !== undefined && { targetEntityType: v2.targetEntityType }),
      // Preserve decompositionHint from V2 so downstream consumers (observability,
      // interpret explainer, pre-route phase) can surface decomposition signals.
      // Previously dropped here, causing decompositionStrategy to be silently absent
      // from all observability slices and V2 explain responses.
      ...(v2.decompositionHint !== undefined && { decompositionHint: v2.decompositionHint }),
    };

    const compiledBase = this.executionCompiler.compile({ plan: v2 });

    // Forward plannerTrace from V2 into CompiledWineQuery so the post-route
    // phase can attach it to the response without needing a separate V2 reference.
    // Only populated when enablePlannerTrace = true (options.explain=true).
    const compiled: CompiledWineQuery =
      v2.plannerTrace != null && v2.plannerTrace.length > 0
        ? { ...compiledBase, plannerTrace: v2.plannerTrace }
        : compiledBase;

    return { v1, compiled };
  }
}
