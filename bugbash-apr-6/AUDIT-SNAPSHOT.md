# 병렬 정적 감사 — 요약 인덱스

**역할:** [`FINDINGS-MATRIX.md`](./FINDINGS-MATRIX.md)에 있는 **동일 주제**를 영역별(A–E)로만 묶어 빠르게 찾기 위한 **색인**이다.  
**진실 공급원(SSOT)은 매트릭스:** 행 추가·해결 시 **`FINDINGS-MATRIX.md`의 `M-xx` 표**를 먼저 고친다.

---

## 영역 → 매트릭스 ID

| 구역 | 포함 ID (예) | 주제 |
|------|----------------|------|
| **A** 파이프라인·도메인 | M-02, M-04, M-05, M-06, M-07, M-15, M-16, M-17, M-18 | 플래너 모드, browse/compare 스텁, ResultGrouper, ConstraintSAT, pairing, 인코더 중복 |
| **B** API·계약 | M-19, M-20, M-21, M-22, **M-33**, **M-34** | 검색 스키마, 배치 집계, hybrid 이중 경로, resolve·requestId |
| **C** 데이터·eval | M-01, M-03, M-08, M-11 | ENTITY_TARGET_TYPE_MAP, 골든 파일명, `npm run eval` |
| **D** CI·도구 | M-12, M-13, M-14 | verify-splits, semgrep, e2e, lint, ESLint project |
| **E** 인프라·보안 | M-23–M-32, **M-35** | ONNX, Claude 도구, watchlist, injection, missingInformation |

---

## 이번 병렬 검증에서 다시 확인한 사실 (요약)

- `scripts/run-eval.ts` **부재** — `package.json` `"eval"` 깨짐 (**M-11**).
- `planner.ts`에 `producer_browse` / `region_browse` / `no_match_detection` **문자열 없음** (**M-02**).
- `mapping.ts`에 `critic_proxy` / `pairing_tags` / organic 등 **문자열 없음** — 스키마·도메인과 동기화 검토 (**M-17**, **M-25**).
- **§L(6차)**에서만 상세히 적었던 항목은 **M-33–M-35**로 매트릭스에 편입됨.

---

## 재현 커맨드

[`FINDINGS-MATRIX.md`](./FINDINGS-MATRIX.md) 하단 **재현 커맨드 묶음**과 동일. 추가로:

```bash
rg "RedisWatchlistSubscriber" src/interface/http/server.ts
head -25 src/application/search/hybrid.usecase.ts
head -25 src/application/search/resolve.usecase.ts
```
