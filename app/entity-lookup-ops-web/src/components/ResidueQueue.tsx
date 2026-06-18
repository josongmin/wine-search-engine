import { useMemo, useState } from 'react';
import { Card, Pill, Empty, Intro } from './ui';
import { GAP_LABEL, groupByBucket } from '../lib/residue';
import { koReason } from '../lib/labels';
import type { GapBucket, ResidueItem } from '../types';

export function ResidueQueue({ residue, onOpen }: { residue: readonly ResidueItem[]; onOpen: (i: ResidueItem) => void }) {
  const [bucket, setBucket] = useState<GapBucket | 'all'>('all');
  const grouped = useMemo(() => groupByBucket(residue), [residue]);
  const buckets = [...grouped.keys()].sort((a, b) => grouped.get(b)!.length - grouped.get(a)!.length);
  const items = bucket === 'all' ? residue : grouped.get(bucket) ?? [];

  if (residue.length === 0) return <Empty title="고칠 검색어가 없어요 ✓" hint="모든 유명 와인 검색어가 잘 연결됩니다." />;

  return (
    <>
      <Intro title="🔧 아직 잘 안 되는 검색어들 — 여기서 고칩니다">
        손님이 입력할 만한데 시스템이 올바른 와인으로 <b>못 연결한 검색어</b> 목록입니다. <b>아무 줄이나 누르면</b> 그 검색어를 어떤 와인에 연결할지 정하는 화면이 열립니다.
      </Intro>

      <div className="toolbar">
        <div className="seg">
          <button className={bucket === 'all' ? 'active' : ''} onClick={() => setBucket('all')}>전체 {residue.length}</button>
          {buckets.map((b) => (
            <button key={b} className={bucket === b ? 'active' : ''} onClick={() => setBucket(b)}>
              {GAP_LABEL[b]} {grouped.get(b)!.length}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <table className="tbl">
          <thead>
            <tr><th>검색어</th><th>어느 와인?</th><th>왜 안 되나</th><th>상태</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.hole.surface + i} className="clickable" onClick={() => onOpen(it)}>
                <td className="kr"><strong>{it.hole.surface}</strong></td>
                <td className="muted">{it.hole.family ?? '—'}</td>
                <td className="kr">{koReason(it.hole.reasonCode ?? it.hole.bucket)}</td>
                <td>{it.evidenceBased ? <Pill tone="green">자동 추천 가능</Pill> : <Pill tone="gray">사람이 확인</Pill>}</td>
                <td className="right"><span className="go">고치기 →</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
