import type { EvalProvenanceSlice } from '../../domain/retrieval/model/provenance.js';
import { rankedResultsToEvalSlices } from '../../domain/retrieval/service/trace-vocab-aligner.js';
import { isProvenanceChannel } from '../../domain/retrieval/model/provenance.js';
import { preferCanonicalRetrievalChannelLabels } from '../../domain/retrieval/model/retrieval-channel.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'eval_provenance' });

export function rankedResultsToEvalProvenanceSlices(
  requestId: string,
  rankedResults: readonly RankedResult[],
): readonly EvalProvenanceSlice[] {
  // Validate channel vocab for any result that carries provenance.
  // Unknown channels cause rankedResultToEvalSlice to silently drop the candidate;
  // log a warning here so vocab drift is observable in production.
  for (const result of rankedResults) {
    const prov = result.retrievalProvenance;
    if (prov !== undefined) {
      const unknownChannels = prov.channels.filter((ch) => !isProvenanceChannel(ch));
      if (unknownChannels.length > 0) {
        log.warn(
          {
            requestId,
            entityId: result.entityId,
            unknownChannels,
          },
          'eval_provenance: unrecognized retrieval channels; candidate will be dropped from eval slice',
        );
      }
    }
  }
  return rankedResultsToEvalSlices(requestId, rankedResults);
}

export function searchResponseToEvalProvenanceSlices(
  response: SearchResponseV1,
): readonly EvalProvenanceSlice[] {
  return (response.meta.retrievalProvenanceSlices ?? []).map((slice) => ({
    ...slice,
    channels: preferCanonicalRetrievalChannelLabels(slice.channels) as EvalProvenanceSlice['channels'],
    topChannel: preferCanonicalRetrievalChannelLabels([slice.topChannel])[0] as EvalProvenanceSlice['topChannel'],
  }));
}
