import { describe, expect, it } from 'vitest';
import {
  applyPublishedSuppressionRules,
  buildCurationPinConvergenceError,
  buildCurationPinSnapshotMismatchError,
  CURATION_PUBLISHED_ALIAS_SOURCE,
  CURATION_STAGING_PG_POOL_DISABLED_MESSAGE,
  hasAdditionalPublishedConsumption,
  isPublishedCurationConsumptionStatus,
  matchesTargetSnapshotVersion,
  mergePublishedAmbiguityRows,
  parsePublishedAliasProposalRow,
  parsePublishedAmbiguityProposalRow,
  parsePublishedSuppressionProposalRow,
  publishedAmbiguityProposalToSnapshotRow,
} from '../../../scripts/etl/load-published-curation-proposals.js';
import type { AmbiguityRegistrySnapshotRow } from '../../../scripts/etl/search-snapshot-schema.js';
import type { CanonicalEntityId } from '../../../src/domain/shared/types/index.js';

const ENTITY_A = 'opus-one-2018' as CanonicalEntityId;
const ENTITY_B = 'opus-one-2019' as CanonicalEntityId;

describe('load-published-curation-proposals', () => {
  it('parsePublishedAliasProposalRow accepts all alias types and normalizes evidence', () => {
    const parsed = parsePublishedAliasProposalRow({
      proposal_id: 'p-1',
      surface_form: '오푸스원',
      target_entity_id: ENTITY_A,
      proposed_type: 'translation',
      evidence: {},
      confidence: 0.92,
      status: 'published',
      target_snapshot_version: null,
    });

    expect(parsed.proposal.type).toBe('translation');
    expect(parsed.proposal.source).toBe(CURATION_PUBLISHED_ALIAS_SOURCE);
    expect(parsed.proposal.scope).toBe('locale_ko');
    expect(parsed.proposal.confidencePrior).toBe(0.92);
  });

  it('parsePublishedAmbiguityProposalRow requires at least two known member entities', () => {
    const known = new Set<CanonicalEntityId>([ENTITY_A, ENTITY_B]);
    const row = parsePublishedAmbiguityProposalRow({
      proposal_id: 'a-1',
      normalized_form: 'opus one',
      member_entity_ids: [ENTITY_A, ENTITY_B, 'missing-entity'],
      evidence: { severity: 'medium' },
      status: 'published',
      target_snapshot_version: null,
    }, known);

    expect(row).not.toBeNull();
    expect(row?.entityIds).toEqual([ENTITY_A, ENTITY_B]);
    expect(row?.severity).toBe('medium');
  });

  it('publishedAmbiguityProposalToSnapshotRow returns null when fewer than two members survive validation', () => {
    const row = publishedAmbiguityProposalToSnapshotRow({
      proposalId: 'a-2',
      normalizedForm: 'solo',
      memberEntityIds: [ENTITY_A, 'missing-entity'],
      evidence: {},
      knownEntityIds: new Set<CanonicalEntityId>([ENTITY_A]),
    });
    expect(row).toBeNull();
  });

  it('mergePublishedAmbiguityRows lets published rows override base rows by normalizedForm', () => {
    const base: AmbiguityRegistrySnapshotRow = {
      registryId: 'base-1',
      normalizedForm: 'opus one',
      entityIds: [ENTITY_A, 'other-a'],
      ambiguityTypes: ['collision'],
      severity: 'low',
    };
    const published: AmbiguityRegistrySnapshotRow = {
      registryId: 'pub-1',
      normalizedForm: 'opus one',
      entityIds: [ENTITY_A, ENTITY_B],
      ambiguityTypes: ['operator_curation'],
      severity: 'high',
    };

    const merged = mergePublishedAmbiguityRows([base], [published]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.registryId).toBe('pub-1');
    expect(merged[0]?.entityIds).toEqual([ENTITY_A, ENTITY_B]);
  });

  it('applyPublishedSuppressionRules removes global and scoped suppressions', () => {
    const aliases = [
      { entityId: ENTITY_A, normalizedValue: 'opusone' },
      { entityId: ENTITY_B, normalizedValue: 'opusone' },
      { entityId: ENTITY_A, normalizedValue: 'other' },
    ];
    const rules = [
      parsePublishedSuppressionProposalRow({
        proposal_id: 's-1',
        surface_form: 'OpusOne',
        target_entity_id: ENTITY_A,
        reason: 'bad alias',
        status: 'published',
        target_snapshot_version: null,
      }),
      parsePublishedSuppressionProposalRow({
        proposal_id: 's-2',
        surface_form: 'other',
        target_entity_id: null,
        reason: 'global noise',
        status: 'published',
        target_snapshot_version: null,
      }),
    ];

    const filtered = applyPublishedSuppressionRules(aliases, rules);
    expect(filtered).toEqual([
      { entityId: ENTITY_B, normalizedValue: 'opusone' },
    ]);
  });

  it('matchesTargetSnapshotVersion is fail-closed for pins until snapshot id is known', () => {
    expect(matchesTargetSnapshotVersion(null, undefined)).toBe(true);
    expect(matchesTargetSnapshotVersion('snap-a', undefined)).toBe(false);
    expect(matchesTargetSnapshotVersion('snap-a', 'snap-a')).toBe(true);
    expect(matchesTargetSnapshotVersion('snap-a', 'snap-b')).toBe(false);
  });

  it('hasAdditionalPublishedConsumption detects newly pinned published ids', () => {
    const baseline = {
      aliasProposalIds: ['a-1'],
      ambiguityProposalIds: [],
      suppressionProposalIds: [],
    };
    const candidate = {
      aliasProposalIds: ['a-1', 'a-2'],
      ambiguityProposalIds: [],
      suppressionProposalIds: [],
    };
    expect(hasAdditionalPublishedConsumption(baseline, candidate)).toBe(true);
    expect(hasAdditionalPublishedConsumption(candidate, baseline)).toBe(false);
  });

  it('parsePublishedAliasProposalRow accepts snake_case evidence via domain SSoT', () => {
    const parsed = parsePublishedAliasProposalRow({
      proposal_id: 'p-snake',
      surface_form: '오푸스원',
      target_entity_id: ENTITY_A,
      proposed_type: 'translation',
      evidence: { source: 'ops_console', source_trust: 0.88, alias_scope: 'locale_ko' },
      confidence: 0.92,
      status: 'published',
      target_snapshot_version: null,
    });

    expect(parsed.proposal.sourceTrust).toBe(0.88);
    expect(parsed.proposal.scope).toBe('locale_ko');
  });

  it('parsePublishedAmbiguityProposalRow normalizes normalized_form for merge keys', () => {
    const known = new Set<CanonicalEntityId>([ENTITY_A, ENTITY_B]);
    const row = parsePublishedAmbiguityProposalRow({
      proposal_id: 'a-norm',
      normalized_form: 'Opus One',
      member_entity_ids: [ENTITY_A, ENTITY_B],
      evidence: { ambiguity_types: ['operator_curation'], severity: 'medium' },
      status: 'published',
      target_snapshot_version: null,
    }, known);

    expect(row?.normalizedForm).toBe('opus one');
  });

  it('buildCurationPinConvergenceError names unconsumed proposal ids', () => {
    const err = buildCurationPinConvergenceError({
      snapshotId: 'search-snapshot:v1:abc',
      passesAttempted: 4,
      unconsumedProposalIds: ['p-1', 'p-2'],
    });
    expect(err.message).toContain('search-snapshot:v1:abc');
    expect(err.message).toContain('p-1');
    expect(err.message).toContain('p-2');
  });

  it('buildCurationPinSnapshotMismatchError names pin drift rows', () => {
    const err = buildCurationPinSnapshotMismatchError({
      snapshotId: 'search-snapshot:v1:final',
      mismatched: [{ proposalId: 'p-1', targetSnapshotVersion: 'search-snapshot:v1:preview' }],
    });
    expect(err.message).toContain('pin snapshot mismatch');
    expect(err.message).toContain('p-1');
  });

  it('exposes a shared fail-loud message when staging PG env is set but pool is disabled', () => {
    expect(CURATION_STAGING_PG_POOL_DISABLED_MESSAGE).toContain('refusing silent curation staging access');
  });

  it('isPublishedCurationConsumptionStatus tracks only published rows for mark/consumed ids', () => {
    expect(isPublishedCurationConsumptionStatus('published')).toBe(true);
    expect(isPublishedCurationConsumptionStatus('approved')).toBe(false);
    expect(isPublishedCurationConsumptionStatus('pending')).toBe(false);
  });
});
