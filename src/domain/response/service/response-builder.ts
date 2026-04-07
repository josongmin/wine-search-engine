/**
 * E4-U1: Main Runtime Response Contract Lock
 *
 * {@link ResponseBuilder} is the **authoritative main runtime response surface**.
 * Route handlers (search.usecase, hybrid.usecase, batch-search) MUST build
 * SearchResponseV1 through ResponseBuilder.build() — not through any V2 builder.
 *
 * V2 builders are sidecar / adapter surfaces:
 *  - {@link MachineResponseBuilderV2} — exposed only via /v1/claude-tools seam
 *  - {@link HumanResponseBuilderV2}   — human-oriented interpret/explain sidecar
 *
 * Do NOT promote V2 builders to main runtime contract without an explicit
 * migration epic that gates on eval regression results.
 *
 * E4-U4: Explanation-Policy Responsibility Split
 *   - Evidence obligation evaluation → evidence-gate.ts (decision domain)
 *   - Query-family explanation obligations → explanation-obligation.ts
 *   - This builder assembles the response; it does NOT own policy decisions.
 *   - Do NOT add suppress/require logic directly here — route via the obligation map.
 *
 * E4-U6: Route/Provenance Metadata Alignment
 *   - `route` field in ResponseBuilderParams maps to compiled effectiveRoute
 *   - `retrievalModeSource` maps to EngineExecutionContract.routeSource
 *   - `plannerSuggestedMode`: from EngineExecutionContract.effectiveRetrievalMode (compiled-first)
 */
import type { DecisionOutput } from '../../decision/model/decision-output.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { CompiledWineQuery } from '../../query/model/compiled-wine-query.js';
import type { EvalProvenanceSlice } from '../../retrieval/model/provenance.js';
import type { EngineDecision } from '../model/engine-decision.js';
import type { ResultItem } from '../model/result-item.js';
import type { ClarificationPayload } from '../model/clarification.js';
import type { CounterfactualReject, ResponseMeta } from '../model/counterfactual.js';
import type { SearchResponseV1, ParsedConstraintsExtern } from '../model/search-response.js';
import type { GroupedResult } from './result-grouper.js';
import { ResultGrouper } from './result-grouper.js';
import { deterministicHash } from '../../shared/utils/hash.js';
import type { SpecializedRouteObservability } from '../model/specialized-route.js';
import { toSpecializedRouteMeta } from '../model/specialized-route.js';
import { EvidenceObligationError } from '../../shared/error/domain-error.js';

/**
 * Parameters required by {@link ResponseBuilder.build}.
 */
export interface ResponseBuildParams {
  /** Internal decision output from the Decision domain. */
  readonly decisionOutput: DecisionOutput;

  /** Query plan (for extracting constraints and retrieval mode). Optional for backward compat. */
  readonly queryPlan?: QueryPlanV1 | undefined;

  /** Compiled execution contract (E1-U3 carrier). When present, effectiveRetrievalMode takes precedence over queryPlan.retrievalMode. */
  readonly compiled?: CompiledWineQuery | undefined;

  /** Ranked result items to include in the response. */
  readonly results: readonly ResultItem[];

  /** Optional clarification payload when the engine needs user input. */
  readonly clarification?: ClarificationPayload | undefined;

  /** Optional counterfactual rejects for transparency. */
  readonly counterfactuals?: readonly CounterfactualReject[] | undefined;

  /** Optional canonical provenance slices to preserve runtime/eval SSOT. */
  readonly retrievalProvenanceSlices?: readonly EvalProvenanceSlice[] | undefined;

  /** Caller-supplied request ID for correlation. */
  readonly requestId?: string | undefined;

  /** Wall-clock query time in milliseconds. */
  readonly queryTimeMs: number;

  /** Execution route label. */
  readonly route: string;

  /**
   * E4-U6: Route/provenance vocabulary — aligned with compiled execution contract.
   *   retrievalModeSource: from EngineExecutionContract.routeSource ('planner' | 'api_override')
   *   plannerSuggestedMode: from EngineExecutionContract.effectiveRetrievalMode (compiled-first)
   * These fields use calibrated semantics vocabulary — do NOT add ad hoc route strings here.
   */
  /** Whether the retrieval mode was determined by the planner or overridden via the API. */
  readonly retrievalModeSource?: 'planner' | 'api_override' | undefined;

  /** The retrieval mode the planner originally suggested, before any API override. */
  readonly plannerSuggestedMode?: string | undefined;

  /** Response format version (defaults to "1.0.0"). */
  readonly version?: string | undefined;

  /** Optional precomputed honesty/degradation contract from upstream route phases. */
  readonly contract?: {
    readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory' | undefined;
    readonly blockingEligible?: boolean | undefined;
    readonly degradationReasons?: readonly string[] | undefined;
  } | undefined;

  /** Optional specialized retrieval provenance surfaced by route execution. */
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
}

/**
 * Assembles a complete {@link SearchResponseV1} from domain outputs.
 *
 * Responsibilities:
 * - Maps the internal {@link DecisionOutput} to the external {@link EngineDecision}.
 * - Enforces the invariant that every result carries real evidence items.
 * - Extracts retrieval mode, result type, and constraints for LLM envelope (Epic 9).
 * - Attaches response-level metadata.
 */
export class ResponseBuilder {
  private readonly resultGrouper = new ResultGrouper();

  /**
   * Build a {@link SearchResponseV1} from the given parameters.
   *
   * @param params - All inputs required to assemble the response.
   * @returns A fully assembled, immutable search response.
   */
  build(params: ResponseBuildParams): SearchResponseV1 {
    const validatedResults = this.enforceEvidence(params.results);
    const enrichedResults = this.enrichResults(validatedResults);
    const contract = this.resolveContract(params, enrichedResults);
    const engineDecision = this.mapDecision(
      params.decisionOutput,
      params.route,
      contract,
      params.retrievalModeSource,
      params.plannerSuggestedMode,
      params.requestId,
    );

    // Compute a deterministic response hash for the determinism gate
    // (RFC-009 §8 / RFC-015). The hash covers only stable, input-derived
    // fields — not timestamps, request IDs, or latency — so that two replay
    // executions with the same snapshot and query produce the same hash.
    const snapshot = params.decisionOutput.decisionSnapshot;
    const topEntityId = params.decisionOutput.selectedEntity?.entityId ?? '';
    const debugRefs = this.buildDebugRefs(params.decisionOutput);
    const responseHash = deterministicHash(
      params.decisionOutput.decisionStatus,
      params.decisionOutput.nextAction,
      params.decisionOutput.decisionConfidence.toFixed(4),
      String(enrichedResults.length),
      topEntityId,
      snapshot.policy_rule_version,
      snapshot.threshold_profile_id,
      snapshot.planner_version,
    );

    const meta: ResponseMeta = {
      requestId: params.requestId,
      queryTimeMs: params.queryTimeMs,
      route: params.route,
      version: params.version ?? '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: snapshot,
      ...(debugRefs !== undefined ? { debugRefs } : {}),
      response_hash: responseHash,
      authorityTraceRef: params.decisionOutput.decisionTraceRef,
      ...(params.requestId !== undefined ? { runtimeCorrelationRef: params.requestId } : {}),
      executionMode: contract.executionMode,
      blockingEligible: contract.blockingEligible,
      ...(contract.degradationReasons.length > 0
        ? { degradationReasons: contract.degradationReasons }
        : {}),
      ...(params.retrievalProvenanceSlices !== undefined && params.retrievalProvenanceSlices.length > 0
        ? { retrievalProvenanceSlices: params.retrievalProvenanceSlices }
        : {}),
      ...toSpecializedRouteMeta(params.specializedRouteObservability),
    };

    // Extract LLM envelope fields (Epic 9)
    const retrievalMode = params.compiled?.execution.effectiveRetrievalMode ?? params.queryPlan?.retrievalMode;
    const resultType = this.computeResultType(
      enrichedResults,
      params.decisionOutput.decisionStatus,
      params.queryPlan,
    );
    const parsedConstraints = params.queryPlan ? this.buildParsedConstraints(params.queryPlan) : undefined;
    const abstainReason = this.extractAbstainReason(params.decisionOutput);

    // Enrich engineDecision with abstain reason if present
    const enrichedEngineDecision: EngineDecision = abstainReason !== undefined
      ? { ...engineDecision, abstainReason }
      : engineDecision;

    return {
      queryType: 'search',
      engineDecision: enrichedEngineDecision,
      results: enrichedResults,
      counterfactuals: params.counterfactuals,
      clarification: params.clarification ?? null,
      meta,
      ...(retrievalMode !== undefined ? { retrievalMode } : {}),
      ...(resultType !== undefined ? { resultType } : {}),
      ...(parsedConstraints !== undefined ? { parsedConstraints } : {}),
    };
  }

  /**
   * Map internal {@link DecisionOutput} to the external-facing {@link EngineDecision}.
   */
  private mapDecision(
    output: DecisionOutput,
    route: string,
    contract: {
      readonly executionMode: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
      readonly blockingEligible: boolean;
      readonly degradationReasons: readonly string[];
    },
    retrievalModeSource?: 'planner' | 'api_override',
    plannerSuggestedMode?: string,
    requestId?: string,
  ): EngineDecision {
    return {
      decisionStatus: output.decisionStatus,
      nextAction: output.nextAction,
      route,
      decisionConfidence: output.decisionConfidence,
      confidenceSemantics: output.confidenceSemantics,
      decisionTraceRef: output.decisionTraceRef,
      authorityTraceRef: output.decisionTraceRef,
      decisionSnapshot: output.decisionSnapshot,
      ...(requestId !== undefined ? { runtimeCorrelationRef: requestId } : {}),
      executionMode: contract.executionMode,
      blockingEligible: contract.blockingEligible,
      ...(contract.degradationReasons.length > 0
        ? { degradationReasons: contract.degradationReasons }
        : {}),
      ...(output.failureReason !== undefined
        ? { failure_reason: output.failureReason }
        : {}),
      ...(output.admissionTraceRef !== undefined
        ? { admission_trace_ref: output.admissionTraceRef }
        : {}),
      ...(retrievalModeSource !== undefined ? { retrievalModeSource } : {}),
      ...(plannerSuggestedMode !== undefined ? { plannerSuggestedMode } : {}),
    };
  }

  private resolveContract(
    params: ResponseBuildParams,
    results: readonly ResultItem[],
  ): {
    readonly executionMode: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
    readonly blockingEligible: boolean;
    readonly degradationReasons: readonly string[];
  } {
    const explicitReasons = params.contract?.degradationReasons ?? [];
    const inferredReasons = new Set<string>(explicitReasons);
    const hasHeuristicDrinkingWindow = results.some(
      (result) => result.drinkingWindow?.evidenceLevel === 'heuristic',
    );

    if (hasHeuristicDrinkingWindow) {
      inferredReasons.add('heuristic_drinking_window');
    }

    const executionMode = params.contract?.executionMode
      ?? (hasHeuristicDrinkingWindow ? 'heuristic' : 'authoritative');

    const blockingEligible = params.contract?.blockingEligible
      ?? (
        executionMode !== 'heuristic'
        && executionMode !== 'advisory'
        && results.every((result) => result.drinkingWindow?.blockingEligible !== false)
      );

    return {
      executionMode,
      blockingEligible,
      degradationReasons: [...inferredReasons],
    };
  }

  /**
   * Enforce the invariant that every result must carry at least one evidence item.
   * Placeholder evidence is not permitted at the response boundary because it
   * would mask an upstream evidence-production defect.
   */
  private enforceEvidence(results: readonly ResultItem[]): readonly ResultItem[] {
    const missingEvidenceResult = results.find((result) => result.evidenceItems.length === 0);
    if (missingEvidenceResult !== undefined) {
      throw new EvidenceObligationError(
        `Result ${missingEvidenceResult.entity.entityId} reached response assembly without evidenceItems`,
      );
    }

    return results;
  }

  /**
   * Enrich results with LLM envelope fields (Epic 9):
   * - matchReasons: extracted from high-strength evidence
   * - violatedConstraints: from ConstraintEvaluation.unmet
   */
  private enrichResults(results: readonly ResultItem[]): readonly ResultItem[] {
    return results.map((result) => {
      // Extract matchReasons from evidence items with strength != 'low' and positive contribution
      const matchReasons = result.evidenceItems
        .filter((ei) => {
          const strength = ei.strength;
          const contrib = parseFloat(ei.contribution);
          return strength !== 'low' && contrib > 0;
        })
        .map((ei) => ei.provenance);

      // Extract violated constraints from ConstraintEvaluation.unmet
      const violatedConstraints = result.constraints.unmet.length > 0
        ? result.constraints.unmet
        : undefined;

      // Build enriched result with conditional spreads
      return {
        ...result,
        ...(matchReasons.length > 0 ? { matchReasons: matchReasons as readonly string[] } : {}),
        ...(violatedConstraints !== undefined ? { violatedConstraints } : {}),
      };
    });
  }

  /**
   * Compute resultType from the results and decision status (Epic 9).
   * When the planner inferred a {@link QueryPlanV1.targetEntityType}, uses
   * {@link ResultGrouper} to emit Epic 8 set types (producer_set, etc.).
   */
  private computeResultType(
    results: readonly ResultItem[],
    decisionStatus: string,
    queryPlan?: QueryPlanV1,
  ): SearchResponseV1['resultType'] {
    // No match case
    if (results.length === 0 || decisionStatus === 'failed') {
      return 'no_match';
    }

    // Single entity case
    if (results.length === 1) {
      return 'single_entity';
    }

    // Multiple results: optional grouping by planner target type (Epic 8)
    if (queryPlan?.targetEntityType !== undefined) {
      const grouped = this.resultGrouper.group(results, queryPlan.targetEntityType);
      return this.mapGroupedResultTypeToResponse(grouped.resultType);
    }

    return 'entity_set';
  }

  private mapGroupedResultTypeToResponse(
    t: GroupedResult['resultType'],
  ): SearchResponseV1['resultType'] {
    return t;
  }

  /**
   * Build ParsedConstraintsExtern from QueryPlanV1 constraints (Epic 9).
   * Converts the internal ConstraintBundle to an external format suitable for LLMs.
   * Returns undefined if no constraints are present.
   */
  private buildParsedConstraints(plan: QueryPlanV1): ParsedConstraintsExtern | undefined {
    const constraints = plan.constraints;
    const hasConstraints =
      constraints.hard.length > 0 ||
      constraints.soft.length > 0 ||
      constraints.inferred.length > 0;

    if (!hasConstraints) {
      return undefined;
    }

    const hard = constraints.hard.map((c) => ({
      field: c.attribute,
      op: c.operator,
      value: this.constraintValueToString(c.value),
    }));

    const soft = constraints.soft.map((c) => ({
      field: c.attribute,
      op: c.operator,
      value: this.constraintValueToString(c.value),
    }));

    // Inferred constraints are included in soft for LLM visibility
    const inferredSoft = constraints.inferred.map((c) => ({
      field: c.attribute,
      op: c.operator,
      value: this.constraintValueToString(c.value),
    }));

    return {
      hard: hard as ReadonlyArray<{
        readonly field: string;
        readonly op: string;
        readonly value: string;
      }>,
      soft: [...soft, ...inferredSoft] as ReadonlyArray<{
        readonly field: string;
        readonly op: string;
        readonly value: string;
      }>,
      unparsed: [],
    };
  }

  /**
   * Convert constraint value to string representation for external format.
   */
  private constraintValueToString(value: string | number | { min: number; max: number } | ReadonlyArray<string>): string {
    if (typeof value === 'string' || typeof value === 'number') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.join(', ')}]`;
    }
    const range = value as { min: number; max: number };
    return `${range.min}-${range.max}`;
  }

  /**
   * Extract abstain reason from DecisionOutput (Epic 9).
   * Returns a reason when:
   * - decisionStatus is 'ambiguous'
   * - AND it's not due to hard constraint violation
   * - AND there's a finalReason in the decision trace
   */
  private extractAbstainReason(
    output: DecisionOutput,
  ): string | undefined {
    if (output.decisionStatus !== 'ambiguous') {
      return undefined;
    }

    // Use structured failureReason field — never rely on free-text finalReason substring matching.
    if (output.failureReason === 'HARD_CONSTRAINT_VIOLATION') {
      return undefined;
    }

    const finalReason = output.decisionTrace.finalReason;
    return finalReason.length > 0 ? finalReason : undefined;
  }

  /**
   * Build compact debug refs when noisy lookup provenance is present.
   */
  private buildDebugRefs(output: DecisionOutput): readonly string[] | undefined {
    const provenance = output.decisionTrace.queryProvenance;
    if (provenance === undefined) {
      return undefined;
    }

    const refs: string[] = ['query_provenance:present'];
    if (provenance.normalizedQueryViews !== undefined) {
      refs.push('query_provenance:normalized_views');
    }
    if ((provenance.anchorLookupVariants ?? []).length > 0) {
      refs.push('query_provenance:anchor_lookup_variants');
    }

    return refs;
  }
}
