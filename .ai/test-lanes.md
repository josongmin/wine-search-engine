# Test lanes & profiles

Repo-local rules for choosing test lanes. This file is for agents and operators. Product behavior still lives in `docs/RFC-*.md`.

## Default rule

- Do **not** run the heaviest search regression tests by default.
- Start with the narrowest lane that matches the change.
- Only escalate to heavier lanes when the changed code actually touches those paths.

## Smart inner-loop rules

- Prefer `pnpm run check:smart` as the default local verifier.
- Prefer `pnpm run check:staged` right before commit when the staged set is much smaller than the worktree.
- Prefer `pnpm run lint:smart` when you only want lint feedback on changed files.
- Prefer `pnpm run lint:staged` right before commit when you want lint only for staged files.
- Prefer `pnpm run test:file` when you already know the exact test file.
- Prefer `pnpm run test:related` when you changed a source file and want the narrowest useful regression set.
- Only jump to `check:dev`, `test:unit`, `test:integration`, `test:e2e`, or `test:heavy` when the change actually needs broader coverage.
- Do **not** default to broad `pnpm run test` / `pnpm run test:unit` / `pnpm run lint` when a smart or file-scoped command will do.

## Lane map

### Fast/default lanes

- `pnpm run test`
  - Lightweight everyday lane.
  - Uses `config/vitest/dev.config.ts`.
  - Keeps normal local iteration focused on the fastest useful coverage.

- `pnpm run test:watch`
  - Watch-mode version of the same lightweight everyday lane.

- `pnpm run check:dev`
  - Recommended everyday check before or during local iteration.
  - Runs `typecheck + pnpm test`.

- `pnpm run check:quick`
  - Fastest default local check.
  - Runs the lightweight everyday lane only.
  - Use this for tight edit-test loops when full typecheck is unnecessary.

- `pnpm run check:smart [changed-file...]`
  - Smart local check for everyday development.
  - If you pass files, it chooses the narrowest useful lane automatically.
  - If you pass nothing, it inspects the current worktree:
    - docs-only changes are skipped
    - test-only changes skip `typecheck`
    - source/config/script changes run `typecheck` before the selected lane
    - lintable changed files run changed-file lint before the selected lane
    - broad config/test-lane changes fall back to a safer broad sweep: `check:dev + test:meta`, and add `test:heavy` when search-pipeline-sensitive code changed
    - explicit test files use the matching `*:file` entrypoint
    - source files use `test:related`
    - response/schema/HTTP-contract-sensitive source changes also run `test:meta`
    - search-pipeline-sensitive source changes also run `test:heavy`
  - Treat this as the default agent command unless a broader lane is clearly required.

- `pnpm run check:staged`
  - Smart staged-only variant of `check:smart`.
  - Uses only staged files to choose the narrowest useful checks.
  - If nothing is staged, it skips instead of falling back to a broad test run.

- `pnpm run lint:file -- <file...>`
  - Runs ESLint only on the given files.
  - Uses a small local cache for repeated inner-loop runs.

- `pnpm run lint:smart [changed-file...]`
  - Lints only changed lintable files.
  - Docs-only changes are skipped.
  - Large changed sets fall back to full `pnpm run lint`.
  - Prefer this over full `pnpm run lint` during normal iteration.

- `pnpm run lint:staged`
  - Lints only staged lintable files.
  - If nothing is staged, it skips.
  - Prefer this right before commit when the worktree is noisy but the staged set is small.

- `pnpm run check:related -- <changed-file...>`
  - Fastest changed-scope check when you know which files you touched.
  - Runs Vitest `related` against the lightweight everyday lane.
  - Good for tight loops before escalating to `check:quick` or `check:dev`.

- `pnpm run test:file -- <test-file...>`
  - Runs one or more explicit files inside the lightweight everyday lane.
  - Use this when you already know the exact test file you want.
  - Also supports extra Vitest args like `--testNamePattern`.

- `pnpm run test:related -- <changed-file...>`
  - Runs tests related to the given source or test files in the lightweight everyday lane.
  - Preferred over broad `pnpm test` when iterating on a narrow change.

- `pnpm run test:unit`
  - Fuller unit regression lane.
  - Uses `config/vitest/unit.config.ts`.
  - Excludes heavy search regression coverage on purpose.
  - Also excludes watchlist/search-specific suites that already have dedicated lanes.

- `pnpm run test:unit:file -- <test-file...>`
  - Explicit-file entrypoint for the fuller unit lane.
  - Also supports extra Vitest args like `--testNamePattern`.

- `pnpm run test:unit:related -- <changed-file...>`
  - Related-test entrypoint for the fuller unit lane.

- `pnpm run test:integration`
  - General integration lane from `test/integration/**/*.test.ts`.
  - Excludes `test/integration/search-pipeline.test.ts`, which is treated as heavy.
  - Also includes `src/__tests__/integration/**/*.integration.test.ts`.

- `pnpm run test:integration:file -- <test-file...>`
  - Explicit-file entrypoint for integration-only checks.
  - Also supports extra Vitest args like `--testNamePattern`.

- `pnpm run test:integration:related -- <changed-file...>`
  - Related-test entrypoint for integration work.

- `pnpm run test:watchlist`
  - Watchlist-focused lane only.
  - Owns the watchlist-specific `src/__tests__` files so they do not slow down the default unit lane.

- `pnpm run test:meta`
  - Meta/parity lane for workflow, fixture-lane, and route-contract consistency checks.
  - Kept out of the everyday dev lane because these are important but not part of the core inner loop.
  - Also owns response/schema contract tests like:
    - `src/domain/response/__tests__/human-response-builder-v2.test.ts`
    - `src/interface/http/schemas/__tests__/search-response-v2.schema.test.ts`
    - `src/interface/http/routes/__tests__/http-contract-manifest-script.test.ts`
    - `src/interface/http/routes/__tests__/http-contract-openapi-bridge.test.ts`

- `pnpm run test:eval`
  - Eval/reporting-focused unit lane.
  - Includes offline/noisy eval reporting tests that are useful but not part of the normal inner loop.
  - Kept out of `pnpm test` so everyday development spends less time on evaluation-only coverage.

### Heavy lane

- `pnpm run test:heavy`
  - Uses `config/vitest/heavy.config.ts`.
  - Single-fork lane for the expensive search regression tests that are still worth keeping:
    - `test/integration/search-pipeline.test.ts`
  - Run this when touching:
    - query planning / routing
    - candidate retrieval / fusion
    - decision engine behavior
    - response-building behavior for search
    - replay behavior / search snapshot compatibility

### Other specialized lanes

- `pnpm run test:e2e:contract`
  - HTTP contract lane.

- `pnpm run test:e2e`
  - Default lightweight e2e entrypoint.
  - Uses the contract/smoke lane by default.
  - Prefer this as the pyramid-friendly baseline e2e check.

- `pnpm run test:e2e:file -- <test-file...>`
  - Explicit-file entrypoint for the in-memory e2e lane.
  - Also supports extra Vitest args like `--testNamePattern`.

- `pnpm run test:e2e:related -- <changed-file...>`
  - Related-test entrypoint for the in-memory e2e lane.

- `pnpm run test:e2e:runtime`
  - Runtime/quality-heavy e2e lane.

- `pnpm run test:e2e:replay:fixtures:runtime-required`
  - Replay fixtures that require runtime behavior but not the full external-runtime lane.

- `pnpm run test:e2e:replay:fixtures:full-runtime`
  - Full-runtime replay lane. Expensive. Do not run casually.

- `pnpm run test:quality`
  - Quality regression lane.

- `pnpm run test:all`
  - Project-wide non-runtime aggregate lane.
  - Includes `unit + integration + watchlist + meta + e2e:contract + ingest:contract + quality`.

- `pnpm run test:all:full`
  - Expanded aggregate lane.
  - Adds `test:heavy` and `test:e2e:runtime` on top of `test:all`.

## Pre-push profiles

- `pnpm run git:prepush:quick`
  - `typecheck + test:unit`
  - Use for quick local iteration.

- `pnpm run git:prepush:smart`
  - Smart branch-diff pre-push gate.
  - Uses `git diff <upstream>...HEAD` to find changed files.
  - Runs `check:smart` on that branch diff, then adds:
    - `verify:http-contracts` for HTTP-contract-sensitive changes
    - `test:heavy` for search-pipeline-sensitive changes
  - Falls back to full `git:prepush` if:
    - there is no upstream branch
    - the branch diff is too large
  - The fallback is heavy-aware:
    - if the changed set touches search-pipeline-sensitive code, it falls back to `git:prepush:heavy`
    - otherwise it falls back to `git:prepush`

- `pnpm run git:prepush`
  - `typecheck + typecheck:etl + security-patterns + test:unit + web test + integration matrix + noisy + deadcode`
  - HTTP contract parity: CI `verification-core` always; local `git:prepush:smart` runs `verify:http-contracts` on HTTP-sensitive diffs

- `pnpm run git:prepush:heavy`
  - `git:prepush + test:heavy`
  - Use before pushing changes that touch search pipeline logic or replay/snapshot behavior.

## Pre-commit note

- Husky `pre-commit` uses `lint-staged`.
- `lint-staged` now routes staged `*.ts(x)` files through `pnpm run lint:file:fix --`.
- That means pre-commit fix/lint now uses the same cached ESLint wrapper as the manual smart/file commands.

## Keep / remove guidance

- Keep heavy tests only if they provide distinct regression value.
- Remove or rewrite tests that are mainly:
  - ad hoc debugging logs
  - exploratory root-cause traces
  - duplicate coverage of better-structured regression tests
  - large fixture loads with weak assertions

- If a test needs giant fixtures or verbose tracing just to help an investigation, prefer:
  - a one-off local script
  - a temporary test not wired into any default lane
  - a narrowly scoped heavy-lane regression with strong assertions

## Benchmark & eval lanes

벤치마크/품질 측정은 목적에 따라 4개 시나리오로 구분된다. **어떤 외부 서비스를 사용하는지**가 측정값의 의미를 결정한다.

---

### 시나리오 A — 코드 회귀 방지 (in-memory, 외부 서비스 없음)

**언제:** PR 전, 리팩터링 후, 라우팅/응답 형식 변경 시  
**목적:** 검색 경로 파손 여부 확인 (실제 품질 측정 아님)  
**외부 서비스:** 없음 (Vespa in-memory stub, embedding hash stub, Cohere 없음)

```bash
pnpm run test:quality          # golden-set + user-journeys + specialized-modes
pnpm run test:e2e:runtime      # full in-memory e2e
pnpm run eval:offline:local    # in-memory로 NDCG/MRR 계산 (stub 기반이라 숫자 무의미)
```

> ⚠️ 여기서 나오는 NDCG/MRR 수치는 stub embedding 기반이라 실제 품질과 무관. 회귀 방지용.

---

### 시나리오 B — Vespa 랭킹 품질 (실제 Vespa, stub embedding/rerank)

**언제:** Vespa 스키마 변경, BM25 weight 조정, YQL 필터 변경 후  
**목적:** Vespa 인덱스 위에서 랭킹 정확도 확인  
**외부 서비스:** 실제 Vespa ✅ | Embedding: fake ML service ❌ | Cohere rerank: 없음 ❌

```bash
pnpm run test:quality:vespa    # search-quality.test.ts + search-correctness.test.ts
pnpm run test:e2e:vespa        # full vespa e2e suite
pnpm run test:e2e:vespa:smoke  # quick availability smoke
```

> ⚠️ Cohere rerank이 켜지지 않음 → `pure_constraint` / `semantic_preference` 쿼리 품질 측정 불가.  
> ⚠️ Embedding이 fake → dense retrieval 품질 측정 불가.  
> BM25 / YQL 필터 동작 확인에만 신뢰 가능.

---

### 시나리오 C — 실제 end-to-end 품질 (전체 스택, dev 서버 필요)

**언제:** Cohere rerank 변경, embedding 모델 변경, 리랭킹 게이트 조정, gold judgment 기반 NDCG 측정  
**목적:** 실제 사용자 경험에 가장 가까운 품질 측정  
**외부 서비스:** 실제 Vespa ✅ | 실제 OpenAI embedding ✅ | 실제 Cohere rerank ✅

```bash
# 1. dev 서버 켜기 (별도 터미널)
pnpm run dev

# 2. 오프라인 eval (bronze 500-query set, NDCG/MRR/Recall)
pnpm run eval:offline:bronze           # → active shared data dir의 data/eval-results-bronze.json
pnpm run eval:offline:assert-baseline  # 베이스라인 대비 회귀 확인

# 3. LLM judge 기반 NDCG (40 Korean queries × 300 wines)
npx tsx --env-file=.env.local scripts/eval/llm-judge-ndcg.ts \
  --queries data/vivino-gold-queries.jsonl \
  --corpus /tmp/test300-v3.ndjson \
  --output /tmp/llm-judge-labels.jsonl

# 4. noisy entity eval
pnpm run eval:noisy:validate
```

> ✅ 이 시나리오만 Cohere rerank 품질을 측정할 수 있다.  
> `pure_constraint` → `rerankGateReason: 'pure_constraint'` 로그 확인으로 rerank 동작 검증 가능.

---

### 시나리오 D — 에이전트 벤치마크 (LLM + 전체 스택)

**언제:** Agent 프롬프트 변경, tool 추가/수정, 다중 턴 플로우 변경  
**목적:** Agent의 답변 품질, 제약 조건 만족도, faithfulness 측정  
**외부 서비스:** 실제 LLM (Anthropic/OpenAI) ✅ | 실제 검색 스택 ✅

**릴리즈 게이트(픽스처 레포):** `pnpm run bench:agent` (= `pnpm run bench:agent:fixtures`) — production `/v1/agent` HTTP entrypoint parity. 실행 전 `pnpm run bench:agent:preflight`로 live target이 AgentRequestSchema를 강제하는 agent-enabled 서버인지 확인한다. `AGENT_SCENARIOS`와 별개.

**탐색용(`test/benchmark/agent/scenarios.ts`):**

```bash
pnpm run benchmark:exploratory:quick       # --profile quick: 20개, judge off
pnpm run benchmark:exploratory:standard    # 80개, judge off (--no-judge)
pnpm run benchmark:messy       # live noisy-entity eval + messy-search agent 레인 (dev server 필요)
pnpm run benchmark:messy:entity # live noisy-entity eval: typo / abbreviation / mixed-language entity 복원
pnpm run benchmark:exploratory:messy-agent # messy-search agent profile: gift / mood / colloquial / code-switch 질의
pnpm run bench:run                         # exploratory standard alias
pnpm run benchmark:exploratory:nightly     # nightly 프로파일, judge on·3 samples (매우 김)
pnpm run bench:agent:exploratory           # in-process exploratory/ablation full corpus
pnpm run bench:agent:inprocess             # explicit in-process runner alias
```

`pnpm run eval:fixtures:verify` / `pnpm run test:verification:fixtures:governance` / `pnpm run test:verification:fixtures` — **셋 다 동일**(픽스처 레포 구조·FixtureLoader·스위트 계약 검증).
검색+에이전트+퍼포 픽스처 스모크 일괄은 `pnpm run test:verification:fixtures:full`.
오프라인 게이트 + 거버넌스만은 `pnpm run eval:full` (= `eval:offline:gate` + `eval:fixtures:verify`).

---

### 요약 매트릭스

| 시나리오 | Vespa | Embedding | Cohere rerank | LLM | 소요시간 | 신뢰도 |
|---|---|---|---|---|---|---|
| **A. 코드 회귀** | stub | stub | 없음 | 없음 | 초~분 | 경로 파손 감지만 |
| **B. Vespa 랭킹** | 실제 | fake | 없음 | 없음 | 분 | BM25/YQL만 |
| **C. E2E 품질** | 실제 | 실제 | 실제 | 실제 | 분~10분 | ✅ 실제 품질 |
| **D. 에이전트** | 실제 | 실제 | 실제 | 실제 | 10분~3시간 | ✅ 에이전트 품질 |

**규칙:** Cohere rerank / embedding 변경 후에는 반드시 시나리오 C로 검증. A/B만으로는 rerank 품질 변화 측정 불가.

---

## Current policy

- The old diagnostic tests (`live-search`, `debug-search`, `trace-pipeline`, `root-cause-trace`) were intentionally removed from automated lanes because they were expensive and low-signal.
- The heavy lane should stay small. Add to it reluctantly.
- `src/__tests__/integration/cache-service*.integration.test.ts` lives in the integration lane rather than the default unit lane.
- Keep large e2e files split by ownership:
  - `search-api.core` owns search/interpret/resolve/replay/hybrid endpoint contracts
  - `search-api.ops` owns `/health` and `/ready`
  - `infrastructure.invariants` owns rate-limit/request-id/replay determinism/isolation
  - `infrastructure.contracts` owns content-type/envelope/error-contract checks

## Recommended inner loop

- Smart default:
  - `pnpm run check:smart`
  - `pnpm run check:smart src/domain/foo.ts`
  - `pnpm run check:staged`
  - `pnpm run lint:smart`
  - `pnpm run lint:smart src/domain/foo.ts`
  - `pnpm run lint:staged`
  - `pnpm run git:prepush:smart`

- Narrowest possible:
  - `pnpm run test:file -- test/unit/foo.test.ts`
  - `pnpm run test:related -- src/domain/foo.ts`
  - `pnpm run test:e2e:file -- test/e2e/infrastructure.invariants.test.ts --testNamePattern "Group 1: Rate Limiting"`
  - `pnpm run test:e2e:file -- test/e2e/infrastructure.contracts.test.ts --testNamePattern "Group 5: Content-Type Edge Cases"`
- Fast local sweep:
  - `pnpm run check:related -- src/domain/foo.ts`
  - `pnpm run check:quick`
- Broader confidence only when needed:
  - `pnpm run check:dev`
  - Then the dedicated lane that matches the area you touched
- `pnpm run test:e2e:inmemory`
  - Broader in-memory e2e lane.
  - Includes infrastructure/edge-case/hard-scenario coverage that is still lighter than runtime e2e, but heavier than contract/smoke.
