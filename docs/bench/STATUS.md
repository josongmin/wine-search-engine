# Bench Status (2026-06-03)

이 폴더의 current SSOT는 이 문서다.

## Current executable lanes

- `pnpm run bench:smoke`
  - deterministic agent-benchmark scorer/unit/regression lane
  - PR workflow `.github/workflows/bench-smoke.yml`가 실제로 호출하는 lane
- `pnpm run bench:agent:export-scenarios-md`
  - `AGENT_SCENARIOS.md` regeneration only
- `pnpm run eval:lookup-v2:authority -- --output /tmp/entity-resolution-validation.json`
  - lookup authority full-distribution gate
- `pnpm run eval:lookup-v2:shadow -- --output /tmp/lookup-v2-shadow-report.json`
  - lookup hotset smoke gate
  - direct `searchUseCase` legacy core vs dedicated V2 비교이며, cutover 이후 public `/v1/lookup/wine` route parity proof와는 다르다

## Non-current / fail-closed

- `test/benchmark/agent/runner.ts`
  - 현재 checkout에 없다
- `scripts/eval/freeze-agent-baseline.ts`
  - runner 부재를 감지하면 fail-closed 한다
- runner-based archive / compare / power-analysis docs
  - historical or dormant design notes only until a real runner is restored

## Documentation policy

- current 문서에서 missing command / missing file를 executable lane처럼 적지 않는다
- lookup authority 품질 판단은 `docs/plans/jun-2-genearl/entity-lookup-v2/cutover-checklist.md`와
  `docs/plans/jun-2-genearl/entity-lookup-v2/IMPROVEMENT-PLAN-2026-06-03.md`를 따른다
