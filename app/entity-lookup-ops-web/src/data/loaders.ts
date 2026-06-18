import type {
  AuthorityRow,
  CoverageHole,
  CoverageReport,
  Dataset,
  GoldRow,
  OwnerEvidence,
  WritePlane,
  WritePlaneCoverageResidue,
  WritePlaneDraftSummary,
  WritePlaneOperationalResidue,
  WritePlaneRemainingWork,
} from '../types';

const BASE = `${import.meta.env.BASE_URL}data`;

async function fetchText(name: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/${name}`, { cache: 'no-store' });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function parseJsonl(text: string | null): Record<string, unknown>[] {
  if (!text) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function collectHoles(root: unknown): CoverageHole[] {
  const seen = new Set<string>();
  const out: CoverageHole[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(visit);
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      const surface = str(o.surfaceForm) ?? str(o.query);
      const status = str(o.observedStatus);
      const bucket = str(o.operatorBucket);
      if (surface && (status || bucket) && !seen.has(surface)) {
        seen.add(surface);
        out.push({
          surface,
          family: str(o.benchmarkGoldHint) ?? str(o.expectedEntityHint),
          bucket,
          status,
          reasonCode: str(o.observedReasonCode),
          holeClass: str(o.holeClass),
          reason: str(o.reason),
        });
      }
      Object.values(o).forEach(visit);
    }
  };
  visit(root);
  return out;
}

function countBy(items: readonly CoverageHole[], key: (h: CoverageHole) => string | undefined): Record<string, number> {
  const m: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    if (k) m[k] = (m[k] ?? 0) + 1;
  }
  return m;
}

function parseCoverage(text: string | null): CoverageReport | undefined {
  if (!text) return undefined;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const report = (j.report ?? j) as Record<string, unknown>;
  const holes = collectHoles(report.holes ?? report).filter((h) => h.status !== 'resolved');
  const hot = Number(report.hotEntityCount ?? 0);
  const covered = Number(report.coveredCount ?? Math.max(0, hot - holes.length));
  const runtime = (j.runtime ?? {}) as Record<string, unknown>;
  return {
    snapshotId: str(runtime.snapshotId),
    generatedAt: str(j.generatedAt),
    gitSha: str(j.gitSha),
    hotEntityCount: hot,
    coveredCount: covered,
    coverageRate: typeof report.coverageRate === 'number' ? (report.coverageRate as number) : hot ? covered / hot : 0,
    holes,
    bucketCounts: countBy(holes, (h) => h.bucket),
    reasonCounts: countBy(holes, (h) => h.reasonCode),
  };
}

function parseWritePlane(text: string | null): WritePlane | undefined {
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const coverageResidue = parseWritePlaneCoverageResidue(j.coverageResidue);
    const draft = parseWritePlaneDraft(j.draft);
    const remainingWork = parseWritePlaneRemainingWork(j.remainingWork);
    return {
      generatedAt: str(j.generatedAt),
      coverageResidue,
      draft,
      operationalResidue: parseWritePlaneOperationalResidue(j.operationalResidue, draft, remainingWork),
      exactSafe: j.exactSafe as Record<string, unknown> | undefined,
      policy: j.policy as Record<string, unknown> | undefined,
      manualTarget: j.manualTarget as Record<string, unknown> | undefined,
      scopeSupport: j.scopeSupport as Record<string, unknown> | undefined,
      reviewedCollision: j.reviewedCollision as Record<string, unknown> | undefined,
      remainingWork,
    };
  } catch {
    return undefined;
  }
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? v as Record<string, unknown> : undefined;
}

function parseNumberRecord(value: unknown): Record<string, number> {
  const root = record(value);
  if (!root) return {};
  return Object.fromEntries(
    Object.entries(root).filter(([, current]) => typeof current === 'number'),
  ) as Record<string, number>;
}

function parseWritePlaneCoverageResidue(value: unknown): WritePlaneCoverageResidue | undefined {
  const root = record(value);
  if (!root) return undefined;
  return {
    hotEntityCount: num(root.hotEntityCount) ?? 0,
    coveredCount: num(root.coveredCount) ?? 0,
    uncoveredCount: num(root.uncoveredCount) ?? 0,
    activeCoverageRatio: num(root.activeCoverageRatio) ?? 0,
    activeCoveragePercent: num(root.activeCoveragePercent) ?? 0,
    operatorBucketCounts: parseNumberRecord(root.operatorBucketCounts),
    observedReasonCodeCounts: parseNumberRecord(root.observedReasonCodeCounts),
  };
}

function parseWritePlaneDraft(value: unknown): WritePlaneDraftSummary | undefined {
  const root = record(value);
  if (!root) return undefined;
  return {
    rows: num(root.rows) ?? 0,
    autoTargetable: num(root.autoTargetable) ?? 0,
    scopePolicyReview: num(root.scopePolicyReview) ?? 0,
    localizedSurfaceReview: num(root.localizedSurfaceReview) ?? 0,
    reviewedRejected: num(root.reviewedRejected) ?? 0,
    catalogSupportReview: num(root.catalogSupportReview) ?? 0,
    reviewedCollision: num(root.reviewedCollision) ?? 0,
    scopeTargetReview: num(root.scopeTargetReview) ?? 0,
  };
}

function parseWritePlaneRemainingWork(value: unknown): WritePlaneRemainingWork | undefined {
  const root = record(value);
  if (!root) return undefined;
  return {
    ownerDispatchPackets: num(root.ownerDispatchPackets) ?? 0,
    ownerDispatchFamilies: num(root.ownerDispatchFamilies) ?? 0,
    ownerDispatchRows: num(root.ownerDispatchRows) ?? 0,
    exactSafePendingFamilyRows: num(root.exactSafePendingFamilyRows) ?? 0,
  };
}

function parseWritePlaneOperationalResidue(
  value: unknown,
  draft: WritePlaneDraftSummary | undefined,
  remainingWork: WritePlaneRemainingWork | undefined,
): WritePlaneOperationalResidue | undefined {
  const root = record(value);
  if (!root) return undefined;
  return {
    draftRows: num(root.draftRows) ?? draft?.rows ?? 0,
    structurallyClosedRows: num(root.structurallyClosedRows) ?? 0,
    structurallyClosedRatio: num(root.structurallyClosedRatio) ?? 0,
    structurallyClosedPercent: num(root.structurallyClosedPercent) ?? 0,
    terminalReviewedRows: num(root.terminalReviewedRows) ?? draft?.reviewedRejected ?? 0,
    autoTargetableRows: num(root.autoTargetableRows) ?? draft?.autoTargetable ?? 0,
    manualReviewRows: num(root.manualReviewRows) ?? 0,
    manualReviewBreakdown: {
      scopePolicyReview: num(record(root.manualReviewBreakdown)?.scopePolicyReview) ?? draft?.scopePolicyReview ?? 0,
      localizedSurfaceReview: num(record(root.manualReviewBreakdown)?.localizedSurfaceReview) ?? draft?.localizedSurfaceReview ?? 0,
      catalogSupportReview: num(record(root.manualReviewBreakdown)?.catalogSupportReview) ?? draft?.catalogSupportReview ?? 0,
      reviewedCollision: num(record(root.manualReviewBreakdown)?.reviewedCollision) ?? draft?.reviewedCollision ?? 0,
      scopeTargetReview: num(record(root.manualReviewBreakdown)?.scopeTargetReview) ?? draft?.scopeTargetReview ?? 0,
    },
    ownerDispatchQueue: {
      packetCount: num(record(root.ownerDispatchQueue)?.packetCount) ?? remainingWork?.ownerDispatchPackets ?? 0,
      familyCount: num(record(root.ownerDispatchQueue)?.familyCount) ?? remainingWork?.ownerDispatchFamilies ?? 0,
      rowCount: num(record(root.ownerDispatchQueue)?.rowCount) ?? remainingWork?.ownerDispatchRows ?? 0,
    },
    exactSafePendingFamilyRows:
      num(root.exactSafePendingFamilyRows) ?? remainingWork?.exactSafePendingFamilyRows ?? 0,
  };
}

function rows(text: string | null, map: (o: Record<string, unknown>) => AuthorityRow): AuthorityRow[] {
  return parseJsonl(text).map(map);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function arrStr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : undefined;
}
function arrNum(v: unknown): number[] | undefined {
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'number') as number[]) : undefined;
}

export async function loadDataset(): Promise<Dataset> {
  const errors: string[] = [];
  const [cov, wp, gold, owner, es, st, pol, coll, sup, loc, wit] = await Promise.all([
    fetchText('coverage.json'),
    fetchText('write-plane-summary.json'),
    fetchText('gold-catalog.jsonl'),
    fetchText('owner-evidence.jsonl'),
    fetchText('exact-safe-registry.jsonl'),
    fetchText('scope-target.jsonl'),
    fetchText('policy.jsonl'),
    fetchText('collision.jsonl'),
    fetchText('scope-support.jsonl'),
    fetchText('localized-surface.jsonl'),
    fetchText('family-core-witness.jsonl'),
  ]);

  if (!cov) errors.push('coverage.json 없음 — `pnpm run sync-data` 실행');
  if (!wp) errors.push('write-plane-summary.json 없음 — `pnpm run sync-data` 실행');

  const authority: AuthorityRow[] = [
    ...rows(es, (o) => ({ cls: 'exact_safe', key: String(o.surface ?? ''), entityId: str(o.entityId), status: str(o.promotionClass), locale: str(o.locale), reason: str(o.sourceEvidence), raw: o })),
    ...rows(st, (o) => ({ cls: 'scope_target', key: String(o.semanticScopeKey ?? ''), entityId: str(o.entityId), status: str(o.decisionStatus), family: str(o.benchmarkGoldHint) ?? str(o.familyKey), locale: str(o.locale), reviewedBy: str(o.reviewedBy), reason: str(o.decisionReason), evidenceClass: str(o.evidenceClass), raw: o })),
    ...rows(pol, (o) => ({ cls: 'policy', key: String(o.semanticConflictKey ?? ''), entityId: str(o.entityId), status: str(o.decision), reviewedBy: str(o.reviewedBy), reason: str(o.decisionReason), raw: o })),
    ...rows(coll, (o) => ({ cls: 'collision', key: String(o.benchmarkGoldHint ?? ''), status: str(o.collisionStatus), family: str(o.benchmarkGoldHint), reviewedBy: str(o.reviewedBy), reason: str(o.decisionReason), evidenceClass: str(o.evidenceClass), raw: o })),
    ...rows(sup, (o) => ({ cls: 'scope_support', key: String(o.semanticScopeKey ?? ''), status: str(o.supportStatus), reviewedBy: str(o.reviewedBy), reason: str(o.decisionReason), evidenceClass: str(o.evidenceClass), raw: o })),
    ...rows(loc, (o) => ({ cls: 'localized_surface', key: `${str(o.componentKey) ?? ''} · ${str(o.localSurface) ?? ''}`, status: str(o.decisionStatus), locale: str(o.locale), reviewedBy: str(o.reviewedBy), reason: str(o.decisionReason), evidenceClass: str(o.evidenceClass), raw: o })),
    ...rows(wit, (o) => ({ cls: 'family_core_witness', key: String(o.surface ?? ''), entityId: str(o.entityId), family: str(o.surface), reviewedBy: str(o.reviewedBy), reason: str(o.decisionReason), evidenceClass: str(o.evidenceClass), raw: o })),
  ];

  const goldRows: GoldRow[] = parseJsonl(gold).map((o) => ({
    entityId: String(o.entityId ?? ''),
    canonicalLabel: String(o.canonicalLabel ?? ''),
    producer: String(o.producer ?? ''),
    region: str(o.region),
    appellation: str(o.appellation),
    vintageYear: Number(o.vintageYear ?? 0),
    koreanAliases: arrStr(o.koreanAliases) ?? [],
  }));

  const ownerEvidence: OwnerEvidence[] = parseJsonl(owner).map((o) => ({
    family: str(o.benchmarkGoldHint) ?? str(o.normalizedBenchmarkGoldHint) ?? '',
    runtimeEvidenceStatus: str(o.runtimeEvidenceStatus),
    gapReasonSignature: str(o.runtimeGapReasonSignature),
    surfaces: arrStr(o.surfaces),
    availableVintages: arrNum(o.runtimeGapAvailableVintages),
    availableLineKeys: arrStr(o.runtimeGapAvailableLineKeys),
    availableRegionKeys: arrStr(o.runtimeGapAvailableRegionKeys),
    entityIds: arrStr(o.runtimeGapEntityIds),
    entityLabels: arrStr(o.runtimeGapEntityLabels),
  }));

  return {
    coverage: parseCoverage(cov),
    writePlane: parseWritePlane(wp),
    authority,
    gold: goldRows,
    ownerEvidence,
    loadedAt: new Date().toISOString(),
    errors,
  };
}

export { num };
