import { useEffect, useState } from 'react';
import { Card, Pill } from './ui';
import { backendReachable, listProposals, reviewProposal, publishProposal, type Proposal } from '../lib/api';
import { koStatus } from '../lib/labels';

// Live "saved decisions" inbox: approve → publish loop. Hidden when backend is offline.
export function ProposalsInbox() {
  const [live, setLive] = useState<boolean | null>(null);
  const [items, setItems] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => {
    void listProposals({ limit: 100 }).then(setItems).catch(() => undefined);
  };
  useEffect(() => {
    void backendReachable().then((l) => {
      setLive(l);
      if (l) load();
    });
  }, []);

  if (live !== true) return null;

  const act = async (p: Proposal, kind: 'approve' | 'publish' | 'reject') => {
    setBusy(p.proposal_id);
    setMsg('');
    try {
      if (kind === 'approve') await reviewProposal(p.proposal_id, p.kind, 'approve', 'ops-web 승인');
      else if (kind === 'reject') await reviewProposal(p.proposal_id, p.kind, 'reject', 'ops-web 반려');
      else await publishProposal(p.proposal_id, p.kind);
      setMsg('✓ 처리했어요.');
      load();
    } catch (e) {
      setMsg(`실패: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  const pending = items.filter((p) => p.status !== 'published' && p.status !== 'rejected');

  return (
    <Card
      title={`검토 대기 · 저장한 결정 (${pending.length})`}
      desc="저장한 검색어 연결을 승인 → 발행하면 검색에 반영"
      right={<button className="btn sm" onClick={load}>↻ 새로고침</button>}
    >
      {pending.length === 0 ? (
        <span className="faint">대기 중인 결정이 없어요. (「고칠 검색어」에서 연결을 저장하면 여기 나타납니다.)</span>
      ) : (
        <table className="tbl">
          <thead><tr><th>종류</th><th>표면 / 키</th><th>대상</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {pending.map((p) => (
              <tr key={p.proposal_id}>
                <td><Pill>{p.kind}</Pill></td>
                <td className="kr">
                  <strong>
                    {p.kind === 'ambiguity'
                      ? (p.normalized_form ?? '—')
                      : (p.surface_form ?? '—')}
                  </strong>
                </td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {p.kind === 'ambiguity'
                    ? (p.member_entity_ids?.join(', ') ?? '—')
                    : (p.target_entity_id ?? p.reason ?? '—')}
                </td>
                <td><Pill tone={p.status === 'approved' ? 'green' : 'amber'}>{koStatus(p.status)}</Pill></td>
                <td className="right nowrap">
                  {p.status === 'pending' && (
                    <>
                      <button className="btn sm" disabled={busy === p.proposal_id} onClick={() => void act(p, 'approve')}>승인</button>
                      <button className="btn sm danger" disabled={busy === p.proposal_id} onClick={() => void act(p, 'reject')}>반려</button>
                    </>
                  )}
                  {p.status === 'approved' && (
                    <button className="btn sm primary" disabled={busy === p.proposal_id} onClick={() => void act(p, 'publish')}>발행</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>{msg}</div>}
    </Card>
  );
}
