import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { AnchorResolverPort } from '../../domain/mixed/service/mixed-solver.js';
import type { AnchorEntityData } from '../../domain/mixed/service/anchor-profiler.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';

/**
 * Vespa-backed implementation of {@link AnchorResolverPort}.
 *
 * Fetches the full {@link RetrievalDocument} from the Vespa index and
 * projects it down to the {@link AnchorEntityData} contract required by
 * {@link AnchorProfiler}.
 */
export class VespaAnchorResolver implements AnchorResolverPort {
  constructor(private readonly searchIndex: SearchIndexPort) {}

  async resolve(entityId: CanonicalEntityId): Promise<AnchorEntityData | undefined> {
    const doc = await this.searchIndex.getDocument(entityId);
    if (doc === null) return undefined;

    return {
      entityId: doc.entityId,
      canonicalLabel: doc.canonicalLabel,
      region: doc.region,
      grapes: doc.grapes,
      body: doc.body,
      sweetness: doc.sweetness,
      style: doc.style,
      ...(doc.embedding !== undefined ? { embedding: doc.embedding } : {}),
    };
  }
}
