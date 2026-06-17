/**
 * Entity Lookup V2 → Autocomplete response projection.
 *
 * Autocomplete is a thin typeahead surface over the V2 lookup authority. These
 * helpers keep the use case focused on orchestration (command dispatch + doc
 * hydration) while the mapping rules stay unit-testable in isolation.
 */

import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import type { LookupV2Status } from '../../../domain/resolver/v2/lookup-v2-types.js';
import { AUTHORITY_TRACE_SCHEMA_VERSION } from '../../../domain/decision/model/id-schema-version.js';
import { deterministicHash } from '../../../domain/shared/utils/hash.js';
import type {
  LookupResolverProjection,
} from '../port/search-pipeline-deps.port.js';
import type {
  AutocompleteEntitySummary,
  AutocompleteResponse,
  AutocompleteSuggestion,
} from '../autocomplete-response.dto.js';
import type {
  EntityLookupV2Result,
  LookupV2CandidateView,
} from './entity-lookup-v2.dto.js';

export { mapResolveRequestToEntityLookupV2Command } from './entity-lookup-v2-request-mapping.js';

export type AutocompleteHydrationDocument = RetrievalDocument | LookupResolverProjection;

export type AutocompleteStatus = AutocompleteResponse['status'];

export function mapLookupV2StatusToAutocompleteStatus(status: LookupV2Status): AutocompleteStatus {
  switch (status) {
    case 'resolved':
      return 'resolved';
    case 'ambiguous':
      return 'ambiguous';
    case 'redirect_discovery':
    case 'failed':
    default:
      return 'failed';
  }
}

export function buildEntityLookupV2AutocompleteTraceRef(result: EntityLookupV2Result): string {
  const digest = deterministicHash({
    status: result.status,
    decisionReasonCode: result.evidenceSummary.decisionReasonCode,
    admissionReasonCode: result.evidenceSummary.admissionReasonCode,
    queryClass: result.evidenceSummary.queryClass,
    topEntityId: result.topCandidate?.entityId ?? '',
    candidateCount: result.candidates.length,
    version: result.meta.version,
  });

  return `decision:${AUTHORITY_TRACE_SCHEMA_VERSION}:${result.evidenceSummary.queryClass}:${digest}`;
}

function readHintString(
  hints: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = hints?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readHintNumber(
  hints: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = hints?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readHintStringArray(
  hints: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly string[] | undefined {
  const value = hints?.[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  return value;
}

function isRetrievalDocument(doc: AutocompleteHydrationDocument): doc is RetrievalDocument {
  return 'aliasesNoisyRecall' in doc;
}

function buildEntitySummaryFromProjection(
  candidate: LookupV2CandidateView,
  projection: LookupResolverProjection,
): AutocompleteEntitySummary {
  const hints = projection.attributeHints;
  const vintage = readHintNumber(hints, 'vintage') ?? readHintNumber(hints, 'vintage_year');
  const grapes = readHintStringArray(hints, 'grapes');

  const entityType = projection.entityType.length > 0
    ? projection.entityType
    : candidate.entityType;

  return {
    entity_id: String(projection.entityId),
    canonical_label: projection.canonicalLabel,
    ...(entityType !== undefined && entityType.length > 0 ? { entity_type: entityType } : {}),
    ...(projection.producer !== undefined && projection.producer.length > 0
      ? { producer: projection.producer }
      : readHintString(hints, 'producer') !== undefined
        ? { producer: readHintString(hints, 'producer') }
        : {}),
    ...(readHintString(hints, 'region') !== undefined ? { region: readHintString(hints, 'region') } : {}),
    ...(readHintString(hints, 'country') !== undefined ? { country: readHintString(hints, 'country') } : {}),
    ...(readHintString(hints, 'appellation') !== undefined
      ? { appellation: readHintString(hints, 'appellation') }
      : {}),
    ...(vintage !== undefined ? { vintage } : {}),
    ...(readHintString(hints, 'wine_type') !== undefined
      ? { wine_type: readHintString(hints, 'wine_type') }
      : {}),
    ...(grapes !== undefined ? { grapes: [...grapes] } : {}),
    ...(readHintString(hints, 'style') !== undefined ? { style: readHintString(hints, 'style') } : {}),
  };
}

function buildEntitySummaryFromRetrievalDocument(
  candidate: LookupV2CandidateView,
  doc: RetrievalDocument,
): AutocompleteEntitySummary {
  return {
    entity_id: candidate.entityId,
    canonical_label: doc.canonicalLabel,
    ...(doc.entityType.length > 0 ? { entity_type: doc.entityType } : {}),
    ...(doc.producer.length > 0 ? { producer: doc.producer } : {}),
    ...(doc.region.length > 0 ? { region: doc.region } : {}),
    ...(doc.country !== undefined && doc.country.length > 0 ? { country: doc.country } : {}),
    ...(doc.appellation !== undefined && doc.appellation.length > 0 ? { appellation: doc.appellation } : {}),
    ...(doc.vintageYear !== undefined ? { vintage: doc.vintageYear } : {}),
    ...(doc.wineType !== undefined && doc.wineType.length > 0 ? { wine_type: doc.wineType } : {}),
    ...(doc.grapes.length > 0 ? { grapes: [...doc.grapes] } : {}),
    ...(doc.style !== undefined && doc.style.length > 0 ? { style: doc.style } : {}),
    availability: doc.availability,
  };
}

function buildEntitySummary(
  candidate: LookupV2CandidateView,
  doc: AutocompleteHydrationDocument | undefined,
): AutocompleteEntitySummary {
  if (doc === undefined) {
    return {
      entity_id: candidate.entityId,
      canonical_label: candidate.canonicalLabel,
      ...(candidate.entityType !== undefined ? { entity_type: candidate.entityType } : {}),
    };
  }

  return isRetrievalDocument(doc)
    ? buildEntitySummaryFromRetrievalDocument(candidate, doc)
    : buildEntitySummaryFromProjection(candidate, doc);
}

export function toAutocompleteSuggestion(
  candidate: LookupV2CandidateView,
  doc: AutocompleteHydrationDocument | undefined,
): AutocompleteSuggestion {
  return {
    entity: buildEntitySummary(candidate, doc),
    rank: candidate.rank,
    calibrated_score: candidate.calibratedScore,
  };
}

export function mapEntityLookupV2ResultToAutocompleteResponse(
  result: EntityLookupV2Result,
  docs: ReadonlyMap<string, AutocompleteHydrationDocument>,
): AutocompleteResponse {
  const traceRef = buildEntityLookupV2AutocompleteTraceRef(result);

  return {
    status: mapLookupV2StatusToAutocompleteStatus(result.status),
    suggestions: result.candidates.map((candidate) =>
      toAutocompleteSuggestion(candidate, docs.get(candidate.entityId)),
    ),
    decision_trace_ref: traceRef,
    authority_trace_ref: traceRef,
    ...(result.meta.requestId !== undefined ? { request_id: result.meta.requestId } : {}),
  };
}
