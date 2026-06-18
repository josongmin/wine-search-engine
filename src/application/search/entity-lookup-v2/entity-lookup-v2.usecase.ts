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

import type { QuerySanitizer } from '../../../domain/security/service/query-sanitizer.js';
import type {
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
  LookupDecision,
  LookupRetrievalResult,
} from '../../../domain/resolver/v2/lookup-v2-types.js';
import { CalibratedAbstainDecider } from '../../../domain/resolver/v2/calibrated-abstain-decider.js';
import {
  decideLookupOutcome,
  PERSISTED_AMBIGUITY_SURFACE_REASON_CODE,
  VINTAGE_MISMATCH_DECISION_REASON_HINT,
} from '../../../domain/resolver/v2/lookup-decision-engine.js';
import { shouldDowngradeForVintageMismatch } from '../../../domain/resolver/v2/vintage-guard.js';
import type { AliasRegistryVersion } from '../../../domain/alias/model/alias-registry-version.js';
import {
  anchorsHaveExactIdentityEvidence,
  buildChannelHitsForEntity,
  classifyResolveEvidenceGrade,
} from '../../../domain/resolver/v2/channel-provenance.js';
import { buildClarification } from '../../../domain/resolver/v2/clarification-graph.js';
import type { AmbiguityDictionary, AmbiguityInfo } from '../../../domain/query/port/ambiguity-dictionary.port.js';
import { clamp01 } from '../../../domain/shared/utils/clamp.js';
import { buildNormalizedQueryViews } from '../../../domain/query/service/query-normalizer.js';
import { buildResolverCandidatesFromGenerator } from '../search-usecase-resolver-candidates.js';
import { hasDeterministicSingletonAliasWitness } from '../search-usecase-blocker-seed-policy.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../../domain/observability/request-pipeline-debug.js';
import { globalSilentSkipCounter } from '../../../domain/observability/silent-skip-counters.js';
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
  LookupV2ChannelHitView,
  LookupV2ClarificationOptionView,
  NormalizedQueryViewsView,
} from './entity-lookup-v2.dto.js';
import {
  LOOKUP_V2_ENGINE_VERSION,
  buildNormalizedQueryViewsView,
  decisionReasonText,
  projectNormalizedQueryViews,
} from './entity-lookup-v2-mapping.js';
import { buildChannelCoverage } from './entity-lookup-v2-decision-helpers.js';
import { buildAnchorsFromRetrievalResult } from './lookup-retrieval-anchors.js';
import {
  buildLookupWitnessSnapshot,
  shouldSurfacePersistedAmbiguityEarly,
  type LookupWitnessSnapshot,
} from './lookup-witness-snapshot.js';
import {
  collectLookupSemanticScopeMatches,
  type LookupSemanticScopeMatch,
} from './lookup-semantic-scope-cache.js';

// Re-export so existing importers (e.g. combine-decisions.test.ts) keep their path.
export { combineDecisions } from './entity-lookup-v2-decision-helpers.js';

/**
 * Max clarification options surfaced for an ambiguous lookup — a UX cap (a
 * disambiguation prompt with >8 options is not actionable). MUST stay <= the
 * wire bound MAX_LOOKUP_V2_CLARIFICATION_OPTIONS (20) in the HTTP schema; kept
 * as a local domain constant rather than importing the interface-layer bound to
 * avoid an application→interface layer dependency.
 */
const LOOKUP_V2_MAX_CLARIFICATION_OPTIONS = 8;

export interface EntityLookupV2UseCaseDeps {
  readonly admissionGate: LookupAdmissionGatePort;
  readonly lookupPlanner: LookupPlannerPort;
  readonly entityResolver: EntityResolverPort;
  readonly resolverProjectionLookup: LookupResolverProjectionPort;
  readonly semanticScopeRegistry?: LookupSemanticScopeRegistryPort | undefined;
  /**
   * T-ELV2-04: independent timed multi-channel retrieval. When present, the
   * response's per-channel coverage + per-candidate channel provenance come
   * from REAL timed channels (not the anchor re-projection); when absent the
   * use case falls back to deriving channels from planner anchors.
   */
  readonly candidateRetrieval?: LookupCandidateRetrievalPort | undefined;
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
          step: PipelineDebugStep.ENTITY_LOOKUP_V2_USE_CASE_START,
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
    const normalizedQueryViews = buildNormalizedQueryViews(effectiveQuery);
    const admission: LookupAdmissionVerdict = this.deps.admissionGate.classify({
      rawQuery: effectiveQuery,
      views: normalizedQueryViews,
      ...(command.locale !== undefined ? { locale: command.locale } : {}),
    });

      if (admission.decision !== 'admit') {
        pipelineDebug(
          {
            step: PipelineDebugStep.ENTITY_LOOKUP_V2_USE_CASE_START,
            admission_reason: admission.reasonCode,
          },
          'pipeline entity-lookup-v2 admission stop (front-door, pre-planner)',
        );
        return this.buildNonAdmittedResult(command, normalizedQueryViews, admission, startedAt);
      }

      const persistedAmbiguityLookup = await this.fetchPersistedAmbiguityOnce(
        normalizedQueryViews.strict,
        options,
      );
      const plannerContext = {
        normalizedQueryViews,
        persistedAmbiguity: persistedAmbiguityLookup,
        ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
        ...(options?.stageTimer !== undefined ? { stageTimer: options.stageTimer } : {}),
      };

    // ── Stage 2a: exact-safe / persisted-ambiguity exits (no alias recall) ──
      options?.stageTimer?.start('planner.total');
      const earlyPlan = await this.deps.lookupPlanner.plan(effectiveQuery, {
        ...plannerContext,
        earlyExitOnly: true,
      });
      if (
        earlyPlan.queryClass === 'ambiguous_short_form'
        && earlyPlan.persistedAmbiguity !== undefined
      ) {
        const earlyWitness = buildLookupWitnessSnapshot({
          rawQuery: earlyPlan.rawQuery,
          normalizedQuery: earlyPlan.normalizedQuery,
          anchors: earlyPlan.anchors,
        });
        if (shouldSurfacePersistedAmbiguityEarly(earlyWitness, earlyPlan.persistedAmbiguity)) {
          options?.stageTimer?.end('planner.total');
          return this.finishResult({
            command,
            plan: earlyPlan,
            viewsView: buildNormalizedQueryViewsView(earlyPlan),
            admission,
            result: undefined,
            persistedAmbiguity: earlyPlan.persistedAmbiguity,
            forcedStatus: 'ambiguous',
            decisionReasonCode: PERSISTED_AMBIGUITY_SURFACE_REASON_CODE,
            startedAt,
            witness: earlyWitness,
            semanticScopeMatches: this.collectSemanticScopeMatches(
              earlyPlan,
              command.locale,
            ),
            ...(options?.stageTimer !== undefined ? { stageTimer: options.stageTimer } : {}),
          });
        }
      }

    // ── Stage 2b: timed multi-channel recall (single alias pass) ────────────
      let retrieval: LookupRetrievalResult | undefined;
      let plan = earlyPlan;
      const exactSafeRegistryPlan =
        earlyPlan.queryClass === 'exact_entity' && earlyPlan.anchors.length > 0;
      if (!exactSafeRegistryPlan && this.deps.candidateRetrieval !== undefined) {
        retrieval = await this.runProvisionalRetrieval(
          this.deps.candidateRetrieval,
          effectiveQuery,
          normalizedQueryViews,
          command,
          options,
        );
        const prefetchedAnchors = retrieval !== undefined
          ? buildAnchorsFromRetrievalResult({
            rawQuery: effectiveQuery,
            normalizedQuery: normalizedQueryViews.strict,
            retrieval,
          })
          : undefined;
        plan = await this.deps.lookupPlanner.plan(effectiveQuery, {
          ...plannerContext,
          ...(prefetchedAnchors !== undefined ? { prefetchedAnchors } : {}),
        });
      } else if (!exactSafeRegistryPlan) {
        plan = await this.deps.lookupPlanner.plan(effectiveQuery, plannerContext);
      }
      options?.stageTimer?.end('planner.total');
    throwIfAborted(options?.abortSignal, 'Entity lookup V2 aborted');

      const viewsView = buildNormalizedQueryViewsView(plan);
      const witness = buildLookupWitnessSnapshot({
        rawQuery: plan.rawQuery,
        normalizedQuery: plan.normalizedQuery,
        anchors: plan.anchors,
      });
      const semanticScopeMatches = this.collectSemanticScopeMatches(plan, command.locale);
      const exactSafeSingletonWitness = witness.exactSafeSingletonWitness;

    // ── Stage 3: candidate union (resolver-backed baseline; T-04 deepens) ───

    // Pool-narrowing gate: an exact-safe singleton witness normally collapses the
    // candidate pool to that single entity (max precision for a bare iconic alias).
    // But when the query carries an EXPLICIT vintage the witness entity does NOT
    // satisfy, the witness is the wrong answer — collapsing to it would strand the
    // requested vintage. Widen back to the full family so vintage-aware selection can
    // pick the matching sibling. Bare / matching-vintage queries keep the narrowed,
    // witness-pinned pool unchanged (no behaviour change for the iconic singleton path).
      let poolNarrowingWitnessEntityId = exactSafeSingletonWitness?.entityId;
      if (
        exactSafeSingletonWitness !== undefined
        && extractQueryVintageYear(command.query) !== null
      ) {
        const witnessProjection = (
          await this.deps.resolverProjectionLookup.getResolverProjections([
            exactSafeSingletonWitness.entityId,
          ])
        ).get(exactSafeSingletonWitness.entityId);
        if (shouldDowngradeForVintageMismatch(command.query, witnessProjection?.canonicalLabel)) {
          poolNarrowingWitnessEntityId = undefined;
        }
      }
      // When the witness was widened away for a vintage conflict, the family graph
      // expansion (normally suppressed under a singleton witness for precision) is
      // exactly what surfaces the requested-vintage sibling from the wrong-vintage
      // anchor — re-enable it for this query only.
      const widenFamilyForVintageConflict =
        exactSafeSingletonWitness !== undefined && poolNarrowingWitnessEntityId === undefined;

    // T-ELV2-04: reuse the recall pass when singleton suppression is unchanged;
    // re-run only when pool-narrowing / vintage-widen changes graph expansion.
      const needsRetrievalRefresh =
        retrieval !== undefined
        && (poolNarrowingWitnessEntityId !== undefined || widenFamilyForVintageConflict);
      // Exact-safe registry plans already carry identity-grade anchors; timed
      // multi-channel recall is redundant unless vintage widening reopens family
      // expansion to surface a requested-vintage sibling.
      const exactSafeFastPath =
        exactSafeRegistryPlan && !widenFamilyForVintageConflict;
      if (
        this.deps.candidateRetrieval !== undefined
        && !exactSafeFastPath
        && (retrieval === undefined || needsRetrievalRefresh)
      ) {
        retrieval = await this.runRetrieval(
          this.deps.candidateRetrieval,
          plan,
          command,
          poolNarrowingWitnessEntityId,
          widenFamilyForVintageConflict,
          options,
        );
      }

      const result = await this.resolveCandidatePool(
        plan,
        retrieval,
        poolNarrowingWitnessEntityId,
        semanticScopeMatches,
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
      const decision = this.decider.decide(result, plan.queryClass, topEvidenceGrade);

      pipelineDebug(
        {
          step: PipelineDebugStep.ENTITY_LOOKUP_V2_USE_CASE_DONE,
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
      const persistedAmbiguity = plan.persistedAmbiguity ?? persistedAmbiguityLookup;

      return this.finishResult({
        command,
        plan,
        viewsView,
        admission,
        result,
        decision,
        witness,
        semanticScopeMatches,
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

  private async fetchPersistedAmbiguityOnce(
    normalizedQuery: string,
    options?: RequestExecutionContext,
  ): Promise<AmbiguityInfo | null> {
    if (this.deps.ambiguityDictionary === undefined) {
      return null;
    }
    options?.stageTimer?.start('ambiguity_lookup');
    try {
      return await this.deps.ambiguityDictionary
        .getAmbiguityInfo(normalizedQuery, options?.abortSignal)
        .catch(() => null);
    } finally {
      options?.stageTimer?.end('ambiguity_lookup');
    }
  }

  private collectSemanticScopeMatches(
    plan: LookupQueryPlan,
    locale: string | undefined,
  ): readonly LookupSemanticScopeMatch[] {
    if (this.deps.semanticScopeRegistry === undefined) {
      return [];
    }
    return collectLookupSemanticScopeMatches({
      registry: this.deps.semanticScopeRegistry,
      rawQuery: plan.rawQuery,
      views: plan.normalizedQueryViews,
      locale,
    });
  }

  /** Provisional timed recall before planner anchor projection (single alias pass). */
  private async runProvisionalRetrieval(
    engine: LookupCandidateRetrievalPort,
    rawQuery: string,
    views: NormalizedQueryViews,
    command: EntityLookupV2Command,
    options?: RequestExecutionContext,
  ): Promise<LookupRetrievalResult | undefined> {
    try {
      options?.stageTimer?.start('retrieval.total');
      return await engine.retrieve(
        {
          rawQuery,
          views,
          queryClass: 'unknown',
          maxCandidates: command.maxCandidates,
          suppressFamilyGraphExpansion: false,
          ...(command.locale !== undefined ? { locale: command.locale } : {}),
          ...(options?.stageTimer !== undefined ? { stageTimer: options.stageTimer } : {}),
        },
        options?.abortSignal,
      ).finally(() => {
        options?.stageTimer?.end('retrieval.total');
      });
    } catch {
      globalSilentSkipCounter.increment('lookup_retrieval_engine_failure', {
        phase: 'provisional',
      });
      return undefined;
    }
  }

  /** Run the multi-channel retrieval engine; never let it sink the request. */
  private async runRetrieval(
    engine: LookupCandidateRetrievalPort,
    plan: LookupQueryPlan,
    command: EntityLookupV2Command,
    exactSafeWitnessEntityId: CanonicalEntityId | undefined,
    widenFamilyForVintageConflict: boolean,
    options?: RequestExecutionContext,
  ): Promise<LookupRetrievalResult | undefined> {
    try {
      options?.stageTimer?.start('retrieval.total');
      return await engine.retrieve(
        {
          rawQuery: plan.rawQuery,
          views: plan.normalizedQueryViews,
          queryClass: plan.queryClass,
          maxCandidates: command.maxCandidates,
          // A vintage-conflicting query under a singleton witness NEEDS the family
          // graph expansion to surface the requested-vintage sibling — do not suppress.
          suppressFamilyGraphExpansion:
            !widenFamilyForVintageConflict
            && (exactSafeWitnessEntityId !== undefined
              || hasDeterministicSingletonAliasWitness(plan.anchors)),
          ...(command.locale !== undefined ? { locale: command.locale } : {}),
          ...(options?.stageTimer !== undefined ? { stageTimer: options.stageTimer } : {}),
        },
        options?.abortSignal,
      ).finally(() => {
        options?.stageTimer?.end('retrieval.total');
      });
    } catch {
      globalSilentSkipCounter.increment('lookup_retrieval_engine_failure', {
        phase: 'primary',
      });
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
    semanticScopeMatches: readonly LookupSemanticScopeMatch[],
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
    if (semanticScopeMatches.length > 0) {
      for (const match of semanticScopeMatches) {
        if (
          exactSafeWitnessEntityId !== undefined
          && match.entityId !== String(exactSafeWitnessEntityId)
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
      this.deps.resolverProjectionLookup,
    ).finally(() => {
      options?.stageTimer?.end('candidate_generation');
    });

    const resolverInput: ResolverInput = {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      normalizedQueryViews: plan.normalizedQueryViews,
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
    witness: LookupWitnessSnapshot;
    semanticScopeMatches: readonly LookupSemanticScopeMatch[];
    stageTimer?: RequestExecutionContext['stageTimer'];
  }): EntityLookupV2Result {
    const {
      command,
      plan,
      viewsView,
      admission,
      result,
      decision,
      retrieval,
      persistedAmbiguity,
      forcedStatus,
      decisionReasonCode,
      stageTimer,
      witness,
      semanticScopeMatches,
    } = args;

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
    const exactSafeSingletonWitness = witness.exactSafeSingletonWitness;
    const lookupDecision = decideLookupOutcome({
      query: command.query,
      rawQuery: plan.rawQuery,
      decisionReasonCode,
      ...(forcedStatus !== undefined && forcedStatus !== 'redirect_discovery'
        ? { forcedStatus }
        : {}),
      ...(decision?.status !== undefined ? { decisionStatus: decision.status } : {}),
      ...(result?.status !== undefined ? { resolverStatus: result.status } : {}),
      ...(result?.candidates[0]?.entityId !== undefined
        ? { topCandidateEntityId: String(result.candidates[0].entityId) }
        : {}),
      ...(result?.candidates[0]?.canonicalLabel !== undefined
        ? { topCandidateCanonicalLabel: result.candidates[0].canonicalLabel }
        : {}),
      ...(exactSafeSingletonWitness !== undefined
        ? {
            exactSafeSingletonWitness: {
              entityId: String(exactSafeSingletonWitness.entityId),
              lookupVariants: exactSafeSingletonWitness.anchor.lookupVariants,
            },
          }
        : {}),
      anchors: plan.anchors,
      resolveCandidateEntityIds: result?.candidates.map((c) => String(c.entityId)) ?? [],
      allCandidates,
      semanticScopeMatches,
      reviewedTargetEntityIds:
        this.deps.semanticScopeRegistry?.getReviewedTargetEntityIds() ?? new Set<string>(),
      hasPersistedAmbiguity: persistedAmbiguity !== undefined,
      ...(trace?.appliedThresholds.resolveThreshold !== undefined
        ? { resolveThreshold: trace.appliedThresholds.resolveThreshold }
        : {}),
    });
    const {
      status,
      effectiveDecisionReasonCode,
      frontPromotedEntityId,
      preferVintageMismatchReasonText,
      promotedTopConfidence,
    } = lookupDecision;

    // The resolver orders by rank, so slicing keeps the strongest candidates.
    // When a reviewed scope-target OR a vintage-matching family sibling resolved the
    // verdict, surface that entity first so it becomes the top candidate.
    const orderedCandidates = frontPromotedEntityId !== undefined
      ? [
          ...allCandidates.filter((c) => c.entityId === frontPromotedEntityId),
          ...allCandidates.filter((c) => c.entityId !== frontPromotedEntityId),
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
    const decisionReason = preferVintageMismatchReasonText
      ? VINTAGE_MISMATCH_DECISION_REASON_HINT
      : decision !== undefined && forcedStatus === undefined && effectiveDecisionReasonCode === decisionReasonCode
        ? decision.detail
        : decisionReasonText(status, effectiveDecisionReasonCode, admission);
    const topConfidence = promotedTopConfidence
      ?? decision?.topConfidence
      ?? trace?.top1CalibratedScore;
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
