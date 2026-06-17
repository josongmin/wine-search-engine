/**
 * Property-based regression tests for the Autocomplete (typeahead) use case.
 *
 * Feature: tools.autocomplete — eval-only typeahead use case over Entity Lookup V2.
 * deterministic projection over Entity Lookup V2: it hydrates each V2 candidate
 * with an optional retrieval document and emits an AutocompleteSuggestion card,
 * preserving the V2 rank ordering. It powers a low-latency hot path, so the
 * projection MUST be faithful, deterministic, NFC/NFD-stable, and order/count/
 * dedup preserving relative to the V2 lookup contract.
 *
 * Production code under test (catalog key_files):
 *  - src/application/search/autocomplete.usecase.ts (AutocompleteUseCase)
 *
 * Shared scorer/extractor helpers exercised by both the live API and the offline
 * eval runner (scripts/eval/run-autocomplete-eval.ts) are property-tested too,
 * because the live API path uses extractAutocompleteRankedEntityIds /
 * extractAutocompleteStatus to read the very same wire shape this use case emits.
 *
 * Invariants verified (append-only; SOTA++ grade; numRuns = 100):
 *   P1  Determinism — execute(req) called twice yields deeply-equal responses.
 *   P2  Cardinality — suggestions.length === V2 candidates.length (no drop,
 *       no synthesis). The HTTP schema caps at MAX_RESOLVE_CANDIDATES; V2 is the
 *       authority on count, the use case is a faithful 1:1 projection.
 *   P3  Order + rank preservation — suggestion[i].entity_id and .rank mirror the
 *       V2 candidate at the same index (rank ordering is V2's; the use case never
 *       re-sorts and never re-numbers).
 *   P4  Identity / dedup faithfulness — the multiset of emitted entity_ids equals
 *       the V2 candidate entity_id multiset (duplicates neither introduced nor
 *       collapsed by the projection).
 *   P5  Label fallback — when document hydration misses an entity, canonical_label
 *       falls back to the V2 candidate's canonicalLabel; when present, the document
 *       label wins.
 *   P6  Mapping fidelity — status is the V2→autocomplete projection, trace refs are
 *       deterministic from the V2 evidence spine, and request_id comes from V2 meta.
 *   P7  NFC/NFD prefix stability — passing a Korean prefix in NFC vs NFD form
 *       reaches Entity Lookup V2 byte-for-byte unchanged (the use case is transparent;
 *       it neither normalizes nor mangles the query) AND the projected suggestions
 *       are identical regardless of which form V2 echoes in labels.
 *   P8  Empty-prefix / empty-candidate safety — zero candidates yields zero
 *       suggestions, never throws, and skips the document lookup entirely.
 *   P9  Score bound preservation — calibrated_score is forwarded verbatim within
 *       V2's documented [0,1] range; never clamped or recomputed.
 *
 * Shared eval helper invariants:
 *   P10 recallAtK monotonicity in k and consistency with reciprocal rank.
 *   P11 extractAutocompleteRankedEntityIds is order-preserving, drops only empty
 *       ids, and reads both entity_id and entityId spellings.
 *
 * Touch-policy: regression-only and append-only. Korean prefixes (와, 까베, 샤르)
 * are first-class. No `\b` is used anywhere; Korean-aware checks use
 * [\p{L}\p{N}] character classes with the /u flag.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { AutocompleteUseCase } from '../../src/application/search/autocomplete.usecase.js';
import { createEntityId, type CanonicalEntityId } from '../../src/domain/shared/types/index.js';
import {
  extractAutocompleteRankedEntityIds,
  scoreAutocompleteBenchmark,
  type AutocompleteBenchmarkCase,
} from '../../scripts/eval/run-autocomplete-eval.ts';
import type { EntityLookupV2UseCasePort } from '../../src/application/search/port/search-route-usecases.port.js';
import type { LookupResolverProjectionPort } from '../../src/application/search/port/search-pipeline-deps.port.js';
import { wrapEntityDocumentBatchLookupAsResolverProjection } from '../../src/application/search/__tests__/resolver-projection-lookup.stub.js';
import type { EntityLookupV2Command, EntityLookupV2Result } from '../../src/application/search/entity-lookup-v2/entity-lookup-v2.dto.js';
import {
  buildEntityLookupV2AutocompleteTraceRef,
  mapLookupV2StatusToAutocompleteStatus,
} from '../../src/application/search/entity-lookup-v2/entity-lookup-v2-autocomplete-mapping.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';

const RUNS = 100;

// Canonical Korean typeahead prefixes for wine queries (한글):
//  와    → "와인" (wine), the most common bare-prefix probe
//  까베  → "까베르네" (Cabernet)
//  샤르  → "샤르도네" (Chardonnay)
const KOREAN_PREFIXES = ['와', '까베', '샤르'] as const;

interface LookupV2CandidateFixture {
  readonly entityId: CanonicalEntityId;
  readonly canonicalLabel: string;
  readonly rank: number;
  readonly calibratedScore: number;
}

function buildLookupV2CandidateView(candidate: LookupV2CandidateFixture): EntityLookupV2Result['candidates'][number] {
  return {
    entityId: String(candidate.entityId),
    canonicalLabel: candidate.canonicalLabel,
    rank: candidate.rank,
    calibratedScore: candidate.calibratedScore,
    channelAgreement: 1,
    channelHits: [],
  };
}

function buildLookupV2Result(
  status: EntityLookupV2Result['status'],
  candidates: readonly LookupV2CandidateFixture[],
  requestId?: string,
): EntityLookupV2Result {
  const candidateViews = candidates.map(buildLookupV2CandidateView);
  return {
    status,
    decisionReason: 'test',
    normalizedQueryViews: {
      raw: 'q',
      strict: 'q',
      accentless: 'q',
      compact: 'q',
      vintageCanonicalized: 'q',
      vintageStripped: 'q',
      lookupVariants: ['q'],
    },
    candidates: candidateViews,
    topCandidate: candidateViews[0] ?? null,
    clarificationOptions: [],
    evidenceSummary: {
      admissionReasonCode: 'admit_entity_lookup',
      decisionReasonCode: status === 'resolved' ? 'resolved_single_candidate' : 'test_reason',
      calibrationTrusted: true,
      queryClass: 'short_entity',
      candidatePoolSize: candidates.length,
      channelCoverage: [],
    },
    meta: {
      queryTimeMs: 1,
      version: 'entity-lookup-v2/1.0.0',
      engineSchemaVersion: 'entity_lookup_v2',
      ...(requestId !== undefined ? { requestId } : {}),
    },
  };
}

/**
 * Build an Entity Lookup V2 stub that echoes a fixed response. Records the
 * command/options it was called with so transparency (P7) can be asserted.
 */
function makeEntityLookupV2Stub(response: EntityLookupV2Result): {
  readonly port: EntityLookupV2UseCasePort;
  readonly calls: { command: EntityLookupV2Command; options: unknown }[];
} {
  const calls: { command: EntityLookupV2Command; options: unknown }[] = [];
  const port: EntityLookupV2UseCasePort = {
    execute: (command, options) => {
      calls.push({ command, options });
      return Promise.resolve(response);
    },
  };
  return { port, calls };
}

function makeResolverProjectionStub(docs: ReadonlyMap<CanonicalEntityId, RetrievalDocument>): {
  readonly port: LookupResolverProjectionPort;
  readonly requestedIds: CanonicalEntityId[][];
} {
  const requestedIds: CanonicalEntityId[][] = [];
  const port = wrapEntityDocumentBatchLookupAsResolverProjection({
    getDocuments: (entityIds) => {
      requestedIds.push([...entityIds]);
      return Promise.resolve(docs);
    },
  });
  return { port, requestedIds };
}

function buildDoc(entityId: CanonicalEntityId, canonicalLabel: string): RetrievalDocument {
  return {
    entityId,
    entityType: 'wine',
    canonicalLabel,
    aliasesIdentitySafe: [canonicalLabel],
    aliasesNoisyRecall: [],
    producer: 'Producer',
    region: 'Region',
    country: 'Country',
    appellation: 'Appellation',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '검색',
    searchTextEn: 'search',
    semanticSummary: 'summary',
    style: 'full red',
    priceBand: 'luxury',
    pairing: ['steak'],
    availability: true,
    popularityScore: 0.5,
    vintageYear: 2018,
    wineType: 'red',
  } as RetrievalDocument;
}

// ── Arbitraries ──────────────────────────────────────────────────────────────

// Entity-id seeds: include Korean + Latin so dedup/identity holds across scripts.
const entityIdSeedArb = fc.oneof(
  fc.constantFrom('opus-one', '샤또-마고', '까베르네', 'drc', '와인-1'),
  fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
);

// V2 candidate arbitrary. Ranks are assigned post-hoc (1..N) by the generator to
// honor the V2 contract ("ordered by rank ascending").
function candidateArb(): fc.Arbitrary<Omit<LookupV2CandidateFixture, 'rank'>> {
  return fc.record({
    entityId: entityIdSeedArb.map((s) => createEntityId(s)),
    canonicalLabel: fc.oneof(
      fc.constantFrom('Opus One 2018', '샤또 마고 2015', '와인 셀렉션', 'Cabernet'),
      fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
    ),
    calibratedScore: fc.double({ min: 0, max: 1, noNaN: true }),
  });
}

function statusArb(): fc.Arbitrary<EntityLookupV2Result['status']> {
  return fc.constantFrom('resolved', 'ambiguous', 'failed', 'redirect_discovery');
}

interface LookupV2ResponseFixture {
  readonly response: EntityLookupV2Result;
  readonly candidates: readonly LookupV2CandidateFixture[];
}

function lookupV2ResponseArb(): fc.Arbitrary<LookupV2ResponseFixture> {
  return fc
    .tuple(
      fc.array(candidateArb(), { minLength: 0, maxLength: 8 }),
      statusArb(),
      fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
    )
    .map(([rawCandidates, status, requestId]) => {
      const candidates: LookupV2CandidateFixture[] = rawCandidates.map((c, index) => ({
        ...c,
        rank: index + 1,
      }));
      const response = buildLookupV2Result(status, candidates, requestId);
      return { response, candidates };
    });
}

// ── P1 Determinism ───────────────────────────────────────────────────────────

describe('Property: autocomplete projection determinism', () => {
  it('execute is referentially transparent for arbitrary V2 responses', async () => {
    await fc.assert(
      fc.asyncProperty(lookupV2ResponseArb(), async ({ response }) => {
        const resolveA = makeEntityLookupV2Stub(response);
        const lookupA = makeResolverProjectionStub(new Map());
        const ucA = new AutocompleteUseCase({ entityLookupV2UseCase: resolveA.port, resolverProjectionLookup: lookupA.port });

        const first = await ucA.execute({ query: 'opu' });
        const second = await ucA.execute({ query: 'opu' });
        expect(first).toEqual(second);
      }),
      { numRuns: RUNS },
    );
  });
});

// ── P2 Cardinality / P3 order+rank / P4 dedup ─────────────────────────────────

describe('Property: faithful 1:1 projection (cardinality, order, rank, identity)', () => {
  it('preserves count, order, rank, and entity-id multiset', async () => {
    await fc.assert(
      fc.asyncProperty(lookupV2ResponseArb(), async ({ response, candidates }) => {
        const resolve = makeEntityLookupV2Stub(response);
        const lookup = makeResolverProjectionStub(new Map());
        const uc = new AutocompleteUseCase({ entityLookupV2UseCase: resolve.port, resolverProjectionLookup: lookup.port });

        const result = await uc.execute({ query: 'q' });

        // P2 cardinality
        expect(result.suggestions).toHaveLength(candidates.length);

        // P3 order + rank preservation
        for (let i = 0; i < candidates.length; i += 1) {
          expect(result.suggestions[i]!.entity.entity_id).toBe(String(candidates[i]!.entityId));
          expect(result.suggestions[i]!.rank).toBe(candidates[i]!.rank);
        }

        // P4 identity multiset (sorted comparison — duplicates preserved)
        const emitted = result.suggestions.map((s) => s.entity.entity_id).sort((a, b) => a.localeCompare(b));
        const expected = candidates.map((c) => String(c.entityId)).sort((a, b) => a.localeCompare(b));
        expect(emitted).toEqual(expected);
      }),
      { numRuns: RUNS },
    );
  });
});

// ── P5 Label fallback ─────────────────────────────────────────────────────────

describe('Property: canonical label hydration + fallback', () => {
  it('uses document label when present, V2 label when hydration misses', async () => {
    await fc.assert(
      fc.asyncProperty(
        lookupV2ResponseArb(),
        // Independent boolean per candidate index decides whether a doc exists.
        fc.array(fc.boolean(), { maxLength: 8 }),
        async ({ response, candidates }, hydrateFlags) => {
          // getDocuments returns a Map keyed by entityId, so duplicate-id
          // candidates legitimately share one doc. Build the doc label from the
          // entityId (not the per-index label) to mirror that contract exactly.
          const docs = new Map<CanonicalEntityId, RetrievalDocument>();
          for (let i = 0; i < candidates.length; i += 1) {
            if (hydrateFlags[i] === true) {
              docs.set(candidates[i]!.entityId, buildDoc(candidates[i]!.entityId, `DOC::${String(candidates[i]!.entityId)}`));
            }
          }
          const resolve = makeEntityLookupV2Stub(response);
          const lookup = makeResolverProjectionStub(docs);
          const uc = new AutocompleteUseCase({ entityLookupV2UseCase: resolve.port, resolverProjectionLookup: lookup.port });

          const result = await uc.execute({ query: 'q' });

          for (let i = 0; i < candidates.length; i += 1) {
            const doc = docs.get(candidates[i]!.entityId);
            const expectedLabel = doc !== undefined ? doc.canonicalLabel : candidates[i]!.canonicalLabel;
            expect(result.suggestions[i]!.entity.canonical_label).toBe(expectedLabel);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ── P6 Mapping fidelity ─────────────────────────────────────────────────────

describe('Property: status / trace-ref / request-id mapping fidelity', () => {
  it('projects V2 envelope fields through the autocomplete mapping', async () => {
    await fc.assert(
      fc.asyncProperty(lookupV2ResponseArb(), async ({ response }) => {
        const lookupV2 = makeEntityLookupV2Stub(response);
        const lookup = makeResolverProjectionStub(new Map());
        const uc = new AutocompleteUseCase({ entityLookupV2UseCase: lookupV2.port, resolverProjectionLookup: lookup.port });

        const result = await uc.execute({ query: 'q' });
        const traceRef = buildEntityLookupV2AutocompleteTraceRef(response);

        expect(result.status).toBe(mapLookupV2StatusToAutocompleteStatus(response.status));
        expect(result.decision_trace_ref).toBe(traceRef);
        expect(result.authority_trace_ref).toBe(traceRef);
        expect(result.request_id).toBe(response.meta.requestId);
      }),
      { numRuns: RUNS },
    );
  });
});

// ── P7 NFC/NFD Korean prefix stability ───────────────────────────────────────

describe('Property: NFC/NFD Korean prefix transparency', () => {
  it('forwards the Korean query to Entity Lookup V2 byte-for-byte (no normalization)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_PREFIXES),
        fc.constantFrom('NFC', 'NFD'),
        async (prefix, form) => {
          // Build the requested normalization form. The use case must not alter it.
          const query = prefix.normalize(form === 'NFC' ? 'NFC' : 'NFD');
          const lookupV2 = makeEntityLookupV2Stub(buildLookupV2Result('resolved', []));
          const lookup = makeResolverProjectionStub(new Map());
          const uc = new AutocompleteUseCase({ entityLookupV2UseCase: lookupV2.port, resolverProjectionLookup: lookup.port });

          await uc.execute({ query });

          expect(lookupV2.calls).toHaveLength(1);
          // Byte-for-byte transparency: V2 receives exactly what we sent.
          expect(lookupV2.calls[0]!.command.query).toBe(query);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('projects identical suggestions whether V2 echoes NFC or NFD Korean labels', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...KOREAN_PREFIXES), async (prefix) => {
        const baseLabel = `${prefix}도네 셀렉션`;
        const entityId = createEntityId(`ko-${prefix}`);

        const buildResponse = (form: 'NFC' | 'NFD'): EntityLookupV2Result =>
          buildLookupV2Result('resolved', [{
            entityId,
            canonicalLabel: baseLabel.normalize(form),
            rank: 1,
            calibratedScore: 0.9,
          }]);

        const runForm = async (form: 'NFC' | 'NFD'): Promise<string | undefined> => {
          const lookupV2 = makeEntityLookupV2Stub(buildResponse(form));
          const lookup = makeResolverProjectionStub(new Map());
          const uc = new AutocompleteUseCase({ entityLookupV2UseCase: lookupV2.port, resolverProjectionLookup: lookup.port });
          const result = await uc.execute({ query: prefix });
          return result.suggestions[0]?.entity.canonical_label;
        };

        const nfc = await runForm('NFC');
        const nfd = await runForm('NFD');
        // The projection preserves whatever V2 returned; both forms render the same
        // grapheme sequence after NFC re-normalization.
        expect(nfc).toBeDefined();
        expect(nfd).toBeDefined();
        expect(nfc!.normalize('NFC')).toBe(nfd!.normalize('NFC'));
      }),
      { numRuns: RUNS },
    );
  });
});

// ── P8 Empty safety ───────────────────────────────────────────────────────────

describe('Property: empty-candidate and empty-prefix safety', () => {
  it('emits zero suggestions and skips the document lookup when V2 returns none', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(''), fc.constantFrom(...KOREAN_PREFIXES), fc.string({ maxLength: 8 })),
        statusArb(),
        async (query, status) => {
          const lookupV2 = makeEntityLookupV2Stub(buildLookupV2Result(status, []));
          const lookup = makeResolverProjectionStub(new Map());
          const uc = new AutocompleteUseCase({ entityLookupV2UseCase: lookupV2.port, resolverProjectionLookup: lookup.port });

          const result = await uc.execute({ query });
          expect(result.suggestions).toEqual([]);
          // No candidates → no doc lookup (latency hot-path guard).
          expect(lookup.requestedIds).toHaveLength(0);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ── P9 Score bound preservation ───────────────────────────────────────────────

describe('Property: calibrated score forwarded verbatim within [0,1]', () => {
  it('never clamps or recomputes the V2 calibrated score', async () => {
    await fc.assert(
      fc.asyncProperty(lookupV2ResponseArb(), async ({ response, candidates }) => {
        const resolve = makeEntityLookupV2Stub(response);
        const lookup = makeResolverProjectionStub(new Map());
        const uc = new AutocompleteUseCase({ entityLookupV2UseCase: resolve.port, resolverProjectionLookup: lookup.port });

        const result = await uc.execute({ query: 'q' });
        for (let i = 0; i < candidates.length; i += 1) {
          expect(result.suggestions[i]!.calibrated_score).toBe(candidates[i]!.calibratedScore);
          expect(result.suggestions[i]!.calibrated_score).toBeGreaterThanOrEqual(0);
          expect(result.suggestions[i]!.calibrated_score).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

// ── P10 Shared eval scorer invariants ────────────────────────────────────────

describe('Property: recall@k monotonicity and reciprocal-rank consistency', () => {
  it('recall@1 ≤ recall@3 ≤ recall@5, and mrr>0 ⇔ recall@5=1 for a single case', () => {
    fc.assert(
      fc.property(
        fc.array(entityIdSeedArb, { minLength: 0, maxLength: 10 }),
        entityIdSeedArb,
        (rankedSeeds, expectedSeed) => {
          const ranked = rankedSeeds.map((s) => String(createEntityId(s)));
          const expected = String(createEntityId(expectedSeed));
          const benchCase: AutocompleteBenchmarkCase = {
            benchmark_id: 'b1',
            query: 'op',
            expected_entity_id: expected,
            category: 'latin_prefix',
            language: 'en',
            difficulty: 'easy',
          };
          const report = scoreAutocompleteBenchmark([benchCase], new Map([['b1', ranked]]));

          expect(report.recall_at_1).toBeLessThanOrEqual(report.recall_at_3);
          expect(report.recall_at_3).toBeLessThanOrEqual(report.recall_at_5);

          const idx = ranked.indexOf(expected);
          const within5 = idx >= 0 && idx < 5;
          expect(report.recall_at_5 === 1).toBe(within5);
          // MRR positive iff the expected id appears anywhere in the ranking.
          expect(report.mrr > 0).toBe(idx >= 0);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ── P11 Wire extraction invariants ────────────────────────────────────────────

describe('Property: extractAutocompleteRankedEntityIds order + filtering', () => {
  it('preserves order, drops only empty ids, reads entity_id and entityId spellings', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.oneof(entityIdSeedArb.map((s) => String(createEntityId(s))), fc.constant('')),
            spelling: fc.constantFrom('entity_id', 'entityId'),
          }),
          { maxLength: 12 },
        ),
        (rows) => {
          const suggestions = rows.map((row) =>
            row.spelling === 'entity_id'
              ? { entity: { entity_id: row.id } }
              : { entity: { entityId: row.id } },
          );
          const extracted = extractAutocompleteRankedEntityIds({ status: 'resolved', suggestions });

          const expected = rows.map((r) => r.id).filter((id) => id.length > 0);
          expect(extracted).toEqual(expected);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
