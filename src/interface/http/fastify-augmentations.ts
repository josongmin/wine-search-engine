/**
 * Central Fastify module augmentations for this service.
 *
 * Keeping them in one module ensures partial TypeScript programs (e.g.
 * `tsconfig.etl.json` pulling `src/config/env.js`) still see the same
 * `FastifyRequest` / `FastifyReply` surface as the full `src/` build.
 */
import type { Span } from '@opentelemetry/api';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startTime: number;
    /**
     * True when `HTTP_DEBUG_SECRET` is set and `X-Debug-Key` matched (see `registerHttpDebugMode`).
     */
    debugRequest: boolean;
    otelSpan?: Span;
  }

  interface FastifyReply {
    snakeCaseApplied?: boolean;
  }
}

export {};
