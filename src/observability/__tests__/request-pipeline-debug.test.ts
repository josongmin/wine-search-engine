import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  getRequestPipelineDebugContext,
  pipelineDebug,
  pipelineTrace,
  runWithRequestPipelineDebug,
  sanitizeQueryForDebug,
} from '../request-pipeline-debug.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
    level: 'debug',
  } as unknown as FastifyBaseLogger;
}

describe('request-pipeline-debug', () => {
  it('sanitizeQueryForDebug collapses whitespace and truncates', () => {
    expect(sanitizeQueryForDebug('  a\n\tb  ')).toBe('a b');
    const long = 'x'.repeat(120);
    expect(sanitizeQueryForDebug(long, 32).length).toBeLessThanOrEqual(35);
  });

  it('pipelineDebug is a no-op without ALS', () => {
    const log = createMockLogger();
    pipelineDebug({ step: 'test' }, 'msg');
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('pipelineDebug emits when debugRequest is true', () => {
    const log = createMockLogger();
    runWithRequestPipelineDebug(
      {
        requestId: 'req-1',
        debugRequest: true,
        requestLog: log,
      },
      () => {
        pipelineDebug({ step: 'test.step', n: 1 }, 'hello');
      },
    );
    expect(log.debug).toHaveBeenCalledTimes(1);
    const call = (log.debug as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatchObject({
      pipeline_debug: true,
      request_id: 'req-1',
      step: 'test.step',
      n: 1,
    });
    expect(call[1]).toBe('hello');
  });

  it('pipelineDebug is skipped when debugRequest is false', () => {
    const log = createMockLogger();
    runWithRequestPipelineDebug(
      {
        requestId: 'req-2',
        debugRequest: false,
        requestLog: log,
      },
      () => {
        pipelineDebug({ step: 'test.step' }, 'hello');
      },
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('pipelineTrace sets step on payload', () => {
    const log = createMockLogger();
    runWithRequestPipelineDebug(
      {
        requestId: 'req-3',
        debugRequest: true,
        requestLog: log,
      },
      () => {
        pipelineTrace('trace.only', 'm', { k: 2 });
      },
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'trace.only', k: 2 }),
      'm',
    );
  });

  it('getRequestPipelineDebugContext returns store inside run', () => {
    runWithRequestPipelineDebug(
      {
        requestId: 'req-4',
        debugRequest: true,
        requestLog: createMockLogger(),
      },
      () => {
        expect(getRequestPipelineDebugContext()?.requestId).toBe('req-4');
      },
    );
    expect(getRequestPipelineDebugContext()).toBeUndefined();
  });
});
