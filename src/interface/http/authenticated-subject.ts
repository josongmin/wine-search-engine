import type { FastifyRequest } from 'fastify';

export const AUTHENTICATED_SUBJECT_HEADER = 'x-authenticated-subject';

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function getAuthenticatedSubject(
  request: Pick<FastifyRequest, 'headers'>,
): string | null {
  const raw = firstHeaderValue(request.headers[AUTHENTICATED_SUBJECT_HEADER]);
  const subject = raw?.trim();
  return subject !== undefined && subject.length > 0 ? subject : null;
}
