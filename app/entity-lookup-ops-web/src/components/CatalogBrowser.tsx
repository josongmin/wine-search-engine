import { useEffect, useState } from 'react';
import { Card, Intro, Pill, Empty } from './ui';
import { WineAdd } from './WineAdd';
import { backendReachable, searchCatalog, aliasAudit, type Candidate, type AliasAudit } from '../lib/api';
import type { Dataset } from '../types';

export function CatalogBrowser({ ds }: { ds: Dataset }) {
  const [live, setLive] = useState<boolean | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState('');
  const [audit, setAudit] = useState<AliasAudit | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    void backendReachable().then(setLive);
  }, []);

  const offlineSearch = (query: string): Candidate[] => {
    const n = query.trim().toLowerCase();
    if (!n) return [];
    return ds.gold
      .filter((g) => `${g.canonicalLabel} ${g.producer} ${g.koreanAliases.join(' ')}`.toLowerCase().includes(n))
      .slice(0, 30)
      .map((g) => ({ entityId: g.entityId, label: g.canonicalLabel }));
  };

  const doSearch = async () => {
    setBusy(true);
    setErr('');
    setOpenId('');
    setAudit(null);
    try {
      const r = live ? await searchCatalog(q, 25) : offlineSearch(q);
      setResults(r);
      if (!r.length) setErr('검색 결과가 없어요.');
    } catch (e) {
      setErr(`검색 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openWine = async (id: string) => {
    if (openId === id) {
      setOpenId('');
      return;
    }
    setOpenId(id);
    setAudit(null);
    if (live) {
      try {
        setAudit(await aliasAudit(id));
      } catch {
        /* ignore */
      }
    }
  };

  return (
    <>
      <Intro title="📚 우리가 관리하는 와인 카탈로그">
        실제로 검색에 잡히는 와인들입니다. 이름으로 검색해서 어떤 와인이 있는지, 각 와인에 <b>어떤 검색어(별칭)가 연결돼 있는지</b> 확인하세요.
        {live === false && (
          <div style={{ marginTop: 6 }} className="muted">
            ※ 지금은 서버(백엔드)가 꺼져 있어 <b>유명 와인 {ds.gold.length}개</b>만 검색됩니다(오프라인). 전체 카탈로그(수천 개)는 백엔드를 켜야 검색돼요.
          </div>
        )}
      </Intro>

      <WineAdd />

      <div className="toolbar">
        <input
          className="search-box"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
          placeholder="와인 이름으로 검색… (예: 페트뤼스, Opus One, 보르도)"
        />
        <button className="btn primary" onClick={() => void doSearch()} disabled={busy || !q.trim()}>{busy ? '검색 중…' : '검색'}</button>
        {live !== null && <Pill tone={live ? 'green' : 'gray'}>{live ? '전체 카탈로그 (라이브)' : `유명 와인만 (오프라인 ${ds.gold.length})`}</Pill>}
      </div>

      {err && <div className="muted" style={{ fontSize: 13 }}>{err}</div>}

      {results.length > 0 ? (
        <Card desc={`${results.length}개 결과`}>
          <div className="cand-list">
            {results.map((r) => (
              <div key={r.entityId}>
                <div className="cand" style={{ cursor: 'pointer' }} onClick={() => void openWine(r.entityId)}>
                  <span className="cand-label kr">{r.label}</span>
                  <span className="cand-id mono">{r.entityId}</span>
                  <span className="go" style={{ marginLeft: 10 }}>{openId === r.entityId ? '▾' : '▸'} 연결된 검색어</span>
                </div>
                {openId === r.entityId && (
                  <div style={{ padding: '8px 14px 4px', fontSize: 13 }}>
                    {!live ? (
                      <span className="faint">연결된 검색어 보기는 백엔드가 필요해요.</span>
                    ) : audit ? (
                      audit.aliases.length ? (
                        <div className="kr">
                          {audit.aliases.map((a) => (
                            <span key={a.alias_id} className="pill gray" style={{ marginRight: 6, marginBottom: 6 }}>{a.surface_form}</span>
                          ))}
                        </div>
                      ) : (
                        <span className="faint">아직 연결된 검색어(별칭)가 없어요.</span>
                      )
                    ) : (
                      <span className="faint">불러오는 중…</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      ) : (
        !err && !busy && <Empty title="와인을 검색해 보세요" hint="이름 일부만 입력해도 됩니다." />
      )}
    </>
  );
}
