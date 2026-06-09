import { useEffect, useMemo, useState } from 'react';
import { Card, Pill, Copy, Empty, Intro } from './ui';
import { CLASS_LABEL, GAP_LABEL } from '../lib/residue';
import { compose } from '../lib/compose';
import { prettyKey, koStatus, koReason } from '../lib/labels';
import { backendReachable, searchCatalog, submitAliasProposal, type Candidate } from '../lib/api';
import { AUTHORITY_CLASSES, type AuthorityClass, type Dataset, type ResidueItem } from '../types';

// Live "connect this search term to a wine" — searches the real catalog via the
// backend and saves the decision (alias proposal). The primary non-developer action.
function ConnectWine({ surface, defaultQuery }: { surface: string; defaultQuery: string }) {
  const [live, setLive] = useState<boolean | null>(null);
  const [q, setQ] = useState(defaultQuery);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void backendReachable().then(setLive);
  }, []);

  const doSearch = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const c = await searchCatalog(q);
      setCands(c);
      setSel(c[0]?.entityId ?? '');
      if (!c.length) setMsg({ ok: false, text: '검색 결과가 없어요. 다른 이름으로 다시 검색해 보세요.' });
    } catch (e) {
      setMsg({ ok: false, text: `검색 실패: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  const doSave = async () => {
    if (!sel) return;
    setBusy(true);
    setMsg(null);
    try {
      await submitAliasProposal({ surface_form: surface, target_entity_id: sel });
      setMsg({ ok: true, text: '✓ 저장했어요! 「정해둔 규칙」에서 검토·반영하면 검색에 적용됩니다.' });
    } catch (e) {
      setMsg({ ok: false, text: `저장 실패: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  if (live === false) {
    return (
      <Card title="🔗 이 검색어를 와인에 연결하기">
        <div className="banner">
          지금은 검색·저장 서버(백엔드)가 꺼져 있어요. 개발자가 백엔드를 켜면 여기서 바로 와인을 찾아 연결할 수 있습니다. 그 전까지는 아래 「개발자용」에서 초안만 만들 수 있어요.
        </div>
      </Card>
    );
  }
  return (
    <Card title="🔗 이 검색어를 와인에 연결하기" desc="맞는 와인을 찾아 저장하면 끝">
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <input
          className="search-box"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
          placeholder="와인 이름으로 검색… (예: 페트뤼스, Petrus)"
        />
        <button className="btn primary" onClick={() => void doSearch()} disabled={busy || !q.trim()}>{busy ? '찾는 중…' : '와인 찾기'}</button>
      </div>
      {cands.length > 0 && (
        <div className="cand-list">
          {cands.map((c) => (
            <label key={c.entityId} className={`cand ${sel === c.entityId ? 'on' : ''}`}>
              <input type="radio" name="cand" checked={sel === c.entityId} onChange={() => setSel(c.entityId)} />
              <span className="cand-label kr">{c.label}</span>
              <span className="cand-id mono">{c.entityId}</span>
            </label>
          ))}
          <button className="btn primary" style={{ marginTop: 12, alignSelf: 'flex-start' }} onClick={() => void doSave()} disabled={busy || !sel}>
            ✅ “{surface}” → 이 와인으로 연결 저장
          </button>
        </div>
      )}
      {msg && <div className={`banner ${msg.ok ? 'ok' : ''}`} style={{ marginTop: 10 }}>{msg.text}</div>}
    </Card>
  );
}

function famMatch(family: string | undefined, hay: string): boolean {
  if (!family) return false;
  const f = family.toLowerCase().replace(/\s+/g, '');
  const h = hay.toLowerCase().replace(/\s+/g, '');
  return f.split(/[^a-z0-9가-힣]+/).filter(Boolean).every((t) => h.includes(t)) || h.includes(f);
}

export function EvidencePanel({ ds, item, residue, onOpen }: { ds: Dataset; item: ResidueItem | null; residue: readonly ResidueItem[]; onOpen: (i: ResidueItem) => void }) {
  if (!item) {
    return (
      <>
      <Intro title="🔎 검색어를 어떤 와인으로 연결할지 결정하는 곳">
        먼저 처리할 검색어를 고르세요. <b>잔여 큐</b>에서 행을 클릭하거나, 아래 목록에서 선택하면 근거와 결정 작성기가 열립니다.
      </Intro>
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
      </>
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
      <Intro title="🔎 이 검색어를 어떤 와인으로 연결할지 결정하는 곳">
        위쪽은 <b>판단 근거(증거)</b> — 런타임에 어떤 와인이 있는지, 빈티지/라인, 기존 결정 등. 아래 <b>결정 작성기</b>에서 등록할 행 초안을 만듭니다.
        <ul className="steps">
          <li>증거를 보고 <b>결정 종류</b>와 <b>대상 와인</b>을 고릅니다.</li>
          <li>초안(코드)을 <b>복사</b> → 해당 적용 명령을 터미널에서 실행 → 발행.</li>
          <li>휴리스틱(최신 빈티지 등) 금지 — 반드시 증거 기반.</li>
        </ul>
      </Intro>
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
          <div className="k">못 푼 이유</div>
          <div>{koReason(item.hole.reasonCode ?? item.hole.bucket)}</div>
        </div>
      </Card>

      <ConnectWine surface={item.hole.surface} defaultQuery={fam ?? item.hole.surface} />

      <div className="section-title">참고 자료 · 개발자용</div>

      <div className="grid cols-2">
        <Card title={`패밀리 증거 · witness (${witness.length})`} desc="증거 오버레이">
          {witness.length ? witness.map((w, i) => <div key={i} className="mono" style={{ fontSize: 11, marginBottom: 4 }}>{w.entityId}</div>) : <span className="faint">없음</span>}
        </Card>
        <Card title={`정확매칭 인증서 (${exact.length})`} desc="단일 매칭">
          {exact.length ? exact.map((e, i) => <div key={i} className="mono" style={{ fontSize: 11, marginBottom: 4 }}>{e.key} → {e.entityId}</div>) : <span className="faint">없음</span>}
        </Card>
      </div>

      <Card title={`이 패밀리의 기존 결정 (${reviewed.length})`} desc="스코프 타깃 / 정책 / 충돌" >
        {reviewed.length ? (
          <table className="tbl">
            <thead><tr><th>종류</th><th>키</th><th>상태</th><th>사유</th></tr></thead>
            <tbody>{reviewed.map((r, i) => (
              <tr key={i}><td><Pill tone="blue">{CLASS_LABEL[r.cls]}</Pill></td><td className="kr" style={{ fontSize: 12 }} title={r.key}>{prettyKey(r.key)}</td><td><Pill tone="amber">{koStatus(r.status)}</Pill></td><td className="muted kr" style={{ fontSize: 12 }}>{r.reason}</td></tr>
            ))}</tbody>
          </table>
        ) : <span className="faint">이 패밀리에 등록된 결정 없음</span>}
      </Card>

      <div className="section-title">결정 작성기</div>
      <Card desc="증거 기반 결정 초안 (자유형 별칭 추가 ❌). 행 직접 추가가 가능하면 복사해서 append, 아니면 검토→적용 파이프라인.">
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <span className="muted" style={{ fontSize: 12 }}>결정 종류</span>
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
