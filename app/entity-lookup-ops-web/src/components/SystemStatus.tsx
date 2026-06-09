import { useEffect, useState } from 'react';
import { Card, Intro, Pill } from './ui';
import { fetchReady } from '../lib/api';

type Ready = { ok: boolean; status: number; body: unknown };

export function SystemStatus() {
  const [r, setR] = useState<Ready | null>(null);
  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true);
    void fetchReady().then((x) => {
      setR(x);
      setLoading(false);
    });
  };
  useEffect(load, []);

  const body = (r?.body ?? {}) as Record<string, unknown>;
  const compsRaw = (body.components ?? body.checks ?? body.dependencies ?? body.snapshot_health ?? {}) as Record<string, unknown>;
  const comps = Object.entries(compsRaw).filter(([, v]) => typeof v !== 'function');

  const statusOf = (v: unknown): { text: string; ok: boolean } => {
    const s =
      typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number'
        ? String(v)
        : String((v as Record<string, unknown>)?.status ?? (v as Record<string, unknown>)?.state ?? 'unknown');
    return { text: s, ok: /ok|up|healthy|ready|pass|true|green/i.test(s) };
  };

  return (
    <>
      <Intro title="💓 시스템 상태">
        검색 엔진과 그 의존 서비스(데이터베이스 · 검색 색인 등)가 정상인지 한눈에 봅니다. <b>빨강</b>이 있으면 개발자에게 알리세요.
      </Intro>

      <Card title="전체 상태" right={<button className="btn sm" onClick={load}>↻ 다시 확인</button>}>
        {loading ? (
          <span className="muted">확인 중…</span>
        ) : r?.status === 0 ? (
          <Pill tone="red"><span className="dot red" /> 백엔드 응답 없음 (서버 꺼짐)</Pill>
        ) : (
          <Pill tone={r?.ok ? 'green' : 'red'}>
            <span className={`dot ${r?.ok ? 'green' : 'red'}`} /> {r?.ok ? '정상 (서비스 가능)' : `비정상 (HTTP ${r?.status})`}
          </Pill>
        )}
      </Card>

      {comps.length > 0 && (
        <Card title="구성요소">
          <table className="tbl">
            <thead><tr><th>구성요소</th><th>상태</th></tr></thead>
            <tbody>
              {comps.map(([k, v]) => {
                const st = statusOf(v);
                return (
                  <tr key={k}>
                    <td className="kr">{k}</td>
                    <td><Pill tone={st.ok ? 'green' : 'amber'}>{st.text}</Pill></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {!loading && r && r.status !== 0 && comps.length === 0 && (
        <Card title="원시 응답">
          <pre className="code light">{JSON.stringify(r.body, null, 2).slice(0, 2500)}</pre>
        </Card>
      )}
    </>
  );
}
