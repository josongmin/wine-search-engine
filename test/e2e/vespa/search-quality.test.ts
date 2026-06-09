import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  closeVespaTestServer,
  createVespaTestServer,
  type VespaTestServer,
} from './helpers/vespa-test-server.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import {
  parseEntityLookupResponse,
  parseSearchResponse,
  postJson,
  type JsonHttpResponse,
} from '../helpers/http-transport.js';
import { HAS_REACHABLE_VESPA } from './helpers/vespa-availability.js';
import type { SearchResponseBody } from '../../../src/interface/http/schemas/search-response.schema.js';
import type { EntityLookupV2Response } from '../../../src/interface/http/schemas/entity-lookup-v2.schema.js';

const OPUS_ONE_2018_ID = 'opus-one-2018';
const CHATEAU_MARGAUX_2015_ID = 'chateau-margaux-2015';
const PENFOLDS_GRANGE_2017_ID = 'penfolds-grange-2017';
const DOM_PERIGNON_2012_ID = 'dom-perignon-2012';
const MOET_BRUT_NV_ID = 'moet-brut-nv';
const KRUG_GRANDE_CUVEE_ID = 'krug-grande-cuvee';
const SCREAMING_EAGLE_2018_ID = 'screaming-eagle-2018';

const BLOCKING_ENTITY_IDS = [
  OPUS_ONE_2018_ID,
  CHATEAU_MARGAUX_2015_ID,
  PENFOLDS_GRANGE_2017_ID,
  DOM_PERIGNON_2012_ID,
  MOET_BRUT_NV_ID,
  KRUG_GRANDE_CUVEE_ID,
  SCREAMING_EAGLE_2018_ID,
];

const SPARKLING_IDS = new Set([
  MOET_BRUT_NV_ID,
  DOM_PERIGNON_2012_ID,
  KRUG_GRANDE_CUVEE_ID,
]);

const HEAVY_RED_IDS = new Set([
  PENFOLDS_GRANGE_2017_ID,
  SCREAMING_EAGLE_2018_ID,
]);

const VESPA_QUALITY_ALIASES = [
  { surface_form: 'opus one 2018', entity_id: createEntityId(OPUS_ONE_2018_ID), confidence: 0.99 },
  { surface_form: 'opus one', entity_id: createEntityId(OPUS_ONE_2018_ID), confidence: 0.9 },
  { surface_form: '오푸스원', entity_id: createEntityId(OPUS_ONE_2018_ID), confidence: 0.98 },
  { surface_form: 'chateau margaux 2015', entity_id: createEntityId(CHATEAU_MARGAUX_2015_ID), confidence: 0.99 },
  { surface_form: 'château margaux', entity_id: createEntityId(CHATEAU_MARGAUX_2015_ID), confidence: 0.95 },
  { surface_form: '샤토 마고', entity_id: createEntityId(CHATEAU_MARGAUX_2015_ID), confidence: 0.97 },
  { surface_form: 'penfolds grange 2017', entity_id: createEntityId(PENFOLDS_GRANGE_2017_ID), confidence: 0.99 },
  { surface_form: '그레인지', entity_id: createEntityId(PENFOLDS_GRANGE_2017_ID), confidence: 0.96 },
  { surface_form: 'dom perignon 2012', entity_id: createEntityId(DOM_PERIGNON_2012_ID), confidence: 0.99 },
  { surface_form: '돔 페리뇽', entity_id: createEntityId(DOM_PERIGNON_2012_ID), confidence: 0.97 },
];

type SearchResult = {
  readonly statusCode: number;
  readonly body?: SearchResponseBody;
  readonly raw: JsonHttpResponse;
};

type LookupResult = {
  readonly statusCode: number;
  readonly body?: EntityLookupV2Response;
  readonly raw: JsonHttpResponse;
};

async function search(
  app: FastifyInstance,
  query: string,
  options: {
    clarification?: boolean;
  } = {},
): Promise<SearchResult> {
  const response = await postJson(app, '/v1/search/hybrid', {
    query,
    options: {
      explain: false,
      clarification: options.clarification ?? false,
    },
  });

  return {
    statusCode: response.statusCode,
    body: response.statusCode === 200 ? parseSearchResponse(response) : undefined,
    raw: response,
  };
}

async function lookup(
  app: FastifyInstance,
  query: string,
): Promise<LookupResult> {
  const response = await postJson(app, '/v2/entity-lookup', { query });
  return {
    statusCode: response.statusCode,
    body: response.statusCode === 200 ? parseEntityLookupResponse(response) : undefined,
    raw: response,
  };
}

function topEntityIds(body: SearchResponseBody, limit = 3): string[] {
  return body.results.slice(0, limit).map((result) => result.entity.entity_id);
}

function expectNoWrongResolve(
  body: EntityLookupV2Response,
  expectedEntityId: string,
): void {
  expect(['resolved', 'ambiguous']).toContain(body.status);
  if (body.top_candidate !== null) {
    expect(body.top_candidate.entity_id).toBe(expectedEntityId);
    return;
  }
  expect(body.candidates.some((candidate) => candidate.entity_id === expectedEntityId)).toBe(true);
}

describe.skipIf(!HAS_REACHABLE_VESPA)('Vespa E2E — Search Quality', () => {
  let server: VespaTestServer;

  beforeAll(async () => {
    server = await createVespaTestServer();

    for (const alias of VESPA_QUALITY_ALIASES) {
      await server.parts.seedAlias(
        alias.surface_form,
        alias.entity_id,
        alias.confidence,
      );
    }

    await server.parts.seedBlockingEntities(BLOCKING_ENTITY_IDS.map(createEntityId));

    await server.parts.seedAmbiguity('마고', ['region', 'entity'], 'medium');
  });

  afterAll(async () => {
    await closeVespaTestServer(server);
  });

  it('exact entity query does not wrong-resolve', async () => {
    const { statusCode, body } = await lookup(server.app, 'Opus One 2018');

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    expectNoWrongResolve(body!, OPUS_ONE_2018_ID);
  });

  it('multilingual aliases do not wrong-resolve across languages', async () => {
    const [enRes, koRes] = await Promise.all([
      lookup(server.app, 'Opus One'),
      lookup(server.app, '오푸스원'),
    ]);

    expect(enRes.statusCode).toBe(200);
    expect(koRes.statusCode).toBe(200);
    expect(enRes.body).toBeDefined();
    expect(koRes.body).toBeDefined();
    expectNoWrongResolve(enRes.body!, OPUS_ONE_2018_ID);
    expectNoWrongResolve(koRes.body!, OPUS_ONE_2018_ID);
  });

  it('additional aliases abstain or resolve safely', async () => {
    const samples = [
      ['Château Margaux', CHATEAU_MARGAUX_2015_ID],
      ['그레인지', PENFOLDS_GRANGE_2017_ID],
      ['돔 페리뇽', DOM_PERIGNON_2012_ID],
    ] as const;

    for (const [query, entityId] of samples) {
      const { statusCode, body } = await lookup(server.app, query);

      expect(statusCode).toBe(200);
      expect(body).toBeDefined();
      expectNoWrongResolve(body!, entityId);
    }
  });

  it('ambiguous query returns clarification-safe behavior', async () => {
    const { statusCode, body } = await lookup(server.app, '마고');

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    expect(body!.status).toBe('ambiguous');
    if (body!.clarification_options.length > 0) {
      expect(body!.clarification_options.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('no-match query abstains without resolving to a single confident entity', async () => {
    const { statusCode, body } = await search(server.app, 'zzz_no_such_wine_xyz_abc', {
      clarification: true,
    });

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    expect(body!.engine_decision.decision_status).not.toBe('resolved');
  });

  it('hybrid sparkling query returns a sparkling wine in the top 3', async () => {
    const { statusCode, body } = await search(server.app, '샴페인');

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    expect(topEntityIds(body!).some((entityId) => SPARKLING_IDS.has(entityId))).toBe(true);
  });

  it('light-body query avoids heavy reds in the top 3', async () => {
    const { statusCode, body } = await search(server.app, '라이트바디 와인');

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    for (const entityId of topEntityIds(body!)) {
      expect(HEAVY_RED_IDS.has(entityId)).toBe(false);
    }
  });

  it('response shape stays RFC-014 compliant on successful search', async () => {
    const { statusCode, body } = await search(server.app, '샴페인');

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    expect(body!.engine_decision.decision_snapshot).toMatchObject({
      model_versions: expect.any(Object),
      index_versions: expect.any(Object),
      policy_rule_version: expect.any(String),
      threshold_profile_id: expect.any(String),
      planner_version: expect.any(String),
      feature_flags: expect.any(Object),
    });
    expect(body!.meta.query_time_ms).toBeGreaterThanOrEqual(0);
    expect(body!.results.length).toBeGreaterThan(0);
    expect(body!.results[0]!.evidence_items.length).toBeGreaterThan(0);
  });

  it('emoji query returns 200 without crashing', async () => {
    const { statusCode } = await search(server.app, '😀 emoji wine');
    expect(statusCode).toBe(200);
  });

  it('very long query is rejected by validation instead of crashing', async () => {
    const longQuery = 'wine '.repeat(200).trim();
    const { statusCode } = await search(server.app, longQuery);
    expect(statusCode).toBe(400);
  });
});
