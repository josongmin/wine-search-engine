import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { ResolveRequest } from './resolve-request.dto.js';
import type { AutocompleteResponse, AutocompleteSuggestion } from './autocomplete-response.dto.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import type { EntityDocumentLookupPort } from './port/search-pipeline-deps.port.js';
import type { ResolveUseCasePort } from './port/search-route-usecases.port.js';

interface AutocompleteUseCaseDeps {
  readonly resolveUseCase: ResolveUseCasePort;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
}

function toAutocompleteSuggestion(
  candidate: Awaited<ReturnType<ResolveUseCasePort['execute']>>['candidates'][number],
  doc: RetrievalDocument | undefined,
): AutocompleteSuggestion {
  return {
    entity: {
      entity_id: String(candidate.entityId),
      canonical_label: doc?.canonicalLabel ?? candidate.canonicalLabel,
      ...(doc?.entityType !== undefined ? { entity_type: doc.entityType } : {}),
      ...(doc?.producer !== undefined && doc.producer.length > 0 ? { producer: doc.producer } : {}),
      ...(doc?.region !== undefined && doc.region.length > 0 ? { region: doc.region } : {}),
      ...(doc?.country !== undefined && doc.country.length > 0 ? { country: doc.country } : {}),
      ...(doc?.appellation !== undefined && doc.appellation.length > 0 ? { appellation: doc.appellation } : {}),
      ...(doc?.vintageYear !== undefined ? { vintage: doc.vintageYear } : {}),
      ...(doc?.wineType !== undefined && doc.wineType.length > 0 ? { wine_type: doc.wineType } : {}),
      ...(doc?.grapes !== undefined && doc.grapes.length > 0 ? { grapes: [...doc.grapes] } : {}),
      ...(doc?.style !== undefined && doc.style.length > 0 ? { style: doc.style } : {}),
      ...(doc?.availability !== undefined ? { availability: doc.availability } : {}),
    },
    rank: candidate.rank,
    calibrated_score: candidate.calibratedScore,
    ...(candidate.source !== undefined ? { source: candidate.source } : {}),
    ...(candidate.sources !== undefined && candidate.sources.length > 0 ? { sources: [...candidate.sources] } : {}),
    ...(candidate.blockerSeed === true ? { blocker_seed: true } : {}),
    ...(candidate.evidenceRefs.length > 0 ? { evidence_refs: [...candidate.evidenceRefs] } : {}),
    ...(candidate.trace !== undefined ? { trace: candidate.trace } : {}),
  };
}

export class AutocompleteUseCase {
  constructor(private readonly deps: AutocompleteUseCaseDeps) {}

  async execute(
    request: ResolveRequest,
    options?: RequestExecutionContext,
  ): Promise<AutocompleteResponse> {
    const resolved = await this.deps.resolveUseCase.execute(request, options);
    const candidateIds = resolved.candidates.map((candidate) => candidate.entityId);
    const docs: ReadonlyMap<CanonicalEntityId, RetrievalDocument> =
      this.deps.entityLookup !== undefined && candidateIds.length > 0
      ? await this.deps.entityLookup.getDocuments(candidateIds)
      : new Map<CanonicalEntityId, RetrievalDocument>();

    return {
      status: resolved.status,
      suggestions: resolved.candidates.map((candidate) =>
        toAutocompleteSuggestion(candidate, docs.get(candidate.entityId)),
      ),
      decision_trace_ref: resolved.decision_trace_ref,
      authority_trace_ref: resolved.authority_trace_ref,
      ...(resolved.request_id !== undefined ? { request_id: resolved.request_id } : {}),
    };
  }
}
