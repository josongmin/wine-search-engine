import { useMemo, useState } from 'react';
import { Card, Pill, Copy, Empty } from './ui';
import { CLASS_LABEL, GAP_LABEL } from '../lib/residue';
import { compose } from '../lib/compose';
import { AUTHORITY_CLASSES, type AuthorityClass, type Dataset, type ResidueItem } from '../types';

function famMatch(family: string | undefined, hay: string): boolean {
  if (!family) return false;
  const f = family.toLowerCase().replace(/\s+/g, '');
  const h = hay.toLowerCase().replace(/\s+/g, '');
  return f.split(/[^a-z0-9가-힣]+/).filter(Boolean).every((t) => h.includes(t)) || h.includes(f);
}

export function EvidencePanel({ ds, item, residue, onOpen }: { ds: Dataset; item: ResidueItem | null; residue: readonly ResidueItem[]; onOpen: (i: ResidueItem) => void }) {
  if (!item) {
    return (
      <Card title="증거 · 결정" desc="잔여 큐에서 항목을 선택하거나, 아래에서 선택">
        {residue.length === 0 ? <Empty title="잔여 없음 ✓" /> : (
          <table className="tbl">
            <thead><tr><th>표면</th><th>버킷</th><th>해소 경로</th></tr></thead>
            <tbody>
              {residue.slice(0, 30).map((it, i) => (
                <tr key={i} className="clickable" onClick={() => onOpen(it)}>
                  <td className="kr"><strong>{it.hole.surface}</strong></td>
                  <td><Pill tone="amber">{GAP_LABEL[it.bucket]}</Pill></td>
                  <td><Pill tone="blue">{CLASS_LABEL[it.authorityClass]}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    );
  }
  return <EvidenceBody ds={ds} item={item} />;
}

function EvidenceBody({ ds, item }: { ds: Dataset; item: ResidueItem }) {
  const fam = item.hole.family;
  const ev = item.evidence;
  const goldRows = useMemo(() => ds.gold.filter((g) => famMatch(fam, g.producer + ' ' + g.canonicalLabel)), [ds, fam]);
  const witness = useMemo(() => ds.authority.filter((a) => a.cls === 'family_core_witness' && famMatch(fam, a.key)), [ds, fam]);
  const exact = useMemo(() => ds.authority.filter((a) => a.cls === 'exact_safe' && (famMatch(fam, a.key) || goldRows.some((g) => g.entityId === a.entityId))), [ds, fam, goldRows]);
  const reviewed = useMemo(() => ds.authority.filter((a) => (a.cls === 'scope_target' || a.cls === 'policy' || a.cls === 'collision') && (famMatch(fam, a.family ?? a.key))), [ds, fam]);

  const candidateEntities = useMemo(() => {
    const set = new Map<string, string>();
    const ids = ev?.entityIds ?? [];
    const labels = ev?.entityLabels ?? [];
    ids.forEach((id, i) => set.set(id, labels[i] ?? id));
    for (const g of goldRows) set.set(g.entityId, g.canonicalLabel);
    return [...set.entries()];
  }, [ev, goldRows]);

  const [cls, setCls] = useState<AuthorityClass | 'runtime_catalog_backfill'>(item.authorityClass);
  const [entityId, setEntityId] = useState<string>(candidateEntities[0]?.[0] ?? '');
  const result = compose({ cls, surface: item.hole.surface, family: fam, entityId: entityId || undefined, vintage: parseVintage(item.hole.surface), evidence: ev });

  return (
    <>
      <Card title={item.hole.surface} desc={`${fam ?? ''} · ${GAP_LABEL[item.bucket]}`} right={<Pill tone={item.evidenceBased ? 'green' : 'gray'}>{item.evidenceBased ? '증거 충분 ✓' : '리뷰 필요'}</Pill>}>
        <div className="muted kr" style={{ fontSize: 13, marginBottom: 14 }}>{item.rationale}</div>
        <div className="evidence-grid">
          <div className="k">런타임 owner</div>
          <div>{ev?.entityLabels?.length ? ev.entityLabels.map((l, i) => <span key={i} className="mono" style={{ marginRight: 8 }}>{l}</span>) : <span className="faint">— (owner-evidence 없음)</span>}</div>
          <div className="k">가용 vintage</div>
          <div className="mono">{ev?.availableVintages?.join(' / ') ?? <span className="faint">—</span>}</div>
          <div className="k">line / region</div>
          <div className="mono">{[...(ev?.availableLineKeys ?? []), ...(ev?.availableRegionKeys ?? [])].join(' / ') || <span className="faint">—</span>}</div>
          <div className="k">gold vintage</div>
          <div className="mono">{goldRows.length ? goldRows.map((g) => g.vintageYear).sort().join(' / ') : <span className="faint">— (gold 없음)</span>}</div>
          <div className="k">사유 코드</div>
          <div className="mono">{item.hole.reasonCode ?? item.hole.bucket ?? '—'}</div>
        </div>
      </Card>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title={`Family-core witness (${witness.length})`} desc="증거 overlay">
          {witness.length ? witness.map((w, i) => <div key={i} className="mono" style={{ fontSize: 11, marginBottom: 4 }}>{w.entityId}</div>) : <span className="faint">없음</span>}
        </Card>
        <Card title={`Exact-safe certificate (${exact.length})`} desc="singleton 매칭">
          {exact.length ? exact.map((e, i) => <div key={i} className="mono" style={{ fontSize: 11, marginBottom: 4 }}>{e.key} → {e.entityId}</div>) : <span className="faint">없음</span>}
        </Card>
      </div>

      <Card title={`현재 reviewed registry row (${reviewed.length})`} desc="scope_target / policy / collision" >
        {reviewed.length ? (
          <table className="tbl">
            <thead><tr><th>class</th><th>키</th><th>상태</th><th>사유</th></tr></thead>
            <tbody>{reviewed.map((r, i) => (
              <tr key={i}><td><Pill tone="blue">{r.cls}</Pill></td><td className="mono" style={{ fontSize: 11 }}>{r.key}</td><td><Pill tone="amber">{r.status}</Pill></td><td className="muted kr" style={{ fontSize: 12 }}>{r.reason}</td></tr>
            ))}</tbody>
          </table>
        ) : <span className="faint">이 family에 reviewed row 없음</span>}
      </Card>

      <div className="section-title">결정 작성기 · Decision Composer</div>
      <Card desc="증거 기반 reviewed 결정 초안 (자유형 alias ❌). raw row가 가능하면 append, 아니면 review→apply 파이프라인.">
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <span className="muted" style={{ fontSize: 12 }}>authority class</span>
          <select className="btn" value={cls} onChange={(e) => setCls(e.target.value as AuthorityClass)}>
            {[...AUTHORITY_CLASSES, 'runtime_catalog_backfill'].map((c) => <option key={c} value={c}>{CLASS_LABEL[c as AuthorityClass]}</option>)}
          </select>
          {candidateEntities.length > 0 && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>대상 entity</span>
              <select className="btn" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
                <option value="">—</option>
                {candidateEntities.map(([id, label]) => <option key={id} value={id}>{label} ({id})</option>)}
              </select>
            </>
          )}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>파일: <span className="mono">{result.file}</span></div>
        {result.row ? (
          <>
            <pre className="code">{result.row}</pre>
            <div style={{ marginTop: 8 }}><Copy text={result.row} label="row 복사" /></div>
          </>
        ) : null}
        <div className="muted kr" style={{ fontSize: 12, marginTop: 10 }}>{result.note}</div>
        {result.applyCmd && (
          <div style={{ marginTop: 8 }}>
            <code className="mono" style={{ fontSize: 11 }}>{result.applyCmd}</code> <Copy text={result.applyCmd} />
          </div>
        )}
      </Card>
    </>
  );
}

function parseVintage(s: string): number | null {
  const four = s.match(/(?:^|[^\d])((?:19|20)\d{2})(?:$|[^\d])/);
  if (four && four[1]) return Number(four[1]);
  const two = s.match(/(?:^|\s)(\d{2})$/);
  if (two && two[1]) { const n = Number(two[1]); return n <= 30 ? 2000 + n : 1900 + n; }
  return null;
}
