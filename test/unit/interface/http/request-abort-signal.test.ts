import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyRequest } from 'fastify';
import { abortSignalFromFastifyRequest } from '../../../../src/interface/http/request-abort-signal.js';

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
    // The fix listens on raw.socket (TCP socket), NOT on raw (IncomingMessage).
    // IncomingMessage 'close' fires immediately after JSON body parse (~100ms),
    // which was aborting every request. Socket 'close' fires only on TCP disconnect.
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, socket });
    const request = { raw } as FastifyRequest;
    const signal = abortSignalFromFastifyRequest(request);

    expect(signal.aborted).toBe(false);
    socket.emit('close');
    expect(signal.aborted).toBe(true);
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

  it('is already aborted when raw.destroyed is true (stream closed before signal creation)', () => {
    // raw.destroyed covers socket-already-gone cases that raw.aborted misses.
    const socket = new EventEmitter();
    const raw = new EventEmitter() as FastifyRequest['raw'];
    Object.assign(raw, { aborted: false, destroyed: true, socket });
    const request = { raw } as FastifyRequest;

    const signal = abortSignalFromFastifyRequest(request);
    expect(signal.aborted).toBe(true);
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
});
