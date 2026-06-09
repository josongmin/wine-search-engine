import { useState, type ReactNode } from 'react';

export function Card({ title, desc, right, children }: { title?: string; desc?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || right) && (
        <div className="hd">
          {title && <h3>{title}</h3>}
          {desc && <span className="desc">{desc}</span>}
          {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
        </div>
      )}
      <div className="bd">{children}</div>
    </div>
  );
}

export function Stat({ k, v, sub, tone }: { k: string; v: ReactNode; sub?: ReactNode; tone?: 'green' | 'amber' | 'red' }) {
  return (
    <div className="card stat">
      <div className="k">{k}</div>
      <div className="v" style={tone ? { color: `var(--${tone})` } : undefined}>{v}</div>
      {sub && <div className="delta muted">{sub}</div>}
    </div>
  );
}

export type Tone = 'green' | 'amber' | 'red' | 'gray' | 'blue';
export function Pill({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Bars({ data, total }: { data: [string, number][]; total?: number }) {
  const max = total ?? Math.max(1, ...data.map(([, n]) => n));
  return (
    <div className="bars">
      {data.map(([label, n]) => (
        <div className="barrow" key={label}>
          <span className="lbl" title={label}>{label}</span>
          <span className="track"><span style={{ width: `${(n / max) * 100}%` }} /></span>
          <span className="n">{n}</span>
        </div>
      ))}
    </div>
  );
}

export function Copy({ text, label = 'copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? '✓ 복사됨' : label}
    </button>
  );
}

export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{title}</div>
      {hint && <div>{hint}</div>}
    </div>
  );
}

export function StatusPill({ status }: { status: 'pass' | 'fail' | 'unknown' }) {
  if (status === 'pass') return <Pill tone="green"><span className="dot green" /> PASS</Pill>;
  if (status === 'fail') return <Pill tone="red"><span className="dot red" /> FAIL</Pill>;
  return <Pill tone="gray"><span className="dot gray" /> unknown</Pill>;
}
