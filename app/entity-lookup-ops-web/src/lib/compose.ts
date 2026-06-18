import type { AuthorityClass, OwnerEvidence } from '../types';

const NOW = '2026-06-09T00:00:00.000Z';

export interface ComposeInput {
  readonly cls: AuthorityClass | 'runtime_catalog_backfill';
  readonly surface: string;
  readonly family?: string;
  readonly entityId?: string;
  readonly vintage?: number | null;
  readonly evidence?: OwnerEvidence | undefined;
  readonly reviewer?: string;
}

export interface ComposeResult {
  readonly file: string;
  readonly row: string | null; // ready-to-append JSONL (null when key is pipeline-computed)
  readonly note: string;
  readonly applyCmd?: string;
}

function evidenceReason(input: ComposeInput, head: string): string {
  const ev = input.evidence;
  const bits: string[] = [head];
  if (ev?.entityLabels?.length) bits.push(`runtime owner=${ev.entityLabels.join('|')}`);
  else if (ev?.entityIds?.length) bits.push(`runtime owner=${ev.entityIds.join('|')}`);
  if (ev?.availableVintages?.length) bits.push(`available vintages=${ev.availableVintages.join('/')}`);
  if (ev?.availableLineKeys?.length) bits.push(`lines=${ev.availableLineKeys.join('/')}`);
  if (ev?.availableRegionKeys?.length) bits.push(`regions=${ev.availableRegionKeys.join('/')}`);
  return bits.join('; ');
}

// Drafts an evidence-cited row. exact_safe / family_core_witness are fully
// constructible; scope_target / policy / collision use pipeline-computed keys,
// so we emit the decision + the apply command rather than a raw row.
export function compose(input: ComposeInput): ComposeResult {
  const reviewer = input.reviewer ?? 'claude';
  switch (input.cls) {
    case 'exact_safe':
      if (!input.entityId) return { file: AUTHORITY_FILE.exact_safe, row: null, note: 'entityId 필요 (collision-free singleton 대상).' };
      return {
        file: AUTHORITY_FILE.exact_safe,
        row: JSON.stringify({
          surface: input.surface,
          entityId: input.entityId,
          promotionClass: 'exact_safe',
          locale: 'ko',
          sourceEvidence: evidenceReason(input, `vintage singleton (${input.vintage ?? 'collision-free'})`),
          reviewedAt: NOW,
        }),
        note: 'exact-safe vintage-consistency: surface vintage == entity vintage 확인 후 append. publish 후 vintageCanonicalized로 매칭.',
      };
    case 'family_core_witness':
      if (!input.entityId) return { file: AUTHORITY_FILE.family_core_witness, row: null, note: 'entityId 필요.' };
      return {
        file: AUTHORITY_FILE.family_core_witness,
        row: JSON.stringify({
          surface: input.family ?? input.surface,
          normalizedSurface: input.family ?? input.surface,
          entityId: input.entityId,
          reviewedBy: reviewer,
          reviewedAt: NOW,
          decisionReason: evidenceReason(input, 'family-core witness: join materialized entity to producer-family owner set (evidence-only, no authority promotion)'),
          evidenceClass: 'family_core_witness_review',
        }),
        note: '2-PHASE: 대상 entity가 active snapshot에 published된 뒤에만 검증 통과(미발행 시 unknown entityId FATAL).',
      };
    case 'scope_target':
      return {
        file: AUTHORITY_FILE.scope_target,
        row: null,
        note: `decision: assign target → ${input.entityId ?? '<reviewed entityId>'} (${evidenceReason(input, 'scope target')}). semanticScopeKey는 review packet에서 계산되므로 raw append 대신 review→apply 파이프라인 사용.`,
        applyCmd: 'pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-semantic-scope-target-registry',
      };
    case 'policy':
      return {
        file: AUTHORITY_FILE.policy,
        row: null,
        note: `decision: keep_ambiguous / promote_exact_safe / needs_scope_target 중 택1 (${evidenceReason(input, 'policy')}).`,
        applyCmd: 'pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-policy-family-decision-registry',
      };
    case 'collision':
      return {
        file: AUTHORITY_FILE.collision,
        row: null,
        note: `decision: assign_target / keep_ambiguous / reject (witness+descriptor 증거 기반). reviewed-collision 파이프라인 사용.`,
        applyCmd: 'pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:apply-reviewed-collision-semantic-scope-target-registry',
      };
    case 'runtime_catalog_backfill':
      return {
        file: 'data/gold-wine-catalog.jsonl (+ CORE case + anchor-suitability regen)',
        row: null,
        note: `구조: 요청 vintage(${input.vintage ?? '?'}) gold 엔티티 materialize → CORE_KOREAN_ICON_QUERY_CASES 등록 → anchor-suitability regen(requiredEntityIds) → exact-safe singleton. ${evidenceReason(input, 'runtime/catalog backfill')}.`,
        applyCmd: 'pnpm run etl:generate-benchmark-anchor-suitability && pnpm run etl:publish-search-snapshot',
      };
    default:
      return { file: '—', row: null, note: '미분류' };
  }
}

export const AUTHORITY_FILE: Record<AuthorityClass, string> = {
  exact_safe: 'data/lookup-v2/korean-exact-safe-registry-v1.jsonl',
  scope_target: 'data/lookup-v2/lookup-semantic-scope-target-registry-v1.jsonl',
  policy: 'data/lookup-v2/lookup-semantic-policy-registry-v1.jsonl',
  collision: 'data/lookup-v2/lookup-family-collision-registry-v1.jsonl',
  scope_support: 'data/lookup-v2/lookup-semantic-scope-support-registry-v1.jsonl',
  localized_surface: 'data/lookup-v2/lookup-localized-scope-surface-registry-v1.jsonl',
  family_core_witness: 'data/lookup-v2/lookup-family-core-witness-registry-v1.jsonl',
};
