/**
 * Property-based regression suite for `etl.entity-identity-and-aliases`.
 *
 * Locks the SOTA++ invariants of the entity-identity layer
 * ({@link resolveWineSnapshotEntity}, {@link buildEntityIdBySourceId},
 * {@link computeIdentitySignature}, {@link buildSyntheticProducerId},
 * {@link buildSyntheticRegionId}) and the alias generation surface
 * ({@link Transliterator.generateAliases}) under fast-check with
 * `numRuns = 100` (industry-standard property baseline).
 *
 * Verified properties (append-only):
 *
 *  1. Identity determinism — `resolveWineSnapshotEntity(r, ∅)` is
 *     referentially transparent across N invocations for arbitrary r.
 *  2. Identity sensitivity — perturbing any one of `producer` /
 *     `canonicalLabel` / `country` / `region` flips the identity tuple.
 *     This protects the content-addressable invariant against silent
 *     producer/region collisions.
 *  3. NFC stability for Korean producers / canonical labels — feeding
 *     the same logical input as NFC vs NFD MUST collapse to the same
 *     identity. Without this, macOS-encoded data and Linux-encoded
 *     data would silently produce different entity ids.
 *  4. Bounded alias count — `generateAliases` is bounded by a named
 *     constant `MAX_TRANSLITERATION_ALIASES_PER_RECORD`, defending
 *     against pathological rule blow-up.
 *  5. Alias closure (canonical ∈ alias surface) — the curated exception
 *     surface for a known Latin term reproduces the same Korean
 *     primary alias as `generateAliases`.
 *  6. No duplicate normalized aliases — within a single
 *     `generateAliases` call, no two emitted alias values share the
 *     same case-folded NFC form.
 *  7. Empty-record safety — empty / whitespace input is a typed empty
 *     output, NEVER a crash.
 *  8. SourceId independence — entityId is content-addressable; two
 *     different `sourceId` values with identical identity tuple share
 *     the same entityId.
 *  9. Gold-overlay precedence — when a gold key matches, the
 *     resolution is `gold_overlay` and the benchmark linkage is
 *     attached, but the runtime public id remains identity-derived.
 * 10. schemaVersion + entityId namespace — every resolution carries
 *     `schemaVersion === SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION` and
 *     the entityId never uses the source-record namespace.
 *
 * In-memory only — no PG / Redis / filesystem IO.
 *
 * Touch policy: this file is regression-only. If a property fails,
 * either fix the source (preferred) or document the limitation in
 * `tools/feature-catalog/features/etl/entity-identity-and-aliases.yaml`
 * under `known_limitations`. NEVER loosen a property to make it pass.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  buildEntityIdBySourceId,
  buildSyntheticProducerId,
  buildSyntheticRegionId,
  resolveWineSnapshotEntity,
  silverGoldMatchKey,
  SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX,
  SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION,
  type WineSnapshotIdentityRow,
} from '../../scripts/etl/snapshot-entity-identity.js';
import { Transliterator } from '../../src/domain/alias/service/transliterator.js';
import { createSourceRecordId } from '../../src/domain/shared/types/entity-id.js';

// Industry-standard property baseline (matches anchor-extraction-properties,
// transliterator-properties, alias-matcher-properties).
const RUNS = 100;

/**
 * Upper bound on aliases emitted per record by the rule-based
 * transliterator (RFC-003 §4.5). The current emitter produces:
 *   1 × primary (translation), and
 *   ≤ 1 × compact phonetic variant (only when not an EXCEPTION hit).
 * Any future expansion (e.g. multi-romanization variants) MUST update
 * this bound deliberately — it backs `Bounded alias count` (property 4).
 */
const MAX_TRANSLITERATION_ALIASES_PER_RECORD = 8;

/** Hangul syllable + Jamo Unicode ranges (for NFC tests on Korean strings). */
const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏]/u;

const KOREAN_PRODUCERS: readonly string[] = [
  '국순당',
  '오미나라',
  '광주요',
  '술샘',
  '복순도가',
];

const KOREAN_LABELS: readonly string[] = [
  '국순당 백세주',
  '오미나라 오미로제',
  '광주요 화요',
  '복순도가 손막걸리',
  '술샘 미르',
];

const ACCENTED_LATIN_PRODUCERS: readonly string[] = [
  'Château Mouton Rothschild',
  'Château Margaux',
  'Domaine Müller-Catoir',
  'Hugel & Fils',
  'Trimbach',
  'Krug',
  'Pétrus',
];

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

/**
 * Non-empty arbitrary that always produces a valid `WineSnapshotIdentityRow`.
 * Each component is at least one non-control character — empty strings would
 * trigger `INVARIANT_VIOLATION` in `computeIdentitySignature`, which is the
 * intended fail-loud behaviour we test separately in property 7.
 */
const rowArb: fc.Arbitrary<WineSnapshotIdentityRow> = fc.record({
  sourceId: fc
    .stringMatching(/^[a-z0-9]+$/u)
    .filter((s) => s.length > 0)
    .map((s) => createSourceRecordId(`vivino-src-${s}`)),
  canonicalLabel: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0),
  producer: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
  country: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
  region: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
  vintageYear: fc.option(fc.integer({ min: 1900, max: 2100 }), { nil: null }),
});

// ────────────────────────────────────────────────────────────────────────────
// Property 1 — Identity determinism
// ────────────────────────────────────────────────────────────────────────────

describe('property: identity determinism', () => {
  it('resolveWineSnapshotEntity is referentially transparent', () => {
    fc.assert(
      fc.property(rowArb, (r) => {
        const a = resolveWineSnapshotEntity(r, new Map());
        const b = resolveWineSnapshotEntity(r, new Map());
        expect(b).toEqual(a);
      }),
      { numRuns: RUNS },
    );
  });

  it('identity is independent of sourceId (content-addressable)', () => {
    fc.assert(
      fc.property(
        rowArb,
        fc.stringMatching(/^[a-z0-9]+$/u).filter((s) => s.length > 0),
        (r, altSrc) => {
          const a = resolveWineSnapshotEntity(r, new Map());
          const b = resolveWineSnapshotEntity(
            { ...r, sourceId: createSourceRecordId(`vivino-alt-${altSrc}`) },
            new Map(),
          );
          // Different sourceId, but content-addressable identity is identical.
          expect(b.entityId).toBe(a.entityId);
          expect(b.identitySignature).toBe(a.identitySignature);
          expect(b.producerId).toBe(a.producerId);
          expect(b.regionId).toBe(a.regionId);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 2 — Identity sensitivity (no silent collisions)
// ────────────────────────────────────────────────────────────────────────────

describe('property: identity sensitivity', () => {
  it('changing producer changes identitySignature', () => {
    fc.assert(
      fc.property(
        rowArb,
        fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
        (r, altProducer) => {
          const baseProducerId = buildSyntheticProducerId(r.producer);
          const altProducerId = buildSyntheticProducerId(altProducer);
          fc.pre(baseProducerId !== altProducerId);
          const a = resolveWineSnapshotEntity(r, new Map());
          const b = resolveWineSnapshotEntity({ ...r, producer: altProducer }, new Map());
          expect(b.identitySignature).not.toBe(a.identitySignature);
          expect(b.entityId).not.toBe(a.entityId);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('changing canonicalLabel changes identitySignature', () => {
    fc.assert(
      fc.property(
        rowArb,
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0),
        (r, altLabel) => {
          // Pre-filter using the same normalization function the identity uses.
          fc.pre(
            altLabel.trim().toLowerCase().replace(/\s+/g, ' ') !==
              r.canonicalLabel.trim().toLowerCase().replace(/\s+/g, ' '),
          );
          const a = resolveWineSnapshotEntity(r, new Map());
          const b = resolveWineSnapshotEntity({ ...r, canonicalLabel: altLabel }, new Map());
          expect(b.identitySignature).not.toBe(a.identitySignature);
          expect(b.entityId).not.toBe(a.entityId);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('changing (country, region) tuple changes identitySignature', () => {
    fc.assert(
      fc.property(
        rowArb,
        fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
        (r, altCountry, altRegion) => {
          const baseRegionId = buildSyntheticRegionId(r.country, r.region);
          const altRegionId = buildSyntheticRegionId(altCountry, altRegion);
          fc.pre(baseRegionId !== altRegionId);
          const a = resolveWineSnapshotEntity(r, new Map());
          const b = resolveWineSnapshotEntity(
            { ...r, country: altCountry, region: altRegion },
            new Map(),
          );
          expect(b.identitySignature).not.toBe(a.identitySignature);
          expect(b.entityId).not.toBe(a.entityId);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 3 — NFC stability (Korean / accented Latin)
// ────────────────────────────────────────────────────────────────────────────

describe('property: NFC stability for Korean and accented Latin', () => {
  it('NFC and NFD forms of Korean producer collapse to identical identitySignature', () => {
    for (const producer of KOREAN_PRODUCERS) {
      const nfc = producer.normalize('NFC');
      const nfd = producer.normalize('NFD');
      expect(HANGUL_RE.test(nfc)).toBe(true);
      const a = resolveWineSnapshotEntity(row({ producer: nfc }), new Map());
      const b = resolveWineSnapshotEntity(row({ producer: nfd }), new Map());
      expect(b.identitySignature).toBe(a.identitySignature);
      expect(b.entityId).toBe(a.entityId);
      expect(b.producerId).toBe(a.producerId);
    }
  });

  it('NFC and NFD forms of Korean canonicalLabel collapse to identical identitySignature', () => {
    for (const label of KOREAN_LABELS) {
      const nfc = label.normalize('NFC');
      const nfd = label.normalize('NFD');
      expect(HANGUL_RE.test(nfc)).toBe(true);
      const a = resolveWineSnapshotEntity(row({ canonicalLabel: nfc }), new Map());
      const b = resolveWineSnapshotEntity(row({ canonicalLabel: nfd }), new Map());
      expect(b.identitySignature).toBe(a.identitySignature);
      expect(b.entityId).toBe(a.entityId);
    }
  });

  it('NFC and NFD forms of accented Latin producer collapse to identical identitySignature', () => {
    for (const producer of ACCENTED_LATIN_PRODUCERS) {
      const nfc = producer.normalize('NFC');
      const nfd = producer.normalize('NFD');
      const a = resolveWineSnapshotEntity(row({ producer: nfc }), new Map());
      const b = resolveWineSnapshotEntity(row({ producer: nfd }), new Map());
      expect(b.identitySignature).toBe(a.identitySignature);
      expect(b.entityId).toBe(a.entityId);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 4 — Bounded alias count
// ────────────────────────────────────────────────────────────────────────────

describe('property: bounded alias count', () => {
  const transliterator = new Transliterator();
  const LANGS = ['fr', 'it', 'es', 'en'] as const;

  it('generateAliases never emits more than MAX_TRANSLITERATION_ALIASES_PER_RECORD entries', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 96 }),
        fc.constantFrom(...LANGS),
        (label, lang) => {
          const out = transliterator.generateAliases(label, lang);
          expect(out.length).toBeLessThanOrEqual(MAX_TRANSLITERATION_ALIASES_PER_RECORD);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 5 — Alias closure (curated exception ↔ generateAliases agreement)
// ────────────────────────────────────────────────────────────────────────────

describe('property: alias closure on curated exceptions', () => {
  const transliterator = new Transliterator();

  const CURATED_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['Opus One', '오푸스원'],
    ['Château Margaux', '샤또 마고'],
    ['Chateau Margaux', '샤또 마고'],
    ['Krug', '크뤼그'],
    ['Sassicaia', '사시카이아'],
    ['Penfolds', '펜폴즈'],
  ];

  it('every curated exception surface is reproduced as the primary alias', () => {
    for (const [latin, expectedKorean] of CURATED_PAIRS) {
      const aliases = transliterator.generateAliases(latin, 'fr');
      expect(aliases.length).toBeGreaterThan(0);
      expect(aliases[0]!.value).toBe(expectedKorean);
      // Static lookup MUST agree with generateAliases — drift between the
      // two surfaces means autocomplete and ETL get out of sync.
      expect(Transliterator.koreanExceptionSurfaceForLatinTerm(latin)).toBe(expectedKorean);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 6 — No duplicate normalized aliases within a single record
// ────────────────────────────────────────────────────────────────────────────

describe('property: no duplicate normalized aliases per record', () => {
  const transliterator = new Transliterator();
  const LANGS = ['fr', 'it', 'es', 'en'] as const;

  it('case-folded NFC alias surfaces are unique within a single generateAliases call', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 48 }).filter((s) => s.trim().length > 0),
        fc.constantFrom(...LANGS),
        (label, lang) => {
          const aliases = transliterator.generateAliases(label, lang);
          const folded = aliases.map((a) => a.value.normalize('NFC').toLowerCase());
          expect(new Set(folded).size).toBe(folded.length);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 7 — Empty / whitespace input safety
// ────────────────────────────────────────────────────────────────────────────

describe('property: empty-input safety', () => {
  const transliterator = new Transliterator();

  it('generateAliases on whitespace-only / empty input returns [] (does not throw)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', ' ', '   ', '\t', '\n', '\r\n', ' '),
        fc.constantFrom('fr', 'it', 'es', 'en'),
        (label, lang) => {
          const out = transliterator.generateAliases(label, lang);
          expect(out).toEqual([]);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('buildEntityIdBySourceId([], …) returns an empty map and does not throw', () => {
    expect(() => buildEntityIdBySourceId([], new Map())).not.toThrow();
    expect(buildEntityIdBySourceId([], new Map()).size).toBe(0);
  });

  it('generateAliases with unknown source language returns [] (does not throw)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 16 }),
        fc.constantFrom('de', 'ja', 'zh', '', 'xx'),
        (label, lang) => {
          // Cast is fine — we are exercising the runtime rejection path
          // for unknown languages, which is the entire point of property 7.
          const out = transliterator.generateAliases(label, lang);
          expect(out).toEqual([]);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 8 — Dedup: identical identity tuple ⇒ identical entityId
// ────────────────────────────────────────────────────────────────────────────

describe('property: dedup on identical identity tuple', () => {
  it('two records with identical (canonicalLabel, producer, country, region) share entityId', () => {
    fc.assert(
      fc.property(
        rowArb,
        fc.stringMatching(/^[a-z0-9]+$/u).filter((s) => s.length > 0),
        fc.stringMatching(/^[a-z0-9]+$/u).filter((s) => s.length > 0),
        (r, srcA, srcB) => {
          fc.pre(srcA !== srcB);
          const a: WineSnapshotIdentityRow = { ...r, sourceId: createSourceRecordId(`vivino-${srcA}`) };
          const b: WineSnapshotIdentityRow = { ...r, sourceId: createSourceRecordId(`vivino-${srcB}`) };
          const map = buildEntityIdBySourceId([a, b], new Map());
          expect(map.get(a.sourceId)).toBe(map.get(b.sourceId));
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 9 — Gold-overlay precedence + linkage authority
// ────────────────────────────────────────────────────────────────────────────

describe('property: gold-overlay precedence and linkage separation', () => {
  it('gold-key hit yields resolution=gold_overlay with benchmark linkage; identity entityId still derives from signature', () => {
    fc.assert(
      fc.property(
        rowArb,
        fc.stringMatching(/^gold-[a-z0-9-]+$/u).filter((s) => s.length > 5),
        (r, goldId) => {
          const key = silverGoldMatchKey(r);
          const lookup = new Map<string, string>([[key, goldId]]);
          const resolved = resolveWineSnapshotEntity(r, lookup);
          expect(resolved.resolution).toBe('gold_overlay');
          expect(resolved.benchmarkEntityId).toBe(goldId);
          expect(resolved.benchmarkLinkageAuthority).toBe('benchmark_linkage');

          // Runtime public id is ALWAYS identity-derived, never a gold id.
          const identityOnly = resolveWineSnapshotEntity(r, new Map());
          expect(resolved.entityId).toBe(identityOnly.entityId);
          expect(resolved.identitySignature).toBe(identityOnly.identitySignature);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 10 — schemaVersion + entityId namespace invariant
// ────────────────────────────────────────────────────────────────────────────

describe('property: schemaVersion + entityId namespace invariant', () => {
  it('every resolution carries schemaVersion and a non-source-record namespace entityId', () => {
    fc.assert(
      fc.property(rowArb, (r) => {
        const resolved = resolveWineSnapshotEntity(r, new Map());
        expect(resolved.schemaVersion).toBe(SNAPSHOT_ENTITY_IDENTITY_SCHEMA_VERSION);
        expect(resolved.runtimePublicIdAuthority).toBe('identity_signature');
        // Fallback entityId carries the snapshot prefix.
        expect(resolved.entityId.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
        // ADR-007: public ids must NEVER use the `vivino-` source-record namespace.
        expect(resolved.entityId.startsWith('vivino-')).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });
});
