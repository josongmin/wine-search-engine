import { useMemo, useState } from 'react';
import { Card, Pill, Empty } from './ui';
import { AUTHORITY_CLASSES, AUTHORITY_META, type AuthorityClass, type Dataset } from '../types';

function statusTone(s?: string): 'green' | 'amber' | 'red' | 'gray' {
  if (!s) return 'gray';
  if (/approv|exact_safe|compact_exact|promote|assign|resolved/i.test(s)) return 'green';
  if (/pending|review|needs|ambig|keep/i.test(s)) return 'amber';
  if (/reject|conflict|blocked/i.test(s)) return 'red';
  return 'gray';
}

export function AuthorityWorkbench({ ds }: { ds: Dataset }) {
  const counts = useMemo(() => {
    const m = new Map<AuthorityClass, number>();
    for (const r of ds.authority) m.set(r.cls, (m.get(r.cls) ?? 0) + 1);
    return m;
  }, [ds]);
  const [cls, setCls] = useState<AuthorityClass>('exact_safe');
  const [q, setQ] = useState('');
  const rows = useMemo(
    () => ds.authority.filter((r) => r.cls === cls && (!q || (r.key + (r.entityId ?? '') + (r.family ?? '')).toLowerCase().includes(q.toLowerCase()))),
    [ds, cls, q],
  );
  const meta = AUTHORITY_META[cls];

  return (
    <>
      <div className="grid cols-4" style={{ gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, marginBottom: 16 }}>
        {AUTHORITY_CLASSES.map((c) => (
          <button key={c} className="card stat" style={{ textAlign: 'left', cursor: 'pointer', border: cls === c ? '1px solid var(--accent)' : undefined, padding: '12px 14px' }} onClick={() => setCls(c)}>
            <div className="k" style={{ fontSize: 11 }}>{AUTHORITY_META[c].label}</div>
            <div className="v" style={{ fontSize: 22, color: cls === c ? 'var(--accent)' : undefined }}>{counts.get(c) ?? 0}</div>
          </button>
        ))}
      </div>

      <Card
        title={meta.label}
        desc={meta.file}
        right={<input className="btn" style={{ width: 200, fontWeight: 400 }} placeholder="필터…" value={q} onChange={(e) => setQ(e.target.value)} />}
      >
        <div className="muted kr" style={{ fontSize: 12, marginBottom: 12 }}>{meta.note}</div>
        {rows.length === 0 ? (
          <Empty title="행 없음" hint={<span className="mono">pnpm run sync-data</span>} />
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>키 / 표면</th><th>엔티티</th><th>상태</th><th>패밀리</th><th>리뷰어</th><th>사유</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, 400).map((r, i) => (
                <tr key={r.key + i}>
                  <td className="kr mono" style={{ fontSize: 12, maxWidth: 280 }}>{r.key}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.entityId ?? '—'}</td>
                  <td><Pill tone={statusTone(r.status)}>{r.status ?? '—'}</Pill></td>
                  <td className="muted mono">{r.family ?? '—'}</td>
                  <td className="muted">{r.reviewedBy ?? '—'}</td>
                  <td className="muted kr" style={{ maxWidth: 360, fontSize: 12 }}>{r.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.length > 400 && <div className="faint" style={{ marginTop: 8 }}>… {rows.length - 400}개 더 (필터로 좁히세요)</div>}
      </Card>
    </>
  );
}
