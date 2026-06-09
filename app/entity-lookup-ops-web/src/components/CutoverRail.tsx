import { Card, Stat, Bars, Pill, Copy } from './ui';
import { RAILS } from '../lib/rails';
import type { Dataset, ResidueItem } from '../types';

function n(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function CutoverRail({ ds, residue }: { ds: Dataset; residue: readonly ResidueItem[] }) {
  const cov = ds.coverage;
  const pct = cov ? Math.round(cov.coverageRate * 1000) / 10 : 0;
  const rw = (ds.writePlane?.remainingWork ?? {}) as Record<string, unknown>;
  const rb = (rw.runtimeBackfill ?? {}) as Record<string, unknown>;
  const buckets = Object.entries(cov?.bucketCounts ?? {}).sort((a, b) => b[1] - a[1]) as [string, number][];

  const remaining: [string, number | undefined][] = [
    ['owner-dispatch 패킷', n(rw.ownerDispatchPackets)],
    ['owner-dispatch 패밀리', n(rw.ownerDispatchFamilies)],
    ['exact-safe 보류 패밀리', n(rw.exactSafePendingFamilyRows)],
    ['runtime backfill 패밀리', n(rb.familyCount)],
    ['manual-target 충돌', n(rw.manualTargetCollision)],
    ['reviewed-collision scope', n(rw.reviewedCollisionScope)],
  ];

  return (
    <>
      <div className="grid cols-4">
        <Stat k="커버리지 (entity-no-policy)" v={<>{pct}%</>} sub={cov ? `${cov.coveredCount}/${cov.hotEntityCount} hot entity` : '—'} tone={pct >= 95 ? 'green' : pct >= 85 ? 'amber' : 'red'} />
        <Stat k="잔여 (미해소 hole)" v={residue.length} sub={`${Object.keys(cov?.bucketCounts ?? {}).length}개 bucket`} tone={residue.length === 0 ? 'green' : 'amber'} />
        <Stat k="리뷰된 authority row" v={ds.authority.length} sub="7개 class 합계" />
        <Stat k="활성 스냅샷" v={<span className="mono" style={{ fontSize: 13 }}>{cov?.snapshotId?.replace('search-snapshot:v1:', '') ?? '—'}</span>} sub={cov?.generatedAt ? new Date(cov.generatedAt).toLocaleString('ko-KR') : ''} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title="Gap bucket별 잔여" desc="coverage 기준">
          {buckets.length ? <Bars data={buckets} /> : <div className="muted">잔여 없음 — 전부 해소됨 ✓</div>}
        </Card>
        <Card title="남은 구조 작업" desc="write-plane · remainingWork">
          <div className="bars">
            {remaining.map(([k, v]) => (
              <div className="barrow" key={k} style={{ gridTemplateColumns: '1fr 44px' }}>
                <span className="lbl" style={{ fontFamily: 'var(--sans)', fontSize: 13 }}>{k}</span>
                <span className="n" style={{ color: v ? 'var(--amber)' : 'var(--green)' }}>{v ?? 0}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="section-title">Publish / Verify 레일</div>
      <Card desc="CSR 콘솔은 실행 불가 — 명령 + 증명 대상만 추적 (운영자가 실행 후 결과 sync)">
        <table className="tbl">
          <thead>
            <tr><th>레일</th><th>증명 대상</th><th>명령</th><th></th></tr>
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
      </Card>

      <div style={{ marginTop: 14 }}>
        <Pill tone="blue">order</Pill>{' '}
        <span className="muted" style={{ fontSize: 12 }}>
          residue 결정 → registry apply → publish → coverage/write-plane refresh → authority/parity/cutover gate → verify pointer parity
        </span>
      </div>
    </>
  );
}
