import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  closeVespaTestServer,
  createVespaTestServer,
  type VespaTestServer,
} from './helpers/vespa-test-server.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import {
  parseSearchResponse,
  postJson,
  type JsonHttpResponse,
} from '../helpers/http-transport.js';
import { HAS_REACHABLE_VESPA } from './helpers/vespa-availability.js';
import type { SearchResponseBody } from '../../../src/interface/http/schemas/search-response.schema.js';

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

async function search(
  app: FastifyInstance,
  query: string,
  options: {
    mode?: 'auto' | 'entity' | 'hybrid' | 'mixed';
    clarification?: boolean;
  } = {},
): Promise<SearchResult> {
  const response = await postJson(app, '/v1/search', {
    query,
    options: {
      mode: options.mode ?? 'auto',
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

function topEntityIds(body: SearchResponseBody, limit = 3): string[] {
  return body.results.slice(0, limit).map((result) => result.entity.entity_id);
}

function expectNoWrongResolve(
  body: SearchResponseBody,
  expectedEntityId: string,
): void {
  expect(['resolved', 'ambiguous']).toContain(body.engine_decision.decision_status);
  if (body.results.length > 0) {
    expect(topEntityIds(body)).toContain(expectedEntityId);
    return;
  }

  // Entity-route search can safely resolve from resolver evidence without
  // materializing ranked result rows in the /v1/search payload.
  expect(body.engine_decision.route).toBe('entity');
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
    const { statusCode, body } = await search(server.app, 'Opus One 2018', {
      mode: 'entity',
      clarification: true,
    });

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    expectNoWrongResolve(body!, OPUS_ONE_2018_ID);
  });

  it('multilingual aliases do not wrong-resolve across languages', async () => {
    const [enRes, koRes] = await Promise.all([
      search(server.app, 'Opus One', { mode: 'entity', clarification: true }),
      search(server.app, '오푸스원', { mode: 'entity', clarification: true }),
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
      const { statusCode, body } = await search(server.app, query, {
        mode: 'entity',
        clarification: true,
      });

      expect(statusCode).toBe(200);
      expect(body).toBeDefined();
      expectNoWrongResolve(body!, entityId);
    }
  });

  it('ambiguous query returns clarification-safe behavior', async () => {
    const { statusCode, body } = await search(server.app, '마고', {
      mode: 'entity',
      clarification: true,
    });

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    expect(body!.engine_decision.decision_status).toBe('ambiguous');
    if (body!.clarification != null) {
      expect(body!.clarification.candidates.length).toBeGreaterThanOrEqual(1);
      expect(body!.clarification.suggestion_type).toBe('disambiguation');
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
    const { statusCode, body } = await search(server.app, '샴페인', {
      mode: 'hybrid',
    });

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    expect(topEntityIds(body!).some((entityId) => SPARKLING_IDS.has(entityId))).toBe(true);
  });

  it('light-body query avoids heavy reds in the top 3', async () => {
    const { statusCode, body } = await search(server.app, '라이트바디 와인', {
      mode: 'hybrid',
    });

    expect(statusCode).toBe(200);
    expect(body).toBeDefined();
    for (const entityId of topEntityIds(body!)) {
      expect(HEAVY_RED_IDS.has(entityId)).toBe(false);
    }
  });

  it('response shape stays RFC-014 compliant on successful search', async () => {
    const { statusCode, body } = await search(server.app, '샴페인', {
      mode: 'hybrid',
    });

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
