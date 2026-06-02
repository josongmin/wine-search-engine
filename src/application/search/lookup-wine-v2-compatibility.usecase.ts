import { AUTHORITY_TRACE_SCHEMA_VERSION } from '../../domain/decision/model/id-schema-version.js';
import type { FailureReason } from '../../domain/decision/model/failure-reason.js';
import type { ClarificationPayload } from '../../domain/response/model/clarification.js';
import type { ResponseMeta } from '../../domain/response/model/counterfactual.js';
import type {
  ConstraintEvaluation,
  EntitySummary,
  MatchDetail,
  ResultItem,
  UncertaintyBlock,
} from '../../domain/response/model/result-item.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type {
  EntityDocumentLookupPort,
} from './port/search-pipeline-deps.port.js';
import type {
  EntityLookupV2ExecutionOptions,
  EntityLookupV2UseCasePort,
} from './port/search-route-usecases.port.js';
import {
  buildDecisionSnapshotFromRuntimeVersions,
} from './search-usecase-decision-snapshot.js';
import type { SnapshotVersions } from './search.usecase.js';
import type {
  EntityLookupV2Command,
  EntityLookupV2Result,
  LookupV2CandidateView,
  LookupV2ClarificationOptionView,
  LookupV2ChannelHitView,
} from './entity-lookup-v2/entity-lookup-v2.dto.js';
import { LOOKUP_WINE_LIMIT_MAX } from './search-tool-contract.js';
import type { CanonicalEntityId, EvidenceItem } from '../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../domain/shared/types/entity-id.js';
import { deterministicHash } from '../../domain/shared/utils/hash.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type { AbstainReason } from '../../domain/query/model/abstain-decision.js';
import type { DecisionConfidenceSemantics } from '../../domain/shared/types/decision-confidence-semantics.js';
import type { LookupResolveEvidenceGrade } from '../../domain/resolver/v2/channel-provenance.js';
import { classifyResolveEvidenceGrade } from '../../domain/resolver/v2/channel-provenance.js';

export interface LookupWineV2CompatibilityCommand {
  readonly query: string;
  readonly limit?: number | undefined;
  readonly locale?: string | undefined;
  readonly requestId?: string | undefined;
}

export interface LookupWineV2CompatibilityUseCaseDeps {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
  readonly entityLookup: EntityDocumentLookupPort;
  readonly snapshotVersions?: SnapshotVersions | undefined;
}

const SEARCH_RESPONSE_VERSION = '1.0.0';
const SEARCH_ENGINE_SCHEMA_VERSION = 'search_response_v1' as const;
const LOOKUP_ROUTE = 'entity' as const;
const LOOKUP_RETRIEVAL_MODE = 'entity_lookup' as const;
const LOOKUP_RETRIEVAL_KIND = 'entity_lookup';
const LOOKUP_MATCH_SOURCE = 'entity_lookup_v2';
const CLARIFICATION_QUESTION = 'Which wine did you mean?';

function clampLookupLimit(limit: number | undefined): number {
  if (limit === undefined) return LOOKUP_WINE_LIMIT_MAX;
  return Math.max(1, Math.min(limit, LOOKUP_WINE_LIMIT_MAX));
}

function mapStatusToNextAction(
  result: EntityLookupV2Result,
): SearchResponseV1['engineDecision']['nextAction'] {
  switch (result.status) {
    case 'resolved':
      return 'return_result';
    case 'ambiguous':
      return 'clarify';
    case 'redirect_discovery':
      return 'hybrid_search';
    case 'failed':
    default:
      return 'fail';
  }
}

function mapStatusToResultType(
  result: EntityLookupV2Result,
): SearchResponseV1['resultType'] {
  switch (result.status) {
    case 'resolved':
      return 'single_entity';
    case 'ambiguous':
      return 'entity_set';
    case 'failed':
    case 'redirect_discovery':
    default:
      return 'no_match';
  }
}

function mapFailureReason(
  result: EntityLookupV2Result,
): FailureReason | undefined {
  const code = result.evidenceSummary.decisionReasonCode;
  if (result.status === 'redirect_discovery') {
    return undefined;
  }
  switch (code) {
    case 'hard_constraint_violation':
      return 'HARD_CONSTRAINT_VIOLATION';
    case 'no_candidates':
      return 'NO_CORPUS_MATCH';
    case 'identity_evidence_required':
    case 'vintage_mismatch':
    case 'low_confidence':
      return 'CONFIDENCE_BELOW_THRESHOLD';
    default:
      return result.status === 'failed' ? 'EVIDENCE_INSUFFICIENT' : 'AMBIGUITY_BLOCKED';
  }
}

function mapAbstainReason(
  result: EntityLookupV2Result,
): AbstainReason | undefined {
  const code = result.evidenceSummary.decisionReasonCode;
  switch (code) {
    case 'no_candidates':
      return 'no_match';
    case 'identity_evidence_required':
      return 'insufficient_evidence';
    case 'low_confidence':
    case 'vintage_mismatch':
      return 'low_confidence';
    default:
      return result.status === 'ambiguous' ? 'low_confidence' : undefined;
  }
}

function deriveConfidenceSemantics(
  calibrationTrusted: boolean,
): DecisionConfidenceSemantics {
  return calibrationTrusted
    ? 'calibrated_decision_confidence'
    : 'uncalibrated_decision_score';
}

function buildAuthorityTraceRef(
  result: EntityLookupV2Result,
  snapshot: ReturnType<typeof buildDecisionSnapshotFromRuntimeVersions>,
  nextAction: SearchResponseV1['engineDecision']['nextAction'],
  failureReason: FailureReason | undefined,
): string {
  const digest = deterministicHash({
    queryClass: result.evidenceSummary.queryClass,
    route: LOOKUP_ROUTE,
    retrievalMode: LOOKUP_RETRIEVAL_MODE,
    retrievalKind: LOOKUP_RETRIEVAL_KIND,
    threshold_profile_id: snapshot.threshold_profile_id,
    planner_version: snapshot.planner_version,
    policy_rule_version: snapshot.policy_rule_version,
    chosenEntityId: result.topCandidate?.entityId ?? '',
    decisionStatus: result.status === 'redirect_discovery' ? 'failed' : result.status,
    nextAction,
    failureReason: failureReason ?? '',
  });

  return `decision:${AUTHORITY_TRACE_SCHEMA_VERSION}:${result.evidenceSummary.queryClass}:${digest}`;
}

function buildResponseHash(
  result: EntityLookupV2Result,
  results: readonly ResultItem[],
): string {
  return deterministicHash({
    status: result.status,
    decisionReason: result.evidenceSummary.decisionReasonCode,
    topEntityId: result.topCandidate?.entityId ?? '',
    resultEntityIds: results.map((item) => String(item.entity.entityId)),
    calibrationTrusted: result.evidenceSummary.calibrationTrusted,
  });
}

function buildEvidenceItem(
  hit: LookupV2ChannelHitView,
): EvidenceItem {
  const strength: EvidenceItem['strength'] =
    hit.channel === 'exact_alias' || hit.channel === 'compact_exact' || hit.channel === 'transliteration_exact'
      ? 'high'
      : hit.channel === 'jamo_phonetic'
        ? 'medium'
        : 'low';

  return {
    type: 'lookup_channel',
    source: LOOKUP_MATCH_SOURCE,
    contribution: `+${hit.channelScore.toFixed(2)}`,
    strength,
    provenance: `Recalled via ${hit.channel}`,
    metadata: {
      matchedView: hit.matchedView,
      ...(hit.matchedAlias !== undefined ? { matchedAlias: hit.matchedAlias } : {}),
      channelRank: hit.channelRank,
    },
  };
}

function fallbackEvidenceItem(candidate: LookupV2CandidateView): EvidenceItem {
  return {
    type: 'lookup_candidate',
    source: LOOKUP_MATCH_SOURCE,
    contribution: `+${candidate.calibratedScore.toFixed(2)}`,
    strength: 'low',
    provenance: 'Candidate preserved from lookup authority output',
  };
}

function buildMatchType(
  candidate: LookupV2CandidateView,
  evidenceGrade: LookupResolveEvidenceGrade,
): MatchDetail['matchType'] {
  if (evidenceGrade === 'identity_grade') {
    const exactAliasHit = candidate.channelHits.find((hit) => hit.channel === 'exact_alias');
    return exactAliasHit?.matchedAlias?.toLowerCase() === candidate.canonicalLabel.toLowerCase()
      ? 'exact'
      : 'alias_exact';
  }
  if (evidenceGrade === 'supportive_only' || evidenceGrade === 'recall_only') {
    return 'alias_fuzzy';
  }
  return 'hybrid';
}

function buildConstraintBlock(): ConstraintEvaluation {
  return {
    matched: [],
    unmet: [],
    inferred: [],
  };
}

function buildUncertaintyBlock(
  candidate: LookupV2CandidateView,
  result: EntityLookupV2Result,
  evidenceGrade: LookupResolveEvidenceGrade,
): UncertaintyBlock {
  return {
    uncertaintyConfidence: candidate.calibratedScore,
    missingInfo: result.status === 'ambiguous' ? ['exact_wine_identity'] : [],
    approximationUsed: evidenceGrade !== 'identity_grade',
    ...(result.status === 'ambiguous'
      ? { ambiguityFlags: [...(result.evidenceSummary.ambiguityTypes ?? ['entity_ambiguity'])] }
      : {}),
  };
}

function buildEntitySummary(
  candidate: LookupV2CandidateView,
  doc: RetrievalDocument | undefined,
): EntitySummary {
  return {
    entityId: createCanonicalEntityId(candidate.entityId),
    canonicalLabel: doc?.canonicalLabel ?? candidate.canonicalLabel,
    type: doc?.entityType ?? candidate.entityType ?? 'wine',
    ...(doc?.producer !== undefined ? { producer: doc.producer } : {}),
    ...(doc?.region !== undefined ? { region: doc.region } : {}),
    ...(doc?.country !== undefined ? { country: doc.country } : {}),
    ...(doc?.appellation !== undefined ? { appellation: doc.appellation } : {}),
    ...(doc?.closure !== undefined ? { closure: doc.closure } : {}),
    ...(doc?.producerPrestige !== undefined ? { producerPrestige: doc.producerPrestige } : {}),
    ...(doc?.style !== undefined ? { style: doc.style } : {}),
    ...(doc?.wineType !== undefined ? { wineType: doc.wineType } : {}),
    ...(doc?.criticScoreNormalized !== undefined ? { criticScore: doc.criticScoreNormalized } : {}),
    ...(doc?.availability !== undefined ? { availability: doc.availability } : {}),
    ...(doc?.vintageYear !== undefined ? { vintage: doc.vintageYear } : {}),
    ...(doc?.grapes !== undefined && doc.grapes.length > 0 ? { grapes: doc.grapes } : {}),
    ...(doc?.priceBand !== undefined ? { priceRange: doc.priceBand } : {}),
    ...(doc?.sourceRecordRefs !== undefined ? { sourceRecordRefs: doc.sourceRecordRefs } : {}),
  };
}

function buildClarificationCandidates(
  options: readonly LookupV2ClarificationOptionView[],
): ClarificationPayload['candidates'] {
  return options.map((option) => ({
    entityId: createCanonicalEntityId(option.entityId),
    label: option.label,
    distinguishingFeatures: option.distinguishingFeature !== undefined
      ? [option.distinguishingFeature]
      : [],
  }));
}

function buildClarificationPayload(
  result: EntityLookupV2Result,
): ClarificationPayload | undefined {
  if (result.status !== 'ambiguous' || result.clarificationOptions.length === 0) {
    return undefined;
  }

  const candidates = buildClarificationCandidates(result.clarificationOptions);
  return {
    reason: result.decisionReason,
    candidates,
    suggestionType: 'disambiguation',
    structuredPayload: {
      kind: 'anchor_disambiguation',
      question: CLARIFICATION_QUESTION,
      options: candidates.map((candidate) => candidate.label),
      optionEntities: candidates.map((candidate) => ({
        entityId: candidate.entityId,
        label: candidate.label,
        ...(candidate.distinguishingFeatures.length > 0
          ? { distinguishingFeatures: candidate.distinguishingFeatures }
          : {}),
      })),
    },
  };
}

function shouldExposeResults(result: EntityLookupV2Result): boolean {
  return result.status === 'resolved' || result.status === 'ambiguous';
}

function toResultItem(
  candidate: LookupV2CandidateView,
  doc: RetrievalDocument | undefined,
  result: EntityLookupV2Result,
): ResultItem {
  const evidenceGrade = classifyResolveEvidenceGrade(candidate.channelHits);
  const evidenceItems = candidate.channelHits.length > 0
    ? candidate.channelHits.map((hit) => buildEvidenceItem(hit))
    : [fallbackEvidenceItem(candidate)];

  return {
    entity: buildEntitySummary(candidate, doc),
    relevanceScore: candidate.calibratedScore,
    match: {
      matchType: buildMatchType(candidate, evidenceGrade),
      ...(candidate.channelHits.some((hit) => hit.channel === 'family_graph') ? { anchorUsed: true } : {}),
      ...(candidate.channelHits[0]?.matchedAlias !== undefined
        ? { matchedAlias: candidate.channelHits[0].matchedAlias }
        : {}),
      scoreComponents: {
        lexical: candidate.calibratedScore,
        semantic: candidate.channelHits.some((hit) => hit.channel === 'dense') ? candidate.calibratedScore : 0,
        attribute: 0,
        popularity: 0,
      },
    },
    constraints: buildConstraintBlock(),
    uncertainty: buildUncertaintyBlock(candidate, result, evidenceGrade),
    evidenceItems,
    humanReadableEvidenceSummary: result.decisionReason,
    ...(result.status !== 'resolved'
      ? { matchReasons: [result.decisionReason] }
      : {}),
  };
}

export class LookupWineV2CompatibilityUseCase {
  constructor(private readonly deps: LookupWineV2CompatibilityUseCaseDeps) {}

  async execute(
    command: LookupWineV2CompatibilityCommand,
    options?: EntityLookupV2ExecutionOptions,
  ): Promise<SearchResponseV1> {
    const v2Command: EntityLookupV2Command = {
      query: command.query,
      maxCandidates: clampLookupLimit(command.limit),
      mode: 'default',
      ...(command.locale !== undefined ? { locale: command.locale } : {}),
      ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
    };

    const result = await this.deps.entityLookupV2UseCase.execute(v2Command, options);
    const snapshot = buildDecisionSnapshotFromRuntimeVersions(this.deps.snapshotVersions);
    const nextAction = mapStatusToNextAction(result);
    const failureReason = mapFailureReason(result);
    const decisionStatus: SearchResponseV1['engineDecision']['decisionStatus'] =
      result.status === 'redirect_discovery' ? 'failed' : result.status;
    const candidateIds = shouldExposeResults(result)
      ? result.candidates.map((candidate) => createCanonicalEntityId(candidate.entityId))
      : [];
    const docs: ReadonlyMap<CanonicalEntityId, RetrievalDocument> = candidateIds.length > 0
      ? await this.deps.entityLookup.getDocuments(candidateIds)
      : new Map<CanonicalEntityId, RetrievalDocument>();
    const results = shouldExposeResults(result)
      ? result.candidates.map((candidate) => toResultItem(candidate, docs.get(createCanonicalEntityId(candidate.entityId)), result))
      : [];
    const authorityTraceRef = buildAuthorityTraceRef(result, snapshot, nextAction, failureReason);
    const decisionConfidence = result.topCandidate?.calibratedScore
      ?? result.evidenceSummary.topConfidence
      ?? 0;

    const meta: ResponseMeta = {
      ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
      queryTimeMs: result.meta.queryTimeMs,
      route: LOOKUP_ROUTE,
      version: SEARCH_RESPONSE_VERSION,
      engine_schema_version: SEARCH_ENGINE_SCHEMA_VERSION,
      decisionSnapshot: snapshot,
      response_hash: buildResponseHash(result, results),
      authorityTraceRef: authorityTraceRef,
      ...(command.requestId !== undefined ? { runtimeCorrelationRef: command.requestId } : {}),
      executionMode: 'authoritative',
    };

    return {
      queryType: 'search',
      engineDecision: {
        decisionStatus,
        nextAction,
        route: LOOKUP_ROUTE,
        decisionConfidence,
        confidenceSemantics: deriveConfidenceSemantics(result.evidenceSummary.calibrationTrusted),
        calibrationTrusted: result.evidenceSummary.calibrationTrusted,
        decisionTraceRef: authorityTraceRef,
        authorityTraceRef,
        ...(command.requestId !== undefined ? { runtimeCorrelationRef: command.requestId } : {}),
        executionMode: 'authoritative',
        decisionSnapshot: snapshot,
        ...(failureReason !== undefined ? { failure_reason: failureReason } : {}),
        ...(mapAbstainReason(result) !== undefined ? { abstainReason: mapAbstainReason(result) } : {}),
      },
      results,
      ...(buildClarificationPayload(result) !== undefined ? { clarification: buildClarificationPayload(result) } : {}),
      meta,
      retrievalMode: LOOKUP_RETRIEVAL_MODE,
      resultType: mapStatusToResultType(result),
    };
  }
}
