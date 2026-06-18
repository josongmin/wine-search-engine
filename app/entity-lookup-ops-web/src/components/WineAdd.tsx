import { useState } from 'react';
import { Copy } from './ui';

function slug(s: string): string {
  return (
    'w-' +
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
  );
}

// MVP+ wine management. The real catalog is filled by ingestion, so this emits a
// structured "registration request" row to hand to ingestion/dev rather than
// writing the product DB directly (which needs a separate write endpoint + approval).
export function WineAdd() {
  const [label, setLabel] = useState('');
  const [producer, setProducer] = useState('');
  const [region, setRegion] = useState('');
  const [vintage, setVintage] = useState('');
  const [aliases, setAliases] = useState('');

  const row = label.trim()
    ? JSON.stringify({
        entityId: slug(`${label}-${vintage || 'nv'}`),
        canonicalLabel: label.trim(),
        producer: producer.trim() || label.trim(),
        ...(region.trim() ? { region: region.trim() } : {}),
        vintageYear: vintage.trim() ? Number(vintage) : 0,
        koreanAliases: aliases.split(',').map((s) => s.trim()).filter(Boolean),
      })
    : '';

  return (
    <details className="dev-fold">
      <summary>➕ 새 와인 등록 요청 만들기</summary>
      <div className="dev-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          실제 카탈로그는 <b>인제스트(적재)</b>가 채웁니다. 여기서는 <b>등록 요청(한 줄)</b>을 만들어 개발자/인제스트 담당에게 전달하세요. (제품 DB 직접 쓰기는 별도 권한·엔드포인트 필요)
        </p>
        <div className="form-grid">
          <label>와인 이름<input className="search-box" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: Chateau Petrus" /></label>
          <label>생산자<input className="search-box" value={producer} onChange={(e) => setProducer(e.target.value)} placeholder="예: Petrus" /></label>
          <label>지역<input className="search-box" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="예: Pomerol, Bordeaux" /></label>
          <label>빈티지(연도)<input className="search-box" value={vintage} onChange={(e) => setVintage(e.target.value)} placeholder="예: 2016" /></label>
          <label style={{ gridColumn: '1 / -1' }}>한글 별칭 (쉼표로 구분)<input className="search-box" style={{ maxWidth: 'none' }} value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="예: 페트뤼스, 페트러스" /></label>
        </div>
        {row && (
          <>
            <pre className="code">{row}</pre>
            <div style={{ marginTop: 8 }}><Copy text={row} label="등록 요청 복사" /></div>
          </>
        )}
      </div>
    </details>
  );
}
