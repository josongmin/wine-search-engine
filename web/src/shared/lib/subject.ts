/**
 * Persistent anonymous subject ID for watchlist authentication.
 *
 * The backend requires an `X-Authenticated-Subject` header on watchlist routes.
 * We use a stable UUID stored in localStorage — same browser = same user.
 * This is an anonymous ID; no personal data is associated.
 */

const SUBJECT_KEY = 'wine-search-subject-id';

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getSubjectId(): string {
  try {
    const stored = localStorage.getItem(SUBJECT_KEY);
    if (stored) return stored;
    const id = generateId();
    localStorage.setItem(SUBJECT_KEY, id);
    return id;
  } catch {
    // SSR or storage blocked — return ephemeral ID
    return generateId();
  }
}
