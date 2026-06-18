// Authority-row-class centric model. The ops console's first-class objects are
// REVIEWED AUTHORITY ROWS (per registry), the COVERAGE RESIDUE queue, and the
// PUBLISH/VERIFY rails — NOT "wine rows". Shapes mirror the lookup-v2 pipeline
// artifacts (write-plane summary + data/lookup-v2/* registries + coverage report).

export type AuthorityClass =
  | 'exact_safe'
  | 'scope_target'
  | 'policy'
  | 'collision'
  | 'scope_support'
  | 'localized_surface'
  | 'family_core_witness';

export const AUTHORITY_CLASSES: readonly AuthorityClass[] = [
  'exact_safe',
  'scope_target',
  'policy',
  'collision',
  'scope_support',
  'localized_surface',
  'family_core_witness',
];

export const AUTHORITY_META: Record<
  AuthorityClass,
  { label: string; file: string; note: string }
> = {
  exact_safe: {
    label: '정확매칭 (exact-safe)',
    file: 'korean-exact-safe-registry-v1.jsonl',
    note: '충돌 없는 단일 표면 → 엔티티. 리졸버가 빈티지 정규화 후 family 선택보다 먼저 매칭.',
  },
  scope_target: {
    label: '스코프 타깃',
    file: 'lookup-semantic-scope-target-registry-v1.jsonl',
    note: '패밀리/라인/빈티지 범위 → 검토된 타깃 엔티티. 지역화 표면 자동동기화의 원천.',
  },
  policy: {
    label: '정책',
    file: 'lookup-semantic-policy-registry-v1.jsonl',
    note: '의미 충돌 → 모호 유지 / exact-safe 승격 / 스코프타깃 필요.',
  },
  collision: {
    label: '패밀리 충돌',
    file: 'lookup-family-collision-registry-v1.jsonl',
    note: '패밀리 표면 충돌 상태(검토됨).',
  },
  scope_support: {
    label: '스코프 지원',
    file: 'lookup-semantic-scope-support-registry-v1.jsonl',
    note: '범위의 카탈로그/런타임 지원 상태.',
  },
  localized_surface: {
    label: '지역화 표면',
    file: 'lookup-localized-scope-surface-registry-v1.jsonl',
    note: '지역화된 구성요소 표면 — 승인된 스코프 타깃에서 자동동기화 가능(수동 전용 아님).',
  },
  family_core_witness: {
    label: '패밀리 증거 (witness)',
    file: 'lookup-family-core-witness-registry-v1.jsonl',
    note: '증거 전용 오버레이: 표면→엔티티를 패밀리 owner 집합에 노출(권한 승격 아님).',
  },
};

export interface AuthorityRow {
  readonly cls: AuthorityClass;
  readonly key: string; // surface / semanticScopeKey / semanticConflictKey / componentKey
  readonly entityId?: string;
  readonly status?: string; // decisionStatus / decision / collisionStatus / supportStatus / promotionClass
  readonly family?: string; // benchmarkGoldHint / familyKey
  readonly locale?: string;
  readonly reviewedBy?: string;
  readonly reason?: string;
  readonly evidenceClass?: string;
  readonly raw: Record<string, unknown>;
}

export interface CoverageHole {
  readonly surface: string;
  readonly family?: string;
  readonly bucket?: string;
  readonly status?: string;
  readonly reasonCode?: string;
  readonly holeClass?: string;
  readonly reason?: string;
}

export interface CoverageReport {
  readonly snapshotId?: string;
  readonly generatedAt?: string;
  readonly gitSha?: string;
  readonly hotEntityCount: number;
  readonly coveredCount: number;
  readonly coverageRate: number;
  readonly holes: readonly CoverageHole[];
  readonly bucketCounts: Record<string, number>;
  readonly reasonCounts: Record<string, number>;
}

export interface WritePlaneCoverageResidue {
  readonly hotEntityCount: number;
  readonly coveredCount: number;
  readonly uncoveredCount: number;
  readonly activeCoverageRatio: number;
  readonly activeCoveragePercent: number;
  readonly operatorBucketCounts: Record<string, number>;
  readonly observedReasonCodeCounts: Record<string, number>;
}

export interface WritePlaneDraftSummary {
  readonly rows: number;
  readonly autoTargetable: number;
  readonly scopePolicyReview: number;
  readonly localizedSurfaceReview: number;
  readonly reviewedRejected: number;
  readonly catalogSupportReview: number;
  readonly reviewedCollision: number;
  readonly scopeTargetReview: number;
}

export interface WritePlaneOperationalResidue {
  readonly draftRows: number;
  readonly structurallyClosedRows: number;
  readonly structurallyClosedRatio: number;
  readonly structurallyClosedPercent: number;
  readonly terminalReviewedRows: number;
  readonly autoTargetableRows: number;
  readonly manualReviewRows: number;
  readonly manualReviewBreakdown: {
    readonly scopePolicyReview: number;
    readonly localizedSurfaceReview: number;
    readonly catalogSupportReview: number;
    readonly reviewedCollision: number;
    readonly scopeTargetReview: number;
  };
  readonly ownerDispatchQueue: {
    readonly packetCount: number;
    readonly familyCount: number;
    readonly rowCount: number;
  };
  readonly exactSafePendingFamilyRows: number;
}

export interface WritePlaneRemainingWork {
  readonly ownerDispatchPackets: number;
  readonly ownerDispatchFamilies: number;
  readonly ownerDispatchRows: number;
  readonly exactSafePendingFamilyRows: number;
}

export interface WritePlane {
  readonly generatedAt?: string;
  readonly coverageResidue?: WritePlaneCoverageResidue;
  readonly draft?: WritePlaneDraftSummary;
  readonly operationalResidue?: WritePlaneOperationalResidue;
  readonly exactSafe?: Record<string, unknown>;
  readonly policy?: Record<string, unknown>;
  readonly manualTarget?: Record<string, unknown>;
  readonly scopeSupport?: Record<string, unknown>;
  readonly reviewedCollision?: Record<string, unknown>;
  readonly remainingWork?: WritePlaneRemainingWork;
}

export interface GoldRow {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly producer: string;
  readonly region?: string;
  readonly appellation?: string;
  readonly vintageYear: number;
  readonly koreanAliases: readonly string[];
}

// Per-family runtime descriptor evidence (from owner-evidence artifacts).
export interface OwnerEvidence {
  readonly family: string;
  readonly runtimeEvidenceStatus?: string;
  readonly gapReasonSignature?: string;
  readonly surfaces?: readonly string[];
  readonly availableVintages?: readonly number[];
  readonly availableLineKeys?: readonly string[];
  readonly availableRegionKeys?: readonly string[];
  readonly entityIds?: readonly string[];
  readonly entityLabels?: readonly string[];
}

export interface Dataset {
  readonly coverage?: CoverageReport;
  readonly writePlane?: WritePlane;
  readonly authority: readonly AuthorityRow[];
  readonly gold: readonly GoldRow[];
  readonly ownerEvidence: readonly OwnerEvidence[];
  readonly loadedAt: string;
  readonly errors: readonly string[];
}

// Residue gap-reason buckets the queue groups by.
export type GapBucket =
  | 'scope_target_missing'
  | 'strict_collision_ambiguous'
  | 'requested_vintage_missing'
  | 'runtime_family_missing'
  | 'family_surface_gap'
  | 'recall_only_no_match'
  | 'other';

export interface ResidueItem {
  readonly hole: CoverageHole;
  readonly bucket: GapBucket;
  readonly authorityClass: AuthorityClass | 'runtime_catalog_backfill';
  readonly evidenceBased: boolean; // true = evidence sufficient to auto-suggest; false = needs human review
  readonly rationale: string;
  readonly evidence: OwnerEvidence | undefined;
}
