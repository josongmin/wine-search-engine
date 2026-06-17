import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { registerHttpDebugMode } from '../../../../src/interface/http/middleware/http-debug-mode.js';
import {
  registerEntityLookupV2OpsRoute,
  registerEntityLookupV2Route,
} from '../../../../src/interface/http/routes/entity-lookup-v2.route.js';
import type { ResolveRouteDeps } from '../../../../src/interface/http/routes/route-deps.js';
import type { EntityLookupV2Result } from '../../../../src/application/search/entity-lookup-v2/entity-lookup-v2.dto.js';

const DEBUG_SECRET = 'test-debug-secret-1234567890';

function buildResult(): EntityLookupV2Result {
  const candidate = {
    entityId: 'opus-one-2018',
    canonicalLabel: 'Opus One 2018',
    calibratedScore: 0.97,
    rank: 1,
    channelAgreement: 1,
    channelHits: [{ channel: 'exact_alias' as const, matchedView: 'opus one', channelScore: 0.97, channelRank: 1 }],
  };
  return {
    status: 'resolved',
    decisionReason: 'Confidently resolved to a single entity.',
    normalizedQueryViews: {
      raw: 'Opus One', strict: 'opus one', accentless: 'opus one', compact: 'opusone',
      vintageCanonicalized: 'opus one', vintageStripped: 'opus one', lookupVariants: ['opus one'],
    },
    candidates: [candidate],
    topCandidate: candidate,
    clarificationOptions: [],
    evidenceSummary: {
      admissionReasonCode: 'admitted_entity_reference',
      decisionReasonCode: 'calibrated_resolve',
      topConfidence: 0.97,
      calibrationTrusted: true,
      queryClass: 'known-item',
      candidatePoolSize: 1,
      channelCoverage: [{ channel: 'exact_alias', firing: true, hitCount: 1, latencyMs: 0 }],
    },
    meta: { requestId: 'req-elv2', queryTimeMs: 2, version: 'entity-lookup-v2/1.0.0', engineSchemaVersion: 'entity_lookup_v2' },
  };
}

function post(app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload });
}

describe('/v2/entity-lookup route wiring (T-ELV2-01/07)', () => {
  let app: FastifyInstance;
  let execute: ReturnType<typeof vi.fn>;
  let deps: ResolveRouteDeps;

  beforeEach(async () => {
    app = Fastify();
    registerRequestContext(app);
    registerHttpDebugMode(app, { secret: DEBUG_SECRET });
    app.setErrorHandler(errorHandler);
    execute = vi.fn().mockResolvedValue(buildResult());
    deps = { entityLookupV2UseCase: { execute } };
    registerEntityLookupV2Route(app, deps);
    registerEntityLookupV2OpsRoute(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the public surface and emits a snake_case envelope', async () => {
    const res = await post(app, '/v2/entity-lookup', { query: 'Opus One' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('resolved');
    // snake_case boundary applied
    expect(body).toHaveProperty('decision_reason');
    expect(body).toHaveProperty('normalized_query_views');
    expect((body['top_candidate'] as Record<string, unknown>)['entity_id']).toBe('opus-one-2018');
    expect((body['meta'] as Record<string, unknown>)['engine_schema_version']).toBe('entity_lookup_v2');
    // public surface runs default mode
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ query: 'Opus One', mode: 'default' }), expect.anything());
  });

  it('rejects an invalid body (missing query) with 400 and does not execute', async () => {
    const res = await post(app, '/v2/entity-lookup', { locale: 'en' });
    expect(res.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects the ops plane without a trusted debug key (403, never executes)', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/inspect', { query: 'Opus One' });
    expect(res.statusCode).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('serves the ops plane in diagnostic mode WITH a valid debug key', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/inspect', { query: 'Opus One' }, { 'x-debug-key': DEBUG_SECRET });
    expect(res.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ query: 'Opus One', mode: 'diagnostic' }), expect.anything());
  });
});
