import { useMemo, useState } from 'react';
import { Card, Pill, Stat } from './ui';
import { classifyDrift, DRIFT_LABEL, type DriftClass } from '../lib/drift';
import type { Dataset } from '../types';

const TONE: Record<DriftClass, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = {
  covered: 'green',
  new_alias: 'blue',
  runtime_backfill: 'amber',
  genuine_ambiguity: 'red',
  unknown: 'gray',
};

const SAMPLE = ['폴 로저 18', '오존생테밀리옹', '샤또 마고 2009', '케이머스 카베르네 2019', '돔페리뇽 로제', '무명 와이너리 2020'].join('\n');

export function DriftIntake({ ds }: { ds: Dataset }) {
  const [text, setText] = useState('');
  const surfaces = useMemo(() => text.split('\n').map((s) => s.trim()).filter(Boolean), [text]);
  const results = useMemo(() => classifyDrift(surfaces, ds), [surfaces, ds]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of results) m[r.klass] = (m[r.klass] ?? 0) + 1;
    return m;
  }, [results]);

  return (
    <>
      <Card title="Drift Intake" desc="운영 쿼리 로그의 신규 surface를 붙여넣으면, 기존 authority/gold와 비교해 자동 분류 (heuristic triage — 결정은 Evidence·Decision에서)">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="surface 한 줄에 하나씩 붙여넣기…"
          style={{ width: '100%', minHeight: 120, fontFamily: 'var(--mono)', fontSize: 13, padding: 12, border: '1px solid var(--border-strong)', borderRadius: 8, resize: 'vertical' }}
        />
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={() => setText(SAMPLE)}>샘플 채우기</button>
          <button className="btn" onClick={() => setText('')}>지우기</button>
          <span className="muted" style={{ fontSize: 12 }}>{surfaces.length}개 표면</span>
        </div>
      </Card>

      {results.length > 0 && (
        <>
          <div className="grid cols-4" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginTop: 16, gap: 10 }}>
            {(Object.keys(DRIFT_LABEL) as DriftClass[]).map((k) => (
              <Stat key={k} k={DRIFT_LABEL[k]} v={counts[k] ?? 0} tone={k === 'genuine_ambiguity' ? 'red' : k === 'runtime_backfill' ? 'amber' : k === 'covered' ? 'green' : undefined} />
            ))}
          </div>
          <Card desc="분류 결과" right={undefined}>
            <table className="tbl">
              <thead><tr><th>표면</th><th>분류</th><th>패밀리 추정</th><th>vintage</th><th>상세</th></tr></thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td className="kr"><strong>{r.surface}</strong></td>
                    <td><Pill tone={TONE[r.klass]}>{DRIFT_LABEL[r.klass]}</Pill></td>
                    <td className="muted">{r.familyGuess ?? '—'}</td>
                    <td className="mono">{r.vintage ?? '—'}</td>
                    <td className="muted kr" style={{ fontSize: 12, maxWidth: 420 }}>{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}
