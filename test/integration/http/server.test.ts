import { describe, expect, it, vi } from 'vitest';
import type { Container } from '../../../src/config/container.js';
import { createServer } from '../../../src/interface/http/server.js';

describe('HTTP server route registration', () => {
  it('exposes the Claude tools endpoint through the server', async () => {
    const container = {
      adaptiveToolExecutor: {
        executeWithFallback: vi.fn(),
      },
    } as unknown as Container;

    const app = await createServer(container, { logLevel: 'silent' });
    try {
      const routes = app.printRoutes();
      expect(routes).toContain('claude-tools (POST, GET, HEAD)');
    } finally {
      await app.close();
    }
  });
});
