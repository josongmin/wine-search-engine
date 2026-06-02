# Entity Lookup V2 — Cutover Checklist (T-ELV2-08)

> 하드 게이트: **shadow compare + hotset eval + live smoke 없이 cutover 금지** (RFC §4.7, DoD §7).
> V1 `/v1/lookup/wine`는 cutover 전까지 authority를 유지한다. V2 `/v2/entity-lookup`는
> 이미 등록되어 있으나(catalog v7.1.0) shadow 단계 동안 비-authority다.

## 0. 현재 상태 (2026-06-02)

구현 완료(테스트·타입체크·린트 green, production wiring 완료):

- **T-ELV2-01** dedicated `/v2/entity-lookup` contract + use-case spine + DI + catalog
- **T-ELV2-02** admission/concept gate — `까쇼`류 redirect_discovery (DoD §3)
- **T-ELV2-04** multi-channel provenance (anchor strategies → 7 channels + coverage) (DoD §4)
- **T-ELV2-05** calibrated-abstain decision authority — `opu one`류 → failed (DoD §1, §5)

미완(후속):

- **T-ELV2-03** dedicated alias registry v2 + hot-entity coverage report (DoD §2 — `dom perignon` hole)
- **T-ELV2-06** family graph + ambiguity graph (graph-backed clarification)
- **T-ELV2-07** trusted operator plane + curation write plane (DoD §6)
- **T-ELV2-08** live shadow runner + canary (이 문서의 게이트 wiring)

## 1. 증거 산출물

| 산출물 | 위치 | 상태 |
|---|---|---|
| hotset corpus | `test/fixtures/lookup-v2-hotset.jsonl` | ✅ (15 labeled; DoD exemplars 포함) |
| shadow-compare 메트릭 (pure) | `scripts/eval/lookup-v2-shadow-metrics.ts` | ✅ unit-tested |
| live shadow runner (V1+V2 실행) | `scripts/eval/run-lookup-v2-shadow-compare.ts` | ✅ 구현·실행됨 |
| shadow compare report | `shadow-results-2026-06-02.md` | 🟡 실행됨·**PASS**(V2 correct=7 > V1=3, wrong-positive 0, non-degenerate) but degraded-substrate caveat(untrusted calibration). raw JSON은 `/tmp`만(미커밋). Gate 4(non-degeneracy)가 향후 0-resolve run의 PASS를 차단. cutover 전 **fresh 정상-stack 재실행 + raw artifact 커밋** 권장 |
| operator smoke | `/v2/entity-lookup/ops/inspect` + web `/ops/*` | ✅ (T-07 trusted plane) |
| live canary replay | — | ⬜ (정상 stack 미러 트래픽 필요) |

## 2. Cutover 게이트 (자동 — `buildShadowReport`)

`scripts/eval/lookup-v2-shadow-metrics.ts`의 `buildShadowReport`가 다음을 강제한다
(`DEFAULT_CUTOVER_GATE`, precision-first):

1. **wrong-positive**: V2 wrong-positive rate ≤ V1 (V1이 0이면 V2도 0이어야 함).
   — V2 존재 이유. `opu one`류 wrong-resolve 금지.
2. **correct-rate**: V2 correct rate ≥ V1 × 0.98 (recall 2% 이내 유지).
3. **concept-redirect**: `까쇼`류 redirect 정확도 ≥ 0.95.
4. **non-degeneracy**: expected-resolve row이 있는데 V1·V2 **둘 다 단 한 건도 resolve 못 한** run은
   거부(degraded substrate에서의 hollow PASS 차단 — 적대적 감사가 잡은 15/15-abstain 케이스).

네 게이트 모두 통과해야 `gate.pass === true`.

## 3. Cutover 절차 (게이트 통과 후)

1. `run-lookup-v2-shadow-compare.ts`를 gate/hotset corpus로 실행 → report `gate.pass` 확인.
2. live smoke: 운영자 trusted plane(T-07)에서 DoD exemplar 쿼리 수동 확인.
3. canary: 트래픽 일부를 V2로 미러링(shadow) — 로그상 wrong-positive 0 확인.
4. authority 전환: lookup 진입점을 V2로 변경 (현재 V1 route 유지; 전환 시 V1을 shadow adapter로 강등).
5. `docs` + catalog 갱신, V1 lookup 경로 deprecation 표기.

## 4. Legacy purge 조건

- cutover 후 **최소 1 release cycle** V2 authority 무사고 운영.
- V1 `/v1/lookup/wine` 호출량 0 (or 내부 shadow 전용)인지 telemetry 확인.
- 확인 후에만 V1 lookup use-case/route/스키마 제거 + catalog major bump.
- **shadow compare report 없이 V1 삭제 금지** (공통 금지사항 §5).

## 5. 롤백

V2는 additive route이므로 cutover authority 전환만 되돌리면 즉시 V1 복귀.
DB/Vespa 변경 없음 (V2는 기존 substrate reuse).
