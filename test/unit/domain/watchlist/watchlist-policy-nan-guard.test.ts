/**
 * E5-T6: BUG-DS06 — watchlist-policy NaN guard
 * Test first (TDD): entry with invalid date → isWatchlistEntryActive returns false.
 */
import { describe, it, expect } from 'vitest';
import { isWatchlistEntryActive } from '../../../../src/domain/watchlist/service/watchlist-policy.js';
import type { WatchlistEntry } from '../../../../src/domain/watchlist/model/watchlist-entry.js';

function makeEntry(expiresAt: Date | null): WatchlistEntry {
  return {
    id: 'entry-1',
    userId: 'user-1',
    entityId: 'entity-1' as unknown as WatchlistEntry['entityId'],
    triggerConditions: [],
    createdAt: new Date('2025-01-01'),
    expiresAt,
    notificationChannels: [],
    active: true,
  } as unknown as WatchlistEntry;
}

describe('E5-T6: isWatchlistEntryActive NaN guard', () => {
  it('returns false for invalid date (new Date("invalid")) — NaN guard', () => {
    const entry = makeEntry(new Date('invalid'));
    const now = new Date('2026-04-10');
    // Without NaN guard: NaN > number → false, so active = (null || false) = false
    // With guard: explicitly returns false when expiresAt is invalid
    expect(isWatchlistEntryActive(entry, now)).toBe(false);
  });

  it('returns true for null expiresAt (never expires)', () => {
    const entry = makeEntry(null);
    const now = new Date('2026-04-10');
    expect(isWatchlistEntryActive(entry, now)).toBe(true);
  });

  it('returns true for future expiresAt', () => {
    const entry = makeEntry(new Date('2030-01-01'));
    const now = new Date('2026-04-10');
    expect(isWatchlistEntryActive(entry, now)).toBe(true);
  });

  it('returns false for past expiresAt', () => {
    const entry = makeEntry(new Date('2020-01-01'));
    const now = new Date('2026-04-10');
    expect(isWatchlistEntryActive(entry, now)).toBe(false);
  });
});
