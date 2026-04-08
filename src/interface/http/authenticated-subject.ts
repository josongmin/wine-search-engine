import type { FastifyInstance, FastifyRequest } from 'fastify';

export const AUTHENTICATED_SUBJECT_HEADER = 'x-authenticated-subject';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Set at server startup. When false, the X-Authenticated-Subject header
     * is treated as untrusted client input and never honored — preventing
     * impersonation when the server is run without a verifying proxy.
     */
    trustsAuthenticatedSubjectHeader?: boolean;
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Returns the authenticated subject ONLY when the request originated through
 * a trusted proxy (`trustProxy=true`). Without a trusted proxy, this header is
 * client-supplied and trivially forgeable, so we refuse to honor it to prevent
 * horizontal privilege escalation across user accounts.
 */
export function getAuthenticatedSubject(
  request: Pick<FastifyRequest, 'headers' | 'server'>,
): string | null {
  if (request.server?.trustsAuthenticatedSubjectHeader !== true) {
    return null;
  }
  const raw = firstHeaderValue(request.headers[AUTHENTICATED_SUBJECT_HEADER]);
  const subject = raw?.trim();
  if (subject === undefined || subject.length === 0 || subject.length > 128) {
    return null;
  }
  return subject;
}

/**
 * Configure the trust state for the X-Authenticated-Subject header.
 * Must be called once at server creation, before any routes run.
 */
export function configureAuthenticatedSubjectTrust(
  app: FastifyInstance,
  trusted: boolean,
): void {
  app.decorate('trustsAuthenticatedSubjectHeader', trusted);
}
