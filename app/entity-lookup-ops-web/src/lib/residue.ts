import type { AuthorityClass, CoverageHole, Dataset, GapBucket, OwnerEvidence, ResidueItem } from '../types';

export const GAP_LABEL: Record<GapBucket, string> = {
  scope_target_missing: 'scope_target_missing',
  strict_collision_ambiguous: 'strict_collision_ambiguous',
  requested_vintage_missing: 'requested_vintage_missing',
  runtime_family_missing: 'runtime_family_missing',
  family_surface_gap: 'family_surface_needs_specific_line',
  recall_only_no_match: 'recall_only_no_match',
  other: 'other',
};

export const CLASS_LABEL: Record<AuthorityClass | 'runtime_catalog_backfill', string> = {
  exact_safe: 'Exact-safe',
  scope_target: 'Scope target',
  policy: 'Policy',
  collision: 'Family collision',
  scope_support: 'Scope support',
  localized_surface: 'Localized surface',
  family_core_witness: 'Family-core witness',
  runtime_catalog_backfill: 'Runtime/catalog backfill',
};

function bucketOf(hole: CoverageHole): GapBucket {
  const r = hole.reasonCode ?? '';
  const b = hole.bucket ?? '';
  if (b === 'strict_collision_ambiguous' || r === 'reviewed_family_collision_requires_clarification') return 'strict_collision_ambiguous';
  if (r === 'requested_vintage_missing') return 'requested_vintage_missing';
  if (r === 'runtime_family_missing') return 'runtime_family_missing';
  if (r === 'family_surface_needs_specific_line') return 'family_surface_gap';
  if (r === 'recall_only_no_match') return 'recall_only_no_match';
  if (b === 'scope_target_missing' || r === 'no_match' || r === 'CONFIDENCE_BELOW_THRESHOLD' || r === 'vintage_mismatch_downgrade') return 'scope_target_missing';
  return 'other';
}

function ownerByFamily(ds: Dataset): Map<string, OwnerEvidence> {
  const m = new Map<string, OwnerEvidence>();
  for (const e of ds.ownerEvidence) if (e.family) m.set(e.family.toLowerCase(), e);
  return m;
}

export function classifyResidue(ds: Dataset): ResidueItem[] {
  if (!ds.coverage) return [];
  const owners = ownerByFamily(ds);
  return ds.coverage.holes.map((hole) => {
    const bucket = bucketOf(hole);
    const ev = hole.family ? owners.get(hole.family.toLowerCase()) : undefined;
    const uniqueOwner = (ev?.entityIds?.length ?? 0) === 1;

    let cls: AuthorityClass | 'runtime_catalog_backfill' = 'scope_target';
    let evidenceBased = false;
    let rationale = '';

    switch (bucket) {
      case 'strict_collision_ambiguous':
        cls = 'collision';
        evidenceBased = false;
        rationale = '진성 충돌 후보 — family-core witness + descriptor 증거로 assign_target / keep_ambiguous / reject를 사람이 결정.';
        break;
      case 'requested_vintage_missing':
        cls = 'runtime_catalog_backfill';
        evidenceBased = Boolean(ev?.availableVintages?.length);
        rationale = `요청 vintage가 runtime owner에 없음(available: ${(ev?.availableVintages ?? []).join('/') || '?'}). 구조: gold vintage 엔티티 materialize + exact-safe singleton(자유형 alias ❌).`;
        break;
      case 'runtime_family_missing':
        cls = 'runtime_catalog_backfill';
        evidenceBased = false;
        rationale = 'runtime owner 자체가 없음 → catalog backfill 후 reviewed target 결정.';
        break;
      case 'family_surface_gap':
        cls = 'scope_target';
        evidenceBased = uniqueOwner;
        rationale = uniqueOwner
          ? `runtime owner 단일(${ev?.entityLabels?.[0] ?? ev?.entityIds?.[0]}) → reviewed scope target로 닫기. (line/region descriptor 증거 확인)`
          : 'family surface가 specific line 필요 — runtime descriptor(line/region/appellation) 증거로 scope target 결정.';
        break;
      case 'recall_only_no_match':
        cls = 'localized_surface';
        evidenceBased = false;
        rationale = 'recall-only 표면 — reviewed scope target 승인 시 localized scope surface auto-sync 가능. 단독 alias 추가 금지.';
        break;
      case 'scope_target_missing':
      default:
        cls = uniqueOwner ? 'scope_target' : 'scope_target';
        evidenceBased = uniqueOwner;
        rationale = uniqueOwner
          ? `unique runtime owner 증거 있음(${ev?.entityIds?.[0]}) → reviewed scope target 후보.`
          : 'runtime owner 증거 부족/다중 → descriptor 축(line/region/appellation/vintage) 노출 후 reviewed 결정.';
        break;
    }

    return { hole, bucket, authorityClass: cls, evidenceBased, rationale, evidence: ev };
  });
}

export function groupByBucket(items: readonly ResidueItem[]): Map<GapBucket, ResidueItem[]> {
  const m = new Map<GapBucket, ResidueItem[]>();
  for (const it of items) {
    const arr = m.get(it.bucket) ?? [];
    arr.push(it);
    m.set(it.bucket, arr);
  }
  return m;
}
