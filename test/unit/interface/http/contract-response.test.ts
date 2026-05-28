import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendContractResponse } from '../../../../src/interface/http/routes/contract-response.js';

function createReply(): FastifyReply & {
  readonly sendMock: ReturnType<typeof vi.fn>;
  readonly statusMock: ReturnType<typeof vi.fn>;
  readonly headerMock: ReturnType<typeof vi.fn>;
  readonly getHeaderMock: ReturnType<typeof vi.fn>;
} {
  const sendMock = vi.fn();
  const statusMock = vi.fn().mockReturnThis();
  const headerMock = vi.fn().mockReturnThis();
  const getHeaderMock = vi.fn();
  return {
    send: sendMock,
    status: statusMock,
    header: headerMock,
    getHeader: getHeaderMock,
    sendMock,
    statusMock,
    headerMock,
    getHeaderMock,
  } as unknown as FastifyReply & {
    readonly sendMock: ReturnType<typeof vi.fn>;
    readonly statusMock: ReturnType<typeof vi.fn>;
    readonly headerMock: ReturnType<typeof vi.fn>;
    readonly getHeaderMock: ReturnType<typeof vi.fn>;
  };
}

describe('sendContractResponse', () => {
  it('serializes validated object payloads before sending', () => {
    const request = {
      log: { error: vi.fn() },
      requestId: 'req-1',
    } as unknown as FastifyRequest;
    const reply = createReply();
    reply.getHeaderMock.mockReturnValue(undefined);

    sendContractResponse(
      request,
      reply,
      200,
      z.object({ ok: z.boolean() }),
      { ok: true },
    );

    expect(reply.headerMock).toHaveBeenCalledWith(
      'Content-Type',
      'application/json; charset=utf-8',
    );
    expect(reply.statusMock).toHaveBeenCalledWith(200);
    expect(reply.sendMock).toHaveBeenCalledWith('{"ok":true}');
  });

  it('preserves an explicit content type while still sending serialized JSON', () => {
    const request = {
      log: { error: vi.fn() },
      requestId: 'req-2',
    } as unknown as FastifyRequest;
    const reply = createReply();
    reply.getHeaderMock.mockReturnValue('application/vnd.cuvee.human+json');

    sendContractResponse(
      request,
      reply,
      200,
      z.object({ ok: z.boolean() }),
      { ok: true },
    );

    expect(reply.headerMock).not.toHaveBeenCalled();
    expect(reply.sendMock).toHaveBeenCalledWith('{"ok":true}');
  });
});
