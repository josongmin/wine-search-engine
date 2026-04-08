/**
 * E5-U1: Eval Feature Delta List (lock)
 *
 * Compiled / calibrated signals that eval slices MUST receive from runtime:
 *   - effectiveRoute    (from CompiledWineQuery.execution.effectiveRetrievalMode)
 *   - routeSource       (from EngineExecutionContract.routeSource)
 *   - plannerSuggestedMode (from EngineExecutionContract.effectiveRetrievalMode)
 *   - funnelMetrics     (from RankingStagePipeline.getLastFunnelMetrics())
 *   - retrievalChannels (from HybridRetrievalInput.activeChannels)
 *
 * Do NOT add eval-specific runtime outputs (new schema fields) — map from
 * existing runtime signals only. See E5-U2 for the export wiring map.
 *
 * E5-U2: Eval Export Wiring Map
 *
 * This file is the single export point for eval data; do NOT add eval field
 * extraction elsewhere. All eval provenance fields must flow through the
 * functions exported here (rankedResultsToEvalProvenanceSlices /
 * searchResponseToEvalProvenanceSlices).
 *
 *  Eval field                                Source
 *  ─────────────────────────────────────────────────────────────────────
 *  queryId                                   SearchRequest.queryId
 *  finalScore                                RankedResult.finalScore
 *  route                                     SearchResponseV1.engineDecision.route
 *                                            (built by ResponseBuilder from compiled.execution.effectiveRoute)
 *  retrievalModeSource                       engineDecision.retrievalModeSource
 *  plannerSuggestedMode                      engineDecision.plannerSuggestedMode
 *  channels                                  RankedResult[*].retrievalProvenance.channels
 *  funnelMetrics                             FunnelMetrics from ranking pipeline (optional)
 *
 * No debug-only fields (pipelineDebug steps, trace strings) must be copied
 * into eval schema — they are not stable eval signals.
 */
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
  return (response.meta.retrievalProvenanceSlices ?? []).map((slice) => {
    // Canonicalize channel labels, then validate against the ProvenanceChannel
    // enum. The previous `as` casts silently bypassed validation and could
    // produce invalid typed objects when compatibility aliases mapped to
    // strings not in the enum. Invalid channels fall back to the original
    // (which is already a string — just not narrowed).
    const canonicalChannels = preferCanonicalRetrievalChannelLabels(slice.channels);
    const validatedChannels = canonicalChannels.filter(isProvenanceChannel);
    // Use canonicalized top channel if valid, else fall back to original.
    const canonicalTopArr = preferCanonicalRetrievalChannelLabels([slice.topChannel]);
    const canonicalTop = canonicalTopArr[0];
    const validatedTop = canonicalTop !== undefined && isProvenanceChannel(canonicalTop)
      ? canonicalTop
      : slice.topChannel;

    return {
      ...slice,
      channels: validatedChannels,
      topChannel: validatedTop,
    };
  });
}
