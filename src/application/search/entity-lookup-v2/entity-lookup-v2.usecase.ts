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
  LookupDecision,
} from '../../../domain/resolver/v2/lookup-v2-types.js';
import { CalibratedAbstainDecider } from '../../../domain/resolver/v2/calibrated-abstain-decider.js';
import { anchorsHaveExactIdentityEvidence, buildChannelHitsForEntity } from '../../../domain/resolver/v2/channel-provenance.js';
import { clamp01 } from '../../../domain/shared/utils/clamp.js';
import { LOOKUP_RETRIEVAL_CHANNELS } from '../../../domain/resolver/v2/lookup-v2-types.js';
import type { LookupRetrievalChannel } from '../../../domain/resolver/v2/lookup-v2-types.js';
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
  LookupV2ChannelCoverageView,
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
  private readonly decider = new CalibratedAbstainDecider();

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

    // Establish EXACT-identity evidence for the top candidate from a STRICT
    // exact lookup strategy on the anchors that recalled it (not a raw score,
    // not a substring-classified channel). This — and only this — may certify a
    // resolve under untrusted calibration (audit R2 close).
    const top = result.candidates[0];
    const topExactEvidence = top !== undefined && anchorsHaveExactIdentityEvidence(top.entityId, plan.anchors);

    // V2 calibrated-abstain authority — precision-first, downgrade-only over the
    // resolver's advisory status (T-ELV2-05).
    const decision = this.decider.decide(result, plan.queryClass, topExactEvidence);

    pipelineDebug(
      {
        step: PipelineDebugStep.RESOLVE_USE_CASE_DONE,
        resolve_status: result.status,
        decision_status: decision.status,
        decision_reason: decision.reasonCode,
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
      decision,
      decisionReasonCode: decision.reasonCode,
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
    decision?: LookupDecision | undefined;
    forcedStatus?: 'failed' | 'redirect_discovery';
    decisionReasonCode: string;
    startedAt: number;
  }): EntityLookupV2Result {
    const { command, plan, viewsView, admission, result, decision, forcedStatus, decisionReasonCode } = args;

    // Authority order: a forced status (admission/SAT) wins; otherwise the
    // calibrated-abstain decision; otherwise the resolver's advisory status.
    const status = forcedStatus ?? decision?.status ?? mapResolverStatusToLookupStatus(result?.status ?? 'failed');
    const trace = result?.decisionTrace;
    const anchors = plan.anchors;
    // Build the FULL candidate view first (channel provenance per candidate);
    // clarification + coverage are derived from this full set so the
    // max_candidates DISPLAY cap never starves disambiguation/observability
    // (audit R2). Only the surfaced `candidates` list is capped.
    const allCandidates: readonly LookupV2CandidateView[] = result === undefined
      ? []
      : result.candidates.map((c) => {
          // T-ELV2-04: decompose the recall that produced this candidate into
          // the declared V2 channels (exact/compact/transliteration/jamo/fuzzy/
          // family/dense) so the per-channel union is an explicit artifact.
          const channelHits = buildChannelHitsForEntity(
            c.entityId,
            c.rank,
            anchors,
            c.blockerSeed === true,
          );
          return {
            entityId: String(c.entityId),
            canonicalLabel: c.canonicalLabel,
            calibratedScore: clamp01(c.calibratedScore),
            rank: c.rank,
            channelAgreement: channelHits.length,
            channelHits: channelHits.map((h) => ({
              channel: h.channel,
              matchedView: h.matchedView,
              ...(h.matchedAlias !== undefined ? { matchedAlias: h.matchedAlias } : {}),
              channelScore: h.channelScore,
              channelRank: h.channelRank,
            })),
          };
        });

    // The resolver orders by rank, so slicing keeps the strongest candidates.
    const candidates = allCandidates.slice(0, command.maxCandidates);
    const topCandidate = status === 'resolved' ? (candidates[0] ?? null) : null;
    const clarificationOptions: readonly LookupV2ClarificationOptionView[] =
      status === 'ambiguous'
        ? allCandidates.slice(0, LOOKUP_V2_MAX_CLARIFICATION_OPTIONS).map((c) => ({
            entityId: c.entityId,
            label: c.canonicalLabel,
          }))
        : [];

    const queryTimeMs = Math.max(0, performance.now() - args.startedAt);

    // Prefer the decision's human detail on the resolve path; fall back to the
    // canonical reason text for forced (admission/SAT) outcomes.
    const decisionReason =
      decision !== undefined && forcedStatus === undefined
        ? decision.detail
        : decisionReasonText(status, decisionReasonCode, admission);
    const topConfidence = decision?.topConfidence ?? trace?.top1CalibratedScore;
    const top1Top2Margin = decision?.top1Top2Margin ?? trace?.calibratedGap;

    return {
      status,
      decisionReason,
      normalizedQueryViews: viewsView,
      candidates,
      topCandidate,
      clarificationOptions,
      evidenceSummary: {
        admissionReasonCode: admission.reasonCode,
        decisionReasonCode,
        ...(topConfidence !== undefined ? { topConfidence: clamp01(topConfidence) } : {}),
        ...(top1Top2Margin !== undefined ? { top1Top2Margin: clamp01(top1Top2Margin) } : {}),
        calibrationTrusted: decision?.calibrationTrusted ?? trace?.calibrationTrusted ?? false,
        queryClass: plan.queryClass,
        candidatePoolSize: result?.candidates.length ?? 0,
        channelCoverage: buildChannelCoverage(allCandidates),
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

/**
 * Aggregate the per-candidate channel hits into the per-channel coverage rail.
 * Emits one row per channel that actually contributed at least one candidate,
 * in declared-channel order. `latencyMs` is 0 on the reuse path (channels are
 * decomposed from anchor recall, not run as independent timed retrievers — the
 * timed independent runtime lands behind the LookupCandidateRetrievalPort seam).
 */
function buildChannelCoverage(
  candidates: readonly LookupV2CandidateView[],
): readonly LookupV2ChannelCoverageView[] {
  const counts = new Map<LookupRetrievalChannel, number>();
  for (const candidate of candidates) {
    for (const hit of candidate.channelHits) {
      counts.set(hit.channel, (counts.get(hit.channel) ?? 0) + 1);
    }
  }
  const rows: LookupV2ChannelCoverageView[] = [];
  for (const channel of LOOKUP_RETRIEVAL_CHANNELS) {
    const hitCount = counts.get(channel);
    if (hitCount !== undefined && hitCount > 0) {
      rows.push({ channel, firing: true, hitCount, latencyMs: 0 });
    }
  }
  return rows;
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
