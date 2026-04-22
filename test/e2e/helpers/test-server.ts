/**
 * E2E test server factory.
 *
 * Creates a real Fastify server wired with in-memory adapters.
 * Uses Fastify's inject() API to avoid binding to a real port.
 */

import type { FastifyInstance } from 'fastify';
import { createServer, type ServerOptions } from '../../../src/interface/http/server.js';
import {
  createTestContainer,
  type TestContainerOptions,
} from '../../integration/helpers/test-container.js';
import { SimilarityScorer } from '../../../src/domain/mixed/service/similarity-scorer.js';
import type { AnchorProfile } from '../../../src/domain/mixed/model/anchor-profile.js';
import type { AnchorEntityData } from '../../../src/domain/mixed/service/anchor-profiler.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { SimilarityCandidate } from '../../../src/domain/mixed/service/similarity-scorer.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';

export interface TestServer {
  readonly app: FastifyInstance;
}

interface TestServerOptions {
  readonly containerOptions?: TestContainerOptions;
  readonly serverOptions?: Pick<ServerOptions, 'rateLimitMax' | 'trustProxy'>;
}

type FixtureDoc = RetrievalDocument;

const mixedSimilarityScorer = new SimilarityScorer();

function buildAnchorEntityData(doc: FixtureDoc): AnchorEntityData {
  return {
    entityId: doc.entityId,
    canonicalLabel: doc.canonicalLabel,
    region: doc.region,
    grapes: doc.grapes,
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
  };
}

function buildAnchorProfile(doc: FixtureDoc): AnchorProfile {
  return {
    ...buildAnchorEntityData(doc),
    anchorConfidence: 1,
  };
}

function buildSimilarityCandidate(doc: FixtureDoc): SimilarityCandidate {
  return {
    region: doc.region,
    grapes: doc.grapes,
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
  };
}

function deriveWineType(style: string): string {
  const normalized = style.toLowerCase().trim();
  if (normalized.includes('sparkling')) return 'sparkling';
  if (normalized.includes('white')) return 'white';
  return 'red';
}

function inferVintageYear(label: string): number | undefined {
  const match = label.match(/(\d{4})$/);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : undefined;
}

function buildCandidateAttributes(doc: FixtureDoc): Readonly<Record<string, unknown>> {
  const vintageYear = inferVintageYear(doc.canonicalLabel);

  return {
    entity_id: doc.entityId,
    canonical_label: doc.canonicalLabel,
    producer: doc.producer,
    region: doc.region,
    grapes: doc.grapes,
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
    price_band: doc.priceBand,
    availability: doc.availability,
    search_text_en: doc.searchTextEn,
    search_text_ko: doc.searchTextKo,
    wine_type: deriveWineType(doc.style),
    color: deriveWineType(doc.style),
    ...(vintageYear !== undefined ? { vintage_year: vintageYear } : {}),
  };
}

function buildHybridCandidate(
  doc: FixtureDoc,
  anchorDoc: FixtureDoc,
  rank: number,
  retrievalScore: number,
): HybridCandidate {
  return {
    entityId: doc.entityId,
    canonicalLabel: doc.canonicalLabel,
    producer: doc.producer,
    region: doc.region,
    searchTextEn: doc.searchTextEn,
    grapePrimary: doc.grapes[0],
    body: doc.body,
    sweetness: doc.sweetness,
    style: doc.style,
    vintageYear: inferVintageYear(doc.canonicalLabel),
    sparseRank: rank,
    denseRank: rank,
    anchorRank: rank,
    fusionRrfTotal: retrievalScore,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'fusion',
      lexicalQueriesUsed: [anchorDoc.canonicalLabel],
      semanticQueriesUsed: [anchorDoc.searchTextEn],
      filtersApplied: [],
      candidateSources: ['sparse_bm25', 'dense_semantic', 'anchor_similarity'],
    },
  };
}

function computeMixedRetrievalScore(
  anchorProfile: AnchorProfile,
  candidate: SimilarityCandidate,
  popularityScore: number,
): number {
  const similarity = mixedSimilarityScorer.score(candidate, anchorProfile);
  return Math.max(0.001, Math.min(1, similarity * 0.75 + popularityScore * 0.25));
}

function seedMixedHarness(
  parts: ReturnType<typeof createTestContainer>,
  docs: readonly FixtureDoc[],
): void {

  for (const doc of docs) {
    parts.anchorResolver.addEntity(doc.entityId, buildAnchorEntityData(doc));
    parts.candidateAttributes.setAttribute(doc.entityId, buildCandidateAttributes(doc));
    parts.candidateAttributes.setSimilarity(doc.entityId, buildSimilarityCandidate(doc));
  }

  for (const anchorDoc of docs) {
    const anchorProfile = buildAnchorProfile(anchorDoc);
    const candidates = docs
      .filter((candidateDoc) => candidateDoc.entityId !== anchorDoc.entityId)
      .map((candidateDoc) => ({
        doc: candidateDoc,
        score: computeMixedRetrievalScore(
          anchorProfile,
          buildSimilarityCandidate(candidateDoc),
          candidateDoc.popularityScore,
        ),
      }))
      .sort((left, right) => right.score - left.score)
      .map(({ doc, score }, index) =>
        buildHybridCandidate(doc, anchorDoc, index + 1, score),
      );

    parts.similarRetrieval.setResults(anchorDoc.entityId, candidates);
  }
}

/**
 * Creates and initializes a Fastify test server backed by in-memory adapters.
 *
 * Loads the 10 test fixtures (aliases + documents) automatically.
 * Returns the Fastify instance for use with app.inject().
 */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const parts = createTestContainer(options.containerOptions);
  const docs = parts.fixtureDocuments;

  // createTestContainer already seeds aliases, search docs, blocking ids,
  // and runtime-shaped fixture documents. Only the ambiguity marker and
  // mixed harness enrichment happen here.
  parts.ambiguityDict.setAmbiguous('마고', ['region', 'entity'], 'medium');

  // Seed the mixed-query harness against the materialized fixture docs so
  // containerOptions like stripCachedDrinkingWindow remain effective in E2E.
  seedMixedHarness(parts, docs);

  // createServer is now async (registers rate-limit plugin etc.)
  const app = await createServer(parts.container, {
    logLevel: 'silent',
    nodeEnv: 'test',
    ...options.serverOptions,
  });

  // Initialize Fastify (registers routes, plugins, etc.)
  await app.ready();

  return { app };
}

/**
 * Closes the test server and releases resources.
 */
export async function closeTestServer(server: TestServer): Promise<void> {
  await server.app.close();
}
