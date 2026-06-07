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
import type {
  EntityDocumentLookupPort,
  EntityResolverPort,
  LookupResolverProjectionPort,
} from '../port/search-pipeline-deps.port.js';
import { createCanonicalEntityId, type CanonicalEntityId } from '../../../domain/shared/types/index.js';
import type { ResolverInput } from '../../../domain/resolver/service/resolver.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { NormalizedQueryViews } from '../../../domain/query/model/query-views.js';
import type {
  LookupAdmissionGatePort,
  LookupAdmissionVerdict,
  LookupCandidateRetrievalPort,
  LookupChannelHit,
  LookupDecision,
  LookupRerankDecisionPort,
  LookupRetrievalResult,
  LookupScoredCandidate,
  LookupV2Status,
} from '../../../domain/resolver/v2/lookup-v2-types.js';
import { CalibratedAbstainDecider } from '../../../domain/resolver/v2/calibrated-abstain-decider.js';
import { ambiguityClusterMembershipScore, extractLookupFeatures } from '../../../domain/resolver/v2/lookup-feature-extractor.js';
import { shouldDowngradeForVintageMismatch, VINTAGE_MISMATCH_REASON_CODE } from '../../../domain/resolver/v2/vintage-guard.js';
import type { AliasRegistryVersion } from '../../../domain/alias/model/alias-registry-version.js';
import {
  anchorsHaveExactIdentityEvidence,
  buildChannelHitsForEntity,
  classifyResolveEvidenceGrade,
} from '../../../domain/resolver/v2/channel-provenance.js';
import { buildClarification } from '../../../domain/resolver/v2/clarification-graph.js';
import type { AmbiguityDictionary, AmbiguityInfo } from '../../../domain/query/port/ambiguity-dictionary.port.js';
import { clamp01 } from '../../../domain/shared/utils/clamp.js';
import { LOOKUP_RETRIEVAL_CHANNELS } from '../../../domain/resolver/v2/lookup-v2-types.js';
import type { LookupRetrievalChannel } from '../../../domain/resolver/v2/lookup-v2-types.js';
import { buildNormalizedQueryViews } from '../../../domain/query/service/query-normalizer.js';
import { buildResolverCandidatesFromGenerator } from '../search-usecase-resolver-candidates.js';
import {
  findRawQueryExactSafeSingletonAliasWitness,
  hasDeterministicSingletonAliasWitness,
} from '../search-usecase-blocker-seed-policy.js';
import { isExactLikeLookupStrategy } from '../../../domain/query/service/lookup-strategy-taxonomy.js';
import { EXACT_IDENTITY_MIN_CONFIDENCE } from '../../../domain/resolver/v2/channel-provenance.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../../domain/observability/request-pipeline-debug.js';
import { PipelineDebugStep } from '../../../domain/observability/pipeline-debug-steps.js';
import { throwIfAborted } from '../../../domain/shared/cooperative-abort.js';
import type { RequestExecutionContext } from '../../../domain/shared/request-execution-context.js';
import { PolicyBlockedError } from '../../../domain/shared/error/policy-blocked.js';
import { extractQueryVintageYear } from '../../../domain/shared/utils/vintage.js';
import type { LookupPlannerPort } from './lookup-planner.port.js';
import type { LookupQueryPlan } from './lookup-query-plan.js';
import type { LookupSemanticScopeRegistryPort } from '../../../domain/resolver/v2/lookup-semantic-scope.js';
import type {
  EntityLookupV2Command,
  EntityLookupV2Result,
  LookupV2CandidateView,
  LookupV2ChannelCoverageView,
  LookupV2ChannelHitView,
  LookupV2ClarificationOptionView,
  NormalizedQueryViewsView,
} from './entity-lookup-v2.dto.js';
import {
  LOOKUP_V2_ENGINE_VERSION,
  buildNormalizedQueryViewsView,
  decisionReasonText,
  mapResolverStatusToLookupStatus,
  projectNormalizedQueryViews,
} from './entity-lookup-v2-mapping.js';

/**
 * Max clarification options surfaced for an ambiguous lookup — a UX cap (a
 * disambiguation prompt with >8 options is not actionable). MUST stay <= the
 * wire bound MAX_LOOKUP_V2_CLARIFICATION_OPTIONS (20) in the HTTP schema; kept
 * as a local domain constant rather than importing the interface-layer bound to
 * avoid an application→interface layer dependency.
 */
const LOOKUP_V2_MAX_CLARIFICATION_OPTIONS = 8;
const PERSISTED_AMBIGUITY_SURFACE_REASON_CODE = 'persisted_ambiguity_surface';
const RECALL_ONLY_NO_MATCH_REASON_CODE = 'recall_only_no_match';
const REVIEWED_FAMILY_COLLISION_REASON_CODE = 'reviewed_family_collision_requires_clarification';
// A reviewed, APPROVED semantic-scope-target that pins the query scope to a
// SINGLE catalog entity is identity-bearing authority — it resolves a reviewed
// family collision to that anchor instead of demanding clarification. Without
// this, an approved scope-target is only a recall seed and the surface stays
// ambiguous forever (collision never breaks). See
// [[project_elv2_scope_target_recall_only_runtime]].
const REVIEWED_SCOPE_TARGET_RESOLVED_REASON_CODE = 'reviewed_scope_target_resolved';
const NON_IDENTITY_STRATEGY_MARKER = /fuzzy|ngram|trigram|edit|prefix|inexact|lexical|phonetic|fallback/u;

export interface EntityLookupV2UseCaseDeps {
  readonly admissionGate: LookupAdmissionGatePort;
  readonly lookupPlanner: LookupPlannerPort;
  readonly entityResolver: EntityResolverPort;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
  readonly resolverProjectionLookup?: LookupResolverProjectionPort | undefined;
  readonly semanticScopeRegistry?: LookupSemanticScopeRegistryPort | undefined;
  /**
   * T-ELV2-04: independent timed multi-channel retrieval. When present, the
   * response's per-channel coverage + per-candidate channel provenance come
   * from REAL timed channels (not the anchor re-projection); when absent the
   * use case falls back to deriving channels from planner anchors.
   */
  readonly candidateRetrieval?: LookupCandidateRetrievalPort | undefined;
  /**
   * T-ELV2-05: learned reranker. When present its learned decision is COMBINED
   * with the calibrated-abstain decision via "most conservative wins" — the
   * model can only TIGHTEN the outcome, never make V2 less precise than the
   * audit-hardened calibrated gates.
   */
  readonly reranker?: LookupRerankDecisionPort | undefined;
  /**
   * T-ELV2-06: persisted ambiguity substrate (the existing AmbiguityDictionary,
   * backed by canonical_ambiguity_registry). When present, an ambiguous outcome
   * is enriched with the registry's authoritative ambiguity types + severity,
   * overriding the in-process label-graph classification.
   */
  readonly ambiguityDictionary?: AmbiguityDictionary | undefined;
  /** T-ELV2-03: dedicated alias-registry version identity, surfaced on meta. */
  readonly aliasRegistryVersion?: AliasRegistryVersion | undefined;
  readonly querySanitizer: QuerySanitizer;
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
    options?.stageTimer?.start('lookup.total');
    try {

      pipelineDebug(
        {
          step: PipelineDebugStep.RESOLVE_USE_CASE_START,
          query_preview: sanitizeQueryForDebug(command.query),
          ...(command.requestId !== undefined ? { request_id: command.requestId } : {}),
        },
        'pipeline entity-lookup-v2',
      );

    // ── Stage 0: deterministic query sanitizer only. Lookup is a bounded
    // public entity-resolution surface, not an LLM prompt surface, so it keeps
    // Layer 1 static blocking but does NOT pay the Layer 2 LLM judge tax.
    options?.stageTimer?.start('security_gate');
    const sanitization = this.deps.querySanitizer.sanitize(command.query);
    options?.stageTimer?.end('security_gate');
    if (!sanitization.safe) {
      throw new PolicyBlockedError(undefined, {
        layer: 'LAYER_1_BLOCKED',
        reason: sanitization.reason,
      });
    }
    const effectiveQuery = sanitization.sanitizedQuery;
    throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');

    // ── Stage 1: FRONT-DOOR admission — runs on a STANDALONE normalizer BEFORE
    //    the planner. This is the true pre-retrieval gate: a concept/under-spec
    //    query is closed here WITHOUT invoking queryPlanner (which, for the
    //    entity lane, performs NL parse + alias-overlay anchor refresh). The
    //    planner is reached only for admitted queries.
    const frontDoorViews = buildNormalizedQueryViews(effectiveQuery);
    const admission: LookupAdmissionVerdict = this.deps.admissionGate.classify({
      rawQuery: effectiveQuery,
      views: frontDoorViews,
      ...(command.locale !== undefined ? { locale: command.locale } : {}),
    });

      if (admission.decision !== 'admit') {
        pipelineDebug(
          {
            step: PipelineDebugStep.RESOLVE_USE_CASE_START,
            admission_reason: admission.reasonCode,
          },
          'pipeline entity-lookup-v2 admission stop (front-door, pre-planner)',
        );
        return this.buildNonAdmittedResult(command, frontDoorViews, admission, startedAt);
      }

    // ── Stage 2: plan + normalized views (admitted queries only) ────────────
      options?.stageTimer?.start('planner.total');
      const plan = await this.deps.lookupPlanner.plan(
        effectiveQuery,
        {
          ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          ...(options?.stageTimer !== undefined ? { stageTimer: options.stageTimer } : {}),
        },
      ).finally(() => {
        options?.stageTimer?.end('planner.total');
      });
    throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');

      const viewsView = buildNormalizedQueryViewsView(plan);
      const exactSafeSingletonWitness = findRawQueryExactSafeSingletonAliasWitness(
        plan.rawQuery,
        plan.normalizedQuery,
        plan.anchors,
      );
      const prefetchedPersistedAmbiguity = await this.prefetchKnownShortAmbiguity(plan, options);
      if (
        prefetchedPersistedAmbiguity !== null
        && exactSafeSingletonWitness === undefined
        && !hasDeterministicSingletonAliasWitness(plan.anchors)
        && !hasHighConfidenceStrictExactSingletonAnchor(plan.anchors)
      ) {
        return this.finishResult({
          command,
          plan,
          viewsView,
          admission,
          result: undefined,
          persistedAmbiguity: prefetchedPersistedAmbiguity,
          forcedStatus: 'ambiguous',
          decisionReasonCode: PERSISTED_AMBIGUITY_SURFACE_REASON_CODE,
          startedAt,
          ...(options?.stageTimer !== undefined ? { stageTimer: options.stageTimer } : {}),
        });
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

    // T-ELV2-04: run the independent timed multi-channel retrieval engine (when
    // wired) for REAL per-channel coverage + provenance, alongside the resolver
    // which scores/calibrates. Channel failures are isolated inside the engine.
      const retrieval = this.deps.candidateRetrieval !== undefined
        ? await this.runRetrieval(
          this.deps.candidateRetrieval,
          plan,
          command,
          exactSafeSingletonWitness?.entityId,
          options,
        )
        : undefined;

      const result = await this.resolveCandidatePool(
        plan,
        retrieval,
        exactSafeSingletonWitness?.entityId,
        command.locale,
        options,
      );
      throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');

    // Build the top candidate's resolve certificate. Exact-identity evidence
    // from anchors wins immediately; otherwise fall back to the retrieval
    // channel provenance so V2 can distinguish identity-grade, supportive-only,
    // and recall-only heads before trusting a calibrated resolve.
      const top = result.candidates[0];
      const topEvidenceGrade = top === undefined
        ? 'none'
        : anchorsHaveExactIdentityEvidence(top.entityId, plan.anchors)
          ? 'identity_grade'
          : classifyResolveEvidenceGrade(
              retrieval?.candidates.find((candidate) => candidate.entityId === top.entityId)?.channelHits
              ?? buildChannelHitsForEntity(top.entityId, top.rank, plan.anchors, top.blockerSeed === true),
            );

    // V2 calibrated-abstain authority — precision-first, downgrade-only over the
    // resolver's advisory status.
      const calibrated = this.decider.decide(result, plan.queryClass, topEvidenceGrade);

    // T-ELV2-05: combine with the learned reranker (when wired) — most
    // conservative status wins, so the model can only tighten, never relax the
    // audit-hardened calibrated gates.
      let decision = calibrated;
      if (this.deps.reranker !== undefined && result.candidates.length > 0) {
      // Reranker-gated: populate the persisted ambiguity-cluster membership feature
      // ONLY when the learned reranker actually consumes it — zero PG/feature cost
      // in the default LTR-OFF build (the reranker is omitted there).
        const clusterMembership = await this.buildClusterMembership(plan.normalizedQuery, options?.abortSignal);
        const learned = await this.deps.reranker.decide({
          queryClass: plan.queryClass,
          scored: buildScoredCandidates(result, retrieval, clusterMembership),
        });
        decision = combineDecisions(calibrated, learned);
      }

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

    // T-ELV2-06: enrich an ambiguous outcome with the PERSISTED ambiguity graph
    // (registry-backed) — authoritative types + severity override the in-process
    // label-graph classification. Degradation-safe (null on miss/unavailable).
      let persistedAmbiguity = prefetchedPersistedAmbiguity;
      if (
        (
          decision.status === 'ambiguous'
          || (
            decision.status === 'failed'
            && (plan.queryClass === 'short_entity' || plan.queryClass === 'ambiguous_short_form')
          )
        )
        && persistedAmbiguity === null
        && this.deps.ambiguityDictionary !== undefined
      ) {
        options?.stageTimer?.start('ambiguity_lookup');
        persistedAmbiguity = await this.deps.ambiguityDictionary
          .getAmbiguityInfo(plan.normalizedQuery, options?.abortSignal)
          .catch(() => null)
          .finally(() => {
            options?.stageTimer?.end('ambiguity_lookup');
          });
      }

      return this.finishResult({
        command,
        plan,
        viewsView,
        admission,
        result,
        decision,
        ...(retrieval !== undefined ? { retrieval } : {}),
        ...(persistedAmbiguity !== null ? { persistedAmbiguity } : {}),
        decisionReasonCode: decision.reasonCode,
        startedAt,
        ...(options?.stageTimer !== undefined ? { stageTimer: options.stageTimer } : {}),
      });
    } finally {
      options?.stageTimer?.end('lookup.total');
    }
  }

  /**
   * Build a per-entity ambiguity-cluster membership signal from the persisted
   * ambiguity graph (T-ELV2-06 Half A). Returns a constant-0 function when no
   * dictionary is wired or the query has no known cluster (≥2 members), so the
   * caller pays nothing extra in that case. Degradation-safe (0 on fetch error).
   */
  private async buildClusterMembership(
    normalizedQuery: string,
    signal: AbortSignal | undefined,
  ): Promise<(entityId: string) => number> {
    if (this.deps.ambiguityDictionary === undefined) return () => 0;
    const info = await this.deps.ambiguityDictionary
      .getAmbiguityInfo(normalizedQuery, signal)
      .catch(() => null);
    const ids = info?.entityIds;
    if (ids === undefined || ids.length < 2) return () => 0;
    const members = new Set<string>(ids);
    const size = ids.length;
    return (entityId: string) => ambiguityClusterMembershipScore(members.has(entityId), size);
  }

  /** Run the multi-channel retrieval engine; never let it sink the request. */
  private async runRetrieval(
    engine: LookupCandidateRetrievalPort,
    plan: LookupQueryPlan,
    command: EntityLookupV2Command,
    exactSafeWitnessEntityId: CanonicalEntityId | undefined,
    options?: RequestExecutionContext,
  ): Promise<LookupRetrievalResult | undefined> {
    try {
      options?.stageTimer?.start('retrieval.total');
      return await engine.retrieve(
        {
          rawQuery: plan.rawQuery,
          views: plan.normalizedQueryViews ?? buildNormalizedQueryViews(plan.rawQuery),
          queryClass: plan.queryClass,
          maxCandidates: command.maxCandidates,
          suppressFamilyGraphExpansion:
            exactSafeWitnessEntityId !== undefined
            || hasDeterministicSingletonAliasWitness(plan.anchors),
          ...(command.locale !== undefined ? { locale: command.locale } : {}),
          ...(options?.stageTimer !== undefined ? { stageTimer: options.stageTimer } : {}),
        },
        options?.abortSignal,
      ).finally(() => {
        options?.stageTimer?.end('retrieval.total');
      });
    } catch {
      // Provenance is best-effort: fall back to the anchor re-projection.
      return undefined;
    }
  }

  /**
   * Candidate union + resolve. T-ELV2-04 replaces the body with the
   * multi-channel retrieval engine and T-ELV2-05 with the learned reranker;
   * the use-case shape is stable across that swap.
   */
  private async resolveCandidatePool(
    plan: LookupQueryPlan,
    retrieval: LookupRetrievalResult | undefined,
    exactSafeWitnessEntityId: CanonicalEntityId | undefined,
    locale: string | undefined,
    options?: RequestExecutionContext,
  ): Promise<EntityResolveResult> {
    // Seed the resolver pool from EVERY recall source not already covered by an
    // alias anchor: the high-recall blocker AND the T-ELV2-04 independent
    // multi-channel retrieval engine. This makes V2 resolve over the union of
    // channels — not just the planner's anchor extraction (reviewer P2 #3:
    // "replace planner/resolver reuse with the real multi-channel retriever").
    const effectiveAnchors = exactSafeWitnessEntityId === undefined
      ? plan.anchors
      : plan.anchors.filter((anchor) =>
        anchor.source === 'alias'
        && anchor.candidateEntityIds.length === 1
        && String(anchor.candidateEntityIds[0]) === String(exactSafeWitnessEntityId),
      );
    const anchorCovered = new Set(effectiveAnchors.flatMap((a) => a.candidateEntityIds.map(String)));
    const seeds = new Map<string, CanonicalEntityId>();
    if (this.deps.semanticScopeRegistry !== undefined) {
      for (const match of this.deps.semanticScopeRegistry.findMatches({
        query: plan.rawQuery,
        views: plan.normalizedQueryViews ?? buildNormalizedQueryViews(plan.rawQuery),
        locale: locale !== undefined && locale.toLowerCase().startsWith('ko') ? 'ko' : 'global',
      })) {
        if (
          exactSafeWitnessEntityId !== undefined
          && String(match.entityId) !== String(exactSafeWitnessEntityId)
        ) {
          continue;
        }
        const entityId = createCanonicalEntityId(match.entityId);
        const key = String(entityId);
        if (!anchorCovered.has(key)) {
          seeds.set(key, entityId);
        }
      }
    }
    if (retrieval !== undefined) {
      for (const candidate of retrieval.candidates) {
        const key = String(candidate.entityId);
        if (
          exactSafeWitnessEntityId !== undefined
          && key !== String(exactSafeWitnessEntityId)
        ) {
          continue;
        }
        if (!anchorCovered.has(key)) seeds.set(key, candidate.entityId);
      }
    }
    const blockerOnlyIds: readonly CanonicalEntityId[] = [...seeds.values()];

    options?.stageTimer?.start('candidate_generation');
    const candidateEntities = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: plan.rawQuery,
        normalizedQuery: plan.normalizedQuery,
        anchors: effectiveAnchors,
        ...(blockerOnlyIds.length > 0 ? { blockerOnlyIds } : {}),
      },
      this.deps.entityLookup,
      this.deps.resolverProjectionLookup,
    ).finally(() => {
      options?.stageTimer?.end('candidate_generation');
    });

    const resolverInput: ResolverInput = {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      ...(plan.normalizedQueryViews !== undefined
        ? { normalizedQueryViews: plan.normalizedQueryViews }
        : {}),
      queryClass: plan.queryClass,
      policy: plan.policy,
      anchorCandidates: effectiveAnchors,
      uncertainty: plan.uncertainty,
      candidateEntities,
      blockingPolicy: 'trust_candidate_pool',
    };

    throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');
    options?.stageTimer?.start('resolver');
    return this.deps.entityResolver.resolve(resolverInput)
      .finally(() => {
        options?.stageTimer?.end('resolver');
      });
  }

  private async prefetchKnownShortAmbiguity(
    plan: LookupQueryPlan,
    options?: RequestExecutionContext,
  ): Promise<AmbiguityInfo | null> {
    if (this.deps.ambiguityDictionary === undefined) {
      return null;
    }
    if (findRawQueryExactSafeSingletonAliasWitness(plan.rawQuery, plan.normalizedQuery, plan.anchors) !== undefined) {
      return null;
    }
    if (hasDeterministicSingletonAliasWitness(plan.anchors)) {
      return null;
    }
    if (hasHighConfidenceStrictExactSingletonAnchor(plan.anchors)) {
      return null;
    }
    options?.stageTimer?.start('ambiguity_lookup');
    return this.deps.ambiguityDictionary
      .getAmbiguityInfo(plan.normalizedQuery, options?.abortSignal)
      .catch(() => null)
      .finally(() => {
        options?.stageTimer?.end('ambiguity_lookup');
      });
  }

  /**
   * Build the terminal result for a query the FRONT-DOOR gate did not admit —
   * WITHOUT a plan, candidates, or any retrieval (the planner was never run).
   */
  private buildNonAdmittedResult(
    command: EntityLookupV2Command,
    frontDoorViews: NormalizedQueryViews,
    admission: LookupAdmissionVerdict,
    startedAt: number,
  ): EntityLookupV2Result {
    const status: 'redirect_discovery' | 'failed' =
      admission.decision === 'redirect_discovery' ? 'redirect_discovery' : 'failed';
    const queryTimeMs = Math.max(0, performance.now() - startedAt);
    return {
      status,
      decisionReason: decisionReasonText(status, admission.reasonCode, admission),
      normalizedQueryViews: projectNormalizedQueryViews(frontDoorViews),
      candidates: [],
      topCandidate: null,
      clarificationOptions: [],
      evidenceSummary: {
        admissionReasonCode: admission.reasonCode,
        decisionReasonCode: admission.reasonCode,
        calibrationTrusted: false,
        // No plan was produced — the gate closed the query before classification.
        queryClass: 'unspecified',
        candidatePoolSize: 0,
        channelCoverage: [],
      },
      meta: {
        ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
        queryTimeMs,
        version: LOOKUP_V2_ENGINE_VERSION,
        engineSchemaVersion: 'entity_lookup_v2',
        ...(this.deps.aliasRegistryVersion !== undefined
          ? { aliasRegistry: this.deps.aliasRegistryVersion }
          : {}),
      },
    };
  }

  /**
   * Breaks a reviewed family collision by candidate identity: if EXACTLY ONE of
   * the colliding candidates is a reviewed APPROVED scope-target anchor (the
   * grand vin / sole catalog entity for its family), that anchor is the answer.
   *
   * This is identity-by-candidate, not by query text — Korean surfaces like
   * "샤또 앙젤뤼스" cannot be text-matched to the latin-keyed scope, but the
   * reviewed_family_recall channel already surfaces the family's entities as
   * candidates, so we pick the reviewed anchor among them.
   *
   * Precision-first: returns undefined unless there is exactly one anchor
   * candidate, and never resolves to an anchor whose vintage contradicts the
   * query's explicit vintage token.
   */
  private resolveReviewedScopeTargetIdentity(args: {
    readonly command: EntityLookupV2Command;
    readonly allCandidates: readonly LookupV2CandidateView[];
  }): string | undefined {
    const registry = this.deps.semanticScopeRegistry;
    if (registry === undefined) {
      return undefined;
    }
    const anchorIds = registry.getReviewedTargetEntityIds();
    if (anchorIds.size === 0) {
      return undefined;
    }
    const anchorCandidates = args.allCandidates.filter((c) => anchorIds.has(c.entityId));
    const anchor = anchorCandidates.length === 1 ? anchorCandidates[0] : undefined;
    if (anchor === undefined) {
      return undefined;
    }
    // Require multi-channel corroboration: a genuine family-core match fires
    // dense + family/line graph channels, whereas a collapsed typo only fuzzily
    // recalls on a single channel. Snapping a single-channel fuzzy hit to the
    // anchor would resurrect typo/no-match queries the gold expects to fail.
    if (anchor.channelAgreement < 2) {
      return undefined;
    }
    if (shouldDowngradeForVintageMismatch(args.command.query, anchor.canonicalLabel)) {
      return undefined;
    }
    return anchor.entityId;
  }

  private finishResult(args: {
    command: EntityLookupV2Command;
    plan: LookupQueryPlan;
    viewsView: NormalizedQueryViewsView;
    admission: LookupAdmissionVerdict;
    result: EntityResolveResult | undefined;
    decision?: LookupDecision | undefined;
    retrieval?: LookupRetrievalResult | undefined;
    persistedAmbiguity?: AmbiguityInfo | undefined;
    forcedStatus?: 'ambiguous' | 'failed' | 'redirect_discovery';
    decisionReasonCode: string;
    startedAt: number;
    stageTimer?: RequestExecutionContext['stageTimer'];
  }): EntityLookupV2Result {
    const { command, plan, viewsView, admission, result, decision, retrieval, persistedAmbiguity, forcedStatus, decisionReasonCode, stageTimer } = args;

    // T-ELV2-04: when the independent timed retrieval engine ran, index its REAL
    // per-channel hits by entity so resolved candidates carry real provenance
    // (and the coverage rail carries real latency) instead of the anchor
    // re-projection.
    const retrievalHitsByEntity = new Map<string, readonly LookupV2ChannelHitView[]>();
    if (retrieval !== undefined) {
      for (const rc of retrieval.candidates) {
        retrievalHitsByEntity.set(
          String(rc.entityId),
          rc.channelHits.map((h) => ({
            channel: h.channel,
            matchedView: h.matchedView,
            ...(h.matchedAlias !== undefined ? { matchedAlias: h.matchedAlias } : {}),
            channelScore: h.channelScore,
            channelRank: h.channelRank,
          })),
        );
      }
    }

    // Authority order: a forced status (admission/SAT) wins; otherwise the
    // calibrated-abstain decision; otherwise the resolver's advisory status.
    let status = forcedStatus ?? decision?.status ?? mapResolverStatusToLookupStatus(result?.status ?? 'failed');
    // Precision-first vintage guard: a resolve to an entity whose vintage differs
    // from the query's EXPLICIT vintage token is NOT a confident single resolve —
    // downgrade to ambiguous (multi-vintage). Exact year compare, downgrade-only.
    // Closes the 2026-06-02 shadow cutover blocker (오퍼스원 2019 → Opus One 2018).
    const vintageMismatch =
      status === 'resolved'
      && shouldDowngradeForVintageMismatch(command.query, result?.candidates[0]?.canonicalLabel);
    if (vintageMismatch) {
      status = 'ambiguous';
    }
    const trace = result?.decisionTrace;
    const anchors = plan.anchors;
    // Build the FULL candidate view first (channel provenance per candidate);
    // clarification + coverage are derived from this full set so the
    // max_candidates DISPLAY cap never starves disambiguation/observability
    // (audit R2). Only the surfaced `candidates` list is capped.
    const allCandidates: readonly LookupV2CandidateView[] = result === undefined
      ? []
      : result.candidates.map((c) => {
          // Prefer REAL independent-channel hits from the retrieval engine
          // (T-ELV2-04); fall back to decomposing the planner anchor recall.
          const realHits = retrievalHitsByEntity.get(String(c.entityId));
          const channelHits: readonly LookupV2ChannelHitView[] = realHits ?? buildChannelHitsForEntity(
            c.entityId,
            c.rank,
            anchors,
            c.blockerSeed === true,
          ).map((h) => ({
            channel: h.channel,
            matchedView: h.matchedView,
            ...(h.matchedAlias !== undefined ? { matchedAlias: h.matchedAlias } : {}),
            channelScore: h.channelScore,
            channelRank: h.channelRank,
          }));
          return {
            entityId: String(c.entityId),
            canonicalLabel: c.canonicalLabel,
            calibratedScore: clamp01(c.calibratedScore),
            rank: c.rank,
            channelAgreement: channelHits.length,
            channelHits,
          };
        });
    let effectiveDecisionReasonCode = vintageMismatch ? VINTAGE_MISMATCH_REASON_CODE : decisionReasonCode;
    if (
      status === 'failed'
      && forcedStatus === undefined
      && persistedAmbiguity !== undefined
    ) {
      status = 'ambiguous';
      effectiveDecisionReasonCode = PERSISTED_AMBIGUITY_SURFACE_REASON_CODE;
    }
    // Reviewed semantic-scope-target authority resolves BEFORE the collision
    // gate: an approved scope-target that pins this query scope to a single
    // catalog entity present in the pool is identity-bearing and breaks the
    // reviewed family collision (precision-first: abstain if the matches span
    // more than one entity, or the target is not actually a candidate).
    // Only RESCUE an ambiguous (collision) decision — never override a `failed`
    // verdict. `failed` means the resolver rejected every candidate (e.g. a
    // typo too far from any alias); promoting a fuzzily-recalled anchor there
    // would resurrect no-match/typo queries the gold expects to fail.
    const reviewedScopeTargetEntityId =
      forcedStatus === undefined
      && persistedAmbiguity === undefined
      && !vintageMismatch
      && status === 'ambiguous'
      && extractQueryVintageYear(command.query) === null
      && hasReviewedFamilyCollisionClarificationEvidence(allCandidates)
        ? this.resolveReviewedScopeTargetIdentity({ command, allCandidates })
        : undefined;
    if (reviewedScopeTargetEntityId !== undefined) {
      status = 'resolved';
      effectiveDecisionReasonCode = REVIEWED_SCOPE_TARGET_RESOLVED_REASON_CODE;
    }
    if (
      forcedStatus === undefined
      && persistedAmbiguity === undefined
      && reviewedScopeTargetEntityId === undefined
      && hasReviewedFamilyCollisionClarificationEvidence(allCandidates)
      && !hasAnyIdentityBearingEvidence(result, plan)
      && (status === 'failed' || status === 'ambiguous')
    ) {
      status = 'ambiguous';
      effectiveDecisionReasonCode = REVIEWED_FAMILY_COLLISION_REASON_CODE;
    }
    if (
      status === 'ambiguous'
      && forcedStatus === undefined
      && persistedAmbiguity === undefined
      && effectiveDecisionReasonCode !== REVIEWED_FAMILY_COLLISION_REASON_CODE
      && (
        hasOnlyRecallOnlyCandidateEvidence(allCandidates)
        || !hasAnyIdentityBearingEvidence(result, plan)
      )
    ) {
      status = 'failed';
      effectiveDecisionReasonCode = RECALL_ONLY_NO_MATCH_REASON_CODE;
    }

    // The resolver orders by rank, so slicing keeps the strongest candidates.
    // When a reviewed scope-target resolved the collision, surface that anchor
    // first so it becomes the top candidate.
    const orderedCandidates = reviewedScopeTargetEntityId !== undefined
      ? [
          ...allCandidates.filter((c) => c.entityId === reviewedScopeTargetEntityId),
          ...allCandidates.filter((c) => c.entityId !== reviewedScopeTargetEntityId),
        ]
      : allCandidates;
    const candidates = orderedCandidates.slice(0, command.maxCandidates);
    const topCandidate = status === 'resolved' ? (candidates[0] ?? null) : null;
    // T-ELV2-06: graph-backed clarification (kind + distinguishing features) for
    // ambiguous outcomes; ambiguity types/severity prefer the persisted graph.
    let clarification;
    if (status === 'ambiguous' && allCandidates.length > 0) {
      stageTimer?.start('clarification');
      clarification = buildClarification(
        allCandidates
          .slice(0, LOOKUP_V2_MAX_CLARIFICATION_OPTIONS)
          .map((c) => ({ entityId: c.entityId, canonicalLabel: c.canonicalLabel })),
      );
      stageTimer?.end('clarification');
    }
    const clarificationOptions: readonly LookupV2ClarificationOptionView[] =
      clarification?.options.map((o) => ({
        entityId: o.entityId,
        label: o.label,
        ...(o.distinguishingFeature !== undefined ? { distinguishingFeature: o.distinguishingFeature } : {}),
      })) ?? [];
    const ambiguityTypes = persistedAmbiguity?.types ?? clarification?.ambiguityTypes;

    const queryTimeMs = Math.max(0, performance.now() - args.startedAt);

    // Prefer the decision's human detail on the resolve path; fall back to the
    // canonical reason text for forced (admission/SAT) outcomes.
    const decisionReason = vintageMismatch
      ? 'The matched wine is a different vintage than the one requested; clarify which vintage you mean.'
      : decision !== undefined && forcedStatus === undefined && effectiveDecisionReasonCode === decisionReasonCode
        ? decision.detail
        : decisionReasonText(status, effectiveDecisionReasonCode, admission);
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
        decisionReasonCode: effectiveDecisionReasonCode,
        ...(topConfidence !== undefined ? { topConfidence: clamp01(topConfidence) } : {}),
        ...(top1Top2Margin !== undefined ? { top1Top2Margin: clamp01(top1Top2Margin) } : {}),
        calibrationTrusted: decision?.calibrationTrusted ?? trace?.calibrationTrusted ?? false,
        queryClass: plan.queryClass,
        candidatePoolSize: result?.candidates.length ?? 0,
        // Real per-channel coverage (latency/hitCount) from the timed retrieval
        // engine when it ran; else derive a rail from the anchor re-projection.
        channelCoverage: retrieval !== undefined
          ? retrieval.coverage.map((c) => ({
              channel: c.channel,
              firing: c.firing,
              hitCount: c.hitCount,
              latencyMs: c.latencyMs,
            }))
          : buildChannelCoverage(allCandidates),
        // T-ELV2-06: surface the structured clarification contract for ambiguous
        // outcomes (kind + ambiguity types from the persisted graph when available,
        // else the in-process classifier; severity only from the persisted graph).
        ...(clarification !== undefined ? { clarificationKind: clarification.kind } : {}),
        ...(ambiguityTypes !== undefined && ambiguityTypes.length > 0 ? { ambiguityTypes } : {}),
        ...(persistedAmbiguity !== undefined ? { ambiguitySeverity: persistedAmbiguity.severity } : {}),
      },
      meta: {
        ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
        queryTimeMs,
        version: LOOKUP_V2_ENGINE_VERSION,
        engineSchemaVersion: 'entity_lookup_v2',
        ...(this.deps.aliasRegistryVersion !== undefined
          ? { aliasRegistry: this.deps.aliasRegistryVersion }
          : {}),
      },
    };
  }
}

function hasHighConfidenceStrictExactSingletonAnchor(
  anchors: LookupQueryPlan['anchors'],
): boolean {
  return anchors.some((anchor) => {
    if (anchor.source !== 'alias' || anchor.candidateEntityIds.length !== 1) {
      return false;
    }
    if (anchor.confidence < EXACT_IDENTITY_MIN_CONFIDENCE) {
      return false;
    }
    const strategies = anchor.lookupStrategies ?? [];
    if (!strategies.some((strategy) => isExactLikeLookupStrategy(strategy))) {
      return false;
    }
    if (strategies.some((strategy) => NON_IDENTITY_STRATEGY_MARKER.test(strategy.toLowerCase()))) {
      return false;
    }
    return true;
  });
}

/**
 * Build the learned-reranker input from the resolver candidates + the engine's
 * per-entity channel provenance (features derived from real channel hits).
 */
function buildScoredCandidates(
  result: EntityResolveResult,
  retrieval: LookupRetrievalResult | undefined,
  /** Persisted ambiguity-cluster membership signal per entity (0 when unknown). */
  clusterMembership: (entityId: string) => number = () => 0,
): readonly LookupScoredCandidate[] {
  const hitsByEntity = new Map<string, {
    readonly hits: readonly LookupChannelHit[];
    readonly entityType: string;
    readonly scopeFeatureHints?: {
      readonly lineGraphProximity?: number | undefined;
      readonly vintageGraphProximity?: number | undefined;
      readonly scopeQualifierAgreement?: number | undefined;
      readonly scopeAxisAgreement?: number | undefined;
    } | undefined;
  }>();
  if (retrieval !== undefined) {
    for (const rc of retrieval.candidates) {
      hitsByEntity.set(String(rc.entityId), {
        hits: rc.channelHits,
        entityType: rc.entityType,
        ...(rc.scopeFeatureHints !== undefined ? { scopeFeatureHints: rc.scopeFeatureHints } : {}),
      });
    }
  }
  return result.candidates.map((c) => {
    const engine = hitsByEntity.get(String(c.entityId));
    const channelHits = engine?.hits ?? [];
    return {
      entityId: c.entityId,
      canonicalLabel: c.canonicalLabel,
      entityType: engine?.entityType ?? 'unknown',
      calibratedScore: c.calibratedScore,
      rank: c.rank,
      features: extractLookupFeatures(
        channelHits,
        c.calibratedScore,
        clusterMembership(String(c.entityId)),
        engine?.scopeFeatureHints,
      ),
      channelHits,
    };
  });
}

/** Conservatism rank — lower is more conservative (failed < ambiguous < resolved). */
const DECISION_CONSERVATISM: Readonly<Record<Exclude<LookupV2Status, 'redirect_discovery'>, number>> = {
  failed: 0,
  ambiguous: 1,
  resolved: 2,
};

/**
 * Combine the calibrated and learned decisions — the MORE conservative status
 * wins (downgrade-only over both), so the learned reranker can only tighten the
 * audit-hardened calibrated outcome, never relax it.
 *
 * On a STATUS TIE we surface the learned decision's reason/scores (visibility),
 * but PRESERVE the stronger calibration trust: the learned decider always emits
 * calibrationTrusted=false, so naively returning it would silently downgrade a
 * calibrated trusted resolve's trust flag for precision-first consumers. A tie
 * must never downgrade trust — only a strictly-more-conservative learned status
 * may change the decision. (DECISION_CONSERVATISM and LookupDecision.status are
 * the same `Exclude<LookupV2Status,'redirect_discovery'>` type, so the rank
 * lookup can never be undefined — no runtime guard needed; do not widen the type
 * without re-checking.)
 */
export function combineDecisions(calibrated: LookupDecision, learned: LookupDecision): LookupDecision {
  const calRank = DECISION_CONSERVATISM[calibrated.status];
  const learnedRank = DECISION_CONSERVATISM[learned.status];
  if (learnedRank < calRank) return learned;
  if (calRank < learnedRank) return calibrated;
  // Tie: surface learned, but trust is the OR (a tie cannot downgrade trust).
  return { ...learned, calibrationTrusted: calibrated.calibrationTrusted || learned.calibrationTrusted };
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

function hasOnlyRecallOnlyCandidateEvidence(
  candidates: readonly LookupV2CandidateView[],
): boolean {
  return candidates.length > 0
    && candidates.every((candidate) => {
      const grade = classifyResolveEvidenceGrade(candidate.channelHits);
      return grade === 'recall_only' || grade === 'none';
    });
}

function hasReviewedFamilyCollisionClarificationEvidence(
  candidates: readonly LookupV2CandidateView[],
): boolean {
  if (candidates.length < 2) {
    return false;
  }
  const matchedAliases = new Set<string>();
  for (const candidate of candidates) {
    const reviewedFamilyHits = candidate.channelHits.filter((hit) =>
      hit.channel === 'dense'
      && hit.matchedView === 'reviewed_family_recall'
      && typeof hit.matchedAlias === 'string'
      && hit.matchedAlias.trim().length > 0,
    );
    if (reviewedFamilyHits.length === 0) {
      return false;
    }
    for (const hit of reviewedFamilyHits) {
      const matchedAlias = hit.matchedAlias;
      if (matchedAlias === undefined) {
        return false;
      }
      matchedAliases.add(matchedAlias.trim().toLowerCase());
    }
  }
  return matchedAliases.size === 1;
}

function hasAnyIdentityBearingEvidence(
  result: EntityResolveResult | undefined,
  plan: LookupQueryPlan,
): boolean {
  if (result === undefined) {
    return false;
  }

  return result.candidates.some((candidate) =>
    anchorsHaveExactIdentityEvidence(candidate.entityId, plan.anchors),
  );
}
