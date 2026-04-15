/**
 * Content negotiation for the Wine Intelligence Engine API.
 *
 * Same resource, different representations — controlled via the `Accept` header
 * per RFC 7231 §5.3.2. This is the HTTP-standard alternative to URL-based
 * versioning (e.g. `/v2/search`) for cases where the underlying resource is
 * identical and only the response shape differs.
 *
 * Vendor media types follow RFC 6838 §3.2:
 *   application/vnd.cuvee.human+json   — UX-oriented summary card format
 *   application/json                    — full engine response (default)
 */

/** Vendor media type for human/UX-oriented responses. */
export const MEDIA_TYPE_HUMAN = 'application/vnd.cuvee.human+json';

/**
 * Determines whether the client is requesting a human-oriented response.
 *
 * Checks the `Accept` header for the vendor media type. Falls back to
 * standard engine response when the header is absent or `application/json`.
 */
export function wantsHumanResponse(acceptHeader: string | undefined): boolean {
  if (acceptHeader === undefined) return false;
  // Case-insensitive check; ignore quality parameters (q=...)
  return acceptHeader.toLowerCase().includes('application/vnd.cuvee.human+json');
}
