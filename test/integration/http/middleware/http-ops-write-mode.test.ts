import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerHttpOpsWriteMode } from '../../../../src/interface/http/middleware/http-ops-write-mode.js';

/**
 * T-ELV2-07 — operator curation write gate (`X-Ops-Write-Key`).
 *
 * The write plane (submit/review/publish proposals) must authorize ONLY when a
 * request presents the configured operator secret. This pins the gate matrix:
 *   no key / wrong key / right key, and the "no secret configured → locked"
 *   default. The constant-time comparator itself is covered separately.
 */
const SECRET = 'ops-write-secret-32-characters-ok';

function buildApp(secret: string | undefined): FastifyInstance {
  const app = Fastify();
  registerHttpOpsWriteMode(app, { secret });
  // Echo route: returns the per-request authorization flag the gate set.
  app.get('/probe', async (request) => ({ authorized: request.opsWriteAuthorized }));
  return app;
}

describe('registerHttpOpsWriteMode gate matrix', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  describe('with a configured secret', () => {
    beforeEach(() => {
      app = buildApp(SECRET);
    });

    it('authorizes a request with the exact X-Ops-Write-Key', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe', headers: { 'x-ops-write-key': SECRET } });
      expect(res.json()).toEqual({ authorized: true });
    });

    it('does NOT authorize a request with no key', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe' });
      expect(res.json()).toEqual({ authorized: false });
    });

    it('does NOT authorize a wrong / off-by-one key', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe', headers: { 'x-ops-write-key': `${SECRET}x` } });
      expect(res.json()).toEqual({ authorized: false });
    });

    it('rejects ambiguous duplicate headers (Fastify joins them into one value)', async () => {
      // Fastify/light-my-request collapses repeated non-special headers into a
      // single comma-joined string ("SECRET, bogus"), which cannot equal the
      // secret — so an ambiguous duplicate header fails closed (the safe outcome).
      const res = await app.inject({
        method: 'GET',
        url: '/probe',
        headers: { 'x-ops-write-key': [SECRET, 'bogus'] },
      });
      expect(res.json()).toEqual({ authorized: false });
    });
  });

  describe('with no secret configured (write plane locked)', () => {
    beforeEach(() => {
      app = buildApp(undefined);
    });

    it('never authorizes — even a request that sends some key', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe', headers: { 'x-ops-write-key': 'anything' } });
      expect(res.json()).toEqual({ authorized: false });
    });
  });
});
