# E1 — Retrieval Correctness

**목표**: 사용자 제약이 Vespa YQL로 빠짐없이 전달되고, 모든 인덱싱 채널이 실제로 쿼리에 기여하도록 한다.
**영향**: 검색 결과 품질 직결. 현재 region 필터, Doc2Query BM25, learned_sparse, 한국어 BM25 전량 사망.
**SOTA++ 방향**: constraint → token → YQL 파이프라인 완전성 보장 + Vespa rank profile 전채널 활성화.

---

## 버그 목록

| ID | 심각도 | 제목 | 파일 |
|----|--------|------|------|
| BUG-01 | 🔴 P0 | `region` positive filter 토큰 drop | `mapping.ts` |
| BUG-02 | 🔴 P0 | `synthetic_queries` Vespa 스키마 미선언 — Doc2Query 사망 | `vespa-schema.sd` |
| BUG-10 | 🟠 P1 | `oak_treatment`, `certifications`, `producer_type` 추출기 없음 | `rule-based-constraint-extractor.ts` |
| BUG-11 | 🟠 P1 | `hybrid`/`prestige` rank profile에서 `search_text_ko`/`search_text_en` 미활용 | `vespa-schema.sd` |
| BUG-14 | 🟠 P1 | lookahead 문자 클래스 오류 `(?!\p{L})(?!\p{N})` | `rule-based-constraint-extractor.ts:83` |
| W2-BUG-01 | 🔴 P0 | `learned_sparse` rank profile 주석 처리 — YQL reject | `vespa-schema.sd`, `candidate-pool.ts` |
| W2-BUG-06 | 🟡 P2 | `popularity_native` rank profile 선언만 있고 미사용 | `candidate-pool.ts` |
| W2-BUG-07 | 🟡 P2 | `wine_aware` rank profile 선언만 있고 미사용 | `vespa-schema.sd` |
| W2-BUG-08 | 🟠 P1 | fullwidth 문자 미처리 (Ａ-Ｚ, ａ-ｚ) NFKC 정규화 누락 | `unicode-normalize.ts` |
| RCA5-08 | 🔴 P0 | 빈 쿼리 배열 → 유효하지 않은 YQL 생성 | `candidate-pool.ts` |
| W3-03 | 🟠 P1 | `body`/`sweetness` 결측값을 `0`으로 처리 — "데이터 없음"과 "실제 0" 혼동 | `mapping.ts:396-397` |
| SCAN4-01 | 🔴 P0 | `sparseRank ∈ (0,1)` → popularity 점수 역전 — 순위 높을수록 점수 낮아짐 | `candidate-pool.ts` |
| IDX-04 | 🟠 P1 | grape varieties 응답 필드 누락 — Vespa 응답에서 grape 배열 미포함 | `mapping.ts` |
| IDX-05 | 🟠 P1 | acidity `hard`/`soft` YQL 분류 불일치 — constraint-compiler와 mapping.ts 기준 다름 | `constraint-compiler.ts`, `mapping.ts` |
| IDX-10 | 🟠 P1 | BM25 saturation 상수 불일치 — `k1` 값 2곳 서로 다름 | `vespa-schema.sd` |
| IDX-11 | 🟠 P1 | `critic_score` 0% coverage — Vespa 필드 인덱싱 미설정으로 BM25 미기여 | `vespa-schema.sd` |
| IDX-09 | 🟡 P2 | `wine_aware` rank profile 2024년 하드코딩 — 연도 갱신 안 됨 | `vespa-schema.sd` |
| IDX-12 | 🟡 P2 | `producerPrestige` coverage 낮음 — ETL 미입력 데이터 비율 높음 | ETL pipeline |
| SCAN4-05 | 🟠 P1 | "dry" 키워드 false positive — "dry white" 쿼리에서 sweetness 필터 오발동 | `rule-based-constraint-extractor.ts` |
| IDX-03 | 🟡 P2 | sensory 속성 척도 주석 오류 — "1-5 ordinal" 주석, 실제 구현은 [0,1] float | `ranked-result.ts:139-149` |
| IDX-07 | 🟡 P2 | `oak_treatment`/`certifications`/`producer_type` LLM_ALLOWED_ATTRIBUTES 미등록 — LLM emit 불가 | `llm-constraint-schema.ts` |
| IDX-08 | 🔴 P0 | Vespa rank profile `synthetic_queries` BM25 가중치 선언되어 있으나 스키마 필드 없음 → 무시/에러 (BUG-02와 연계) | `vespa-schema.sd` |
| W2-01 | 🟠 P1 | `SOFT_CONSTRAINT_ATTRIBUTES` 5개 누락 → 하드 필터 오분류 (BUG-15와 연계, 별도 발생지) | `constraint-compiler.ts` |

---

## RCA 요약

### BUG-01: region single-value filter drop
토큰 생성(`constraint-to-sparse-filter-tokens.ts:66`)은 정상. `mapping.ts` switch에 `case 'region':` 없음.
- multi-value(`region_in:`) → default case → 정상 ✓
- negation(`region_not:`) → explicit case → 정상 ✓
- **single-value(`region:`) → default → 스킬런트 드롭** ✗

### IDX-08: synthetic_queries BM25 가중치 선언 vs 스키마 미선언

`vespa-schema.sd`의 `lexical` rank profile에 `bm25(synthetic_queries) * 0.6` 선언.
그러나 `synthetic_queries` 필드 자체가 스키마에 없음 → Vespa가 표현식 무시 또는 에러.
BUG-02 수정(필드 선언 추가) 시 자동 해소. BUG-02와 함께 처리.

### BUG-02: Doc2Query 완전 사망
`mapping.ts:308-310` serialize 코드 존재, `retrieval-document.ts:122` 모델 선언 존재.
`vespa-schema.sd`에 `synthetic_queries` 필드 선언 없음 → Vespa 인덱싱 안 됨.
**추가**: 스키마 추가 후 `bm25` rank profile에도 `bm25(synthetic_queries)` 가중치 추가해야 실제 매칭에 사용됨.

### W2-BUG-01: learned_sparse 채널
`candidate-pool.ts`에서 `learned_sparse` rank profile이 주석 처리 → 호출 시 Vespa YQL reject → 채널 전체 사망.

### SCAN4-01: sparseRank 인기도 역전

`candidate-pool.ts`의 popularity 신호: `sparseRank` 가 `(0,1)` 범위 float로 계산됨.
의도: rank 1 → 점수 높음. 실제: `rank ∈ (0,1)` → `1/rank > 1` → 낮은 순위가 더 높은 점수.
Vespa `rank()` 함수 반환값이 1-based integer가 아니라 normalized float임을 고려 안 함.

### IDX-05: acidity 분류 불일치

`constraint-compiler.ts`는 `acidity`를 soft constraint로 처리.
`mapping.ts` switch에서는 `acidity`가 range filter(hard)로 변환.
두 레이어 간 의도 불일치 → acidity 제약이 hard YQL과 soft penalty 양쪽에서 이중 처리.

### SCAN4-05: "dry" false positive

`rule-based-constraint-extractor.ts`: `"dry"` 단독 매칭.
"dry white wine", "dry rosé" 등 적법한 쿼리에서 `sweetness:dry` 단독 추출.
"dry" 뒤에 색상/유형 키워드가 붙는 패턴과 혼동. 경계 테스트 없음.

### RCA5-08: 빈 쿼리 배열
특정 조건에서 sparse query 배열이 비어있는 상태로 YQL 생성 → `where ()` 형태의 invalid YQL → Vespa 500.

---

## 구현 계획

### Phase 1 — 즉시 fix (P0, 코드 1-3줄)

**E1-P0-0**: `sparseRank` popularity 역전 수정 (SCAN4-01)
```typescript
// candidate-pool.ts — sparseRank 계산 위치
// 변경 전: score = sparseRank (0~1 float, rank 낮을수록 값 높아짐)
// 변경 후:
const popularityScore = 1 - sparseRank; // rank 0.0 → score 1.0 (최상위)
```
또는 Vespa `rank()` 반환이 1-based integer라면 `1 / (1 + sparseRank)` 패턴 적용.
**테스트**: rank=0.1 (높은 인기) → score > rank=0.9 (낮은 인기) 검증.


**E1-P1-1**: `mapping.ts` region case 추가
```typescript
case 'region':
  clauses.push(`region contains ${yqlString(value)}`);
  break;
```
테스트: `region = 'Burgundy'` → YQL에 `region contains "Burgundy"` 확인.

**E1-P1-2**: `learned_sparse` rank profile 주석 해제
`candidate-pool.ts`에서 주석 해제 + YQL 템플릿 검증.

**E1-P1-3**: 빈 쿼리 배열 가드
YQL 생성 전 `if (terms.length === 0) return null` 가드 추가.

### Phase 2 — 스키마 + rank profile (P0~P1)

**E1-P2-1**: `synthetic_queries` 스키마 + rank profile
```
field synthetic_queries type array<string> {
  indexing: summary | index
}
```
`bm25` profile: `bm25(canonical_label) + bm25(search_text_ko) + bm25(search_text_en) + 0.5 * bm25(synthetic_queries)`
(0.5 가중치는 eval sweep 후 튜닝)

**E1-P2-2**: `hybrid`/`prestige_hybrid` profile에 `search_text_ko`/`search_text_en` 추가
현재 `canonical_label`만 BM25. 한국어 쿼리에서 tasting note, 설명 매칭 안 됨.

**E1-P2-3**: lookahead 문자 클래스 수정
`(?!\p{L})(?!\p{N})` → `(?![\p{L}\p{N}])` + 경계 테스트 추가.

### Phase 3 — 추출기 확장 (P1~P2)

**E1-P3-1**: `oak_treatment`, `producer_type` rule-based 패턴 추가
- "오크 숙성 안 한", "스틸 발효", "stainless" → `oak_treatment:none`
- "소규모 도메인", "가족 소유", "family estate" → `producer_type:domaine`
- `llm-constraint-schema.ts` LLM_ALLOWED_ATTRIBUTES에 추가

**E1-P3-3**: acidity 분류 불일치 수정 (IDX-05) ⚠️ E5-P2-1 완료 후 진행
`constraint-compiler.ts`와 `mapping.ts` 간 acidity 처리 방식 합의.
SOFT_CONSTRAINT_ATTRIBUTES SSoT(E5-P2-1)와 연동하여 single source에서 결정.
**선행 조건**: E5-P2-1 (`constraint-attributes.ts` SSoT 모듈) 완료 필수.

**E1-P3-4**: "dry" false positive 수정 (SCAN4-05)
```typescript
// 변경 전: /\bdry\b/
// 변경 후: /(?:^|[^\p{L}\p{N}])dry(?!\s+(?:white|red|rosé|rose|wine))(?=$|[^\p{L}\p{N}])/u
```
false-positive 테스트: "dry white", "dry rosé", "bone dry finish" 모두 통과.

**E1-P3-5**: `IDX-09` wine_aware 2024 하드코딩 제거
`vespa-schema.sd`의 2024 연도 상수 → config 또는 현재 연도 기반 계산.

**E1-P3-6**: BM25 saturation 상수 통일 (IDX-10)
`k1` 값을 `vespa-schema.sd` 내 SSoT 상수로 추출, 모든 rank profile에서 참조.

**E1-P3-7**: W3-03 body/sweetness 결측값 0 → null 구분 수정
```typescript
// mapping.ts:396-397
// 변경 전: body: wine.body ?? 0  (0은 "가장 라이트" 의미, 결측과 동일 취급)
// 변경 후:
body: wine.body != null ? wine.body : undefined,  // 결측은 필드 자체 생략
sweetness: wine.sweetness != null ? wine.sweetness : undefined,
```
Vespa에서 필드 부재 vs 값=0을 구분하여 BM25/filter 처리 정확도 향상.
Rule 26 (value || default → null/undefined 구분) 적용.

**E1-P3-8**: IDX-03 척도 주석 수정
`ranked-result.ts:139-149` 주석 "1-5 ordinal scale" → "[0,1] normalized float (normalizeScale(x, max=5))" 정정.

**E1-P3-9**: IDX-07 oak_treatment/certifications LLM schema 등록
`llm-constraint-schema.ts`의 `LLM_ALLOWED_ATTRIBUTES`에 `oak_treatment`, `certifications` 추가.
테스트: LLM이 `oak_treatment: "none"` emit 시 tool validation 통과.

**E1-P3-2**: fullwidth NFKC 정규화
`unicode-normalize.ts`에 NFKC normalization 추가 (Node.js `str.normalize('NFKC')`).

**E1-P3-3**: `popularity_native`/`wine_aware` rank profile 활성화 또는 삭제 결정

---

## 완료 기준 (Definition of Done)

- [ ] `region:Barolo` → Vespa YQL에 `region contains "Barolo"` 포함됨 (integration test)
- [ ] `synthetic_queries` 필드 인덱싱 확인 + `bm25` profile에서 매칭됨
- [ ] `learned_sparse` 채널 쿼리 성공 (Vespa 400/500 없음)
- [ ] 빈 쿼리 배열 → graceful skip (Vespa 에러 없음)
- [ ] `search_text_ko` BM25 hybrid profile에 기여 확인
- [ ] fullwidth "Ａ" → "A" 정규화 테스트 통과
- [ ] `sparseRank` popularity 역전 수정 — rank 낮을수록 score 높음 확인
- [ ] "dry white wine" 쿼리 → sweetness 필터 오발동 없음
- [ ] `acidity` 분류 — constraint-compiler와 mapping.ts 일치 확인 (E5-P2-1 완료 후)
- [ ] `body`/`sweetness` = 0 와인 → Vespa 필드 값 0 저장 (undefined 아님), 결측은 필드 생략
- [ ] IDX-07: LLM `oak_treatment` emit → tool validation 통과
- [ ] BUG-14: lookahead 문자 클래스 수정 — ASCII/한글/악센트 경계 테스트 통과
- [ ] recall@20 현재 대비 +5% 이상 (eval sweep 기준)
