/**
 * Invariant: GET /ready surfaces an optional `snapshot_health` block per the
 * runtime plane composite-PK migration (016). When the caller wires a reader,
 * its output is serialized under `snapshot_health` and validated by the
 * ReadyResponseSchema. When the reader returns undefined (or isn't wired),
 * the field is omitted cleanly — contract stays backwards-compatible.
 *
 * Append-only test: never delete this file.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerHealthRoutes } from '../../src/interface/http/routes/health.route.js';

async function buildApp(
  snapshotHealthReader?: () => Promise<{
    readonly active_snapshot_id: string;
    readonly previous_snapshot_id: string | null;
    readonly stale_row_count: number;
    readonly pointer_age_seconds: number;
  } | undefined>,
) {
  const app = Fastify({ logger: false });
  registerHealthRoutes(app, {
    readiness: {
      synthetic: {
        required: false,
        check: (): 'up' => 'up',
      },
    },
    ...(snapshotHealthReader !== undefined ? { snapshotHealthReader } : {}),
  });
  await app.ready();
  return app;
}

describe('/ready snapshot_health contract', () => {
  it('embeds snapshot_health when reader returns a value', async () => {
    const app = await buildApp(async () => ({
      active_snapshot_id: 'search-snapshot:v1:active',
      previous_snapshot_id: 'search-snapshot:v1:previous',
      stale_row_count: 123,
      pointer_age_seconds: 3600,
    }));
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.snapshot_health).toEqual({
        active_snapshot_id: 'search-snapshot:v1:active',
        previous_snapshot_id: 'search-snapshot:v1:previous',
        stale_row_count: 123,
        pointer_age_seconds: 3600,
      });
    } finally {
      await app.close();
    }
  });

  it('omits snapshot_health when reader returns undefined', async () => {
    const app = await buildApp(async () => undefined);
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.snapshot_health).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('omits snapshot_health when reader throws (never fails /ready)', async () => {
    const app = await buildApp(async () => {
      throw new Error('pg connection refused');
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.snapshot_health).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('omits snapshot_health when reader is not wired', async () => {
    const app = await buildApp(undefined);
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.snapshot_health).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
