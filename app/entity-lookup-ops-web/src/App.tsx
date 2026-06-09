import { useEffect, useMemo, useState } from 'react';
import { loadDataset } from './data/loaders';
import { classifyResidue } from './lib/residue';
import type { Dataset, ResidueItem } from './types';
import { CutoverRail } from './components/CutoverRail';
import { ResidueQueue } from './components/ResidueQueue';
import { AuthorityWorkbench } from './components/AuthorityWorkbench';
import { EvidencePanel } from './components/EvidencePanel';
import { DriftIntake } from './components/DriftIntake';

type Face = 'rail' | 'residue' | 'authority' | 'evidence' | 'drift';

const FACES: { id: Face; label: string; ic: string }[] = [
  { id: 'rail', label: '컷오버 레일', ic: '◎' },
  { id: 'residue', label: '잔여 큐', ic: '▤' },
  { id: 'authority', label: 'Authority 워크벤치', ic: '⚖' },
  { id: 'evidence', label: '증거 · 결정', ic: '🔎' },
  { id: 'drift', label: '드리프트 인테이크', ic: '⇲' },
];

export function App() {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [face, setFace] = useState<Face>('rail');
  const [selected, setSelected] = useState<ResidueItem | null>(null);

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

  const openEvidence = (item: ResidueItem) => {
    setSelected(item);
    setFace('evidence');
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Entity Lookup · Ops</h1>
          <div className="sub">authority 결정 · 잔여 · 컷오버</div>
        </div>
        <nav className="nav">
          {FACES.map((f) => (
            <button key={f.id} className={face === f.id ? 'active' : ''} onClick={() => setFace(f.id)}>
              <span className="ic">{f.ic}</span>
              {f.label}
              {f.id === 'residue' && residue.length > 0 && <span className="badge">{residue.length}</span>}
              {f.id === 'authority' && ds && <span className="badge">{ds.authority.length}</span>}
            </button>
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
              커버리지 {pct}% · {cov!.coveredCount}/{cov!.hotEntityCount}
            </span>
          )}
          <button className="btn sm" onClick={reload}>↻ 새로고침</button>
        </header>

        <div className="content">
          {loading && <div className="empty"><div className="big">데이터 로딩…</div></div>}
          {!loading && ds && ds.errors.length > 0 && (
            <div className="banner">
              ⚠ {ds.errors.join(' · ')} — <span className="mono">cd app/entity-lookup-ops-web &amp;&amp; pnpm run sync-data</span>
            </div>
          )}
          {!loading && ds && (
            <>
              {face === 'rail' && <CutoverRail ds={ds} residue={residue} />}
              {face === 'residue' && <ResidueQueue residue={residue} onOpen={openEvidence} />}
              {face === 'authority' && <AuthorityWorkbench ds={ds} />}
              {face === 'evidence' && <EvidencePanel ds={ds} item={selected} residue={residue} onOpen={setSelected} />}
              {face === 'drift' && <DriftIntake ds={ds} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
