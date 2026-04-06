# bugbash-apr-6

`docs/plans/apr-5-v0.1`·`apr-5-v0.2`·`apr-6-v0.3`(Epic 18) 및 실제 코드·CI·`package.json`을 대조한 **빵꾸(갭)·보완점** 기록소입니다.

## SSOT (어디를 보나)

| 우선순위 | 파일 | 내용 |
|----------|------|------|
| **한 줄 색인** | [`GAPS.md`](./GAPS.md) | `G-xx` ID ↔ 한 줄 요약 ↔ `BACKLOG`/`TASKS` 조항 |
| **병렬 매트릭스 (파일·명령)** | [`FINDINGS-MATRIX.md`](./FINDINGS-MATRIX.md) | **`M-xx`** 행 — 코드·CI·스키마 대조 **SSOT** |
| **영역 색인** | [`AUDIT-SNAPSHOT.md`](./AUDIT-SNAPSHOT.md) | A–E 영역 ↔ `M-xx` ID만 묶기 (표 본문은 매트릭스) |
| **플랜 전체 매트릭스** | [`PLANS-GAP-AUDIT.md`](./PLANS-GAP-AUDIT.md) | v0.1+v0.2+v0.3(Epic 18) 표 + **`[ ]` vs 코드 드리프트** 절 + 재현 `rg` |
| **상세·재현 커맨드** | [`TASKS.md`](./TASKS.md) | 심화 A–F, §G–§I, §K, §L, **§M**(injection), **§N**(CORS·rate·OpenAPI), **§P**(watchlist/runtime) |
| **v0.1 플랜 대비 본문** | [`BACKLOG.md`](./BACKLOG.md) | P0–P2, §12–**55**, 제안 작업 순서 |
| **실행·테스트 로그** | [`AUDIT-LOG.md`](./AUDIT-LOG.md) | 날짜별 `npm run`·`rg` 근거 |
| **병렬 점검 한 장 표** | [`FINDINGS-MATRIX.md`](./FINDINGS-MATRIX.md) | `M-xx` ↔ `G-xx` ↔ `BACKLOG` § — 파일·라인·재현 커맨드 |

**새 빵꾸를 남길 때:**  
1) `BACKLOG.md`에 번호(§)와 근거 파일을 추가하거나, 이미 있으면 `TASKS.md` 해당 절에만 보강.  
2) `GAPS.md`에 `G-xx` 한 줄 추가.  
3) 검증했다면 `AUDIT-LOG.md`에 명령·결과 한 블록.  
4) **`docs/plans` 에픽 단위**로 보이면 [`PLANS-GAP-AUDIT.md`](./PLANS-GAP-AUDIT.md) 표의 해당 행도 갱신.  
5) 플랜 문서의 `- [ ]`만 과거로 남았으면 같은 파일의 **「체크리스트 드리프트」** 절을 먼저 기준으로 본다. 여기서 `- [ ]`는 코드 부재가 아니라 문서 잔상일 수 있다.

## 병렬 검증 체크리스트 (재사용)

아래를 한 번에 돌려 빈틈 후보를 수집할 수 있다.

```bash
# npm eval 스크립트 (과거 run-eval.ts 가정은 폐기)
cat package.json | jq '.scripts.eval'
test -f scripts/eval/run-offline-eval.ts && echo "run-offline-eval.ts ok" || echo "MISSING run-offline-eval.ts"

# 플랜 대비 미구현 심볼
rg -l "ConstraintSAT|AbstainPolicy|constraint-sat|abstain-policy" src || true
rg "producer_browse|region_browse|no_match_detection" src/domain/query/service/planner.ts

# v0.2 스키마 ↔ 매핑
rg "critic_proxy|pairing_tags|organic|biodynamic" src/infrastructure/vespa/mapping.ts || true

# 배선 끊김
rg "extractPairingConstraint" src --glob "*.ts" | grep -v pairing-extractor || true
rg "ResultGrouper" src --glob "*.ts"
rg "BrowseRetriever|CompareRetriever" src/application src/interface || true

# 워치리스트·Redis
rg "RedisWatchlistSubscriber" src/interface/http/server.ts || true
rg -i watchlist src/infrastructure/db/migrations || true

# 계약 불일치
rg "max\(2000\)" src/interface/http/schemas/search.schema.ts
rg "MAX_QUERY_LENGTH" src/domain/security/service/query-sanitizer.ts

# CI
rg "verify-splits" .github || true

# Epic 16: injection 방어가 SearchUseCase에만 있는지
rg "QuerySanitizer|querySanitizer|injectionJudge" src/application --glob "*.ts"

# §39–41: CORS / OpenAPI / rate limit env
rg -i cors src || true
rg -i "openapi|swagger" src || true
rg HTTP_RATE_LIMIT src/config/env.ts
```

## 문서 간 대응 (요약)

| `TASKS` | `BACKLOG` | 주제 |
|---------|-----------|------|
| §H 표 | §34–37 | watchlist ID/Redis/DB, `drinking_window_now` NL, `EVAL_RUN_AT_STARTUP` |
| §K 표 | §31–33 | ~~`npm run eval` 깨짐~~ → **`run-offline-eval.ts` OK** (`G-04` 해소); pairing 미배선, `WineAttributeEncoders` 이중 정의 |
| §G (24–30) | §24–30 | 쿼리 길이, `missingInformation`, Vespa LTR, 비교 테이블, entropy, injection fail-open 등 |
| §M (7차) | §38 · **G-40** | Epic 16: `Hybrid`/`Interpret`/`Resolve`에 `QuerySanitizer` 없음 — **injection 우회** |
| §N (8차) | §39–41 · **G-46–G-48** | CORS 없음 · `HTTP_RATE_LIMIT_MAX=0` 시 rate limit off · OpenAPI 없음 |
| P0–P2 본문 | §1–23 | 골든·플래너·browse·eval·린트 등 초기 감사 |

---

**최종 갱신:** 2026-04-06 — **6차:** Epic 9·eval·v0.3 Epic 18 [`PLANS-GAP-AUDIT.md`](./PLANS-GAP-AUDIT.md) · **G-04** 해소 · 체크리스트 드리프트 판독 규칙 보강 · 9차 ID **G-60–G-63** 정리. (이전: `M-01`…`M-40` · **G-55·G-56** · Epic 15 **G-45** 등.)
