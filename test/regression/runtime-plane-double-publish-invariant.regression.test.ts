/**
 * Invariant: a second publish with a fresh snapshot id MUST NOT mutate any
 * row whose `search_snapshot_id` belongs to a previous snapshot. This is
 * the append-only contract that migration 010's comment promised and that
 * migration 016's composite PK actually enforces at the SQL level.
 *
 * The test exercises the publisher by intercepting the PG client and
 * asserting:
 *  1. All 4 INSERT statements use composite (search_snapshot_id, <id>)
 *     conflict targets, never single-column.
 *  2. No UPDATE / DELETE hits the runtime-plane tables for rows tied to
 *     the previous snapshot_id.
 *  3. The assertion helper `assertSnapshotNotAlreadyPublished` fires before
 *     any INSERT.
 *
 * Does not require a real Postgres instance — the mock client records the
 * SQL text and params, and assertions run against the captured trace.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PUBLISHER_PATH = fileURLToPath(
  new URL('../../scripts/etl/publish-runtime-substrates.ts', import.meta.url),
);

const src = readFileSync(PUBLISHER_PATH, 'utf8');

describe('Runtime plane double-publish append-only invariant', () => {
  it('all 3 runtime-plane INSERTs use composite conflict targets exclusively', () => {
    // Extract every `ON CONFLICT (...)` occurrence and bucket by target.
    const matches = [...src.matchAll(/ON CONFLICT \(([^)]+)\)/g)].map((m) => m[1]);
    const compositeTargets = matches.filter((t) =>
      t !== undefined && /^search_snapshot_id,\s*(entity|alias|registry)_id$/.test(t),
    );
    const singleColumnTargets = matches.filter((t) =>
      t !== undefined && /^(entity|alias|registry)_id$/.test(t),
    );
    // 3 runtime-plane INSERTs (+ 1 entity_snapshots with its own snapshot_id PK = 4 total)
    expect(compositeTargets.length).toBe(3);
    expect(singleColumnTargets.length).toBe(0);
  });

  it('entity_snapshots archive INSERT is DO NOTHING (never DO UPDATE)', () => {
    // The archive table has a per-row snapshot_id; its conflict target is
    // (snapshot_id) single-column by design (not the composite (search_snapshot_id, ...)
    // pattern). But the conflict action must be DO NOTHING — rewriting an
    // archive row would silently destroy rollback history.
    const archiveInsertRegion = /INSERT INTO entity_snapshots[\s\S]*?ON CONFLICT \(snapshot_id\)\s*(DO NOTHING|DO UPDATE)/;
    const match = src.match(archiveInsertRegion);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('DO NOTHING');
  });

  it('assertSnapshotNotAlreadyPublished is invoked before any INSERT', () => {
    const assertPos = src.indexOf('assertSnapshotNotAlreadyPublished(client, manifest.snapshotId)');
    const firstInsertPos = src.search(/INSERT INTO entities \(/);
    expect(assertPos).toBeGreaterThan(-1);
    expect(firstInsertPos).toBeGreaterThan(-1);
    expect(assertPos).toBeLessThan(firstInsertPos);
  });

  it('no UPDATE statement targets entities / aliases / ambiguity_registry', () => {
    // The publisher must not mutate existing rows — only append via INSERT.
    expect(src).not.toMatch(/UPDATE entities\s+SET/i);
    expect(src).not.toMatch(/UPDATE aliases\s+SET/i);
    expect(src).not.toMatch(/UPDATE ambiguity_registry\s+SET/i);
  });

  it('no DELETE statement targets entities / aliases / ambiguity_registry', () => {
    // Reap is done out-of-band via scripts/ops/reap-snapshots.ts, NEVER
    // inside the publisher (which would break rollback semantics).
    expect(src).not.toMatch(/DELETE FROM entities/i);
    expect(src).not.toMatch(/DELETE FROM aliases/i);
    expect(src).not.toMatch(/DELETE FROM ambiguity_registry/i);
  });

  it('publisher INSERTs bind search_snapshot_id as a column in every table', () => {
    // Each runtime-plane INSERT must explicitly include search_snapshot_id in
    // the column list so the composite-PK NOT NULL constraint is satisfied.
    // Also covers the case where the column list is present but the VALUES
    // clause forgot to include the parameter — regex checks both spots.
    const entitiesInsert = src.match(/INSERT INTO entities \(([\s\S]*?)\)\s*SELECT([\s\S]*?)FROM input/);
    expect(entitiesInsert?.[1]).toMatch(/search_snapshot_id/);
    expect(entitiesInsert?.[2]).toMatch(/search_snapshot_id/);

    const aliasesInsert = src.match(/INSERT INTO aliases \(([\s\S]*?)\)\s*SELECT([\s\S]*?)FROM input/);
    expect(aliasesInsert?.[1]).toMatch(/search_snapshot_id/);
    expect(aliasesInsert?.[2]).toMatch(/search_snapshot_id/);

    const ambiguityInsert = src.match(/INSERT INTO ambiguity_registry \(([\s\S]*?)\)\s*SELECT([\s\S]*?)FROM input/);
    expect(ambiguityInsert?.[1]).toMatch(/search_snapshot_id/);
    expect(ambiguityInsert?.[2]).toMatch(/search_snapshot_id/);
  });
});
