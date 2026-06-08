import { describe, expect, it } from 'vitest';
import {
  buildLookupV2CurationDraftRowsWithRuntimeDescriptors,
  inferDraftLocale,
} from '../../../scripts/eval/export-lookup-v2-curation-drafts.js';
import type { LookupV2RuntimeSemanticDescriptor } from '../../../scripts/eval/lookup-v2-runtime-semantic-descriptors.js';

function buildRuntimeDescriptorMap(
  entries: readonly [string, LookupV2RuntimeSemanticDescriptor][],
): ReadonlyMap<string, LookupV2RuntimeSemanticDescriptor> {
  return new Map(entries);
}

describe('inferDraftLocale', () => {
  it('classifies Hangul surfaces as ko', () => {
    expect(inferDraftLocale('샤또 무통 로쉴드')).toBe('ko');
  });

  it('classifies Latin surfaces as global', () => {
    expect(inferDraftLocale('Dom Perignon')).toBe('global');
  });
});

describe('buildLookupV2CurationDraftRows', () => {
  it('projects coverage curation tasks into deterministic draft rows', () => {
    const rows = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: '샤또 무통 로쉴드',
          holeClass: 'realworld_korean_orthography',
          observedStatus: 'failed',
          suggestedAliasType: 'translation',
          status: 'needs_target',
          benchmarkGoldHint: 'mouton',
          reason: 'Hot-entity coverage hole',
        },
        {
          surfaceForm: 'Dom Perignon',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldEntityId: 'w-dom-perignon-2013',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-05T00:00:00.000Z',
      buildRuntimeDescriptorMap([
        ['wine-ce-7ad85be72e30da173b87702175d8423ebfad6b8834d0b6ff794d2d4a62573e0e', {
          entityId: 'wine-ce-7ad85be72e30da173b87702175d8423ebfad6b8834d0b6ff794d2d4a62573e0e',
          canonicalLabel: 'Chateau Mouton Rothschild',
          familyKey: 'mouton rothschild',
          producerKey: 'chateau mouton rothschild',
        }],
        ['w-dom-perignon-2013', {
          entityId: 'w-dom-perignon-2013',
          canonicalLabel: 'Dom Perignon',
          familyKey: 'moet chandon',
          producerKey: 'moet chandon',
          lineKey: 'dom perignon',
          vintage: 2013,
        }],
      ]),
      new Map([['mouton', 'wine-ce-7ad85be72e30da173b87702175d8423ebfad6b8834d0b6ff794d2d4a62573e0e']]),
      new Map(),
      new Map(),
      new Map([
        ['mouton', {
          surface: '무통',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-7ad85be72e30da173b87702175d8423ebfad6b8834d0b6ff794d2d4a62573e0e',
          conflictType: 'short_form_collision',
          conflictBenchmarkHints: ['mouton'],
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        }],
      ]),
      new Map(),
    );

    expect(rows).toEqual([
      expect.objectContaining({
        surface: '샤또 무통 로쉴드',
        locale: 'ko',
        suggestedAliasType: 'translation',
        holeClass: 'realworld_korean_orthography',
        observedStatus: 'failed',
        benchmarkGoldHint: 'mouton',
        benchmarkGoldEntityId: 'wine-ce-7ad85be72e30da173b87702175d8423ebfad6b8834d0b6ff794d2d4a62573e0e',
        benchmarkGoldEntityIdSource: 'policy_registry_authority',
        familyKey: 'mouton rothschild',
        scopeAxis: 'family',
        semanticScopeKey: 'family::mouton rothschild::::::::::bare::ko',
        semanticConflictKey: 'family::mouton rothschild::::::::::bare::ko',
        surfaceFormKind: 'bare',
        triageBucket: 'scope_policy_review',
        policyConflictHint: 'mouton',
      }),
      expect.objectContaining({
        surface: 'Dom Perignon',
        locale: 'global',
        suggestedAliasType: 'canonical',
        holeClass: 'realworld_exact_vintage',
        observedStatus: 'failed',
        benchmarkGoldEntityId: 'w-dom-perignon-2013',
        benchmarkGoldEntityIdSource: 'fixture_exact',
        familyKey: 'moet chandon',
        lineKey: 'dom perignon',
        scopeAxis: 'line',
        semanticScopeKey: 'line::moet chandon::dom perignon::::::::qualified::global',
        surfaceFormKind: 'qualified',
        triageBucket: 'auto_targetable',
      }),
    ]);
  }, 10_000);

  it('normalizes benchmark hints before lookup and policy triage', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: 'LATOUR 2018',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'Latour',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-05T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map([['latour', 'wine-ce-latour']]),
      new Map(),
      new Map(),
      new Map([
        ['latour', {
          surface: '라뚜르',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-latour',
          conflictType: 'short_form_collision',
          conflictBenchmarkHints: ['latour'],
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        }],
      ]),
      new Map(),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldEntityId: 'wine-ce-latour',
      benchmarkGoldEntityIdSource: 'policy_registry_authority',
      semanticScopeKey: 'line::latour::::::::2018::qualified::global',
      scopeAxis: 'line',
      surfaceFormKind: 'qualified',
      triageBucket: 'scope_policy_review',
      policyConflictHint: 'Latour',
    }));
  });

  it('keeps policy conflict families in policy_review until a reviewed decision exists', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: '베가 시실리아 우니꼬 2011',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'vega sicilia unico',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-05T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map(),
      new Map(),
      new Map(),
      new Map([
        ['vega sicilia unico', {
          surface: '베가 시실리아',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-vega',
          conflictType: 'broad_icon_collision',
          conflictBenchmarkHints: ['vega sicilia unico'],
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        }],
      ]),
      new Map(),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldEntityId: 'wine-ce-vega',
      benchmarkGoldEntityIdSource: 'policy_registry_authority',
      semanticScopeKey: 'line::vega sicilia unico::::::::2011::qualified::ko',
      scopeAxis: 'line',
      surfaceFormKind: 'qualified',
      triageBucket: 'scope_policy_review',
      policyConflictHint: 'vega sicilia unico',
    }));
  });

  it('promotes family target registry authority into auto_targetable rows', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: '페트뤼스',
          holeClass: 'realworld_korean_orthography',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'petrus',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-05T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map(),
      new Map([
        ['family::petrus::::::::::compact::ko', {
          semanticScopeKey: 'family::petrus::::::::::compact::ko',
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          scopeAxis: 'family',
          familyKey: 'petrus',
          surfaceFormKind: 'compact',
          locale: 'ko',
          entityId: 'wine-ce-petrus',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-05T00:00:00.000Z',
          decisionReason: 'fixture exact',
          evidenceClass: 'fixture_exact',
        }],
      ]),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldEntityId: 'wine-ce-petrus',
      benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
      semanticScopeKey: 'family::petrus::::::::::compact::ko',
      triageBucket: 'auto_targetable',
    }));
  });

  it('preserves an explicit vintage-qualified fallback scope when the hinted runtime descriptor only matches at family scope', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: 'Opus 원 2019',
          holeClass: 'realworld_mixed_script_alias',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'opus one',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-08T00:00:00.000Z',
      buildRuntimeDescriptorMap([
        ['opus-one-2018', {
          entityId: 'opus-one-2018',
          canonicalLabel: 'Opus One 2018',
          familyKey: 'opus one',
          lineKey: '오푸스원',
          vintage: 2018,
        }],
      ]),
      new Map([['opus one', 'opus-one-2018']]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(row).toEqual(expect.objectContaining({
      semanticScopeKey: 'line::opus one::::::::2019::mixed_script::ko',
      scopeAxis: 'line',
      familyKey: 'opus one',
      vintage: 2019,
      surfaceFormKind: 'mixed_script',
      benchmarkGoldEntityIdSuggestion: 'opus-one-2018',
      benchmarkGoldEntityIdSuggestionSource: 'hint_resolution',
      triageBucket: 'scope_target_review',
    }));
  });

  it('promotes reviewed policy family decisions into auto_targetable rows', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: '라뚜르 2009',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'latour',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-05T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map([['latour', 'wine-ce-latour']]),
      new Map(),
      new Map(),
      new Map([
        ['latour', {
          surface: '라뚜르',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-latour',
          conflictType: 'short_form_collision',
          conflictBenchmarkHints: ['latour'],
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        }],
      ]),
      new Map([
        ['line::latour::::::::2009::qualified::ko::wine-ce-latour', {
          semanticConflictKey: 'line::latour::::::::2009::qualified::ko',
          conflictClass: 'short_form_collision',
          entityId: 'wine-ce-latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'seed',
        }],
      ]),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldEntityId: 'wine-ce-latour',
      benchmarkGoldEntityIdSource: 'semantic_policy_registry',
      triageBucket: 'auto_targetable',
    }));
  });

  it('downgrades hint-only target resolution to manual_target and preserves it as a suggestion', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: 'Opus 원 2019',
          holeClass: 'realworld_mixed_script_alias',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'opus one',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-05T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map([['opus one', 'opus-one-2018']]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'opus one',
      benchmarkGoldEntityIdSuggestion: 'opus-one-2018',
      benchmarkGoldEntityIdSuggestionSource: 'hint_resolution',
      semanticScopeKey: 'line::opus one::::::::2019::mixed_script::ko',
      scopeAxis: 'line',
      vintage: 2019,
      triageBucket: 'scope_target_review',
    }));
    expect(row).not.toHaveProperty('benchmarkGoldEntityId');
  });

  it('routes reviewed rejected family-target scopes out of the blind manual_target queue', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: '샤또 오존',
          holeClass: 'realworld_producer_prefixed',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'ausone',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-06T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map(),
      new Map(),
      new Map([
        ['family::ausone::::::::::bare::ko', {
          semanticScopeKey: 'family::ausone::::::::::bare::ko',
          benchmarkGoldHint: 'ausone',
          normalizedBenchmarkGoldHint: 'ausone',
          scopeAxis: 'family',
          familyKey: 'ausone',
          surfaceFormKind: 'bare',
          locale: 'ko',
          decisionStatus: 'rejected',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'active catalog only exposes Chapelle d’Ausone; generic Ausone family cannot be safely targeted',
          evidenceClass: 'manual_target_family_review',
        }],
      ]),
      new Map(),
      new Map(),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'ausone',
      semanticScopeKey: 'family::ausone::::::::::bare::ko',
      triageBucket: 'reviewed_rejected',
    }));
    expect(row).not.toHaveProperty('benchmarkGoldEntityId');
  });

  it('routes reviewed scope-support absent families into catalog_support_review instead of scope_target_review', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: '살롱 샴페인',
          holeClass: 'realworld_brand_suffix',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'salon',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-07T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map([
        ['family::salon::::::::::bare::ko', {
          semanticScopeKey: 'family::salon::::::::::bare::ko',
          supportStatus: 'active_entity_absent',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'active catalog lacks reviewed Salon witness surface',
          evidenceClass: 'scope_support_review',
        }],
      ]),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'salon',
      semanticScopeKey: 'family::salon::::::::::bare::ko',
      triageBucket: 'catalog_support_review',
      supportStatus: 'active_entity_absent',
    }));
    expect(row).not.toHaveProperty('benchmarkGoldEntityId');
  });

  it('routes reviewed family collisions into reviewed_collision instead of manual_target', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: '실버 오크 카베르네',
          holeClass: 'realworld_brand_suffix',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'silver oak',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-07T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map([
        ['silver oak', {
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          collisionStatus: 'active_entity_collision',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'active runtime exposes Napa and Alexander Valley owners',
          evidenceClass: 'collision_support_review',
        }],
      ]),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'silver oak',
      triageBucket: 'reviewed_collision',
      collisionStatus: 'active_entity_collision',
    }));
    expect(row).not.toHaveProperty('benchmarkGoldEntityId');
  });

  it('allows scope-reviewed family targets inside reviewed_collision families', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: '실버 오크 17',
          holeClass: 'realworld_vintage_suffix',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'silver oak',
          reason: 'Hot-entity coverage hole',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-07T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map(),
      new Map([
        ['line::silver oak::::::::2017::qualified::ko', {
          semanticScopeKey: 'line::silver oak::::::::2017::qualified::ko',
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          scopeAxis: 'line',
          familyKey: 'silver oak',
          vintage: 2017,
          surfaceFormKind: 'qualified',
          locale: 'ko',
          entityId: 'wine-ce-silver-oak-av',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'reviewed collision scope target',
          evidenceClass: 'reviewed_collision_family_review',
        }],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map([
        ['silver oak', {
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          collisionStatus: 'active_entity_collision',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'active runtime exposes Napa and Alexander Valley owners',
          evidenceClass: 'collision_support_review',
        }],
      ]),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'silver oak',
      benchmarkGoldEntityId: 'wine-ce-silver-oak-av',
      benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
      semanticScopeKey: 'line::silver oak::::::::2017::qualified::ko',
      triageBucket: 'auto_targetable',
      collisionStatus: 'active_entity_collision',
    }));
  });

  it('drops stale localized-surface review rows once the reviewed family surface already exists', () => {
    const rows = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: 'Opus 원 2019',
          holeClass: 'realworld_mixed_script_alias',
          observedStatus: 'ambiguous',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'opus one',
          reason: 'Hot-entity coverage hole',
          operatorBucket: 'family_surface_gap',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-08T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map([['opus one', 'opus-one-2018']]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map([
        ['family::opus one::ko', new Set(['opus 원'])],
      ]),
    );

    expect(rows).toEqual([]);
  });

  it('keeps localized surface gaps visible even when the family stays policy-owned ambiguous', () => {
    const [row] = buildLookupV2CurationDraftRowsWithRuntimeDescriptors(
      [
        {
          surfaceForm: '그랜지 2016',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'grange',
          reason: 'Hot-entity coverage hole',
          operatorBucket: 'family_surface_gap',
        },
      ],
      '/tmp/sample-coverage.json',
      '2026-06-08T00:00:00.000Z',
      buildRuntimeDescriptorMap([]),
      new Map([['grange', 'wine-ce-grange']]),
      new Map(),
      new Map(),
      new Map([
        ['grange', {
          surface: '그랜지',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-grange',
          conflictType: 'short_form_collision',
          conflictBenchmarkHints: ['grange'],
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-08T00:00:00.000Z',
        }],
      ]),
      new Map([
        ['line::grange::::::::2016::qualified::ko::wine-ce-grange', {
          semanticConflictKey: 'line::grange::::::::2016::qualified::ko',
          conflictClass: 'short_form_collision',
          entityId: 'wine-ce-grange',
          decision: 'keep_ambiguous',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-08T00:00:00.000Z',
          decisionReason: 'short-form broad surface stays ambiguity-owned',
        }],
      ]),
      new Map(),
      new Map(),
      new Map(),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'grange',
      benchmarkGoldEntityIdSource: 'policy_registry_authority',
      benchmarkGoldEntityIdSuggestion: 'wine-ce-grange',
      benchmarkGoldEntityIdSuggestionSource: 'hint_resolution',
      triageBucket: 'localized_surface_review',
      operatorBucket: 'family_surface_gap',
    }));
  });
});
