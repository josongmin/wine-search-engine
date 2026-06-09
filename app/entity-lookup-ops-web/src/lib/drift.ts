import type { Dataset } from '../types';

export type DriftClass = 'covered' | 'new_alias' | 'runtime_backfill' | 'genuine_ambiguity' | 'unknown';

export interface DriftResult {
  readonly surface: string;
  readonly klass: DriftClass;
  readonly familyGuess?: string;
  readonly vintage?: number | null;
  readonly detail: string;
}

export const DRIFT_LABEL: Record<DriftClass, string> = {
  covered: '이미 커버됨 (no-op)',
  new_alias: '새 alias / scope-target 문제',
  runtime_backfill: 'runtime backfill 문제',
  genuine_ambiguity: '진성 ambiguity 문제',
  unknown: '미상 (신규 엔티티 가능)',
};

function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function extractVintage(s: string): number | null {
  const four = s.match(/(?:^|[^\d])((?:19|20)\d{2})(?:$|[^\d])/);
  if (four && four[1]) return Number(four[1]);
  const two = s.match(/(?:^|\s)(\d{2})$/);
  if (two && two[1]) {
    const n = Number(two[1]);
    return n <= 30 ? 2000 + n : 1900 + n;
  }
  return null;
}

export function classifyDrift(surfaces: readonly string[], ds: Dataset): DriftResult[] {
  // build lookup indexes from existing authority + gold
  const known = new Set<string>();
  for (const a of ds.authority) {
    if (a.cls === 'exact_safe' || a.cls === 'family_core_witness' || a.cls === 'localized_surface') known.add(norm(a.key.split(' · ')[0] ?? a.key));
  }
  for (const g of ds.gold) for (const al of g.koreanAliases) known.add(norm(al));

  // family token index from gold producers + bare aliases
  const familyTokens: { token: string; family: string; vintages: number[] }[] = [];
  const byFamily = new Map<string, number[]>();
  for (const g of ds.gold) {
    const fam = g.producer || g.canonicalLabel;
    const vs = byFamily.get(fam) ?? [];
    vs.push(g.vintageYear);
    byFamily.set(fam, vs);
  }
  for (const [fam, vs] of byFamily) {
    for (const g of ds.gold.filter((x) => (x.producer || x.canonicalLabel) === fam)) {
      for (const al of g.koreanAliases) {
        const base = norm(al.replace(/\d{2,4}\s*$/, ''));
        if (base.length >= 2) familyTokens.push({ token: base, family: fam, vintages: [...new Set(vs)].sort() });
      }
    }
  }

  return surfaces.map((surfaceRaw) => {
    const surface = surfaceRaw.trim();
    const n = norm(surface);
    const vintage = extractVintage(surface);
    if (!surface) return { surface, klass: 'unknown', detail: '빈 입력' };

    if (known.has(n)) return { surface, klass: 'covered', vintage, detail: '기존 authority/alias와 정확히 일치.' };

    // family match by token containment
    const matches = familyTokens.filter((ft) => n.includes(ft.token) || ft.token.includes(n.replace(/\d{2,4}$/, '')));
    const fams = [...new Set(matches.map((m) => m.family))];

    if (fams.length === 0) {
      return { surface, klass: 'unknown', vintage, detail: '매칭되는 family 없음 — 신규 엔티티 backfill 후보 or 오타.' };
    }
    if (fams.length > 1) {
      return { surface, klass: 'genuine_ambiguity', vintage, detail: `여러 family 매칭(${fams.slice(0, 4).join(', ')}) → collision/policy 결정 필요.` };
    }
    const fam = fams[0]!;
    const vintages = matches[0]!.vintages;
    if (vintage && !vintages.includes(vintage)) {
      return { surface, klass: 'runtime_backfill', familyGuess: fam, vintage, detail: `${fam} 인식되나 vintage ${vintage} 미존재(있음: ${vintages.join('/')}) → runtime/catalog backfill.` };
    }
    return { surface, klass: 'new_alias', familyGuess: fam, vintage, detail: `${fam} family로 인식되나 이 surface 미등록 → identity-safe alias / scope-target.` };
  });
}
