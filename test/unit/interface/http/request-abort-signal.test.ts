import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyReply } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { isAbortError } from '../../../../src/domain/shared/cooperative-abort.js';
import {
  abortSignalFromFastifyRequest,
  raceWithRequestAbort,
} from '../../../../src/interface/http/request-abort-signal.js';

describe('abortSignalFromFastifyRequest', () => {
  it('returns the same AbortSignal for the same Fastify request object', () => {
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, socket });
    const request = { raw } as FastifyRequest;

    const a = abortSignalFromFastifyRequest(request);
    const b = abortSignalFromFastifyRequest(request);

    expect(a).toBe(b);
  });

  it('aborts when the TCP socket emits close', () => {
    // Pre-body socket close is still an authoritative transport abort.
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, complete: false, socket });
    const request = { raw } as FastifyRequest;
    const signal = abortSignalFromFastifyRequest(request);

    expect(signal.aborted).toBe(false);
    socket.emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('does NOT abort when the TCP socket closes after the request fully completed', () => {
    // Regression: after body parsing, socket close can be server-initiated
    // (request timeout / reply transport shutdown). Do not reinterpret that as
    // a client abort unless raw.aborted is also true.
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, complete: true, socket });
    const request = { raw } as FastifyRequest;
    const signal = abortSignalFromFastifyRequest(request);

    socket.emit('close');
    expect(signal.aborted).toBe(false);
  });

  it('does NOT abort when IncomingMessage itself emits close (body-consumed false positive)', () => {
    // Regression: raw 'close' must NOT abort the signal — that event fires
    // when the request body is consumed, not when the client disconnects.
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, socket });
    const request = { raw } as FastifyRequest;
    const signal = abortSignalFromFastifyRequest(request);

    raw.emit('close'); // This is the body-consumed event, NOT TCP disconnect.
    expect(signal.aborted).toBe(false);
  });

  it('aborts when raw emits aborted (explicit client abort before headers)', () => {
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, socket });
    const request = { raw } as FastifyRequest;
    const signal = abortSignalFromFastifyRequest(request);

    raw.emit('aborted');
    expect(signal.aborted).toBe(true);
  });

  it('is already aborted when raw.aborted is true', () => {
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: true, socket });
    const request = { raw } as FastifyRequest;

    const signal = abortSignalFromFastifyRequest(request);

    expect(signal.aborted).toBe(true);
  });

  it('does not abort when socket is null (e.g. HTTP/2 or already destroyed)', () => {
    // When socket is null, no socket listener is registered.
    // Signal should be created but remain un-aborted (no crash).
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, socket: null });
    const request = { raw } as FastifyRequest;

    const signal = abortSignalFromFastifyRequest(request);
    expect(signal.aborted).toBe(false);
  });

  it('is already aborted when raw.destroyed is true before request completion', () => {
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, complete: false, destroyed: true, socket });
    const request = { raw } as FastifyRequest;

    const signal = abortSignalFromFastifyRequest(request);
    expect(signal.aborted).toBe(true);
  });

  it('does NOT treat raw.destroyed as aborted after request completion', () => {
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, complete: true, destroyed: true, socket });
    const request = { raw } as FastifyRequest;

    const signal = abortSignalFromFastifyRequest(request);
    expect(signal.aborted).toBe(false);
  });

  it('cleans up raw "aborted" listener when socket closes (no memory leak)', () => {
    // Bug: previously the raw.once('aborted', abort) listener was never removed
    // when the socket closed first, causing gradual listener accumulation.
    // Fix: onSocketClose() explicitly calls raw.removeListener('aborted', onRawAborted).
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, socket });
    const request = { raw } as FastifyRequest;

    abortSignalFromFastifyRequest(request);
    expect(raw.listenerCount('aborted')).toBe(1); // listener registered

    socket.emit('close');
    expect(raw.listenerCount('aborted')).toBe(0); // cleaned up after socket close
  });

  it('cleans up socket "close" listener when raw aborted fires (no memory leak)', () => {
    // Symmetric cleanup: when raw 'aborted' fires first, the socket 'close' listener
    // must also be removed to avoid accumulation on long-lived socket objects.
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, socket });
    const request = { raw } as FastifyRequest;

    abortSignalFromFastifyRequest(request);
    expect(socket.listenerCount('close')).toBe(1); // listener registered

    raw.emit('aborted');
    expect(socket.listenerCount('close')).toBe(0); // cleaned up after raw aborted
  });

  it('cleans up socket "close" listener when reply finishes on a keep-alive socket', () => {
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    const replyRaw = new EventEmitter();
    Object.assign(raw, { aborted: false, socket });
    const request = { raw } as FastifyRequest;
    const reply = { raw: replyRaw } as FastifyReply;

    abortSignalFromFastifyRequest(request, reply);
    expect(socket.listenerCount('close')).toBe(1);

    replyRaw.emit('finish');
    expect(socket.listenerCount('close')).toBe(0);
    expect(raw.listenerCount('aborted')).toBe(0);
  });

  it('aborts when reply closes before finish even after the request body completed', () => {
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    const replyRaw = new EventEmitter();
    Object.assign(raw, { aborted: false, complete: true, socket });
    const request = { raw } as FastifyRequest;
    const reply = { raw: replyRaw } as FastifyReply;

    const signal = abortSignalFromFastifyRequest(request, reply);
    replyRaw.emit('close');

    expect(signal.aborted).toBe(true);
  });

  it('aborts before Fastify requestTimeout closes the socket', () => {
    vi.useFakeTimers();
    try {
      const socket = new EventEmitter();
      const raw = new EventEmitter() as FastifyRequest['raw'];
      const replyRaw = new EventEmitter();
      Object.assign(raw, { aborted: false, complete: true, socket });
      const request = { raw } as FastifyRequest;
      const reply = { raw: replyRaw } as FastifyReply;

      const signal = abortSignalFromFastifyRequest(request, reply, { requestTimeoutMs: 2_500 });
      vi.advanceTimersByTime(1_499);
      expect(signal.aborted).toBe(false);

      vi.advanceTimersByTime(1);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the HTTP default budget when no route-specific timeout is provided', () => {
    vi.useFakeTimers();
    try {
      const socket = new EventEmitter();
      const raw = new EventEmitter() as FastifyRequest['raw'];
      const replyRaw = new EventEmitter();
      Object.assign(raw, { aborted: false, complete: true, socket });
      const request = { raw } as FastifyRequest;
      const reply = { raw: replyRaw } as FastifyReply;

      const signal = abortSignalFromFastifyRequest(request, reply);
      vi.advanceTimersByTime(28_999);
      expect(signal.aborted).toBe(false);

      vi.advanceTimersByTime(1);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('raceWithRequestAbort', () => {
  it('rejects with AbortError when the request signal aborts before the operation settles', async () => {
    const controller = new AbortController();
    const pending = new Promise<never>(() => undefined);
    const raced = raceWithRequestAbort(pending, controller.signal, 'Search request aborted');

    controller.abort();

    await expect(raced).rejects.toMatchObject({ name: 'AbortError', message: 'Search request aborted' });
  });

  it('passes through the operation result when no abort occurs', async () => {
    await expect(
      raceWithRequestAbort(Promise.resolve('ok'), new AbortController().signal, 'unused'),
    ).resolves.toBe('ok');
  });

  it('treats an already-aborted signal as AbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      raceWithRequestAbort(Promise.resolve('late'), controller.signal, 'aborted early'),
    ).rejects.toSatisfy((error: unknown) => isAbortError(error));
  });
});
