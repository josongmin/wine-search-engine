/**
 * Persistent anonymous subject ID for watchlist authentication.
 *
 * The backend requires an `X-Authenticated-Subject` header on watchlist routes.
 * We use a stable UUID stored in localStorage — same browser = same user.
 * This is an anonymous ID; no personal data is associated.
 */

const SUBJECT_KEY = 'wine-search-subject-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function generateId(): string {
  // Require crypto.randomUUID. The previous Math.random fallback produced
  // predictable IDs — combined with the backend trusting this header as
  // identity, that was a real attack surface (header injection / log
  // poisoning via tampered localStorage).
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error('crypto.randomUUID unavailable; refusing to use predictable fallback');
}

function isValidSubjectId(value: string | null): value is string {
  return value !== null && UUID_RE.test(value);
}

export function getSubjectId(): string {
  try {
    const stored = localStorage.getItem(SUBJECT_KEY);
    // Validate the stored value: localStorage is attacker-controlled
    // (XSS / DevTools / extensions). Reject anything that isn't a UUID
    // and regenerate so we never inject arbitrary strings into HTTP
    // headers downstream.
    if (isValidSubjectId(stored)) return stored;
    const id = generateId();
    localStorage.setItem(SUBJECT_KEY, id);
    return id;
  } catch {
    // SSR or storage blocked — return ephemeral ID (still UUID).
    return generateId();
  }
}
