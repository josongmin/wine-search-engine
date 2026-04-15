import { z } from 'zod';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { CandidateAttributePort } from '../../domain/mixed/service/mixed-solver.js';
import type { SimilarityCandidate } from '../../domain/mixed/service/similarity-scorer.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const attrLog = bootstrapLogger.child({ component: 'VespaCandidateAttributes' });

/**
 * Zod schema for the ranker-critical fields returned by Vespa document fetch.
 *
 * Uses `.passthrough()` so unknown fields from index drift are preserved
 * rather than rejected — callers may still read them via dynamic keys.
 * The schema validates only the fields the downstream ranker/solver depends on.
 */
export const VespaCandidateAttributesSchema = z.object({
  canonicalLabel: z.string().optional(),
  region: z.string().optional(),
  appellation: z.string().optional(),
  country: z.string().optional(),
  grapePrimary: z.string().optional(),
  vintageYear: z.number().int().optional(),
  criticScoreNormalized: z.number().finite().optional(),
  priceUsd: z.number().finite().optional(),
  producerPrestige: z.number().finite().optional(),
  popularityScore: z.number().finite().optional(),
  body: z.number().finite().optional(),
  tannin: z.number().finite().optional(),
  acidity: z.number().finite().optional(),
  sweetness: z.number().finite().optional(),
}).passthrough();

/** Empty record returned when Vespa document validation fails (graceful degradation). */
const EMPTY_ATTRIBUTES: Readonly<Record<string, unknown>> = Object.freeze({});
/** Number of object keys included in the schema-failure log preview. */
const SCHEMA_FAIL_PREVIEW_KEY_LIMIT = 8;

/**
 * Validate a raw Vespa document into a safe attribute record.
 * On failure, logs a warning with a field preview and returns empty attributes
 * so that a single malformed hit does not crash the entire request.
 */
function validateAttributes(
  entityId: CanonicalEntityId,
  raw: unknown,
): Readonly<Record<string, unknown>> {
  const result = VespaCandidateAttributesSchema.safeParse(raw);
  if (result.success) {
    return result.data as Readonly<Record<string, unknown>>;
  }

  attrLog.warn(
    {
      entityId,
      issues: result.error.issues.slice(0, 3),
      preview: typeof raw === 'object' && raw !== null
        ? Object.keys(raw).slice(0, SCHEMA_FAIL_PREVIEW_KEY_LIMIT)
        : typeof raw,
    },
    'VespaCandidateAttributes: document failed schema validation, returning empty attributes',
  );
  return EMPTY_ATTRIBUTES;
}

/**
 * Vespa-backed implementation of {@link CandidateAttributePort}.
 *
 * Fetches full {@link RetrievalDocument}s from the Vespa index in parallel
 * and maps them to the attribute contracts expected by the mixed-query domain.
 */
export class VespaCandidateAttributes implements CandidateAttributePort {
  constructor(private readonly searchIndex: SearchIndexPort) {}

  async loadAttributes(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, Readonly<Record<string, unknown>>>> {
    if (entityIds.length === 0) {
      return new Map();
    }

    const map = new Map<CanonicalEntityId, Readonly<Record<string, unknown>>>();

    // Epic-07 T07-2 / T-E4-01: `getDocuments` is now a required port contract,
    // so we always prefer the backend-native batch fetch over N single GETs.
    const docs = await this.searchIndex.getDocuments(entityIds);
    for (const [id, doc] of docs) {
      map.set(id, validateAttributes(id, doc));
    }
    return map;
  }

  async loadSimilarityCandidate(
    entityId: CanonicalEntityId,
  ): Promise<SimilarityCandidate | undefined> {
    const doc = await this.searchIndex.getDocument(entityId);
    if (doc === null) return undefined;

    return {
      region: doc.region,
      grapes: doc.grapes,
      body: doc.body,
      sweetness: doc.sweetness,
      style: doc.style,
      ...(doc.embedding !== undefined ? { embedding: doc.embedding } : {}),
    };
  }
}
