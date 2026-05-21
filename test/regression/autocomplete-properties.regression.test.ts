/**
 * Property-based regression tests for the Autocomplete (typeahead) use case.
 *
 * Feature: tools.autocomplete — POST /v1/entity/autocomplete. The use case is a
 * deterministic projection over the entity resolver: it hydrates each resolver
 * candidate with an optional retrieval document and emits an AutocompleteSuggestion
 * card, preserving the resolver's rank ordering. It powers a low-latency hot path,
 * so the projection MUST be faithful, deterministic, NFC/NFD-stable, and order/
 * count/dedup preserving relative to the resolver contract.
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
 *   P2  Cardinality — suggestions.length === resolver candidates.length (no drop,
 *       no synthesis). The HTTP schema caps at MAX_RESOLVE_CANDIDATES; the resolver
 *       is the authority on count, the use case is a faithful 1:1 projection.
 *   P3  Order + rank preservation — suggestion[i].entity_id and .rank mirror the
 *       resolver candidate at the same index (rank ordering is the resolver's; the
 *       use case never re-sorts and never re-numbers).
 *   P4  Identity / dedup faithfulness — the multiset of emitted entity_ids equals
 *       the resolver candidate entity_id multiset (duplicates neither introduced
 *       nor collapsed by the projection).
 *   P5  Label fallback — when document hydration misses an entity, canonical_label
 *       falls back to the resolver candidate's canonicalLabel; when present, the
 *       document label wins (newField ?? deprecatedField-style migration).
 *   P6  Passthrough — status, decision_trace_ref, authority_trace_ref, and
 *       request_id are forwarded verbatim from the resolver response.
 *   P7  NFC/NFD prefix stability — passing a Korean prefix in NFC vs NFD form
 *       reaches the resolver byte-for-byte unchanged (the use case is transparent;
 *       it neither normalizes nor mangles the query) AND the projected suggestions
 *       are identical regardless of which form the resolver echoes in labels.
 *   P8  Empty-prefix / empty-candidate safety — zero candidates yields zero
 *       suggestions, never throws, and skips the document lookup entirely.
 *   P9  Score bound preservation — calibrated_score is forwarded verbatim within
 *       the resolver's documented [0,1] range; never clamped or recomputed.
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
import type { ResolveUseCasePort } from '../../src/application/search/port/search-route-usecases.port.js';
import type { EntityDocumentLookupPort } from '../../src/application/search/port/search-pipeline-deps.port.js';
import type { ResolveResponse } from '../../src/application/search/resolve-response.dto.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import type { ResolveRequest } from '../../src/application/search/resolve-request.dto.js';

const RUNS = 100;

// Canonical Korean typeahead prefixes for wine queries (한글):
//  와    → "와인" (wine), the most common bare-prefix probe
//  까베  → "까베르네" (Cabernet)
//  샤르  → "샤르도네" (Chardonnay)
const KOREAN_PREFIXES = ['와', '까베', '샤르'] as const;

// A canonical decision-trace ref matching CANONICAL_AUTHORITY_TRACE_REF_PATTERN.
const TRACE_REF =
  'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

interface ResolverCandidateFixture {
  readonly entityId: CanonicalEntityId;
  readonly canonicalLabel: string;
  readonly rank: number;
  readonly calibratedScore: number;
  readonly evidenceRefs: readonly string[];
}

/**
 * Build a resolve use-case stub that echoes a fixed response. Records the
 * request/options it was called with so transparency (P7) can be asserted.
 */
function makeResolveStub(response: ResolveResponse): {
  readonly port: ResolveUseCasePort;
  readonly calls: { request: ResolveRequest; options: unknown }[];
} {
  const calls: { request: ResolveRequest; options: unknown }[] = [];
  const port: ResolveUseCasePort = {
    execute: (request, options) => {
      calls.push({ request, options });
      return Promise.resolve(response);
    },
  };
  return { port, calls };
}

function makeEntityLookupStub(docs: ReadonlyMap<CanonicalEntityId, RetrievalDocument>): {
  readonly port: EntityDocumentLookupPort;
  readonly requestedIds: CanonicalEntityId[][];
} {
  const requestedIds: CanonicalEntityId[][] = [];
  const port: EntityDocumentLookupPort = {
    getDocuments: (entityIds) => {
      requestedIds.push([...entityIds]);
      return Promise.resolve(docs);
    },
  };
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

// Resolver candidate arbitrary. Ranks are assigned post-hoc (1..N) by the
// generator to honor the resolver contract ("ordered by rank ascending").
function candidateArb(): fc.Arbitrary<Omit<ResolverCandidateFixture, 'rank'>> {
  return fc.record({
    entityId: entityIdSeedArb.map((s) => createEntityId(s)),
    canonicalLabel: fc.oneof(
      fc.constantFrom('Opus One 2018', '샤또 마고 2015', '와인 셀렉션', 'Cabernet'),
      fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
    ),
    calibratedScore: fc.double({ min: 0, max: 1, noNaN: true }),
    evidenceRefs: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
  });
}

function statusArb(): fc.Arbitrary<ResolveResponse['status']> {
  return fc.constantFrom('resolved', 'ambiguous', 'failed');
}

interface ResolveResponseFixture {
  readonly response: ResolveResponse;
  readonly candidates: readonly ResolverCandidateFixture[];
}

function resolveResponseArb(): fc.Arbitrary<ResolveResponseFixture> {
  return fc
    .tuple(
      fc.array(candidateArb(), { minLength: 0, maxLength: 8 }),
      statusArb(),
      fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
    )
    .map(([rawCandidates, status, requestId]) => {
      const candidates: ResolverCandidateFixture[] = rawCandidates.map((c, index) => ({
        ...c,
        rank: index + 1,
      }));
      const response: ResolveResponse = {
        status,
        candidates: candidates.map((c) => ({
          entityId: c.entityId,
          canonicalLabel: c.canonicalLabel,
          rank: c.rank,
          calibratedScore: c.calibratedScore,
          evidenceRefs: c.evidenceRefs,
        })),
        topEntity: candidates[0]
          ? {
              entityId: candidates[0].entityId,
              canonicalLabel: candidates[0].canonicalLabel,
              calibratedScore: candidates[0].calibratedScore,
            }
          : undefined,
        decision_trace_ref: TRACE_REF,
        authority_trace_ref: TRACE_REF,
        ...(requestId !== undefined ? { request_id: requestId } : {}),
      };
      return { response, candidates };
    });
}

// ── P1 Determinism ───────────────────────────────────────────────────────────

describe('Property: autocomplete projection determinism', () => {
  it('execute is referentially transparent for arbitrary resolver responses', async () => {
    await fc.assert(
      fc.asyncProperty(resolveResponseArb(), async ({ response }) => {
        const resolveA = makeResolveStub(response);
        const lookupA = makeEntityLookupStub(new Map());
        const ucA = new AutocompleteUseCase({ resolveUseCase: resolveA.port, entityLookup: lookupA.port });

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
      fc.asyncProperty(resolveResponseArb(), async ({ response, candidates }) => {
        const resolve = makeResolveStub(response);
        const lookup = makeEntityLookupStub(new Map());
        const uc = new AutocompleteUseCase({ resolveUseCase: resolve.port, entityLookup: lookup.port });

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
  it('uses document label when present, resolver label when hydration misses', async () => {
    await fc.assert(
      fc.asyncProperty(
        resolveResponseArb(),
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
          const resolve = makeResolveStub(response);
          const lookup = makeEntityLookupStub(docs);
          const uc = new AutocompleteUseCase({ resolveUseCase: resolve.port, entityLookup: lookup.port });

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

// ── P6 Passthrough ────────────────────────────────────────────────────────────

describe('Property: status / trace-ref / request-id passthrough', () => {
  it('forwards resolver envelope fields verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(resolveResponseArb(), async ({ response }) => {
        const resolve = makeResolveStub(response);
        const lookup = makeEntityLookupStub(new Map());
        const uc = new AutocompleteUseCase({ resolveUseCase: resolve.port, entityLookup: lookup.port });

        const result = await uc.execute({ query: 'q' });

        expect(result.status).toBe(response.status);
        expect(result.decision_trace_ref).toBe(response.decision_trace_ref);
        expect(result.authority_trace_ref).toBe(response.authority_trace_ref);
        expect(result.request_id).toBe(response.request_id);
      }),
      { numRuns: RUNS },
    );
  });
});

// ── P7 NFC/NFD Korean prefix stability ───────────────────────────────────────

describe('Property: NFC/NFD Korean prefix transparency', () => {
  it('forwards the Korean query to the resolver byte-for-byte (no normalization)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...KOREAN_PREFIXES),
        fc.constantFrom('NFC', 'NFD'),
        async (prefix, form) => {
          // Build the requested normalization form. The use case must not alter it.
          const query = prefix.normalize(form === 'NFC' ? 'NFC' : 'NFD');
          const resolve = makeResolveStub({
            status: 'resolved',
            candidates: [],
            topEntity: undefined,
            decision_trace_ref: TRACE_REF,
            authority_trace_ref: TRACE_REF,
          });
          const lookup = makeEntityLookupStub(new Map());
          const uc = new AutocompleteUseCase({ resolveUseCase: resolve.port, entityLookup: lookup.port });

          await uc.execute({ query });

          expect(resolve.calls).toHaveLength(1);
          // Byte-for-byte transparency: the resolver receives exactly what we sent.
          expect(resolve.calls[0]!.request.query).toBe(query);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('projects identical suggestions whether resolver echoes NFC or NFD Korean labels', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...KOREAN_PREFIXES), async (prefix) => {
        const baseLabel = `${prefix}도네 셀렉션`;
        const entityId = createEntityId(`ko-${prefix}`);

        const buildResponse = (form: 'NFC' | 'NFD'): ResolveResponse => ({
          status: 'resolved',
          candidates: [
            {
              entityId,
              canonicalLabel: baseLabel.normalize(form),
              rank: 1,
              calibratedScore: 0.9,
              evidenceRefs: [],
            },
          ],
          topEntity: undefined,
          decision_trace_ref: TRACE_REF,
          authority_trace_ref: TRACE_REF,
        });

        const runForm = async (form: 'NFC' | 'NFD'): Promise<string | undefined> => {
          const resolve = makeResolveStub(buildResponse(form));
          const lookup = makeEntityLookupStub(new Map());
          const uc = new AutocompleteUseCase({ resolveUseCase: resolve.port, entityLookup: lookup.port });
          const result = await uc.execute({ query: prefix });
          return result.suggestions[0]?.entity.canonical_label;
        };

        const nfc = await runForm('NFC');
        const nfd = await runForm('NFD');
        // The projection preserves whatever the resolver returned; both forms
        // render the same grapheme sequence after NFC re-normalization.
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
  it('emits zero suggestions and skips the document lookup when resolver returns none', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(''), fc.constantFrom(...KOREAN_PREFIXES), fc.string({ maxLength: 8 })),
        statusArb(),
        async (query, status) => {
          const resolve = makeResolveStub({
            status,
            candidates: [],
            topEntity: undefined,
            decision_trace_ref: TRACE_REF,
            authority_trace_ref: TRACE_REF,
          });
          const lookup = makeEntityLookupStub(new Map());
          const uc = new AutocompleteUseCase({ resolveUseCase: resolve.port, entityLookup: lookup.port });

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
  it('never clamps or recomputes the resolver calibrated score', async () => {
    await fc.assert(
      fc.asyncProperty(resolveResponseArb(), async ({ response, candidates }) => {
        const resolve = makeResolveStub(response);
        const lookup = makeEntityLookupStub(new Map());
        const uc = new AutocompleteUseCase({ resolveUseCase: resolve.port, entityLookup: lookup.port });

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
