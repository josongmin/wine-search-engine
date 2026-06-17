/**
 * E4-U1: Main Runtime Response Contract Lock
 *
 * {@link ResponseBuilder} is the **authoritative main runtime response surface**.
 * Route handlers (search.usecase, batch-search) MUST build
 * SearchResponseV1 through ResponseBuilder.build() — not through any V2 builder.
 *
 * V2 builders are sidecar / adapter surfaces:
 *  - {@link MachineResponseBuilderV2} — internal machine/executor projection only
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
import type { QueryRoute } from '../../query/model/query-route.js';
import type { AdmissionClosureSummary } from '../../decision/model/decision-input.js';
import type {
  ExecutionProvenanceClosure,
  ExecutionLaneTrace,
  ExecutionRetrievalMode,
  ExecutionTopology,
} from '../../query/model/engine-execution-contract.js';
import type { AbstainReason } from '../../query/model/abstain-decision.js';
import type { EvalProvenanceSlice } from '../../retrieval/model/provenance.js';
import type { EngineDecision } from '../model/engine-decision.js';
import type { ResultItem } from '../model/result-item.js';
import type { ClarificationPayload } from '../model/clarification.js';
import type { AuditExtension } from '../../audit/model/audit-extension.js';
import type {
  CounterfactualReject,
  ExecutionContractMeta,
  ProvenanceTraceMeta,
  ResponseMeta,
} from '../model/counterfactual.js';
import type { SearchResponseV1, ParsedConstraintsExtern } from '../model/search-response.js';
import type { GroupedResult } from './result-grouper.js';
import { ResultGrouper } from './result-grouper.js';
import { deterministicHash } from '../../shared/utils/hash.js';
import type { SpecializedRouteObservability } from '../model/specialized-route.js';
import { toSpecializedRouteMeta } from '../model/specialized-route.js';
import { EvidenceObligationError } from '../../shared/error/domain-error.js';
import {
  filterBindingInferredConstraints,
  isCorruptedSnapshot,
} from '../../shared/types/index.js';
import {
  buildClarificationCandidateSignature,
  buildDisplayIdentitySignature,
} from './display-identity.js';
import {
  buildDeterminismFingerprint,
  type DeterminismFingerprintParams,
} from '../../shared/utils/determinism-fingerprint.js';

/**
 * Parameters required by {@link ResponseBuilder.build}.
 */
export interface ResponseBuildParams {
  /** Internal decision output from the Decision domain. */
  readonly decisionOutput: DecisionOutput;

  /** Query plan (for extracting constraints and retrieval mode). Optional for backward compat. */
  readonly queryPlan?: QueryPlanV1 | undefined;

  /** Compiled execution contract (E1-U3 carrier). effectiveRetrievalMode takes precedence over queryPlan.retrievalMode. */
  readonly compiled: CompiledWineQuery;

  /** Ranked result items to include in the response. */
  readonly results: readonly ResultItem[];

  /** Optional clarification payload when the engine needs user input. */
  readonly clarification?: ClarificationPayload | undefined;

  /** Optional counterfactual rejects for transparency. */
  readonly counterfactuals?: readonly CounterfactualReject[] | undefined;

  /** Optional canonical provenance slices to preserve runtime/eval SSOT. */
  readonly retrievalProvenanceSlices?: readonly EvalProvenanceSlice[] | undefined;

  /**
   * Typed abstain reason for abstain-driven outcomes.
   * MUST come from TypedAbstainDecision.reason, never from free-text traces.
   */
  readonly abstainReason?: AbstainReason | undefined;

  /** Caller-supplied request ID for correlation. */
  readonly requestId?: string | undefined;

  /** Wall-clock query time in milliseconds. */
  readonly queryTimeMs: number;

  /** Execution route label. */
  readonly route: QueryRoute;

  /**
   * E4-U6: Route/provenance vocabulary — aligned with compiled execution contract.
   *   retrievalModeSource: from EngineExecutionContract.routeSource ('planner' | 'api_override')
   *   plannerSuggestedMode: from EngineExecutionContract.effectiveRetrievalMode (compiled-first)
   * These fields use calibrated semantics vocabulary — do NOT add ad hoc route strings here.
   */
  /** Whether the retrieval mode was determined by the planner or overridden via the API. */
  readonly retrievalModeSource?: 'planner' | 'api_override' | undefined;

  /** The retrieval mode the planner originally suggested, before any API override. */
  readonly plannerSuggestedMode?: ExecutionRetrievalMode | undefined;

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

  /** Stable execution-contract projection for response meta. */
  readonly executionContract?: {
    readonly executionTopology?: ExecutionTopology | undefined;
    readonly effectiveRetrievalMode: ExecutionRetrievalMode;
    readonly retrievalKind:
      | 'entity_lookup'
      | 'generic_hybrid'
      | 'specialized_hybrid'
      | 'mixed_similarity';
    readonly sparseExecuted: boolean;
    readonly specializedRouteExecuted?: SpecializedRouteObservability['specializedRouteExecuted'] | undefined;
    readonly usedCompiledExecution: boolean;
    readonly laneTrace?: ExecutionLaneTrace | undefined;
    readonly provenanceClosure?: ExecutionProvenanceClosure | undefined;
    readonly admissionClosure?: AdmissionClosureSummary | undefined;
  } | undefined;

  /**
   * Optional audit payload to include in the response meta.
   * Populated when `options.explain = true` and the planner trace is non-empty.
   * Use conditional spread at call sites: `...(auditExtension !== undefined ? { auditExtension } : {})`.
   */
  readonly auditExtension?: AuditExtension | undefined;

  /**
   * E1-T5: Optional determinism fingerprint params.
   * When provided, meta.determinism_fingerprint is populated with a stable 16-char hex digest
   * that identifies the exact engine configuration (planner version, model, fusion config, etc.).
   * Two responses with the same fingerprint MUST produce identical rankings for the same index state.
   */
  readonly determinismFingerprintParams?: DeterminismFingerprintParams | undefined;

  /**
   * Per-stage latency snapshot from the request-scoped StageTimer.
   * When present, attached verbatim to SearchResponseV1.stageTimings.
   */
  readonly stageTimings?: Readonly<Record<string, number>> | undefined;
}

/** Fixed-point precision for confidence in deterministic response hash. */
const RESPONSE_HASH_CONFIDENCE_DECIMAL_PLACES = 4;

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
    const validatedResults = this.dedupeResultsByDisplayIdentity(
      this.enforceEvidence(params.results),
    );
    const enrichedResults = this.enrichResults(validatedResults);
    const contract = this.resolveContract(params, enrichedResults);
    const executionTopology =
      params.executionContract?.executionTopology ?? params.compiled.execution.executionTopology;
    const laneTrace = params.executionContract?.laneTrace;
    const auditExtension = this.buildAuditExtension(params.auditExtension, executionTopology, laneTrace);
    const engineDecision = this.mapDecision(
      params.decisionOutput,
      params.route,
      contract,
      params.retrievalModeSource,
      params.plannerSuggestedMode,
      params.requestId,
      executionTopology,
      laneTrace,
    );

    // Compute a deterministic response hash for the determinism gate
    // (RFC-009 §8 / RFC-015). The hash covers only stable, input-derived
    // fields — not timestamps, request IDs, or latency — so that two replay
    // executions with the same snapshot and query produce the same hash.
    const snapshot = params.decisionOutput.decisionSnapshot;
    const topEntityId = params.decisionOutput.selectedEntity?.entityId ?? '';
    const debugRefs = this.buildDebugRefs(params.decisionOutput);
    // Guard: corrupted snapshot would produce a fake response hash and pollute
    // downstream consumers. Use empty strings for hash inputs so the hash is
    // still deterministic but distinguishable from a real snapshot hash.
    const snapshotCorrupted = isCorruptedSnapshot(snapshot);
    const responseHash = deterministicHash(
      params.decisionOutput.decisionStatus,
      params.decisionOutput.nextAction,
      params.decisionOutput.decisionConfidence.toFixed(RESPONSE_HASH_CONFIDENCE_DECIMAL_PLACES),
      String(enrichedResults.length),
      topEntityId,
      snapshotCorrupted ? '' : snapshot.policy_rule_version,
      snapshotCorrupted ? '' : snapshot.threshold_profile_id,
      snapshotCorrupted ? '' : snapshot.planner_version,
    );

    // E1-T5: Build determinism fingerprint when params are supplied.
    // The fingerprint covers only engine configuration — not query text or request ID —
    // so that identical configurations always produce the same fingerprint regardless of query.
    const determinismFingerprint = params.determinismFingerprintParams != null
      ? buildDeterminismFingerprint(params.determinismFingerprintParams)
      : undefined;

    const meta: ResponseMeta = {
      requestId: params.requestId,
      queryTimeMs: params.queryTimeMs,
      route: params.route,
      version: params.version ?? '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: snapshot,
      ...(debugRefs !== undefined ? { debugRefs } : {}),
      response_hash: responseHash,
      ...(determinismFingerprint !== undefined ? { determinism_fingerprint: determinismFingerprint } : {}),
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
      ...(params.executionContract !== undefined
        ? {
            executionContract: this.buildExecutionContractMeta(
              params.executionContract,
              params.retrievalModeSource ?? params.compiled.execution.routeSource,
              params.plannerSuggestedMode,
              params.compiled,
              executionTopology,
              laneTrace,
            ),
          }
        : {}),
      ...(params.executionContract !== undefined
        ? {
            provenanceTrace: this.buildProvenanceTraceMeta(
              params.executionContract,
              params.decisionOutput,
              contract.degradationReasons,
            ),
          }
        : {}),
      ...(auditExtension !== undefined ? { auditExtension } : {}),
    };

    // Extract LLM envelope fields (Epic 9)
    const retrievalMode = params.compiled.execution.effectiveRetrievalMode;
    const resultType = this.computeResultType(
      enrichedResults,
      params.decisionOutput.decisionStatus,
      params.queryPlan,
    );
    const parsedConstraints = params.queryPlan ? this.buildParsedConstraints(params.queryPlan) : undefined;
    const abstainReason = this.extractAbstainReason(
      params.decisionOutput,
      params.abstainReason,
    );

    // Enrich engineDecision with abstain reason if present
    const enrichedEngineDecision: EngineDecision = abstainReason !== undefined
      ? { ...engineDecision, abstainReason }
      : engineDecision;

    return {
      queryType: 'search',
      engineDecision: enrichedEngineDecision,
      results: enrichedResults,
      ...(params.counterfactuals !== undefined ? { counterfactuals: params.counterfactuals } : {}),
      clarification: this.dedupeClarificationCandidates(params.clarification),
      meta,
      retrievalMode,
      ...(resultType !== undefined ? { resultType } : {}),
      ...(parsedConstraints !== undefined ? { parsedConstraints } : {}),
      ...(params.stageTimings !== undefined && Object.keys(params.stageTimings).length > 0
        ? { stageTimings: params.stageTimings }
        : {}),
    };
  }

  /**
   * Map internal {@link DecisionOutput} to the external-facing {@link EngineDecision}.
   */
  private mapDecision(
    output: DecisionOutput,
    route: QueryRoute,
    contract: {
      readonly executionMode: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
      readonly blockingEligible: boolean;
      readonly degradationReasons: readonly string[];
    },
    retrievalModeSource?: 'planner' | 'api_override',
    plannerSuggestedMode?: ExecutionRetrievalMode,
    requestId?: string,
    executionTopology?: ExecutionTopology,
    laneTrace?: ExecutionLaneTrace,
  ): EngineDecision {
    return {
      decisionStatus: output.decisionStatus,
      nextAction: output.nextAction,
      route,
      decisionConfidence: output.decisionConfidence,
      confidenceSemantics: output.confidenceSemantics,
      ...(output.calibrationTrusted !== undefined
        ? { calibrationTrusted: output.calibrationTrusted }
        : {}),
      ...(output.top1RawScore !== undefined
        ? { top1RawScore: output.top1RawScore }
        : {}),
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
      ...(executionTopology !== undefined ? { executionTopology } : {}),
      ...(laneTrace !== undefined ? { laneTrace } : {}),
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

    const declaredExecutionMode = params.contract?.executionMode ?? 'authoritative';

    // Wire-contract invariant (bugbash 2026-04-14): if ANY degradation reason
    // is present, the response MUST NOT advertise `authoritative` — that would
    // be the wire lying to operators. Flip to `degraded` here rather than
    // depending on every upstream call site to remember the coupling.
    // `heuristic` and `advisory` stay as-is (they already encode non-authoritative
    // execution with their own semantics).
    const executionMode: 'authoritative' | 'degraded' | 'heuristic' | 'advisory' =
      inferredReasons.size > 0 && declaredExecutionMode === 'authoritative'
        ? 'degraded'
        : declaredExecutionMode;

    const blockingEligible = params.contract?.blockingEligible
      ?? (
        executionMode === 'authoritative'
        && results.every((result) => result.drinkingWindow?.blockingEligible !== false)
      );

    return {
      executionMode,
      blockingEligible,
      degradationReasons: [...inferredReasons],
    };
  }

  private buildExecutionContractMeta(
    executionContract: NonNullable<ResponseBuildParams['executionContract']>,
    retrievalModeSource: NonNullable<ResponseBuildParams['retrievalModeSource']>,
    plannerSuggestedMode: ExecutionRetrievalMode | undefined,
    compiled: CompiledWineQuery,
    executionTopology: ExecutionTopology,
    laneTrace: ExecutionLaneTrace | undefined,
  ): ExecutionContractMeta {
    return {
      executionTopology,
      effectiveRetrievalMode: executionContract.effectiveRetrievalMode,
      retrievalModeSource,
      plannerSuggestedMode: plannerSuggestedMode ?? executionContract.effectiveRetrievalMode,
      retrievalKind: executionContract.retrievalKind,
      sparseExecuted: executionContract.sparseExecuted,
      ...(executionContract.specializedRouteExecuted !== undefined
        ? { specializedRouteExecuted: executionContract.specializedRouteExecuted }
        : {}),
      usedCompiledExecution: executionContract.usedCompiledExecution,
      budget: compiled.execution.budget,
      provenancePolicy: compiled.execution.provenancePolicy,
      ...(laneTrace !== undefined ? { laneTrace } : {}),
      ...(executionContract.provenanceClosure !== undefined
        ? { provenanceClosure: executionContract.provenanceClosure }
        : {}),
      ...(executionContract.admissionClosure !== undefined
        ? { admissionClosure: executionContract.admissionClosure }
        : {}),
    };
  }

  private buildAuditExtension(
    auditExtension: AuditExtension | undefined,
    executionTopology: ExecutionTopology,
    laneTrace: ExecutionLaneTrace | undefined,
  ): AuditExtension | undefined {
    if (auditExtension === undefined) {
      return undefined;
    }

    const executionTrace = auditExtension.execution_trace;
    if (executionTrace === undefined) {
      return auditExtension;
    }

    return {
      ...auditExtension,
      execution_trace: {
        ...executionTrace,
        execution_topology: executionTopology,
        ...(laneTrace !== undefined ? { lane_trace: laneTrace } : {}),
      },
    };
  }

  private buildProvenanceTraceMeta(
    executionContract: NonNullable<ResponseBuildParams['executionContract']>,
    decisionOutput: DecisionOutput,
    degradationReasons: readonly string[],
  ): ProvenanceTraceMeta | undefined {
    const provenanceClosure = executionContract.provenanceClosure;
    if (provenanceClosure === undefined) {
      return undefined;
    }

    const admissionDecision =
      decisionOutput.decisionStatus === 'resolved'
        ? 'admission_gate_passed'
        : decisionOutput.failureReason !== undefined || decisionOutput.admissionTraceRef !== undefined
          ? 'admission_gate_rejected'
          : 'admission_gate_not_applicable';
    const decisionGate =
      decisionOutput.decisionStatus === 'resolved'
        ? 'decision_gate_resolved'
        : decisionOutput.decisionStatus === 'ambiguous'
          ? 'decision_gate_ambiguous'
          : 'decision_gate_failed';

    return {
      policy: provenanceClosure.policy,
      observed: {
        topEntityPresent: decisionOutput.selectedEntity !== undefined,
        preRank: provenanceClosure.preRank,
        postRank: provenanceClosure.postRank,
      },
      missing: provenanceClosure.missing,
      shortfalls: degradationReasons,
      gateDecisions: {
        admission: admissionDecision,
        decision: decisionGate,
        decisionStatus: decisionOutput.decisionStatus,
        nextAction: decisionOutput.nextAction,
        ...(decisionOutput.failureReason !== undefined
          ? { failureReason: decisionOutput.failureReason }
          : {}),
      },
      ...(executionContract.admissionClosure !== undefined
        ? { admissionClosure: executionContract.admissionClosure }
        : {}),
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

  private dedupeResultsByDisplayIdentity(
    results: readonly ResultItem[],
  ): readonly ResultItem[] {
    const deduped = new Map<string, ResultItem>();
    for (const result of results) {
      const signature = buildDisplayIdentitySignature({
        canonicalLabel: result.entity.canonicalLabel,
        producer: result.entity.producer,
        region: result.entity.region,
        country: result.entity.country,
        vintage: result.entity.vintage,
        type: result.entity.type,
      });
      const existing = deduped.get(signature);
      if (existing === undefined || result.relevanceScore > existing.relevanceScore) {
        deduped.set(signature, result);
      }
    }
    return [...deduped.values()];
  }

  private dedupeClarificationCandidates(
    clarification: ClarificationPayload | undefined,
  ): ClarificationPayload | null {
    if (clarification === undefined) {
      return null;
    }

    const deduped = new Map<string, ClarificationPayload['candidates'][number]>();
    for (const candidate of clarification.candidates) {
      const signature = buildClarificationCandidateSignature(candidate);
      const existing = deduped.get(signature);
      if (
        existing === undefined
        || candidate.distinguishingFeatures.length > existing.distinguishingFeatures.length
      ) {
        deduped.set(signature, candidate);
      }
    }
    const candidates = [...deduped.values()];
    const structuredPayload = clarification.structuredPayload === undefined
      ? undefined
      : {
          ...clarification.structuredPayload,
          ...(clarification.structuredPayload.options !== undefined
            ? {
                options: clarification.suggestionType === 'disambiguation' && candidates.length > 0
                  ? candidates.map((candidate) => candidate.label)
                  : [...new Set(clarification.structuredPayload.options)],
              }
            : {}),
          ...(clarification.suggestionType === 'disambiguation' && candidates.length > 0
            ? {
                optionEntities: candidates.map((candidate) => ({
                  entityId: candidate.entityId,
                  label: candidate.label,
                  ...(candidate.distinguishingFeatures.length > 0
                    ? { distinguishingFeatures: candidate.distinguishingFeatures }
                    : {}),
                })),
              }
            : clarification.structuredPayload.optionEntities !== undefined
            ? {
                optionEntities: clarification.structuredPayload.optionEntities,
              }
            : {}),
        };

    return {
      ...clarification,
      candidates,
      ...(structuredPayload !== undefined ? { structuredPayload } : {}),
    };
  }

  /**
   * Enrich results with LLM envelope fields (Epic 9):
   * - matchReasons: extracted from high-strength evidence
   * - violatedConstraints: from ConstraintEvaluation.unmet
   */
  private enrichResults(results: readonly ResultItem[]): readonly ResultItem[] {
    return results.map((result) => {
      // Extract matchReasons from evidence items with strength != 'low' and positive contribution.
      // Use Number() instead of parseFloat() so "0.05abc" rejects (NaN) instead of
      // silently coercing to 0.05. Empty string, malformed strings, and Infinity
      // all become NaN → filtered out instead of polluting match reasons.
      const matchReasons = result.evidenceItems
        .filter((ei) => {
          const strength = ei.strength;
          const contrib = Number(ei.contribution);
          return strength !== 'low' && Number.isFinite(contrib) && contrib > 0;
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
    const bindingInferred = filterBindingInferredConstraints(constraints.inferred);
    const hasConstraints =
      constraints.hard.length > 0 ||
      constraints.soft.length > 0 ||
      bindingInferred.length > 0;

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
    const inferredSoft = bindingInferred.map((c) => ({
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
   * Validates the range branch at runtime instead of trusting the cast —
   * an upstream `{min: undefined, max: 100}` would otherwise produce literal
   * "undefined-100" in client-visible responses.
   */
  private constraintValueToString(value: string | number | { min: number; max: number } | ReadonlyArray<string>): string {
    if (typeof value === 'string' || typeof value === 'number') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.join(', ')}]`;
    }
    // Validate the range branch at runtime instead of trusting the type — an
    // upstream `{min: undefined, max: 100}` would otherwise produce literal
    // "undefined-100" in client-visible responses.
    const candidate = value as { min: unknown; max: unknown };
    if (
      typeof candidate.min === 'number'
      && typeof candidate.max === 'number'
      && Number.isFinite(candidate.min)
      && Number.isFinite(candidate.max)
    ) {
      return `${candidate.min}-${candidate.max}`;
    }
    return '[invalid_constraint_value]';
  }

  /**
   * Extract abstain reason from the explicit typed seam (Epic 9 / E6).
   * Free-text decisionTrace.finalReason must never flow into the public enum
   * contract because it breaks HTTP schema validation.
   */
  private extractAbstainReason(
    output: DecisionOutput,
    abstainReason?: AbstainReason,
  ): AbstainReason | undefined {
    if (output.decisionStatus !== 'ambiguous') {
      return undefined;
    }

    // Use structured failureReason field — never rely on free-text finalReason substring matching.
    if (output.failureReason === 'HARD_CONSTRAINT_VIOLATION') {
      return undefined;
    }

    return abstainReason;
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
