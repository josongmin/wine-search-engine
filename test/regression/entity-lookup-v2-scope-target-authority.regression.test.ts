import { describe, it, expect, beforeAll } from 'vitest';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { loadLookupV2RuntimeSemanticDescriptorMapSync } from '../../scripts/eval/lookup-v2-runtime-semantic-descriptors.js';
import { loadLookupV2RuntimeKnownEntityIdsSync } from '../../scripts/eval/lookup-v2-runtime-known-entity-ids.js';
import {
  loadLookupV2SemanticScopeTargetRegistrySync,
  type LookupV2SemanticScopeTargetRegistryRow,
} from '../../scripts/eval/lookup-v2-semantic-scope-target-registry.js';
import {
  loadLookupV2ExactSafeScopeRegistrySync,
  type LookupV2ExactSafeScopeRegistryRow,
} from '../../scripts/eval/lookup-v2-exact-safe-scope-registry.js';
import {
  loadLookupV2SemanticPolicyRegistrySync,
  type LookupV2SemanticPolicyRegistryRow,
} from '../../scripts/eval/lookup-v2-semantic-policy-registry.js';
import {
  loadLookupV2LocalizedSurfaceRegistrySync,
  type LookupV2LocalizedSurfaceRegistryRow,
} from '../../scripts/eval/lookup-v2-localized-surface-registry.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Hell-gate regression for the entity-lookup-v2 reviewed-authority registries.
 *
 * These pin the structural invariants behind the collision scope-target
 * authoring + W-A exact-safe promotion done in this session:
 *  - reviewed authority may ONLY point at entities that exist in the runtime
 *    (anti-fabrication — a per-family workflow agent twice emitted readable ids);
 *  - a "grand vin" anchor must NOT resolve to a known SECOND/THIRD wine line
 *    (the Masseto→Massetino class of mistake);
 *  - approved authority is only authored for families the benchmark gold
 *    actually expects RESOLVED (never for an ambiguous-only family);
 *  - localized surfaces stay recall-only (no authority leak);
 *  - every registry round-trips through its own validator.
 *
 * Append-only. See [[project-elv2-recall-gap-rca]] / [[project-entity-lookup-v2-build]].
 */

// Known second/third-wine / sub-label markers. A bare producer surface must
// never resolve to one of these — they are distinct wines, not the grand vin.
const SECOND_WINE_MARKERS = [
  'le carillon', 'carillon d', 'alter ego', 'la dame de', 'les forts',
  'les griffons', 'les tourelles', 'les hauts de', 'carruades', 'pavillon',
  'clarence de', 'le petit', 'petit mouton', 'massetino', 'napanook', 'coudoulet',
  'hommage', 'no 3', 'no. 3', 'amiral de', 'pagodes de', 'reserve de la comtesse',
  'pignan', 'fonsalette', 'second wine',
  // NB: do NOT add bare 'reserve' — Château Rayas' grand vin lineKey legitimately
  // contains "reserve" ("...chateauneuf du pape reserve").
] as const;

// Grand-vin classification markers (flagship indicators in a lineKey).
const GRAND_VIN_MARKERS = ['grand cru classe', 'premier grand cru', 'grand vin'] as const;

const STRETCH_FIXTURE = path.resolve(__dirname, '../fixtures/lookup-v2-korean-realworld-stretch.jsonl');

function loadGoldFamiliesResolved(): Set<string> {
  const resolved = new Set<string>();
  for (const line of fs.readFileSync(STRETCH_FIXTURE, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as { expected_status?: string; expected_entity_hint?: string };
    if (row.expected_status === 'resolved' && typeof row.expected_entity_hint === 'string') {
      resolved.add(normalizeForMatch(row.expected_entity_hint));
    }
  }
  return resolved;
}

describe('entity-lookup-v2 reviewed-authority registry invariants (hell-gate)', () => {
  // Loading the runtime descriptor map + registries is expensive (~4s); do it once.
  let descriptors: ReturnType<typeof loadLookupV2RuntimeSemanticDescriptorMapSync>;
  let knownIds: ReturnType<typeof loadLookupV2RuntimeKnownEntityIdsSync>;
  let scopeTargets: readonly LookupV2SemanticScopeTargetRegistryRow[];
  let exactSafe: readonly LookupV2ExactSafeScopeRegistryRow[];
  let policy: readonly LookupV2SemanticPolicyRegistryRow[];
  let localized: readonly LookupV2LocalizedSurfaceRegistryRow[];
  let loadErrors: string[];

  beforeAll(() => {
    loadErrors = [];
    const guard = (label: string, fn: () => void): void => {
      try { fn(); } catch (e) { loadErrors.push(`${label}: ${(e as Error).message}`); }
    };
    guard('scope-target', () => { scopeTargets = loadLookupV2SemanticScopeTargetRegistrySync(); });
    guard('exact-safe', () => { exactSafe = loadLookupV2ExactSafeScopeRegistrySync(); });
    guard('policy', () => { policy = loadLookupV2SemanticPolicyRegistrySync(); });
    guard('localized', () => { localized = loadLookupV2LocalizedSurfaceRegistrySync(); });
    descriptors = loadLookupV2RuntimeSemanticDescriptorMapSync();
    knownIds = loadLookupV2RuntimeKnownEntityIdsSync();
  }, 60_000);

  it('all four lookup registries round-trip through their own validators', () => {
    expect(loadErrors).toEqual([]);
  });

  it('every APPROVED scope-target points to an existing runtime entity of the same family (anti-fabrication)', () => {
    const offenders: string[] = [];
    for (const row of scopeTargets) {
      if (row.decisionStatus !== 'approved' || row.entityId === undefined) continue;
      const d = descriptors.get(row.entityId);
      if (d === undefined) offenders.push(`${row.semanticScopeKey} -> unknown entityId ${row.entityId}`);
      else if (d.familyKey !== row.familyKey) offenders.push(`${row.semanticScopeKey} -> family ${d.familyKey} != ${row.familyKey}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no grand-vin scope-target anchor resolves to a known second/third wine (Masseto→Massetino guard)', () => {
    const offenders: string[] = [];
    for (const row of scopeTargets) {
      if (row.decisionStatus !== 'approved' || row.entityId === undefined) continue;
      const lineKey = (descriptors.get(row.entityId)?.lineKey ?? '').toLowerCase();
      for (const marker of SECOND_WINE_MARKERS) {
        if (lineKey.includes(marker)) {
          offenders.push(`${row.semanticScopeKey} -> "${lineKey}" matches second-wine marker "${marker}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('grand-vin dominance: if a family has a grand-vin-marked entity, the anchor must be one of them', () => {
    // Build familyKey -> [lineKey...] across all runtime entities.
    const byFamily = new Map<string, { entityId: string; lineKey: string }[]>();
    for (const [entityId, d] of descriptors) {
      const list = byFamily.get(d.familyKey) ?? [];
      list.push({ entityId, lineKey: (d.lineKey ?? '').toLowerCase() });
      byFamily.set(d.familyKey, list);
    }
    const isGrand = (lk: string): boolean => GRAND_VIN_MARKERS.some((m) => lk.includes(m));
    const offenders: string[] = [];
    for (const row of scopeTargets) {
      if (row.decisionStatus !== 'approved' || row.entityId === undefined) continue;
      const fam = byFamily.get(row.familyKey) ?? [];
      const grandVins = fam.filter((e) => isGrand(e.lineKey));
      if (grandVins.length === 0) continue; // sole/flagship-by-convention families (caymus, silver oak) — covered by other tests
      if (!grandVins.some((e) => e.entityId === row.entityId)) {
        const chosen = descriptors.get(row.entityId)?.lineKey ?? '?';
        offenders.push(`${row.semanticScopeKey} chose "${chosen}" but family has grand-vin lines ${JSON.stringify(grandVins.map((e) => e.lineKey))}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('approved authority is only authored for families the benchmark gold expects RESOLVED', () => {
    const goldResolved = loadGoldFamiliesResolved();
    const offenders: string[] = [];
    for (const row of scopeTargets) {
      if (row.decisionStatus !== 'approved') continue;
      const fam = normalizeForMatch(row.benchmarkGoldHint);
      if (!goldResolved.has(fam)) offenders.push(`${row.semanticScopeKey} (family "${fam}" not gold-resolved)`);
    }
    expect(offenders).toEqual([]);
  });

  it('every APPROVED exact-safe-scope entity exists in runtime known ids (anti-fabrication)', () => {
    const offenders = exactSafe
      .filter((r) => r.decisionStatus === 'approved' && !knownIds.has(r.entityId))
      .map((r) => r.reviewScopeKey);
    expect(offenders).toEqual([]);
  });

  it('every semantic-policy entity exists in runtime known ids', () => {
    const offenders = policy
      .filter((r) => !knownIds.has(r.entityId))
      .map((r) => r.semanticConflictKey);
    expect(offenders).toEqual([]);
  });

  it('localized surface registry has no duplicate (locale, normalized) keys', () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const row of localized) {
      const key = `${row.locale}::${row.normalizedLocalSurface}`;
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
    expect(dups).toEqual([]);
  });

  it('normalizeForMatch is idempotent + boundary-safe across Korean / accented / mixed-script / emoji', () => {
    // CLAUDE.md test-discipline rules 5 & 8: any normalization touching the
    // localized registry must behave on non-ASCII. normalized form must be a
    // fixed point (normalize(normalize(x)) === normalize(x)) so registry rows
    // never drift on a re-normalization pass.
    const samples = [
      '샤또 앙젤뤼스', // Korean
      '쏠라이아', // Korean compact
      'Château Pétrus', // accented Latin
      'Silver Oak 나파밸리', // mixed script
      'Caymus 카베르네 🍷', // emoji
      '  마쎄토   또스카나  ', // whitespace collapse
    ];
    for (const s of samples) {
      const once = normalizeForMatch(s);
      expect(normalizeForMatch(once)).toBe(once);
      expect(once).toBe(once.trim());
      expect(once).not.toMatch(/\s{2,}/);
    }
    // every registry row is already at its fixed point
    for (const row of localized) {
      expect(normalizeForMatch(row.normalizedLocalSurface)).toBe(row.normalizedLocalSurface);
    }
  });

  it('localized surfaces stay recall-only: normalized form is canonical and evidence class is fixed', () => {
    const offenders: string[] = [];
    for (const row of localized) {
      if (row.normalizedLocalSurface !== normalizeForMatch(row.localSurface)) {
        offenders.push(`${row.localSurface} normalized mismatch`);
      }
      // widen to string so the runtime guard survives even if a corrupted row
      // carried a non-canonical evidenceClass past the loader.
      const evidenceClass: string = row.evidenceClass;
      if (evidenceClass !== 'localized_surface_review') {
        offenders.push(`${row.localSurface} evidenceClass=${evidenceClass}`);
      }
      // recall-only: the localized registry row type carries NO entityId field at all.
      if ('entityId' in (row as Record<string, unknown>)) {
        offenders.push(`${row.localSurface} leaks an entityId (authority promotion)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
