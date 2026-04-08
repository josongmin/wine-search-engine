import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyRequest } from 'fastify';
import { abortSignalFromFastifyRequest } from '../../../../src/interface/http/request-abort-signal.js';

describe('abortSignalFromFastifyRequest', () => {
  it('returns the same AbortSignal for the same Fastify request object', () => {
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false });
    const request = { raw } as FastifyRequest;

    const a = abortSignalFromFastifyRequest(request);
    const b = abortSignalFromFastifyRequest(request);

    expect(a).toBe(b);
  });

  it('aborts when the raw socket emits close', () => {
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false });
    const request = { raw } as FastifyRequest;
    const signal = abortSignalFromFastifyRequest(request);

    expect(signal.aborted).toBe(false);
    raw.emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('is already aborted when raw.aborted is true', () => {
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: true });
    const request = { raw } as FastifyRequest;

    const signal = abortSignalFromFastifyRequest(request);

    expect(signal.aborted).toBe(true);
  });
});
