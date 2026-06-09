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
    label: 'Coverage (entity-no-policy)',
    command: 'pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy',
    proves: 'active runtime 대비 hot-entity surface 해소율 + residue bucket.',
  },
  {
    id: 'write_plane',
    label: 'Write-plane refresh',
    command: 'pnpm run eval:lookup-v2:coverage:korean-realworld-stretch:entity-no-policy:refresh-write-plane',
    proves: 'residue를 authority class별 packet/draft로 packetize (SSoT).',
  },
  {
    id: 'authority',
    label: 'Authority',
    command: 'pnpm run eval:lookup-v2:authority',
    proves: 'V2 full-distribution correctness — correct / wrong / miss (목표 wrong0 miss0).',
  },
  {
    id: 'scope_parity',
    label: 'Active-runtime semantic scope-target parity',
    command: 'pnpm run eval:lookup-v2:verify-active-runtime-semantic-scope-target-parity',
    proves: 'reviewed scope-target registry ↔ active runtime 일치.',
  },
  {
    id: 'parity',
    label: 'Parity gate',
    command: 'pnpm run eval:lookup-v2:parity:korean-realworld-stretch:entity-no-policy',
    proves: 'baseline 대비 회귀 없음.',
  },
  {
    id: 'cutover',
    label: 'Cutover gate',
    command: 'pnpm run lookup-v2:cutover-gate',
    proves: 'cutover-eligible 종합 판정.',
  },
  {
    id: 'publish',
    label: 'Publish search snapshot',
    command: 'pnpm run etl:publish-search-snapshot',
    proves: 'gold+silver+carry-forward build → Vespa index → RDS pointer promote.',
  },
  {
    id: 'verify_pointer',
    label: 'Verify snapshot (pointer parity)',
    command: 'pnpm run etl:verify-search-snapshot -- --require-pointer-parity',
    proves: 'published snapshot ↔ active pointer parity.',
  },
];

export type RailStatus = 'pass' | 'fail' | 'unknown';

export interface RailStatusMap {
  readonly [railId: string]: { status: RailStatus; detail?: string; at?: string };
}
