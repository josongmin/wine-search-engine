# Entity Lookup V2 — Cutover Checklist (Historical Audit Snapshot)

> Historical / audit-only document.
> Current authority truth moved to `docs/bench/STATUS.md` and
> `tools/feature-catalog/features/retrieval/entity-lookup-v2.yaml`.
> This file intentionally preserves pre-parity cutover context and stale shadow
> terminology for RCA only. Do not use it as the current execution or cutover SSOT.
>
> Historical diagnostics (`entity-resolution-validation-2026-06-02.md`,
> `shadow-results-2026-06-02.md`) are retained for RCA/audit, not for current
> cutover verdicts.

## 0. 현재 상태 (2026-06-05)

현재 cutover authority truth:

- **full eval_cases authority** (`run-entity-resolution-validation.ts`, 215 rows,
  fingerprint `bd8abea5871dcede17272c3cc0bd1dcebcf93ea658d2d4b2ab930e5ba4f26cae`):
  `V1 46.5%, wrong=0, miss=115` vs `V2 100.0%, wrong=0, miss=0`
- **verdict: code/data/runtime/bench PASS, self-canary PASS, artifact-only publish PASS, real traffic mirror input external**
- **post-cutover latency truth** (`run-lookup-v2-latency-korean-famous.ts`, 75 rows):
  canonical active runtime rerun (`lookup_direct_container`):
  `bootstrap_ms=670.765`, `first_query_ms=400.941`, `warm_p95_ms=63.767`
  → **PASS**
- **coverage truth** (`run-lookup-v2-coverage-report.ts`, Korean-famous 107 rows):
  `hot_entities=70/70`, `non_entity=37/37`, `curation_tasks=0`
  → **PASS**
- **active runtime truth** (`pnpm run etl:migrate-runtime-state ... --manifest ...7bcd44a5484b2be5...`):
  active runtime snapshot = `search-snapshot:v1:7bcd44a5484b2be5`
- active runtime contracts:
  - runtime state `search_snapshot_runtime_state.v7`
  - manifest `search_snapshot.v5`
- readiness:
  - bootstrap verify PASS
  - pointer parity verify PASS
- current residue는 **real traffic mirror input external** 이다.
- operator-plane PG publish DNS는 이 호스트에서 여전히 환경 이슈일 수 있지만,
  lookup-only canonical active promote는 `artifact-only` lane으로 이미 닫혔다.
- blocker rows closed:
  - `Viña Espectro Maipo Valley Carmenere` →
    recall-only `fuzzy_alias` head no longer self-certifies resolve
  - `2018 St. Supéry Élu` →
    exact-head false ambiguity closed at the shared ambiguity seam
- **45-row hotset smoke** is still PASS and still non-authoritative:
  `V2 wrong+=0` after expanded Korean typo / short-form / recommendation coverage
- note: the older `V1 93.5%` comparison is now historical. The current codebase's
  explicit `legacy_core` rerun is `V1 46.5%`, so cutover docs must not quote the
  older baseline as current truth.

구현 완료(테스트·타입체크·린트 green, production wiring 완료):

- **T-ELV2-01** dedicated `/v2/entity-lookup` contract + use-case spine + DI + catalog
- **T-ELV2-02** admission/concept gate — `까쇼`류 redirect_discovery (DoD §3)
- **T-ELV2-03** dedicated alias registry v2 + hot-entity coverage report / curation rail
- **T-ELV2-04** multi-channel provenance (anchor strategies → 7 channels + coverage) (DoD §4)
- **T-ELV2-05** calibrated-abstain decision authority — `opu one`류 → failed (DoD §1, §5)
- **T-ELV2-06** family graph + ambiguity graph (graph-backed clarification)
- **T-ELV2-07** trusted operator plane + curation write plane (DoD §6)

미완(운영 closeout):

- **T-ELV2-08** live canary + legacy purge closeout

## 1. 증거 산출물

| 산출물 | 위치 | 상태 |
|---|---|---|
| hotset corpus | `test/fixtures/lookup-v2-hotset.jsonl` | ✅ (45 labeled; Korean typo / short-form ambiguity / recommendation phrase / adversarial no-match 압력 포함) |
| full authority report | `/tmp/entity-resolution-validation-active-2026-06-05-post-bootstrap-fix.json` | ✅ **AUTHORITY PASS**: explicit `legacy_core` baseline `V1 100/215 (46.5%), wrong=0, miss=115` vs `V2 215/215 (100%), wrong=0, miss=0`, fingerprint `bd8abea5871dcede17272c3cc0bd1dcebcf93ea658d2d4b2ab930e5ba4f26cae` |
| full authority report (current structural rerun) | `/tmp/entity-resolution-validation-structural-final.json` | ✅ **AUTHORITY PASS**: `V2 215/215 (100%), wrong=0, miss=0`, fingerprint `bd8abea5871dcede17272c3cc0bd1dcebcf93ea658d2d4b2ab930e5ba4f26cae` |
| shadow-compare 메트릭 (pure) | `scripts/eval/lookup-v2-shadow-metrics.ts` | ✅ unit-tested |
| live shadow runner (V1+V2 실행) | `scripts/eval/run-lookup-v2-shadow-compare.ts` | ✅ 구현·실행됨 |
| shadow compare report | `/tmp/lookup-v2-shadow-active-2026-06-05-post-bootstrap-fix.json` | ✅ **SMOKE PASS (post-cutover), NOT cutover authority**: `rows=31`, `V2 correct=27`, `wrongPositive=0`, `concept_redirect_acc=1.000`, gate PASS. **주의**: 현재 shadow lane의 `V1`은 public `/v1/lookup/wine` route가 아니라 explicit `legacy_core` baseline이다. 즉 이 lane은 post-cutover에는 public route parity proof가 아니라 legacy-core smoke다. |
| shadow compare report (expanded Korean rerun) | `/tmp/lookup-v2-shadow-korean-expanded-final.json` | ✅ **SMOKE PASS (post-cutover), NOT cutover authority**: `rows=45`, `V2 correct=41`, `wrongPositive=0`, `concept_redirect_acc=1.000`, gate PASS. |
| latency full-corpus report | `/tmp/lookup-v2-latency-structural-final.json` | ✅ **LATENCY PASS**: `bootstrap_ms=670.765`, `first_query_ms=400.941`, `warm_p95_ms=63.767`. lookup direct bootstrap / warm path 모두 threshold 이내다. |
| Korean-famous coverage report | `/tmp/lookup-v2-coverage-korean-famous-expanded-final.json` | ✅ **COVERAGE PASS**: `hot_entities=70/70`, `non_entity=37/37`, `curation_tasks=0`. |
| canary corpus build | `/tmp/lookup-v2-canary-built-sample.jsonl` | ✅ explicit dotted-path extractor lane PASS (`scanned=4`, `matched=3`, `rows=3`) |
| canary self-replay | `/tmp/lookup-v2-canary-replay-active-2026-06-05-post-bootstrap-fix.json` | ✅ **SELF-CANARY PASS**: `hard_drift=0`, `soft_abstain_drift=0`, labeled `75/75`. real traffic mirror raw input 자체는 여전히 외부 필요. |
| canary self-replay (current structural rerun) | `/tmp/lookup-v2-canary-replay-structural-final.json` | ✅ **SELF-CANARY PASS**: `hard_drift=0`, `soft_abstain_drift=0`, sample labeled `3/3`. real traffic mirror raw input 자체는 여전히 외부 필요. |
| active runtime proof | `/Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json` | ✅ active runtime points at `search-snapshot:v1:7bcd44a5484b2be5`; current-contract artifact-only promote PASS. |
| artifact-only publish proof | — | ✅ `pnpm run etl:publish-runtime-substrates:artifact-only -- --manifest /Users/songmin/.wine-search-engine/data/search-snapshots/search-snapshot:v1:7bcd44a5484b2be5/manifest.json --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --runtime-nl-mappings /Users/songmin/.wine-search-engine/data/nl-mappings.json` PASS |
| operator-plane PG publish | — | ℹ️ host DNS / operator-plane availability issue는 여전히 별도 운영 문제일 수 있다. lookup-only cutover gate와는 분리한다. |
| product-edge purge rail | `test/regression/lookup-wine-authority-surface.regression.test.ts` | ✅ removed `/v1/lookup/wine` stays gone; local CLI + eval/debug rails are locked to dedicated lookup-direct V2 authority |
| operator smoke | `/v2/entity-lookup/ops/inspect` + web `/ops/*` | ✅ (T-07 trusted plane) |
| live canary replay | — | ⬜ (정상 stack 미러 트래픽 필요) |

## 2. Cutover 게이트 (자동)

### 2.0 권위(authority) — FULL `eval_cases` distribution

**cutover 게이트의 authority는 전체 `eval_cases` 분포(2026-06-03 기준 215 entity-semantic
케이스)다. 15-query hotset은 fast smoke check 일 뿐 authority 가 아니다.**

현재 authority run의 결론은 전체 분포 기준 **PASS**다. hotset은 여전히 smoke일 뿐이고,
cutover truth는 전체 `eval_cases` 분포에 묶인다. 최신 ground-truth
(`expected_entity_id` exact match) 숫자는 **V2 100.0% vs explicit legacy-core V1 46.5%** 이다.

- **Authority 스코어러**: `pnpm run eval:lookup-v2:authority -- --output <file>` (`scripts/eval/run-entity-resolution-validation.ts`) — 전체
  `eval_cases` 를 per-class 로 채점하고, per-class 게이트 verdict(`gate.pass` + `reasons`)와
  선택된 eval row 들의 **SHA-256 content fingerprint**(`evalCasesFingerprint`)를 JSON 으로 출력.
  fingerprint 는 `query|query_class|expected_entity_id` 를 sort·join 해서 해싱하므로 row 순서에
  무관하다. `eval_cases` 는 DB 에서 버전 관리되지 않으므로, 두 run 사이 row 가 추가/수정/삭제되면
  fingerprint 가 달라져 PASS 가 무효임을 드러낸다. **게이트 PASS 는 특정 fingerprint 에 묶인다.**
- **Fast smoke (비-authority)**: `pnpm run eval:lookup-v2:shadow -- --output <file>` +
  15-hotset → `buildShadowReport`. 빠른 sanity check 용이며, 단독으로 cutover 를 승인할 수 없다.
  cutover 이후 이 lane은 public `/v1/lookup/wine` route parity가 아니라 explicit
  `legacy_core` baseline vs dedicated V2 smoke 비교라는 점을 명시한다.

### 2.1 Overall 게이트 (`buildShadowReport`, `DEFAULT_CUTOVER_GATE`, precision-first)

`scripts/eval/lookup-v2-shadow-metrics.ts`의 `buildShadowReport`가 다음을 강제한다:

1. **wrong-positive**: V2 wrong-positive rate ≤ V1 (V1이 0이면 V2도 0이어야 함).
   — V2 존재 이유. `opu one`류 wrong-resolve 금지.
2. **correct-rate**: V2 correct rate ≥ V1 × 0.98 (recall 2% 이내 유지).
3. **concept-redirect**: `까쇼`류 redirect 정확도 ≥ 0.95.
4. **non-degeneracy**: expected-resolve row이 있는데 V1·V2 **둘 다 단 한 건도 resolve 못 한** run은
   거부(degraded substrate에서의 hollow PASS 차단 — 적대적 감사가 잡은 15/15-abstain 케이스).

### 2.2 PER-CLASS no-regression 게이트 (`evaluatePerClassGate`)

overall 게이트는 한 클래스의 회귀를 전체 lift 로 가릴 수 있다(예: noisy_recall 하락을
exact_entity 상승이 덮음). 이를 막기 위해 per-class 게이트를 추가로 강제한다
(authority 스코어러와 `buildShadowReport` 모두 적용; `DEFAULT_PER_CLASS_GATE`):

5. **per-class correct-rate no-regression**: **모든** query class 에서 V2 correct-rate ≥
   V1 correct-rate × **0.98**(overall correct-rate 게이트와 동일한 2% tolerance). 한 클래스라도
   이 아래로 떨어지면 FAIL.
6. **abstain 클래스 0-wrong-positive**: should-NOT-resolve 클래스
   (`ambiguous_short_form`, `no_match`)는 V2 wrong-positive 가 **정확히 0** 이어야 한다.
   단 1건의 wrong-positive 라도 FAIL(overall rate 와 무관한 hard precision 실패).

위 게이트 전부 통과해야 `gate.pass === true`.

## 3. Cutover 절차 (게이트 통과 후)

1. full authority eval PASS를 artifact와 fingerprint로 고정한다.
2. compatibility-backed authority 전환:
   `/v1/lookup/wine`, local CLI, agent `lookup_wine` → V2 authority 완료.
3. live smoke: 운영자 trusted plane(T-07)에서 DoD exemplar 쿼리 수동 확인.
4. canary: 트래픽 일부를 V2로 미러링(shadow) — 로그상 wrong-positive 0 유지 확인.
5. `docs` + catalog 갱신, 남은 항목은 release-cycle 이후 legacy resolver deletion만 추적한다.

## 4. Legacy purge 조건

- product edge (`/v1/lookup/wine`, local CLI `lookupWine`) fallback purge는 완료되었다.
- cutover 후 **최소 1 release cycle** V2 authority 무사고 운영.
- compatibility route `/v1/lookup/wine` 호출량과 error mix를 telemetry로 본다.
- 확인 후에만 V1 resolver path purge + catalog major bump.
- **shadow compare report 없이 V1 삭제 금지** (공통 금지사항 §5).

## 5. 롤백

V2는 additive route이므로 cutover authority 전환만 되돌리면 즉시 V1 복귀.
DB/Vespa 변경 없음 (V2는 기존 substrate reuse).
