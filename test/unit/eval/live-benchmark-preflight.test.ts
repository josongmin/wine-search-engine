import { describe, expect, it, vi } from 'vitest';

import {
  buildBenchmarkRequestHeaders,
  isLocalApiUrl,
  resolveBenchmarkSearchEndpoint,
} from '../../../scripts/eval/live-benchmark-preflight.js';

describe('live-benchmark-preflight pure helpers', () => {
  describe('resolveBenchmarkSearchEndpoint', () => {
    it('public lane resolves to /v1/search', () => {
      expect(resolveBenchmarkSearchEndpoint('http://localhost:3000', 'public')).toBe(
        'http://localhost:3000/v1/search',
      );
    });

    it('trusted_benchmark lane resolves to /internal/benchmark/search', () => {
      expect(resolveBenchmarkSearchEndpoint('http://localhost:3000', 'trusted_benchmark')).toBe(
        'http://localhost:3000/internal/benchmark/search',
      );
    });
  });

  describe('buildBenchmarkRequestHeaders', () => {
    it('public lane never requires a debug key', () => {
      expect(buildBenchmarkRequestHeaders('public')).toEqual({ 'content-type': 'application/json' });
    });

    it('trusted_benchmark lane requires a non-empty debug key', () => {
      expect(() => buildBenchmarkRequestHeaders('trusted_benchmark')).toThrow(/debug-key/);
      expect(() => buildBenchmarkRequestHeaders('trusted_benchmark', '')).toThrow(/debug-key/);
    });

    it('trusted_benchmark lane forwards the supplied debug key', () => {
      expect(buildBenchmarkRequestHeaders('trusted_benchmark', 'k')).toEqual({
        'content-type': 'application/json',
        'x-debug-key': 'k',
      });
    });
  });

  describe('isLocalApiUrl', () => {
    it('returns true for localhost and 127.0.0.1', () => {
      expect(isLocalApiUrl('http://localhost:3000')).toBe(true);
      expect(isLocalApiUrl('http://127.0.0.1:8080')).toBe(true);
    });

    it('returns false for non-loopback hosts', () => {
      expect(isLocalApiUrl('https://api.example.com')).toBe(false);
    });
  });
});

describe('assertLiveBenchmarkReadiness', () => {
  it('throws when /ready returns ready=false with the readiness check digest', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ready: false,
          checks: {
            search_snapshot: { status: 'down', required: true },
            embeddings: { status: 'up', required: true },
          },
        }),
        { status: 200 },
      ),
    );
    try {
      const { assertLiveBenchmarkReadiness } = await import(
        '../../../scripts/eval/live-benchmark-preflight.js'
      );
      await expect(assertLiveBenchmarkReadiness('http://localhost:3000')).rejects.toThrow(
        /search_snapshot=down/,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when drinking-window model readiness is down even if /ready is otherwise green', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ready: true,
          checks: {
            postgres: { status: 'up', required: true },
            drinking_window_model: { status: 'down', required: false },
            blocking_zero_candidates: { status: 'up', required: false },
          },
        }),
        { status: 200 },
      ),
    );
    try {
      const { assertLiveBenchmarkReadiness } = await import(
        '../../../scripts/eval/live-benchmark-preflight.js'
      );
      await expect(assertLiveBenchmarkReadiness('http://localhost:3000')).rejects.toThrow(
        /drinking_window_model=down/,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when drinking-window model readiness is absent from /ready', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ready: true,
          checks: {
            postgres: { status: 'up', required: true },
            blocking_zero_candidates: { status: 'up', required: false },
          },
        }),
        { status: 200 },
      ),
    );
    try {
      const { assertLiveBenchmarkReadiness } = await import(
        '../../../scripts/eval/live-benchmark-preflight.js'
      );
      await expect(assertLiveBenchmarkReadiness('http://localhost:3000')).rejects.toThrow(
        /drinking_window_model=missing/,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws on non-2xx /ready', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('boom', { status: 503 }),
    );
    try {
      const { assertLiveBenchmarkReadiness } = await import(
        '../../../scripts/eval/live-benchmark-preflight.js'
      );
      await expect(assertLiveBenchmarkReadiness('http://localhost:3000')).rejects.toThrow(
        /HTTP 503/,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when blocker zero-candidate readiness is down even if /ready is otherwise green', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ready: true,
          checks: {
            postgres: { status: 'up', required: true },
            drinking_window_model: { status: 'up', required: false },
            blocking_zero_candidates: { status: 'down', required: false },
          },
        }),
        { status: 200 },
      ),
    );
    try {
      const { assertLiveBenchmarkReadiness } = await import(
        '../../../scripts/eval/live-benchmark-preflight.js'
      );
      await expect(assertLiveBenchmarkReadiness('http://localhost:3000')).rejects.toThrow(
        /blocking_zero_candidates=down/,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when blocker zero-candidate readiness is absent from /ready', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ready: true,
          checks: {
            postgres: { status: 'up', required: true },
            drinking_window_model: { status: 'up', required: false },
          },
        }),
        { status: 200 },
      ),
    );
    try {
      const { assertLiveBenchmarkReadiness } = await import(
        '../../../scripts/eval/live-benchmark-preflight.js'
      );
      await expect(assertLiveBenchmarkReadiness('http://localhost:3000')).rejects.toThrow(
        /blocking_zero_candidates=missing/,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('passes silently when /ready returns ready=true', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ready: true,
          checks: {
            postgres: { status: 'up', required: true },
            drinking_window_model: { status: 'up', required: false },
            blocking_zero_candidates: { status: 'up', required: false },
          },
        }),
        { status: 200 },
      ),
    );
    try {
      const { assertLiveBenchmarkReadiness } = await import(
        '../../../scripts/eval/live-benchmark-preflight.js'
      );
      await expect(assertLiveBenchmarkReadiness('http://localhost:3000')).resolves.toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
