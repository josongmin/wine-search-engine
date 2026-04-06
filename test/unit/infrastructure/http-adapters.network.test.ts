import { afterEach, describe, expect, it } from 'vitest';
import { HttpEmbeddingService } from '../../../src/infrastructure/vespa/embedding-service.js';
import { HttpCrossEncoderReranker } from '../../../src/infrastructure/vespa/reranker.js';
import { HttpLearnedMatcherAdapter } from '../../../src/infrastructure/adapter/http-learned-matcher.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import type { ResolverCandidate } from '../../../src/domain/resolver/model/resolved-candidate.js';
import { startJsonTestServer, type TestHttpServer } from './http-service-test-server.js';
import { CAN_BIND_LOOPBACK_HTTP } from '../../helpers/runtime-capabilities.js';

function makeCandidate(entityId: string, canonicalLabel: string): ResolverCandidate {
  return {
    entityId: createEntityId(entityId),
    entityType: 'wine',
    canonicalLabel,
    aliasMatches: [],
    sourceSignals: {
      canonicalExactMatch: 0,
      canonicalNormalizedMatch: 0,
      aliasExactMatch: 0,
      aliasFuzzyMatch: 0,
      aliasTypePrior: 0,
      producerMatch: 0,
      vintageMatch: 0,
      regionMatch: 0,
      grapeHintMatch: 0,
      phoneticMatch: 0,
      editDistanceScore: 0,
      ambiguityPenalty: 0,
    },
  };
}

describe.skipIf(!CAN_BIND_LOOPBACK_HTTP)('HTTP adapters — real local network round-trip', () => {
  let server: TestHttpServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  it('embedding service posts to /embeddings over real HTTP', async () => {
    server = await startJsonTestServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.11, 0.22] }],
        model: 'bge-m3-test',
      }));
    });

    const service = new HttpEmbeddingService({
      url: server.baseUrl,
      model: 'bge-m3-test',
    });

    await expect(service.embed('opus one')).resolves.toEqual([0.11, 0.22]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      url: '/embeddings',
      headers: expect.objectContaining({
        'content-type': expect.stringContaining('application/json'),
      }),
    });
    expect(JSON.parse(server.requests[0]!.body)).toEqual({
      model: 'bge-m3-test',
      input: 'opus one',
    });
  });

  it('reranker service posts to /rerank over real HTTP', async () => {
    server = await startJsonTestServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        results: [
          { index: 1, score: 0.4 },
          { index: 0, score: 0.8 },
        ],
      }));
    });

    const reranker = new HttpCrossEncoderReranker({
      url: server.baseUrl,
    });

    const results = await reranker.rerank(
      'luxury red wine',
      [
        { entityId: createEntityId('wine-opus-one'), text: 'Opus One 2018' },
        { entityId: createEntityId('wine-moet'), text: 'Moet Brut NV' },
      ],
      2,
    );

    expect(results.map((result) => result.entityId)).toEqual([
      createEntityId('wine-opus-one'),
      createEntityId('wine-moet'),
    ]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe('/rerank');
    expect(JSON.parse(server.requests[0]!.body)).toEqual({
      query: 'luxury red wine',
      texts: ['Opus One 2018', 'Moet Brut NV'],
    });
  });

  it('learned matcher posts noisy lookup context over real HTTP', async () => {
    server = await startJsonTestServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        results: [
          {
            entity_id: 'entity-opus-one',
            match_probability: 0.93,
            model_id: 'matcher',
            model_version: '1.2.0',
            match_signal_vector: [0.93, 0.41],
          },
        ],
      }));
    });

    const adapter = new HttpLearnedMatcherAdapter(server.baseUrl);

    const outputs = await adapter.match(
      '오푸스원 18',
      [makeCandidate('entity-opus-one', 'Opus One 2018')],
      {
        queryClass: 'short_entity',
        normalizedQueryViews: {
          raw: '오푸스원 18',
          strict: '오푸스원 18',
          accentless: '오푸스원 18',
          collapsedWhitespace: '오푸스원 18',
          punctuationStripped: '오푸스원 18',
          compact: '오푸스원18',
          phoneticCompact: 'psn18',
          vintageCanonicalized: '오푸스원 2018',
          vintageStripped: '오푸스원',
          transliterated: 'opus one',
          lookupVariants: ['오푸스원 18', 'opus one', 'opusone18'],
        },
        anchorLookupVariants: ['opus one', 'opusone18'],
        anchorLookupStrategies: ['transliterated_exact', 'compact_exact'],
        candidateFeatures: new Map([
          ['entity-opus-one', {
            charNgramOverlap: 0.81,
            tokenCoverage: 1,
            vintageConsistency: true,
            scriptCompatibility: 0.5,
            provenanceStage: 'transliterated_exact',
            queryCompactLength: 8,
          }],
        ]),
      },
    );

    expect(outputs).toEqual([
      {
        entityId: createEntityId('entity-opus-one'),
        matchProbability: 0.93,
        modelId: 'matcher',
        modelVersion: '1.2.0',
        matchSignalVector: [0.93, 0.41],
      },
    ]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe('/match');
    expect(JSON.parse(server.requests[0]!.body)).toEqual(
      expect.objectContaining({
        query: '오푸스원 18',
        context: expect.objectContaining({
          query_class: 'short_entity',
          anchor_lookup_variants: ['opus one', 'opusone18'],
          anchor_lookup_strategies: ['transliterated_exact', 'compact_exact'],
          candidate_features: {
            'entity-opus-one': {
              char_ngram_overlap: 0.81,
              token_coverage: 1,
              vintage_consistency: true,
              script_compatibility: 0.5,
              provenance_stage: 'transliterated_exact',
              query_compact_length: 8,
            },
          },
          normalized_query_views: expect.objectContaining({
            transliterated: 'opus one',
            phonetic_compact: 'psn18',
          }),
        }),
      }),
    );
  });
});
