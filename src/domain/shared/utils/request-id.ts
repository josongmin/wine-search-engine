import { createHash } from 'node:crypto';

/** Shared max length for request / correlation IDs across inbound and outbound hops. */
const REQUEST_ID_MAX_LEN = 128;

/** Header-safe request-id charset accepted by edge/server middleware. */
const REQUEST_ID_SAFE_PATTERN = /^[a-zA-Z0-9._-]+$/;

const DOWNSTREAM_REQUEST_ID_PREFIX = 'u';
const DOWNSTREAM_REQUEST_ID_HASH_HEX_LEN = 24;
const DOWNSTREAM_REQUEST_ID_EMPTY_TOKEN = 'empty';

export function isHeaderSafeRequestId(value: string): boolean {
  return value.length > 0
    && value.length <= REQUEST_ID_MAX_LEN
    && REQUEST_ID_SAFE_PATTERN.test(value);
}

/**
 * Canonicalizes an arbitrary internal request ID into an ASCII-only header-safe
 * value for downstream HTTP propagation.
 *
 * The original requestId remains unchanged inside our domain responses/logs.
 * Only the transport header is normalized so Unicode-rich local IDs (for
 * example benchmark probes that embed Hangul query text) do not crash undici's
 * ByteString validation.
 */
export function canonicalizeRequestIdForHeader(requestId: string): string {
  if (isHeaderSafeRequestId(requestId)) {
    return requestId;
  }

  const digest = createHash('sha256')
    .update(requestId, 'utf8')
    .digest('hex')
    .slice(0, DOWNSTREAM_REQUEST_ID_HASH_HEX_LEN);

  const encoded = Buffer.from(requestId, 'utf8').toString('base64url');
  const fixedOverhead =
    DOWNSTREAM_REQUEST_ID_PREFIX.length
    + 1
    + 1
    + DOWNSTREAM_REQUEST_ID_HASH_HEX_LEN;
  const prefixBudget = Math.max(1, REQUEST_ID_MAX_LEN - fixedOverhead);
  const prefixSource = encoded.length > 0 ? encoded : DOWNSTREAM_REQUEST_ID_EMPTY_TOKEN;
  const prefix = prefixSource.slice(0, prefixBudget);
  return `${DOWNSTREAM_REQUEST_ID_PREFIX}.${prefix}.${digest}`;
}
