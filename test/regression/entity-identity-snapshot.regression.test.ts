/**
 * etl.entity-identity-and-aliases (maturity 2 → 3) regression suite.
 *
 * Locks the dedicated invariants for snapshot-entity-identity + the
 * transliteration-alias bridge:
 *
 *   - Identity stability (determinism): the same input row resolves to the
 *     same `WineSnapshotEntityResolution` across N calls, including
 *     entityId / identitySignature / producerId / regionId.
 *   - Korean alias bridge: an English-canonical wine yields at least one
 *     Hangul-bearing alias via the rule-based transliterator.
 *   - Cross-tier (resolution) non-overlap: a single record reports exactly
 *     one of {gold_overlay, identity_signature} — they are mutually exclusive.
 *   - Identity uniqueness / dedup: two records with the same canonical
 *     identity tuple (canonicalLabel, producer, region, country) share the
 *     same entityId; differing producers do not collide.
 *   - Empty input: empty record arrays produce empty maps and do not throw.
 *   - Versioning hook: every emitted resolution carries `schemaVersion`.
 *   - NFC normalization: Korean alias values are stored in NFC, never NFD.
 *
 * In-memory only. No PG / filesystem IO. No external mocks.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEntityIdBySourceId,
  resolveWineSnapshotEntity,
  SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX,
  SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION,
  type WineSnapshotIdentityRow,
} from '../../scripts/etl/snapshot-entity-identity.js';
import { Transliterator } from '../../src/domain/alias/service/transliterator.js';
import { createSourceRecordId } from '../../src/domain/shared/types/entity-id.js';

const DETERMINISM_RUNS = 5;
const HANGUL_RE = /[가-힯ᄀ-ᇿ㄰-㆏]/u;

function row(overrides: Partial<WineSnapshotIdentityRow> = {}): WineSnapshotIdentityRow {
  return {
    sourceId: createSourceRecordId('vivino-test-default'),
    canonicalLabel: 'Opus One 2018',
    producer: 'Opus One',
    country: 'United States',
    region: 'Napa Valley',
    vintageYear: 2018,
    ...overrides,
  };
}

describe('entity-identity snapshot — determinism', () => {
  it('returns byte-identical resolution across 5 calls (same input)', () => {
    const fixed = row();
    const first = resolveWineSnapshotEntity(fixed, new Map());
    for (let i = 0; i < DETERMINISM_RUNS; i++) {
      const again = resolveWineSnapshotEntity(fixed, new Map());
      expect(again).toEqual(first);
    }
  });

  it('buildEntityIdBySourceId is sort-stable across reruns', () => {
    const recs: readonly WineSnapshotIdentityRow[] = [
      row({ sourceId: createSourceRecordId('s-1'), canonicalLabel: 'A 2020', producer: 'Producer A' }),
      row({ sourceId: createSourceRecordId('s-2'), canonicalLabel: 'B 2020', producer: 'Producer B' }),
      row({ sourceId: createSourceRecordId('s-3'), canonicalLabel: 'C 2020', producer: 'Producer C' }),
    ];
    const golden = buildEntityIdBySourceId(recs, new Map());
    for (let i = 0; i < DETERMINISM_RUNS; i++) {
      const next = buildEntityIdBySourceId(recs, new Map());
      expect([...next.entries()]).toEqual([...golden.entries()]);
    }
  });
});

describe('entity-identity snapshot — Korean alias bridge', () => {
  const transliterator = new Transliterator();

  it('English wine label transliterates to a Hangul-bearing alias', () => {
    const aliases = transliterator.generateAliases('Chateau Margaux', 'fr');
    expect(aliases.length).toBeGreaterThan(0);
    const primary = aliases[0]!;
    expect(HANGUL_RE.test(primary.value)).toBe(true);
  });

  it('alias values are stored in NFC (never NFD)', () => {
    const aliases = transliterator.generateAliases('Chateau Margaux', 'fr');
    expect(aliases.length).toBeGreaterThan(0);
    for (const a of aliases) {
      expect(a.value).toBe(a.value.normalize('NFC'));
      // Defence: NFD form must differ for any composed Hangul syllable.
      if (HANGUL_RE.test(a.value)) {
        expect(a.value).not.toBe(a.value.normalize('NFD'));
      }
    }
  });

  it('bidirectional: a Korean canonical does not crash and yields deterministic output', () => {
    // Korean canonical fed into the rule pipeline must not throw, and must
    // be sort-stable (determinism check 2). Korean input falls through the
    // rule table as pass-through characters (per transliterator design).
    const koreanLabel = '샤또 마고';
    const first = transliterator.generateAliases(koreanLabel, 'fr');
    for (let i = 0; i < DETERMINISM_RUNS; i++) {
      expect(transliterator.generateAliases(koreanLabel, 'fr')).toEqual(first);
    }
    // Primary alias must remain in NFC.
    if (first.length > 0) {
      expect(first[0]!.value).toBe(first[0]!.value.normalize('NFC'));
    }
  });
});

describe('entity-identity snapshot — cross-tier (resolution) non-overlap', () => {
  it('gold_overlay and identity_signature are mutually exclusive per record', () => {
    const fixed = row();
    const lookup = new Map<string, string>([
      // Key derived from silverGoldMatchKey(record). Mirrors snapshot logic.
      ['opus one 2018|2018', 'gold-opus-one-2018'],
    ]);
    const goldResolved = resolveWineSnapshotEntity(fixed, lookup);
    expect(goldResolved.resolution).toBe('gold_overlay');
    expect(goldResolved.benchmarkEntityId).toBe('gold-opus-one-2018');
    expect(goldResolved.benchmarkLinkageAuthority).toBe('benchmark_linkage');

    const fallback = resolveWineSnapshotEntity(fixed, new Map());
    expect(fallback.resolution).toBe('identity_signature');
    expect(fallback.benchmarkEntityId).toBeUndefined();
    expect(fallback.benchmarkLinkageAuthority).toBeUndefined();

    // Same record must NEVER yield both tiers simultaneously.
    expect(new Set([goldResolved.resolution, fallback.resolution]).size).toBe(2);
  });
});

describe('entity-identity snapshot — identity uniqueness / dedup', () => {
  it('two records with identical canonical tuple share the same entityId', () => {
    const a = row({ sourceId: createSourceRecordId('s-a') });
    const b = row({ sourceId: createSourceRecordId('s-b') });
    const map = buildEntityIdBySourceId([a, b], new Map());
    expect(map.get('s-a')).toBe(map.get('s-b'));
  });

  it('records with differing producers do not collide', () => {
    const a = row({ sourceId: createSourceRecordId('s-a'), producer: 'Producer Alpha' });
    const b = row({ sourceId: createSourceRecordId('s-b'), producer: 'Producer Beta' });
    const map = buildEntityIdBySourceId([a, b], new Map());
    expect(map.get('s-a')).not.toBe(map.get('s-b'));
  });

  it('producer spelling variants (Château vs Chateau) currently resolve to DISTINCT entityIds (policy: dedup is downstream alias-layer concern)', () => {
    // Identity signature is hash-based and treats `Château Mouton` and
    // `Chateau Mouton` as distinct producer surface forms. The transliteration
    // / alias layer is responsible for cross-form bridging — NOT identity
    // resolution. This regression test pins the boundary: if we ever want
    // identity to fold accents, that is a deliberate identity-rule change
    // and requires a deliberate test update.
    const accented = row({
      sourceId: createSourceRecordId('s-acc'),
      producer: 'Château Mouton',
      canonicalLabel: 'Château Mouton 2018',
    });
    const plain = row({
      sourceId: createSourceRecordId('s-plain'),
      producer: 'Chateau Mouton',
      canonicalLabel: 'Chateau Mouton 2018',
    });
    const map = buildEntityIdBySourceId([accented, plain], new Map());
    expect(map.get('s-acc')).not.toBe(map.get('s-plain'));
  });
});

describe('entity-identity snapshot — empty input', () => {
  it('returns an empty map and does not throw', () => {
    expect(() => buildEntityIdBySourceId([], new Map())).not.toThrow();
    const map = buildEntityIdBySourceId([], new Map());
    expect(map.size).toBe(0);
  });
});

describe('entity-identity snapshot — versioning hook', () => {
  it('every resolution carries schemaVersion = "1"', () => {
    const fallback = resolveWineSnapshotEntity(row(), new Map());
    expect(fallback.schemaVersion).toBe(SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION);
    expect(fallback.schemaVersion).toBe('1');

    const goldResolved = resolveWineSnapshotEntity(row(), new Map([['opus one 2018|2018', 'gold-x']]));
    expect(goldResolved.schemaVersion).toBe(SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION);
  });

  it('entityId never uses the source-record namespace and always carries the snapshot fallback prefix when not from continuity', () => {
    const fallback = resolveWineSnapshotEntity(row(), new Map());
    expect(fallback.entityId.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    expect(fallback.entityId.includes('vivino')).toBe(false);
  });
});
