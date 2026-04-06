import { describe, it, expect, beforeEach } from 'vitest';
import { getSessionId } from '../session';

describe('getSessionId', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('generates a UUID', () => {
    const id = getSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('returns same ID on repeated calls', () => {
    const first = getSessionId();
    const second = getSessionId();
    expect(first).toBe(second);
  });

  it('persists in sessionStorage', () => {
    const id = getSessionId();
    expect(sessionStorage.getItem('wine-search-session-id')).toBe(id);
  });
});
