// The publish/verify rails are real npm scripts in the parent repo. The CSR app
// cannot execute them (no backend) — it tracks them: shows the command, what it
// proves, and (optionally) a last-known status synced into public/data/rail-status.json.

export interface Rail {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly proves: string;
}

export const RAILS: readonly Rail[] = [
  {
    id: 'coverage',
    label: '커버리지 (entity-no-policy)',
    command: 'pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy',
    proves: '활성 런타임 대비 hot-entity 표면 해소율 + 잔여 버킷.',
  },
  {
    id: 'write_plane',
    label: '라이트플레인 갱신',
    command: 'pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:refresh-write-plane',
    proves: '잔여를 authority class별 패킷/초안으로 정리 (SSoT).',
  },
  {
    id: 'authority',
    label: 'Authority (정확도)',
    command: 'pnpm run eval:lookup-v2:authority',
    proves: 'V2 전체분포 정확도 — 정답 / 오답 / 미스 (목표 오답0 미스0).',
  },
  {
    id: 'scope_parity',
    label: '런타임 ↔ 스코프타깃 정합',
    command: 'pnpm run eval:lookup-v2:verify-active-runtime-semantic-scope-target-parity',
    proves: '검토된 스코프타깃 레지스트리 ↔ 활성 런타임 일치.',
  },
  {
    id: 'parity',
    label: '패리티 게이트',
    command: 'pnpm run eval:lookup-v2:parity:korean-realworld-stretch:entity-no-policy',
    proves: '베이스라인 대비 회귀 없음.',
  },
  {
    id: 'cutover',
    label: '컷오버 게이트',
    command: 'pnpm run lookup-v2:cutover-gate',
    proves: '컷오버 가능 여부 종합 판정.',
  },
  {
    id: 'publish',
    label: '스냅샷 발행',
    command: 'pnpm run etl:publish-search-snapshot',
    proves: 'gold+silver+carry-forward 빌드 → Vespa 색인 → RDS 포인터 승격.',
  },
  {
    id: 'verify_pointer',
    label: '스냅샷 검증 (포인터 정합)',
    command: 'pnpm run etl:verify-search-snapshot -- --require-pointer-parity',
    proves: '발행된 스냅샷 ↔ 활성 포인터 정합.',
  },
];

export type RailStatus = 'pass' | 'fail' | 'unknown';

export interface RailStatusMap {
  readonly [railId: string]: { status: RailStatus; detail?: string; at?: string };
}
