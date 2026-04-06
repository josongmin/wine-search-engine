import type { EvalProvenanceSlice } from '../../domain/retrieval/model/provenance.js';
import { rankedResultsToEvalSlices } from '../../domain/retrieval/service/trace-vocab-aligner.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';

export function rankedResultsToEvalProvenanceSlices(
  requestId: string,
  rankedResults: readonly RankedResult[],
): readonly EvalProvenanceSlice[] {
  return rankedResultsToEvalSlices(requestId, rankedResults);
}

export function searchResponseToEvalProvenanceSlices(
  response: SearchResponseV1,
): readonly EvalProvenanceSlice[] {
  return response.meta.retrievalProvenanceSlices ?? [];
}
