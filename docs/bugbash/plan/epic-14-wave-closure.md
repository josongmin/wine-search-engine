# Epic 14 — Wave 3-5 잔여 클로저

**Phase:** 유지보수
**우선순위:** P3
**Breaking:** Minimal
**2026 라벨:** `LEGACY_RISK`
**학습 필요:** `학습 불필요`

---

## 왜

Wave 3-5에서 대부분 완료되었지만 잔여 항목이 있음. 이것들이 blocking은 아니지만, Phase B/C 진입 전 깔끔히 닫아야 technical debt 누적 방지.

---

## Task 목록

### T14-1. `decision_trace_ref` Phase C 진행

잔여 consumer (edge-cases tests, resolve-response.dto) → `authority_trace_ref` 전환.

### T14-2. Eval Metric Policy 모듈

`scripts/eval/eval-metric-policy.ts` — `blocking` vs `advisory` 분류.

### T14-3. ID Schema Version Decoder

Authority/batch/snapshot 버전별 parser/validator 구현.

### T14-4. Replay Fixture 전체 HTTP 통합

Wave5 full-runtime lane과 연계.

### T14-5. Wave4 Consumer Inventory 완결

모든 internal consumer → `complete`.

---

## 완료 조건

- `decision_trace_ref` 의존 consumer → `complete`/`retired`
- Eval metric policy 동작
- Consumer inventory 전원 `complete`
