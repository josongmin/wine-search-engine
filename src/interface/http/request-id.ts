import type { IncomingHttpHeaders } from 'node:http';
import { nanoid } from 'nanoid';

/** Max length for inbound correlation / request ids (gateways, load balancers). */
const INCOMING_REQUEST_ID_MAX_LEN = 128;

/**
 * Allowed charset for inbound ids: letters, digits, dot, underscore, hyphen (no whitespace).
 */
const INCOMING_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

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
    if (candidate.length > INCOMING_REQUEST_ID_MAX_LEN) {
      continue;
    }
    if (!INCOMING_REQUEST_ID_PATTERN.test(candidate)) {
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
    trimmed.length > 0 &&
    trimmed.length <= INCOMING_REQUEST_ID_MAX_LEN &&
    INCOMING_REQUEST_ID_PATTERN.test(trimmed)
  ) {
    return trimmed;
  }
  return getRequestId(request);
}
