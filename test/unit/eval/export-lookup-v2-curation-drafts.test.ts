import { describe, expect, it } from 'vitest';
import {
  buildLookupV2CurationDraftRows,
  inferDraftLocale,
} from '../../../scripts/eval/export-lookup-v2-curation-drafts.js';

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
    const rows = buildLookupV2CurationDraftRows(
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
      {
        surface: '샤또 무통 로쉴드',
        locale: 'ko',
        suggestedAliasType: 'translation',
        holeClass: 'realworld_korean_orthography',
        observedStatus: 'failed',
        benchmarkGoldHint: 'mouton',
        benchmarkGoldEntityId: 'wine-ce-7ad85be72e30da173b87702175d8423ebfad6b8834d0b6ff794d2d4a62573e0e',
        benchmarkGoldEntityIdSource: 'policy_registry_authority',
        triageBucket: 'policy_review',
        policyConflictHint: 'mouton',
        sourceArtifact: '/tmp/sample-coverage.json',
        sourceEvidence: 'Hot-entity coverage hole',
        reviewedAt: '2026-06-05T00:00:00.000Z',
      },
      {
        surface: 'Dom Perignon',
        locale: 'global',
        suggestedAliasType: 'canonical',
        holeClass: 'realworld_exact_vintage',
        observedStatus: 'failed',
        benchmarkGoldEntityId: 'w-dom-perignon-2013',
        benchmarkGoldEntityIdSource: 'fixture_exact',
        triageBucket: 'auto_targetable',
        sourceArtifact: '/tmp/sample-coverage.json',
        sourceEvidence: 'Hot-entity coverage hole',
        reviewedAt: '2026-06-05T00:00:00.000Z',
      },
    ]);
  });

  it('normalizes benchmark hints before lookup and policy triage', () => {
    const [row] = buildLookupV2CurationDraftRows(
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
      triageBucket: 'policy_review',
      policyConflictHint: 'Latour',
    }));
  });

  it('keeps policy conflict families in policy_review until a reviewed decision exists', () => {
    const [row] = buildLookupV2CurationDraftRows(
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
      triageBucket: 'policy_review',
      policyConflictHint: 'vega sicilia unico',
    }));
  });

  it('promotes family target registry authority into auto_targetable rows', () => {
    const [row] = buildLookupV2CurationDraftRows(
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
      new Map(),
      new Map([
        ['petrus::canonical::realworld_korean_orthography', {
          reviewScopeKey: 'petrus::canonical::realworld_korean_orthography',
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          scopeHoleClass: 'realworld_korean_orthography',
          scopeSuggestedAliasType: 'canonical',
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
      benchmarkGoldEntityIdSource: 'family_target_registry',
      triageBucket: 'auto_targetable',
    }));
  });

  it('promotes reviewed policy family decisions into auto_targetable rows', () => {
    const [row] = buildLookupV2CurationDraftRows(
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
        ['라뚜르::wine-ce-latour', {
          policyConflictSurface: '라뚜르',
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
      benchmarkGoldEntityIdSource: 'policy_family_decision_registry',
      triageBucket: 'auto_targetable',
    }));
  });

  it('downgrades hint-only target resolution to manual_target and preserves it as a suggestion', () => {
    const [row] = buildLookupV2CurationDraftRows(
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
      triageBucket: 'manual_target',
    }));
    expect(row).not.toHaveProperty('benchmarkGoldEntityId');
  });

  it('routes reviewed rejected family-target scopes out of the blind manual_target queue', () => {
    const [row] = buildLookupV2CurationDraftRows(
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
      new Map(),
      new Map(),
      new Map([
        ['ausone::canonical::realworld_producer_prefixed', {
          reviewScopeKey: 'ausone::canonical::realworld_producer_prefixed',
          benchmarkGoldHint: 'ausone',
          normalizedBenchmarkGoldHint: 'ausone',
          scopeHoleClass: 'realworld_producer_prefixed',
          scopeSuggestedAliasType: 'canonical',
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
      triageBucket: 'reviewed_rejected',
    }));
    expect(row).not.toHaveProperty('benchmarkGoldEntityId');
  });

  it('routes reviewed catalog-support absent families into catalog_absent instead of manual_target', () => {
    const [row] = buildLookupV2CurationDraftRows(
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
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map([
        ['salon', {
          benchmarkGoldHint: 'salon',
          normalizedBenchmarkGoldHint: 'salon',
          supportStatus: 'active_catalog_absent',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'active catalog lacks reviewed Salon witness surface',
          evidenceClass: 'catalog_support_review',
        }],
      ]),
    );

    expect(row).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'salon',
      triageBucket: 'catalog_absent',
      supportStatus: 'active_catalog_absent',
    }));
    expect(row).not.toHaveProperty('benchmarkGoldEntityId');
  });

  it('routes reviewed family collisions into reviewed_collision instead of manual_target', () => {
    const [row] = buildLookupV2CurationDraftRows(
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
    const [row] = buildLookupV2CurationDraftRows(
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
      new Map(),
      new Map([
        ['silver oak::canonical::realworld_vintage_suffix', {
          reviewScopeKey: 'silver oak::canonical::realworld_vintage_suffix',
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          scopeHoleClass: 'realworld_vintage_suffix',
          scopeSuggestedAliasType: 'canonical',
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
      benchmarkGoldEntityIdSource: 'family_target_registry',
      triageBucket: 'auto_targetable',
      collisionStatus: 'active_entity_collision',
    }));
  });
});
