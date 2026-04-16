import type { IncomingHttpHeaders } from 'node:http';
import { nanoid } from 'nanoid';
import {
  isHeaderSafeRequestId,
} from '../../domain/shared/utils/request-id.js';

function firstHeaderValue(value: IncomingHttpHeaders[string]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[0]?.trim();
  }
  return value.trim();
}

/**
 * Prefer a validated incoming `X-Request-Id` or `X-Correlation-Id`; otherwise generate one.
 * Used as Fastify `genReqId` so logs and downstream tracing align with edge proxies.
 */
export function resolveIncomingRequestId(headers: IncomingHttpHeaders): string {
  const candidates = [
    firstHeaderValue(headers['x-request-id']),
    firstHeaderValue(headers['x-correlation-id']),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) {
      continue;
    }
    if (!isHeaderSafeRequestId(candidate)) {
      continue;
    }
    return candidate;
  }
  return nanoid();
}

interface HttpRequestIdCarrier {
  readonly id: string;
  readonly requestId?: string;
}

export function getRequestId(request: HttpRequestIdCarrier): string {
  return request.requestId ?? request.id;
}

export function resolveRequestId(
  request: HttpRequestIdCarrier,
  explicitRequestId?: string | null,
): string {
  const trimmed = explicitRequestId?.trim();
  if (
    trimmed !== undefined &&
    isHeaderSafeRequestId(trimmed)
  ) {
    return trimmed;
  }
  return getRequestId(request);
}
