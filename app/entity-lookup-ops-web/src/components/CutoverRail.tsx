import { useEffect, useState } from 'react';
import { Card, Stat, Bars, Copy, Intro } from './ui';
import { RAILS } from '../lib/rails';
import { koReason } from '../lib/labels';
import { backendReachable, coverageHealth, type CoverageHealth } from '../lib/api';
import type { Dataset, ResidueItem } from '../types';

export function CutoverRail({ ds, residue }: { ds: Dataset; residue: readonly ResidueItem[] }) {
  const cov = ds.coverage;
  const op = ds.writePlane?.operationalResidue;
  const pct = cov ? Math.round(cov.coverageRate * 1000) / 10 : 0;
  const [pending, setPending] = useState<number | null>(null);
  const [awaitingMaterialization, setAwaitingMaterialization] = useState<number | null>(null);
  const [legacyAbbrevBacklog, setLegacyAbbrevBacklog] = useState<number | null>(null);
  const [lookupRuntime, setLookupRuntime] = useState<CoverageHealth['lookup_runtime'] | null>(null);
  useEffect(() => {
    void backendReachable().then((l) => {
      if (l) {
        void coverageHealth().then((h) => {
          setPending(h.queue_by_status.pending);
          setAwaitingMaterialization(h.published_awaiting_materialization);
          setLegacyAbbrevBacklog(h.legacy_approved_abbreviation_backlog);
          setLookupRuntime(h.lookup_runtime ?? null);
        }).catch(() => undefined);
      }
    });
  }, []);
  const buckets = (Object.entries(cov?.bucketCounts ?? {}).sort((a, b) => b[1] - a[1]) as [string, number][]).map(
    ([k, v]) => [koReason(k), v] as [string, number],
  );
  const manualBreakdown = Object.entries(op?.manualReviewBreakdown ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => [manualResidueLabel(key), count] as [string, number]);
  const remainingReview = op?.manualReviewRows ?? residue.length;
  const structurallyClosed = op?.structurallyClosedRows ?? 0;
  const structurallyClosedPct = op?.structurallyClosedPercent ?? 0;
  const dispatchRows = op?.ownerDispatchQueue.rowCount ?? ds.writePlane?.remainingWork?.ownerDispatchRows ?? 0;
  const exactSafePending = op?.exactSafePendingFamilyRows ?? ds.writePlane?.remainingWork?.exactSafePendingFamilyRows ?? 0;

  return (
    <>
      <Intro title="🏠 지금 검색이 얼마나 잘 되나요?">
        손님이 입력한 와인 검색어를 시스템이 <b>올바른 와인으로 연결하는 비율</b>입니다. 아직 못 고친 검색어가 있으면 「고칠 검색어」에서 하나씩 처리하면 됩니다.
      </Intro>

      <div className="grid cols-4">
        <Stat
          k="검색 정확도"
          v={<>{pct}%</>}
          sub={cov ? `유명 와인 ${cov.hotEntityCount}개 중 ${cov.coveredCount}개를 제대로 연결` : '—'}
          tone={pct >= 95 ? 'green' : pct >= 85 ? 'amber' : 'red'}
        />
        <Stat
          k="구조 종료"
          v={op ? `${structurallyClosed}/${op.draftRows}` : '—'}
          sub={op ? `auto-targetable + reviewed-rejected (${structurallyClosedPct}%)` : 'write-plane summary 없음'}
          tone={!op ? undefined : op.manualReviewRows === 0 ? 'green' : 'amber'}
        />
        <Stat
          k="사람 검토"
          v={remainingReview}
          sub={op ? `dispatch ${dispatchRows}행 · exact-safe pending ${exactSafePending}` : '잔여 큐 기준'}
          tone={remainingReview === 0 ? 'green' : remainingReview <= 5 ? 'amber' : 'red'}
        />
        <Stat
          k="정책상 종료"
          v={op?.terminalReviewedRows ?? ds.writePlane?.draft?.reviewedRejected ?? 0}
          sub={`authority rows ${ds.authority.length}개`}
          tone={(op?.terminalReviewedRows ?? ds.writePlane?.draft?.reviewedRejected ?? 0) > 0 ? 'amber' : undefined}
        />
      </div>

      {remainingReview > 0 && (
        <button className="btn primary cta" onClick={() => { window.location.hash = '#/residue'; }}>
          🔧 사람 검토 {remainingReview}건 처리하러 가기 →
        </button>
      )}

      {pending != null && pending > 0 && (
        <button className="btn cta" onClick={() => { window.location.hash = '#/authority'; }}>
          ✏️ 저장한 결정 {pending}건이 발행 대기 중 — 처리하러 가기 →
        </button>
      )}

      {awaitingMaterialization != null && awaitingMaterialization > 0 && (
        <button className="btn cta" onClick={() => { window.location.hash = '#/authority'; }}>
          📦 발행됐지만 검색 반영 대기 {awaitingMaterialization}건 — 스냅샷 배포 필요
        </button>
      )}

      {legacyAbbrevBacklog != null && legacyAbbrevBacklog > 0 && (
        <button className="btn cta" onClick={() => { window.location.hash = '#/authority'; }}>
          🔤 legacy approved 약어 {legacyAbbrevBacklog}건 — publish 후 스냅샷 재배포 필요
        </button>
      )}

      {lookupRuntime != null && lookupRuntime.family_graph_edge_count === 0 && (
        <button className="btn cta" type="button">
          🕸 family graph edge 0 — family_graph 채널 dormant (스냅샷 scope graph 확인)
        </button>
      )}

      {lookupRuntime != null && lookupRuntime.unwired_substrate_ids.length > 0 && (
        <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
          미배선 substrate: {lookupRuntime.unwired_substrate_ids.join(', ')}
          {lookupRuntime.search_snapshot_id != null
            ? ` · snapshot ${lookupRuntime.search_snapshot_id}`
            : ''}
        </p>
      )}

      <Card title="안 되는 이유" desc="무엇 때문에 못 연결됐는지">
        {buckets.length ? <Bars data={buckets} /> : <div className="muted">없음 — 전부 잘 연결됨 ✓</div>}
      </Card>

      {op && (
        <Card title="운영 residue" desc="구조 자동화로 닫힌 행과 최종 사람 검토 lane 분리">
          <div className="grid cols-2">
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>최종 검토가 필요한 lane</div>
              {manualBreakdown.length
                ? <Bars data={manualBreakdown} total={Math.max(1, op.manualReviewRows)} />
                : <div className="muted">없음 — 운영자가 직접 판정할 잔여 lane이 비었다.</div>}
            </div>
            <div className="evidence-grid">
              <div className="k">auto-targetable</div>
              <div>{op.autoTargetableRows}</div>
              <div className="k">terminal reject</div>
              <div>{op.terminalReviewedRows}</div>
              <div className="k">owner dispatch</div>
              <div>{op.ownerDispatchQueue.packetCount} packet / {op.ownerDispatchQueue.rowCount} row</div>
              <div className="k">exact-safe pending</div>
              <div>{op.exactSafePendingFamilyRows} family row</div>
            </div>
          </div>
        </Card>
      )}

      <details className="dev-fold">
        <summary>🛠 개발자용 · 배포 명령 (운영자는 안 봐도 됩니다)</summary>
        <div className="dev-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            변경한 결정을 실제 서비스에 반영하려면 개발자가 아래 명령을 터미널에서 실행합니다. 전부 통과해야 배포됩니다.
          </p>
          <table className="tbl">
            <thead>
              <tr><th>검사</th><th>무엇을 확인하나</th><th>명령</th><th></th></tr>
            </thead>
            <tbody>
              {RAILS.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap"><strong>{r.label}</strong></td>
                  <td className="muted kr" style={{ maxWidth: 320 }}>{r.proves}</td>
                  <td><code className="mono" style={{ fontSize: 11 }}>{r.command}</code></td>
                  <td className="right"><Copy text={r.command} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function manualResidueLabel(key: string): string {
  switch (key) {
    case 'scopePolicyReview':
      return '정책 검토';
    case 'localizedSurfaceReview':
      return '지역화 표면';
    case 'catalogSupportReview':
      return '카탈로그 지원';
    case 'reviewedCollision':
      return '충돌 검토';
    case 'scopeTargetReview':
      return '스코프 타깃';
    default:
      return key;
  }
}
