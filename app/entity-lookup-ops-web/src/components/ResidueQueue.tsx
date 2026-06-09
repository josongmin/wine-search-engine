import { useMemo, useState } from 'react';
import { Card, Pill, Empty } from './ui';
import { CLASS_LABEL, GAP_LABEL, groupByBucket } from '../lib/residue';
import type { GapBucket, ResidueItem } from '../types';

export function ResidueQueue({ residue, onOpen }: { residue: readonly ResidueItem[]; onOpen: (i: ResidueItem) => void }) {
  const [bucket, setBucket] = useState<GapBucket | 'all'>('all');
  const grouped = useMemo(() => groupByBucket(residue), [residue]);
  const buckets = [...grouped.keys()].sort((a, b) => (grouped.get(b)!.length - grouped.get(a)!.length));
  const items = bucket === 'all' ? residue : grouped.get(bucket) ?? [];

  if (residue.length === 0) return <Empty title="잔여 없음 ✓" hint="모든 hot-entity surface가 해소됨." />;

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="seg">
          <button className={bucket === 'all' ? 'active' : ''} onClick={() => setBucket('all')}>전체 · {residue.length}</button>
          {buckets.map((b) => (
            <button key={b} className={bucket === b ? 'active' : ''} onClick={() => setBucket(b)}>
              {GAP_LABEL[b]} · {grouped.get(b)!.length}
            </button>
          ))}
        </div>
      </div>

      <Card desc="각 hole → gap bucket → 닫을 authority class. 증거 충분 여부 표시. 행 클릭 → 증거·결정.">
        <table className="tbl">
          <thead>
            <tr><th>표면</th><th>패밀리</th><th>버킷</th><th>해소 경로</th><th>증거</th><th>사유 코드</th></tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.hole.surface + i} className="clickable" onClick={() => onOpen(it)}>
                <td className="kr"><strong>{it.hole.surface}</strong></td>
                <td className="muted mono">{it.hole.family ?? '—'}</td>
                <td><Pill tone={it.bucket === 'strict_collision_ambiguous' ? 'red' : 'amber'}>{GAP_LABEL[it.bucket]}</Pill></td>
                <td className="nowrap"><Pill tone="blue">{CLASS_LABEL[it.authorityClass]}</Pill></td>
                <td>{it.evidenceBased ? <Pill tone="green">증거 충분 ✓</Pill> : <Pill tone="gray">리뷰 필요</Pill>}</td>
                <td className="muted mono" style={{ fontSize: 11 }}>{it.hole.reasonCode ?? it.hole.bucket ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
