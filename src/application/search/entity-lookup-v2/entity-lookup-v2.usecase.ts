/**
 * Entity Lookup V2 use case (T-ELV2-01).
 *
 * Owns the V2 entity-resolution pipeline:
 *
 *   admission gate → plan/normalize → candidate union → resolve+calibrate
 *   → 4-state calibrated decision → response
 *
 * This is a sibling stack to the discovery primitives, NOT a wrapper over the
 * V1 lookup use case (ticket forbidden: "V2를 사실상 V1 wrapper로 만드는 것").
 * It reuses the resolver *primitives* (scoring / calibration / ambiguity) as
 * shared substrate, but owns:
 *   - the front-door admission / concept gate (ahead of any retrieval),
 *   - the 4-state outcome incl. `redirect_discovery`,
 *   - the precision-first calibrated decision mapping,
 *   - the multi-channel provenance projection.
 *
 * The middle of the pipeline (`resolveCandidatePool`) is the seam that
 * T-ELV2-04 (multi-channel retrieval) and T-ELV2-05 (learned rerank +
 * calibrated abstain) will deepen behind the same use-case shape.
 */

import { ConstraintSAT } from '../../../domain/query/service/constraint-sat.js';
import type { QuerySanitizer } from '../../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../../domain/security/port/injection-judge.port.js';
import type { QueryEntrySecurityObserver } from '../../../domain/security/port/security-observer.port.js';
import type {
  BlockingUseCasePort,
  EntityDocumentLookupPort,
  EntityResolverPort,
  QueryPlannerPort,
} from '../port/search-pipeline-deps.port.js';
import type { CanonicalEntityId } from '../../../domain/shared/types/index.js';
import type { ResolverInput } from '../../../domain/resolver/service/resolver.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { NormalizedQueryViews } from '../../../domain/query/model/query-views.js';
import type {
  LookupAdmissionGatePort,
  LookupAdmissionVerdict,
} from '../../../domain/resolver/v2/lookup-v2-types.js';
import { buildResolverCandidatesFromGenerator } from '../search-usecase-resolver-candidates.js';
import { shouldSuppressBlockerSeedExpansion } from '../search-usecase-blocker-seed-policy.js';
import { buildPlannerContextFromSearchRequest } from '../search-usecase-planner-context.js';
import { createSearchQuerySecurityGate } from '../search-usecase-security-gate.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../../domain/observability/request-pipeline-debug.js';
import { PipelineDebugStep } from '../../../domain/observability/pipeline-debug-steps.js';
import { throwIfAborted } from '../../../domain/shared/cooperative-abort.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
import type {
  EntityLookupV2Command,
  EntityLookupV2Result,
  LookupV2CandidateView,
  LookupV2ClarificationOptionView,
  NormalizedQueryViewsView,
} from './entity-lookup-v2.dto.js';
import {
  LOOKUP_V2_ENGINE_VERSION,
  buildNormalizedQueryViewsView,
  decisionReasonText,
  mapResolverStatusToLookupStatus,
} from './entity-lookup-v2-mapping.js';

/** Max clarification options surfaced for an ambiguous lookup (domain cap). */
const LOOKUP_V2_MAX_CLARIFICATION_OPTIONS = 8;

export interface EntityLookupV2UseCaseDeps {
  readonly admissionGate: LookupAdmissionGatePort;
  readonly queryPlanner: QueryPlannerPort;
  readonly entityResolver: EntityResolverPort;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
  readonly blocker?: BlockingUseCasePort | undefined;
  readonly querySanitizer: QuerySanitizer;
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly judgeTimeoutMs?: number | undefined;
  readonly queryEntrySecurityObserver?: QueryEntrySecurityObserver | undefined;
}

export class EntityLookupV2UseCase {
  private readonly constraintSAT = new ConstraintSAT();

  constructor(private readonly deps: EntityLookupV2UseCaseDeps) {}

  async execute(
    command: EntityLookupV2Command,
    options?: RequestExecutionContext,
  ): Promise<EntityLookupV2Result> {
    throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');
    const startedAt = performance.now();

    pipelineDebug(
      {
        step: PipelineDebugStep.RESOLVE_USE_CASE_START,
        query_preview: sanitizeQueryForDebug(command.query),
        ...(command.requestId !== undefined ? { request_id: command.requestId } : {}),
      },
      'pipeline entity-lookup-v2',
    );

    // ── Stage 0: security gate (shared public entry guard) ──────────────────
    const securityGate = createSearchQuerySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
      judgeFailureMode: this.deps.judgeFailureMode,
      judgeTimeoutMs: this.deps.judgeTimeoutMs,
      queryEntrySecurityObserver: this.deps.queryEntrySecurityObserver,
    });
    const effectiveQuery = await securityGate.getSafeQueryOrThrow(command.query);
    throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');

    // ── Stage 1: plan + normalized views (explicit artifact) ────────────────
    const plan = await this.deps.queryPlanner.plan(
      effectiveQuery,
      buildPlannerContextFromSearchRequest(
        { query: effectiveQuery },
        {
          ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          ...(options?.debugRequest === true ? { debugRequest: true } : {}),
        },
      ),
    );
    throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');

    const views: NormalizedQueryViews = plan.normalizedQueryViews ?? synthesizeViews(plan);
    const viewsView = buildNormalizedQueryViewsView(plan);

    // ── Stage 2: admission / concept gate (front-door, pre-retrieval) ───────
    const admission: LookupAdmissionVerdict = this.deps.admissionGate.classify({
      rawQuery: plan.rawQuery,
      views,
      ...(command.locale !== undefined ? { locale: command.locale } : {}),
    });

    if (admission.decision !== 'admit') {
      pipelineDebug(
        {
          step: PipelineDebugStep.RESOLVE_CONSTRAINT_SAT_CONTRADICTED,
          query_class: plan.queryClass,
          admission_reason: admission.reasonCode,
        },
        'pipeline entity-lookup-v2 admission stop',
      );
      return this.buildNonAdmittedResult(command, plan, viewsView, admission, startedAt);
    }

    // ── Stage 3: candidate union (resolver-backed baseline; T-04 deepens) ───
    const sat = this.constraintSAT.check(plan.constraints);
    if (sat.contradicted) {
      return this.finishResult({
        command,
        plan,
        viewsView,
        admission,
        result: undefined,
        forcedStatus: 'failed',
        decisionReasonCode: 'hard_constraint_violation',
        startedAt,
      });
    }

    const result = await this.resolveCandidatePool(plan, options);
    throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');

    pipelineDebug(
      {
        step: PipelineDebugStep.RESOLVE_USE_CASE_DONE,
        resolve_status: result.status,
        candidate_count: result.candidates.length,
        has_top_entity: result.topEntity !== undefined,
      },
      'pipeline entity-lookup-v2',
    );

    return this.finishResult({
      command,
      plan,
      viewsView,
      admission,
      result,
      decisionReasonCode: result.decisionTrace.outcomeReasonCodes[0] ?? result.status,
      startedAt,
    });
  }

  /**
   * Candidate union + resolve. T-ELV2-04 replaces the body with the
   * multi-channel retrieval engine and T-ELV2-05 with the learned reranker;
   * the use-case shape is stable across that swap.
   */
  private async resolveCandidatePool(
    plan: QueryPlanV1,
    options?: RequestExecutionContext,
  ): Promise<EntityResolveResult> {
    let blockerOnlyIds: readonly CanonicalEntityId[] = [];
    if (this.deps.blocker !== undefined && !shouldSuppressBlockerSeedExpansion(plan.anchors)) {
      const allBlockerIds = await this.deps.blocker.block(plan.rawQuery, plan.normalizedQuery);
      const anchorCovered = new Set(plan.anchors.flatMap((a) => a.candidateEntityIds.map(String)));
      blockerOnlyIds = allBlockerIds.filter((id) => !anchorCovered.has(String(id)));
    }

    const candidateEntities = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: plan.rawQuery,
        normalizedQuery: plan.normalizedQuery,
        anchors: plan.anchors,
        ...(blockerOnlyIds.length > 0 ? { blockerOnlyIds } : {}),
      },
      this.deps.entityLookup,
    );

    const resolverInput: ResolverInput = {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      ...(plan.normalizedQueryViews !== undefined
        ? { normalizedQueryViews: plan.normalizedQueryViews }
        : {}),
      queryClass: plan.queryClass,
      policy: plan.policy,
      anchorCandidates: plan.anchors,
      uncertainty: plan.uncertainty,
      candidateEntities,
      blockingPolicy: 'trust_candidate_pool',
    };

    throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');
    return this.deps.entityResolver.resolve(resolverInput);
  }

  private buildNonAdmittedResult(
    command: EntityLookupV2Command,
    plan: QueryPlanV1,
    viewsView: NormalizedQueryViewsView,
    admission: LookupAdmissionVerdict,
    startedAt: number,
  ): EntityLookupV2Result {
    const status = admission.decision === 'redirect_discovery' ? 'redirect_discovery' : 'failed';
    return this.finishResult({
      command,
      plan,
      viewsView,
      admission,
      result: undefined,
      forcedStatus: status,
      decisionReasonCode: admission.reasonCode,
      startedAt,
    });
  }

  private finishResult(args: {
    command: EntityLookupV2Command;
    plan: QueryPlanV1;
    viewsView: NormalizedQueryViewsView;
    admission: LookupAdmissionVerdict;
    result: EntityResolveResult | undefined;
    forcedStatus?: 'failed' | 'redirect_discovery';
    decisionReasonCode: string;
    startedAt: number;
  }): EntityLookupV2Result {
    const { command, plan, viewsView, admission, result, forcedStatus, decisionReasonCode } = args;

    const status = forcedStatus ?? mapResolverStatusToLookupStatus(result?.status ?? 'failed');
    const trace = result?.decisionTrace;
    const candidates: readonly LookupV2CandidateView[] = result === undefined
      ? []
      : result.candidates.map((c) => ({
          entityId: String(c.entityId),
          canonicalLabel: c.canonicalLabel,
          calibratedScore: clamp01(c.calibratedScore),
          rank: c.rank,
          // Multi-channel provenance is filled by T-ELV2-04; the resolver-backed
          // baseline has no per-channel union yet, so agreement is 0 / hits empty.
          channelAgreement: 0,
          channelHits: [],
        }));

    const topCandidate = status === 'resolved' ? (candidates[0] ?? null) : null;
    const clarificationOptions: readonly LookupV2ClarificationOptionView[] =
      status === 'ambiguous'
        ? candidates.slice(0, LOOKUP_V2_MAX_CLARIFICATION_OPTIONS).map((c) => ({
            entityId: c.entityId,
            label: c.canonicalLabel,
          }))
        : [];

    const queryTimeMs = Math.max(0, performance.now() - args.startedAt);

    return {
      status,
      decisionReason: decisionReasonText(status, decisionReasonCode, admission),
      normalizedQueryViews: viewsView,
      candidates,
      topCandidate,
      clarificationOptions,
      evidenceSummary: {
        admissionReasonCode: admission.reasonCode,
        decisionReasonCode,
        ...(trace?.top1CalibratedScore !== undefined
          ? { topConfidence: clamp01(trace.top1CalibratedScore) }
          : {}),
        ...(trace?.calibratedGap !== undefined ? { top1Top2Margin: clamp01(trace.calibratedGap) } : {}),
        calibrationTrusted: trace?.calibrationTrusted ?? false,
        queryClass: plan.queryClass,
        candidatePoolSize: result?.candidates.length ?? 0,
        // Per-channel coverage rail is populated by T-ELV2-04.
        channelCoverage: [],
      },
      meta: {
        ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
        queryTimeMs,
        version: LOOKUP_V2_ENGINE_VERSION,
        engineSchemaVersion: 'entity_lookup_v2',
      },
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * The planner normally produces `normalizedQueryViews`; in the rare case it is
 * absent (older planner path), synthesize a minimal view set from the plan so
 * the admission gate still receives a structured input rather than crashing.
 */
function synthesizeViews(plan: QueryPlanV1): NormalizedQueryViews {
  const q = plan.normalizedQuery;
  return {
    raw: plan.rawQuery,
    strict: q,
    accentless: q,
    collapsedWhitespace: q,
    punctuationStripped: q,
    compact: q.replace(/[^\p{L}\p{N}]/gu, ''),
    vintageCanonicalized: q,
    vintageStripped: q,
    semanticVariants: [q],
    lookupVariants: [q],
  };
}
