import { useEffect, useMemo, useState } from 'react';
import { loadDataset } from './data/loaders';
import { classifyResidue } from './lib/residue';
import { getOpsKeys, setOpsKeys, resetReachable } from './lib/api';
import type { Dataset, ResidueItem } from './types';
import { CutoverRail } from './components/CutoverRail';
import { ResidueQueue } from './components/ResidueQueue';
import { AuthorityWorkbench } from './components/AuthorityWorkbench';
import { EvidencePanel } from './components/EvidencePanel';
import { DriftIntake } from './components/DriftIntake';
import { CatalogBrowser } from './components/CatalogBrowser';
import { QueryDebug } from './components/QueryDebug';
import { SystemStatus } from './components/SystemStatus';

type Face = 'rail' | 'catalog' | 'residue' | 'authority' | 'evidence' | 'drift' | 'debug' | 'status';

const GROUPS = ['현황', '와인 관리', '검색어 매핑', '검색 품질', '시스템'] as const;

const FACES: { id: Face; label: string; ic: string; group: (typeof GROUPS)[number]; hidden?: boolean }[] = [
  { id: 'rail', label: '홈', ic: '🏠', group: '현황' },
  { id: 'catalog', label: '와인 카탈로그', ic: '📚', group: '와인 관리' },
  { id: 'residue', label: '고칠 검색어', ic: '🔧', group: '검색어 매핑' },
  { id: 'evidence', label: '검색어 처리', ic: '✏️', group: '검색어 매핑', hidden: true },
  { id: 'authority', label: '정해둔 규칙', ic: '📖', group: '검색어 매핑' },
  { id: 'drift', label: '새 검색어 점검', ic: '🔎', group: '검색어 매핑' },
  { id: 'debug', label: '쿼리 디버그', ic: '🐞', group: '검색 품질' },
  { id: 'status', label: '시스템 상태', ic: '💓', group: '시스템' },
];

const FACE_IDS = FACES.map((f) => f.id);

// Hash routing: #/rail, #/residue, #/authority, #/evidence, #/evidence/<surface>, #/drift
function parseHash(): { face: Face; param?: string } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [f, ...rest] = raw.split('/');
  const face = (FACE_IDS as string[]).includes(f ?? '') ? (f as Face) : 'rail';
  const param = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  return param ? { face, param } : { face };
}
function navigate(face: Face, param?: string) {
  window.location.hash = `#/${face}${param ? `/${encodeURIComponent(param)}` : ''}`;
}

export function App() {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [showKeys, setShowKeys] = useState(false);
  const [dk, setDk] = useState('');
  const [wk, setWk] = useState('');
  const [route, setRoute] = useState<{ face: Face; param?: string }>(() => parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    if (!window.location.hash) navigate('rail');
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const face = route.face;

  const reload = () => {
    setLoading(true);
    void loadDataset().then((d) => {
      setDs(d);
      setLoading(false);
    });
  };
  useEffect(reload, []);

  const residue = useMemo<ResidueItem[]>(() => (ds ? classifyResidue(ds) : []), [ds]);
  const cov = ds?.coverage;
  const pct = cov ? Math.round(cov.coverageRate * 1000) / 10 : null;

  const selected = useMemo<ResidueItem | null>(
    () => (face === 'evidence' && route.param ? residue.find((r) => r.hole.surface === route.param) ?? null : null),
    [face, route.param, residue],
  );
  const openEvidence = (item: ResidueItem) => navigate('evidence', item.hole.surface);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>와인 검색 관리</h1>
          <div className="sub">검색어가 잘 연결되는지 확인하고 고치는 곳</div>
        </div>
        <nav className="nav">
          {GROUPS.map((g) => (
            <div className="nav-group" key={g}>
              <div className="nav-group-title">{g}</div>
              {FACES.filter((f) => !f.hidden && f.group === g).map((f) => (
                <button key={f.id} className={face === f.id ? 'active' : ''} onClick={() => navigate(f.id)}>
                  <span className="ic">{f.ic}</span>
                  {f.label}
                  {f.id === 'residue' && residue.length > 0 && <span className="badge">{residue.length}</span>}
                  {f.id === 'authority' && ds && <span className="badge">{ds.authority.length}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          {cov?.snapshotId ? <div className="mono" style={{ fontSize: 10 }}>{cov.snapshotId}</div> : null}
          {ds ? <div>로드 {new Date(ds.loadedAt).toLocaleTimeString('ko-KR')}</div> : null}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{FACES.find((f) => f.id === face)?.label}</h2>
          <div className="spacer" />
          {pct !== null && (
            <span className={`pill ${pct >= 95 ? 'green' : pct >= 85 ? 'amber' : 'red'}`}>
              검색 정확도 {pct}%
            </span>
          )}
          <button className="btn sm" onClick={() => { const k = getOpsKeys(); setDk(k.debug); setWk(k.write); setShowKeys((v) => !v); }}>🔑 운영 키</button>
          <button className="btn sm" onClick={reload}>↻ 새로고침</button>
        </header>

        {showKeys && (
          <div className="keybar">
            <div className="keybar-inner">
              <div className="keybar-title">운영 키 (저장·승인·발행에 필요 — 개발자에게 받으세요)</div>
              <label>디버그 키 (X-Debug-Key)<input className="search-box" type="password" value={dk} onChange={(e) => setDk(e.target.value)} placeholder="HTTP_DEBUG_SECRET" /></label>
              <label>쓰기 키 (X-Ops-Write-Key)<input className="search-box" type="password" value={wk} onChange={(e) => setWk(e.target.value)} placeholder="HTTP_OPS_WRITE_SECRET" /></label>
              <div className="toolbar">
                <button className="btn primary" onClick={() => { setOpsKeys(dk.trim(), wk.trim()); resetReachable(); setShowKeys(false); reload(); }}>저장</button>
                <button className="btn" onClick={() => setShowKeys(false)}>닫기</button>
                <span className="muted" style={{ fontSize: 11 }}>키는 이 브라우저에만 저장됩니다(localStorage).</span>
              </div>
            </div>
          </div>
        )}

        <div className="content">
          {loading && <div className="empty"><div className="big">데이터 로딩…</div></div>}
          {!loading && ds && ds.errors.length > 0 && (
            <div className="banner">
              ⚠ {ds.errors.join(' · ')} — <span className="mono">cd app/entity-lookup-ops-web &amp;&amp; pnpm run sync-data</span>
            </div>
          )}
          {!loading && ds && (
            <div className="face">
              {face === 'rail' && <CutoverRail ds={ds} residue={residue} />}
              {face === 'catalog' && <CatalogBrowser ds={ds} />}
              {face === 'residue' && <ResidueQueue residue={residue} onOpen={openEvidence} />}
              {face === 'authority' && <AuthorityWorkbench ds={ds} />}
              {face === 'evidence' && <EvidencePanel ds={ds} item={selected} residue={residue} onOpen={openEvidence} />}
              {face === 'drift' && <DriftIntake ds={ds} />}
              {face === 'debug' && <QueryDebug />}
              {face === 'status' && <SystemStatus />}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
