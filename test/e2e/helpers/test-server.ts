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
import {
  toAnchorEntityData,
  toCandidateAttributes,
  toHybridCandidate,
  toSimilarityCandidate,
} from '../../integration/helpers/test-fixtures.js';
import { SimilarityScorer } from '../../../src/domain/mixed/service/similarity-scorer.js';
import type { AnchorProfile } from '../../../src/domain/mixed/model/anchor-profile.js';
import type { AnchorEntityData } from '../../../src/domain/mixed/service/anchor-profiler.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { SimilarityCandidate } from '../../../src/domain/mixed/service/similarity-scorer.js';
import type { RetrievalDocument } from '../../../src/domain/retrieval/model/retrieval-document.js';

export interface TestServer {
  readonly app: FastifyInstance;
}

interface TestAmbiguousSurface {
  readonly term: string;
  readonly types: readonly string[];
  readonly severity: 'low' | 'medium' | 'high';
}

interface TestServerOptions {
  readonly containerOptions?: TestContainerOptions;
  readonly serverOptions?: Pick<ServerOptions, 'rateLimitMax' | 'trustProxy'>;
  readonly ambiguousSurfaces?: readonly TestAmbiguousSurface[];
}

type FixtureDoc = RetrievalDocument;

const mixedSimilarityScorer = new SimilarityScorer();

function buildAnchorEntityData(doc: FixtureDoc): AnchorEntityData {
  return toAnchorEntityData(doc);
}

function buildAnchorProfile(doc: FixtureDoc): AnchorProfile {
  return {
    ...buildAnchorEntityData(doc),
    anchorConfidence: 1,
  };
}

function buildSimilarityCandidate(doc: FixtureDoc): SimilarityCandidate {
  return toSimilarityCandidate(doc);
}

function buildCandidateAttributes(doc: FixtureDoc): Readonly<Record<string, unknown>> {
  return toCandidateAttributes(doc);
}

function buildHybridCandidate(
  doc: FixtureDoc,
  anchorDoc: FixtureDoc,
  rank: number,
  retrievalScore: number,
): HybridCandidate {
  const candidate = toHybridCandidate(
    doc,
    rank,
    ['sparse_bm25', 'dense_semantic', 'anchor_similarity'],
    'fusion',
  );
  return {
    ...candidate,
    fusionRrfTotal: retrievalScore,
    retrievalTrace: {
      ...candidate.retrievalTrace,
      lexicalQueriesUsed: [anchorDoc.canonicalLabel],
      semanticQueriesUsed: [anchorDoc.searchTextEn],
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
  const ambiguousSurfaces = options.ambiguousSurfaces ?? [
    { term: '마고', types: ['region', 'entity'], severity: 'medium' } as const,
  ];
  for (const surface of ambiguousSurfaces) {
    parts.ambiguityDict.setAmbiguous(surface.term, [...surface.types], surface.severity);
  }

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
