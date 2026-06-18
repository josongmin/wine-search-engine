import { useEffect, useState } from 'react';
import { Card, Intro, Empty } from './ui';
import { backendReachable, searchCatalog, hybridSearch, type Candidate, type SearchHit } from '../lib/api';

export function QueryDebug() {
  const [live, setLive] = useState<boolean | null>(null);
  const [q, setQ] = useState('');
  const [ents, setEnts] = useState<Candidate[] | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    void backendReachable().then(setLive);
  }, []);

  const run = async () => {
    setBusy(true);
    setErr('');
    setEnts(null);
    setHits(null);
    const [e, h] = await Promise.allSettled([searchCatalog(q, 8), hybridSearch(q)]);
    if (e.status === 'fulfilled') setEnts(e.value);
    if (h.status === 'fulfilled') setHits(h.value.hits);
    if (e.status === 'rejected' && h.status === 'rejected') setErr('검색 실패 — 백엔드 상태를 확인하세요.');
    setBusy(false);
  };

  if (live === false) {
    return (
      <>
        <Intro title="🐞 쿼리 디버그">손님 검색어를 직접 넣어 결과를 확인하는 곳입니다.</Intro>
        <Card>
          <div className="banner">백엔드가 꺼져 있어 검색을 실행할 수 없어요. 개발자가 백엔드를 켜면 여기서 실제 검색 결과를 볼 수 있습니다.</div>
        </Card>
      </>
    );
  }
  return (
    <>
      <Intro title="🐞 쿼리 디버그 — 손님 검색어로 실제 결과 보기">
        손님이 칠 법한 검색어를 넣고 <b>실행</b>하면, (1) 그 말을 어떤 와인으로 <b>인식</b>하는지와 (2) 실제 <b>검색 결과</b> 목록을 함께 보여줍니다. “왜 이게 안 나오지?”를 눈으로 확인하는 곳.
      </Intro>

      <div className="toolbar">
        <input
          className="search-box"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
          placeholder="검색어 입력… (예: 페트뤼스, 5만원대 부드러운 레드)"
        />
        <button className="btn primary" onClick={() => void run()} disabled={busy || !q.trim()}>{busy ? '실행 중…' : '실행'}</button>
      </div>
      {err && <div className="muted" style={{ fontSize: 13 }}>{err}</div>}

      {ents && (
        <Card title="① 검색어 인식 (어떤 와인으로 보는가)" desc="entity 연결">
          {ents.length ? (
            <div className="cand-list">
              {ents.map((c, i) => (
                <div key={c.entityId} className="cand">
                  <span className="cand-label kr">{i === 0 ? '⭐ ' : ''}{c.label}</span>
                  <span className="cand-id mono">{c.entityId}{c.score != null ? ` · ${c.score.toFixed(3)}` : ''}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="faint">인식된 와인이 없어요 (검색어 매핑이 필요할 수 있음).</span>
          )}
        </Card>
      )}

      {hits && (
        <Card title="② 검색 결과 (하이브리드)" desc={`${hits.length}건`}>
          {hits.length ? (
            <table className="tbl">
              <thead><tr><th>#</th><th>와인</th><th>지역</th><th>점수</th></tr></thead>
              <tbody>
                {hits.map((h, i) => (
                  <tr key={i}>
                    <td className="muted">{i + 1}</td>
                    <td className="kr"><strong>{h.label}</strong></td>
                    <td className="muted">{h.region ?? '—'}</td>
                    <td className="mono">{typeof h.score === 'number' ? h.score.toFixed(3) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <span className="faint">검색 결과가 없어요.</span>
          )}
        </Card>
      )}

      {!ents && !hits && !busy && <Empty title="검색어를 넣고 실행해 보세요" hint="손님이 실제로 칠 법한 말로 테스트하면 좋아요." />}
    </>
  );
}
