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
    label: 'Exact-safe',
    file: 'korean-exact-safe-registry-v1.jsonl',
    note: 'collision-free singleton surface → entity. 리졸버가 vintageCanonicalized로 family-selection 전에 매칭.',
  },
  scope_target: {
    label: 'Scope target',
    file: 'lookup-semantic-scope-target-registry-v1.jsonl',
    note: 'family/line/vintage scope → reviewed target entity. localized surface auto-sync의 source.',
  },
  policy: {
    label: 'Policy',
    file: 'lookup-semantic-policy-registry-v1.jsonl',
    note: 'semantic conflict → keep_ambiguous / promote_exact_safe / needs_scope_target.',
  },
  collision: {
    label: 'Family collision',
    file: 'lookup-family-collision-registry-v1.jsonl',
    note: 'family surface 충돌 상태(reviewed).',
  },
  scope_support: {
    label: 'Scope support',
    file: 'lookup-semantic-scope-support-registry-v1.jsonl',
    note: 'scope의 catalog/runtime support 상태.',
  },
  localized_surface: {
    label: 'Localized surface',
    file: 'lookup-localized-scope-surface-registry-v1.jsonl',
    note: 'component(localized) surface — approved scope target에서 auto-sync 가능(수동 전용 아님).',
  },
  family_core_witness: {
    label: 'Family-core witness',
    file: 'lookup-family-core-witness-registry-v1.jsonl',
    note: 'evidence-only overlay: surface→entity를 family owner set에 노출(authority 승격 아님).',
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

export interface WritePlane {
  readonly generatedAt?: string;
  readonly coverageResidue?: Record<string, unknown>;
  readonly draft?: Record<string, number>;
  readonly exactSafe?: Record<string, unknown>;
  readonly policy?: Record<string, unknown>;
  readonly manualTarget?: Record<string, unknown>;
  readonly scopeSupport?: Record<string, unknown>;
  readonly reviewedCollision?: Record<string, unknown>;
  readonly remainingWork?: Record<string, unknown>;
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
