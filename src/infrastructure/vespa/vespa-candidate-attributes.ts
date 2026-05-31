import { z } from 'zod';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { CandidateAttributePort } from '../../domain/mixed/service/mixed-solver.js';
import type { SimilarityCandidate } from '../../domain/mixed/service/similarity-scorer.js';
import type { SearchIndexPort } from '../../domain/retrieval/port/search-index.port.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import {
  globalSilentSkipCounter,
  type SilentSkipCounter,
} from '../../domain/observability/silent-skip-counters.js';
import type { GetDocumentsReport } from './vespa-search-index.js';

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
 * Structural shape of the non-deprecated, diagnostics-rich batch-fetch API.
 *
 * The `SearchIndexPort` contract only exposes the legacy `getDocuments`
 * (whose concrete `VespaSearchIndex` implementation is `@deprecated`).
 * `getDocumentsReport` lives on the concrete Vespa adapter and surfaces
 * `missingIds` / `parseFailures` / `batchFailures` so partial hydration is
 * observable. We narrow for it structurally so this adapter can prefer the
 * non-deprecated API when the injected index provides it, without forcing the
 * domain port to depend on an infrastructure-only return shape.
 */
interface GetDocumentsReportCapable {
  getDocumentsReport(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<GetDocumentsReport>;
}

function hasGetDocumentsReport(
  index: SearchIndexPort,
): index is SearchIndexPort & GetDocumentsReportCapable {
  return (
    typeof (index as Partial<GetDocumentsReportCapable>).getDocumentsReport ===
    'function'
  );
}

/**
 * Vespa-backed implementation of {@link CandidateAttributePort}.
 *
 * Fetches full {@link RetrievalDocument}s from the Vespa index in parallel
 * and maps them to the attribute contracts expected by the mixed-query domain.
 */
export class VespaCandidateAttributes implements CandidateAttributePort {
  constructor(
    private readonly searchIndex: SearchIndexPort,
    private readonly silentSkipCounter: SilentSkipCounter = globalSilentSkipCounter,
  ) {}

  async loadAttributes(
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, Readonly<Record<string, unknown>>>> {
    if (entityIds.length === 0) {
      return new Map();
    }

    const map = new Map<CanonicalEntityId, Readonly<Record<string, unknown>>>();

    // Epic-07 T07-2 / T-E4-01: prefer the backend-native batch fetch over N
    // single GETs. The concrete `VespaSearchIndex.getDocuments` is `@deprecated`
    // in favour of `getDocumentsReport`, which surfaces missing/parse/batch
    // diagnostics so partial hydration is observable rather than silently
    // swallowed. Use the non-deprecated API when the injected index exposes it;
    // fall back to the legacy port method otherwise (migration fallback:
    // newApi ?? deprecated). TODO(cleanup): remove the `getDocuments` branch
    // once `getDocumentsReport` is promoted onto `SearchIndexPort`.
    const docs = hasGetDocumentsReport(this.searchIndex)
      ? await this.fetchDocsWithReport(this.searchIndex, entityIds)
      : await this.searchIndex.getDocuments(entityIds);
    for (const [id, doc] of docs) {
      map.set(id, validateAttributes(id, doc));
    }
    return map;
  }

  /**
   * Fetch documents via the non-deprecated diagnostics-rich API and record any
   * partial-hydration signal on the silent-skip counter so a thinned candidate
   * set (which degrades similarity/attribute scoring) is observable instead of
   * silent. The behaviour-visible result is identical to `getDocuments` — only
   * the surviving `docs` map is returned.
   */
  private async fetchDocsWithReport(
    index: SearchIndexPort & GetDocumentsReportCapable,
    entityIds: readonly CanonicalEntityId[],
  ): Promise<ReadonlyMap<CanonicalEntityId, RetrievalDocument>> {
    const report = await index.getDocumentsReport(entityIds);
    if (
      report.missingIds.length > 0 ||
      report.parseFailures > 0 ||
      report.batchFailures > 0
    ) {
      attrLog.warn(
        {
          requestedCount: entityIds.length,
          returnedCount: report.docs.size,
          missingCount: report.missingIds.length,
          parseFailures: report.parseFailures,
          batchFailures: report.batchFailures,
        },
        'VespaCandidateAttributes: partial document hydration — mixed-query attribute solver running on a thinned candidate set',
      );
      const context = {
        requestedCount: entityIds.length,
        returnedCount: report.docs.size,
      } as const;
      if (report.missingIds.length > 0) {
        this.silentSkipCounter.increment('candidate_attributes_hydration_missing', {
          ...context,
          missingCount: report.missingIds.length,
        });
      }
      if (report.parseFailures > 0) {
        this.silentSkipCounter.increment('candidate_attributes_hydration_parse_failure', {
          ...context,
          parseFailures: report.parseFailures,
        });
      }
      if (report.batchFailures > 0) {
        this.silentSkipCounter.increment('candidate_attributes_hydration_batch_failure', {
          ...context,
          batchFailures: report.batchFailures,
        });
      }
    }
    return report.docs;
  }

  async loadSimilarityCandidate(
    entityId: CanonicalEntityId,
  ): Promise<SimilarityCandidate | undefined> {
    const doc = await this.searchIndex.getDocument(entityId);
    if (doc === null) return undefined;

    // doc.style is optional on RetrievalDocument (derived-style fallback for
    // wines whose silver row didn't carry an authoritative style descriptor).
    // SimilarityCandidate requires a string, so absent style degrades to '' —
    // computeStyleDistance treats '' as a non-matching style without breaking
    // the other similarity axes (region / grapes / body / sweetness / embed).
    return {
      region: doc.region,
      grapes: doc.grapes,
      body: doc.body,
      sweetness: doc.sweetness,
      style: doc.style ?? '',
      ...(doc.embedding !== undefined ? { embedding: doc.embedding } : {}),
    };
  }
}
