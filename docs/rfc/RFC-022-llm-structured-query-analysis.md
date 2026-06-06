# RFC-022 — LLM-Structured Query Analysis with Deterministic Tool Dispatch

**상태**: Draft
**작성일**: 2026-06-06
**상위·연관 문서**
- `RFC-005` — Query planner·Policy compiler (`WineSearchAnalysis` → plan)
- `RFC-004` / `RFC-019` — Attribute/constraint 정규화·ontology-grounded constraint compiler
- `RFC-020` — Constraint Extraction Measurement Framework (이 RFC의 회귀 게이트)
- `RFC-021` — Primitive Search Surface and Agent-Orchestrated Query Composition (agent/search 경계)
- `RFC-008` / `RFC-016` — Response·Evidence·Admission Gate (anti-hallucination·degraded 계약)
- `RFC-015` — Determinism, Replay, kill switch
- `RFC-000` — Master Architecture

**충돌 시 `RFC-021` agent/search 경계, `RFC-016` admission/anti-hallucination, `RFC-000` SSOT가 우선한다.**

---

## 0. 한 줄 방향

> **분석(analyze) 단계를 deterministic-first에서 LLM-structured-first로 승격한다. 단 LLM은 typed `WineSearchAnalysis`만 생성하고, 도구 선택은 계속 `DeterministicRouter`가 한다. 그리고 검색이 0건이면 fail-closed로 끝내지 말고, bounded recovery + LLM advisory로 사용자에게 응답한다.**

이 RFC는 ReAct/function-calling 으로의 회귀가 **아니다**. LLM에게 도구 리스트를 주고 고르게 하지 않는다. LLM은 "이 쿼리가 무엇을 의미하는가"를 typed contract로 뽑을 뿐이고, "어떤 도구를 어떻게 부를지"는 여전히 deterministic plan이 소유한다. RFC-021이 세운 **agent/search 경계와 PtE 결정성**을 유지한 채 NLU 강건성만 끌어올린다.

---

## 1. Problem Statement

### 1.1 관측된 실패

실 LLM(OpenAI) + EC2 Vespa 풀스택에서 agent use-case(`AgentUseCasePort.run()`, HTTP `/v1/agent`와 동일 코어)로 다음을 호출:

```
query: "5만원이상 오푸스말고 다른 와인줘봐"
→ runner tool_call: search_hybrid { query: "5만원이상 오푸스말고 다른 와인줘봐", limit: 100 }   # filters 비어있음
→ Blocker returned 0 candidates
→ answer: "추천 가능한 와인이 없습니다."
```

심지어 깨끗한 쿼리에서도 동일:

```
query: "레드 와인 추천해줘"
→ search_hybrid { ..., filterCount: 1 }
→ Blocker returned 0 candidates
→ answer: "추천할 수 있는 레드 와인이 없습니다."
```

### 1.2 근본 원인 — 두 층

**(A) 분석이 deterministic-first다.** [`query-analyzer.ts`](../../src/application/wine-search/query-analyzer.ts) 계약:

> *"It is deterministic by default; an optional `StructuredLlmPort` is invoked **only** when the deterministic pipeline produces no signal at all (no anchors, no constraints, intent=unknown)."*

`"5만원이상 오푸스말고 다른 와인줘봐"`는 deterministic 추출기가 `intent=search`라는 **신호는 찾는다**. 따라서 LLM 분석 fallback은 **호출되지 않는다**. 그런데 deterministic 추출기는 `5만원 이상`(가격 하한)·`오푸스 말고`(엔티티 배제)를 typed constraint로 뽑지 못한다 → `WineSearchAnalysis.constraints`가 비어 있음 → `search_hybrid` filters 비어 있음 → 검색 0건.

중요: **제약 어휘는 이미 충분하다.** [`constraint-bundle-schema.ts`](../../src/domain/shared/types/constraint-bundle-schema.ts)의 `ConstraintOperatorSchema`는 `>=`, `range`, `exclude`, `not_in`을 이미 지원한다. 빠진 것은 **표현력이 아니라 추출**이다. → B방향(LLM이 기존 스키마로 typed 제약을 생성)이 정확히 들어맞는다.

**(B) 빈 결과에서 fail-closed.** retrieval이 0 후보를 주면 synthesizer는 [`synthesis-fallback-templates.ts`](../../src/application/wine-search/synthesis-fallback-templates.ts)의 "찾지 못했습니다" 템플릿으로 닫는다. LLM은 환각 방지(RFC-008/016) 때문에 없는 와인을 지어내지 않는데 — 이건 옳다 — 그러나 **사용자에게 아무 도움도 주지 못한 채 끝난다.** "어떤 조건이 막았는지", "조건을 어떻게 풀면 되는지"조차 말하지 않는다.

### 1.3 왜 deterministic NLU 보강(방향 A)으로는 부족한가

가격·부정 한국어 패턴을 deterministic 추출기에 추가할 수는 있다(RFC-019의 일부). 그러나 `줘봐`, `말고`, `~이상`, 어순 변형, 혼합 의도 같은 long-tail 조합은 규칙 기반으로는 영구히 샌다. RFC-020 측정 프레임워크가 보여주듯 커버리지 곡선은 점근적이다. LLM 구조화 추출은 이 long-tail을 일반화로 흡수한다.

---

## 2. Non-Goals

- **function-calling/ReAct 도입 아님.** LLM은 도구를 고르거나 도구 인자를 직접 만들지 않는다. typed analysis만 만든다.
- **ranking/fusion/rerank/identity resolution 권한 이동 아님.** 그것들은 RFC-012/013/006 search core authority로 남는다 (RFC-021 §0 불변).
- **환각 허용 아님.** 빈 결과 advisory는 **구체적 entity를 절대 지어내지 않는다** (RFC-016).
- public `/v1/search/*` primitive의 의미 해석 권한을 늘리지 않는다 (RFC-021: primitive는 deterministic 유지). 이 RFC는 **agent 분석 단계**에만 적용된다.

### 2.1 LLM Role Boundary (불변 — 이 RFC의 1급 invariant)

> **LLM must never influence execution planning or tool selection.**
> **LLM output is treated as an untrusted semantic annotation layer.**

이 구조는 ReAct agent가 아니라 **"deterministic loop + LLM semantic compiler"** 다.

LLM이 **하는 것** (semantic compiler):
- constraint extraction (가격·부정·스타일 → typed `NormalizedConstraint`)
- ambiguity resolution (의미 해석)
- explanation generation (검색 실패 설명, §3.8)

LLM이 **절대 하지 않는 것** (deterministic FSM 소유):
- 도구 선택 / 도구 인자 직접 생성
- retry 여부 결정
- relaxation 전략 선택
- plan/route 결정

위반은 RFC-021 경계·PtE 결정성·replay 가능성을 동시에 깨므로 컴파일/리뷰 단계에서 거부한다.

---

## 3. Design

### 3.1 분석 단계 승격: deterministic-first → LLM-structured-first (deterministic floor)

`QueryAnalyzerService.analyze()`의 호출 순서를 뒤집는다.

**기존:**
```
deterministic 추출 → (신호 0일 때만) LLM fallback → WineSearchAnalysis
```

**신규:**
```
deterministic 추출 (floor, 항상 실행)
  ∥
LLM 구조화 추출 (StructuredLlmPort, WineSearchAnalysisSchema 강제)
  ↓
merge pipeline (§3.3 고정 순서)  →  WineSearchAnalysis (typed, 검증됨)
```

규칙:
1. **LLM은 typed contract만 생성** (§2.1 boundary). 출력은 `WineSearchAnalysisSchema`로 검증. partial validity는 §3.5 drop-only 규칙으로 처리.
2. **merge는 deterministic을 floor로 둔다.** deterministic이 확정한 identity 증거는 LLM이 덮어쓸 수 없다 (§3.4 precedence table). LLM은 비어 있는 칸을 채우거나 정책이 허용한 곳에만 기여한다.
3. **도구 선택은 LLM이 하지 않는다.** merge된 `WineSearchAnalysis`는 그대로 [`DeterministicRouter`](../../src/application/wine-search/deterministic-router.ts)로 들어가고, "same analysis → same plan" 불변을 유지한다.

```
analyze(LLM-structured + deterministic floor)
  → WineSearchAnalysis (intent + NormalizedConstraint[])
  → DeterministicRouter  (LLM 아님)   → ExecutionPlan
  → ExecutionRunner      (search_hybrid 등)
  → SynthesisRunner (LLM)             → answer
```

### 3.2 Constraint Tier Registry (hard/soft SSoT)

hard/soft가 RFC마다 암묵적이던 문제를 닫는다. tier 판정은 **이 레지스트리 단일 출처**로만 한다. S1 relaxation(§3.7)은 **오직 이 레지스트리 기반**으로 동작한다.

```
ConstraintTierRegistry {
  HARD:                          # 사용자가 명시한 제약 — relaxation이 절대 풀지 않음
    - price            (>=, <=, range)
    - entity_exclusion (exclude, not_in)
    - region_restriction  (단, "명시적"일 때만 — 예: "보르도만")
    - vintage          (명시적 연도/범위)

  SOFT:                          # 선호 — relaxation 1순위 완화 대상
    - taste            (당도·산도·바디·탄닌)
    - food_pairing
    - rating_preference
    - style_description
}
```

- attribute → tier 매핑은 deterministic 함수이며 모듈 스코프 `const`로 고정(CLAUDE.md rule 16).
- LLM이 tier를 제안해도 **레지스트리가 최종 권위**다. LLM tier는 무시되거나 hint로만 쓴다(절대 hard↔soft 승격/강등 권한 없음).
- "region_restriction이 explicit인가"의 판정은 deterministic(명시적 지역 토큰 존재 여부) — 모호하면 SOFT로 강등(보수적).

### 3.3 Merge Pipeline — 고정 순서 (replay 필수)

merge는 **이 6단계 순서로만** 실행한다. 순서 고정이 replay 가능성의 전제다.

```
1. deterministic extract        # floor — 항상 먼저, identity/anchor 확정
2. LLM extract                  # untrusted semantic annotation
3. canonicalization (RFC-004)   # 통화·단위·alias 정규화 ("5만원"→50000, "오푸스"→opus-one)
4. constraint tier tagging      # §3.2 registry로 hard/soft 부착 (LLM tier 무시)
5. conflict resolution          # §3.4 ConstraintPrecedencePolicy
6. final validation (schema)    # WineSearchAnalysisSchema 최종 검증
```

각 단계는 순수 함수. 1·3·4·5·6은 deterministic, 2만 LLM(캐시 가능 §3.11). 동일 입력 + 동일 LLM 캐시 → 동일 출력.

### 3.4 Conflict Resolution — ConstraintPrecedencePolicy (필수 규칙표)

merge 충돌의 silent drift를 막는 단일 규칙표. attribute class별 병합 규칙:

```
ConstraintPrecedencePolicy {

  identity  (producer, wine, entity_id, anchor)
    → DETERMINISTIC ONLY.  LLM overwrite 금지. (RFC-006 identity 안전성)

  price
    → deterministic WINS if exists,  else LLM allowed.

  exclude   (not_in, exclude entity)
    → UNION,  but validated:  dedupe + canonical mapping (RFC-004).
       (deterministic 배제 ∪ LLM 배제, canonical id로 정규화 후 중복 제거)

  range     (price range, vintage range)
    → INTERSECTION (safe clamp).
       (두 출처의 범위 교집합 — 더 좁은 쪽으로 안전하게 수렴)

  soft attributes (taste, pairing, style, rating)
    → LLM allowed UNLESS deterministic exists.
}
```

핵심:
- **identity = 절대 불변** (deterministic only).
- 나머지는 "merge 규칙이 명시적으로 존재" — 암묵적 last-writer-wins 금지.
- `exclude` UNION은 반드시 canonical mapping 후 dedupe (그러지 않으면 "오푸스"/"opus one"/"opus-one"이 별개 배제로 남음).
- `range` INTERSECTION은 빈 구간이 나오면(min>max) constraint-bundle-schema의 기존 swap/normalize 규칙을 따르되, **진짜 공집합이면 over-constrained 신호**로 §3.7 loop에 전달.

### 3.5 LLM Partial Validity — drop-only 전략

`safeParse` all-or-nothing 폴백을 버린다. LLM 출력을 constraint 단위로 분해 검증한다.

```
LLMAnalysisResult {
  valid_constraints:   Constraint[]   # 스키마 통과
  invalid_constraints: Constraint[]   # 스키마 위반 → drop
  hallucinated_fields: string[]       # 스키마 외 필드 → 로깅 후 무시
}
```

처리 규칙:
- **invalid constraint → 해당 constraint만 drop** (전체 폴백 아님).
- **valid constraint → keep** (canonicalization·tier·conflict 단계로 진행).
- **전체가 비었을 때만** deterministic-only 폴백.

효과: LLM이 한 필드를 잘못 내도 시스템이 죽거나 전부 버리지 않는다. valid 부분은 살린다.

### 3.6 추출 대상 — 기존 제약 어휘 재사용

`"5만원이상 오푸스말고 다른 와인줘봐"`의 목표 분석(canonicalization·tier 부착 후):

```jsonc
{
  "intent": "search",
  "constraints": [
    { "attribute": "price_krw", "operator": ">=",      "value": 50000,     "tier": "hard", "extractor": "llm", "source_phrase": "5만원이상" },
    { "attribute": "entity",    "operator": "exclude",  "value": "opus-one", "tier": "hard", "extractor": "llm", "source_phrase": "오푸스말고" }
  ]
}
```

- 가격: `>=` / `range` — 기존 operator. 통화 정규화(`5만원`→`50000`)는 RFC-004(merge §3.3 step 3).
- 부정/배제: `exclude` / `not_in` — 기존 operator. canonical mapping 후 UNION(§3.4).
- `줘봐`/`추천`: 콜로퀴얼 noise는 span 제거(RFC-019).
- **새 제약 타입 없음** — `NormalizedConstraintSchema` 그대로.

### 3.7 Bounded FSM Recovery Loop (empty/over-constrained 회복)

0건/저품질에서 fail-closed 하지 않는다. **deterministic state machine이 통제하는 bounded loop**로 회복한다. LLM은 loop를 driving하지 않는다(§2.1).

```
STATE 0: ANALYZE      (LLM semantic compile + deterministic floor)
   ↓
STATE 1: PLAN         (DeterministicRouter — LLM 아님)
   ↓
STATE 2: EXECUTE      (search_hybrid 등)
   ↓
STATE 3: EVALUATE     (result quality check — deterministic)
   ├── good            → SYNTHESIS → END (grounded=true)
   ├── empty/poor      → RELAX (deterministic step fn) → back to STATE 1
   └── max retry 도달  → EXPLANATION (§3.8) → END (grounded=false)
```

**Loop 불변 (RFC-015):**
- `max_iterations = 2` (초기값; 2~3 범위, config 상수).
- `hard_constraints_never_relaxed = true`.
- loop trigger는 **단 2개**: (A) empty result, (B) low quality(optional, 초기엔 off).
- 모든 budget 체크는 EXECUTE(비싼 연산) **앞**에 둔다(CLAUDE.md rule 20, pre-flight).
- relaxation·retry 여부·전략은 **전부 deterministic FSM** 소유 — LLM 금지.

**RELAX = 명시적 step function (한 번에 1 step):**
```
RelaxationSteps = [
  step1: remove soft constraints only,                       # §3.2 SOFT만
  step2: widen numeric ranges (±20~30%, soft range만),
  step3: remove least-impactful hard-adjacent constraint     # optional, policy-gated, 기본 off
]
```
- 한 iteration에 **정확히 1 step**만 적용. 무한 루프 금지.
- step3(hard-adjacent 완화)은 기본 비활성 — 사용자 명시 제약 보호. 활성화는 별도 정책 플래그 + 응답에 명시 고지.

### 3.8 S2 = Failure Explanation Layer (recommend 아님)

S2를 "advisory 추천"이 아니라 **검색 실패 설명 레이어**로 못박는다. LLM은 추천자가 아니라 **검색 실패 디버거**다.

**❌ 금지 의미**: recommend / suggest wine / 구체 와인명·entity_id 생성.
**✔️ 정식 출력**:
```jsonc
{
  "type": "explanation",
  "grounded": false,
  "reason": "constraint_overconstrained",
  "blocked_by": ["price>=50000", "exclude:opus-one"],
  "suggested_relaxations": [
    "price >= 30000",
    "remove brand exclusion"
  ]
}
```

- `blocked_by`·`suggested_relaxations`는 **deterministic FSM이 계산한 사실**(어떤 제약이 결과를 0으로 만들었는지) — LLM은 이를 자연어로 표면화만 한다.
- LLM이 `suggested_relaxations`를 발명하지 않는다(FSM이 step function에서 산출한 것만 표면화).
- 구체 entity 생성 시 RFC-016 위반 → 부정 테스트로 게이트(§4).
- 응답 meta: `grounded:false`, `degraded_reason:"constraint_overconstrained"` (RFC-016 FailureReason SSOT 정합).

이로써 사용자는 "추천 가능한 와인이 없습니다" 대신 **"5만원 이상 + 오푸스 제외 조건에서 결과가 없습니다. 가격을 3만원 이상으로 낮추거나 브랜드 제외를 빼보세요"** 같은 **행동 가능한** 응답을 받는다.

### 3.9 Multi-turn — Session State Mutation (같은 loop 재실행)

multi-turn은 turn별 독립 실행이 **아니다**. session-level constraint state를 **mutate**하고 **같은 FSM loop를 재실행**한다.

```
WineSessionState {
  constraints: Constraint[]    # 누적·변형되는 제약 집합
  intent: "search"
  history: Query[]
  iteration: number
}
```

```
Turn 1: "5만원 이상 와인 추천"   → state.constraints += {price>=50000}
Turn 2: "좀 더 가벼운 걸로"      → state.constraints 수정 (body=light 추가/갱신)
Turn 3: "오푸스 말고"            → state.constraints.exclusion += opus-one
        → 매 turn: 갱신된 state로 STATE 0~ FSM loop 재실행
```

규칙:
- single-turn = fresh state. multi-turn = state mutation.
- turn 입력은 **새 제약을 기존 state에 merge**(§3.3~3.4 동일 pipeline·precedence 재사용) — 충돌 시 동일 precedence table 적용.
- state는 `AgentSessionService`/세션 스토어(기존 multi-turn 인프라)에 보관.
- **identity·hard 제약 보호 규칙은 turn 간에도 동일** — 후속 turn LLM이 이전 turn의 deterministic identity를 덮어쓰지 못함.

통합 흐름:
```
User Input → Session State Update → ANALYZE → [Bounded FSM Loop §3.7] → Response
                                                  (필요 시 RELAX 후 state 반영)
```

### 3.10 계약·스키마 변경

1. **`WineSearchAnalysisSchema`** — LLM 구조화 출력 타깃. LLM 입력 스키마는 `.strict()` 금지(CLAUDE.md rule 10 예외). 출력은 §3.5 drop-only로 constraint 단위 검증.
2. **`AnalysisOutcome`** — `source: 'deterministic' | 'llm-merged' | 'deterministic-fallback'` provenance.
3. **constraint provenance** — 각 constraint에 `extractor: 'deterministic' | 'llm'` 태그(RFC-020 측정).
4. **응답 meta** — `grounded: false`, `degraded_reason: 'constraint_overconstrained'`, explanation payload(§3.8). RFC-008/014 envelope·RFC-016 FailureReason SSOT 정합. eval-only 필드 wire 누출 금지(stripEvalOnlyFields).
5. **`WineSessionState`**(§3.9) — 세션 스토어 스키마 확장.

### 3.11 결정성·Replay·Kill switch (RFC-015)

- LLM 분석(merge step 2)은 비결정적 → **분석 결과를 정규화 쿼리 키로 snapshot/replay 캐시**. 동일 쿼리 → 캐시된 `WineSearchAnalysis` 재사용(결정적 재현).
- merge step 1·3·4·5·6과 FSM loop(§3.7)·relaxation step function은 **전부 deterministic** → loop 자체가 replay 가능.
- **deterministic floor 상시 존재** → LLM unavailable 시 deterministic-only로 정확히 폴백(회귀 0, 'LLM down → honest fail' 정합).
- kill switches: `killSwitchLlmAnalysis`(true → deterministic-only 분석), `killSwitchRecoveryLoop`(true → S1/S2 끄고 기존 fail-closed). 둘 다 즉시 현행 동작 복귀.

---

## 4. Eval & 회귀 게이트 (RFC-020)

- **Golden set**: 복합·콜로퀴얼 한국어 쿼리 추가 — 가격(`N만원 이상/이하/대`), 부정(`A 말고`, `A 빼고`), 혼합(`스테이크에 어울리는 5만원대 레드`), noise(`줘봐`, `추천좀`).
- **메트릭**:
  - constraint extraction recall/precision (RFC-020) — deterministic 대비 LLM-merged 향상치.
  - empty-rate (0건 응답 비율) — 하락이 목표.
  - **wrong-resolve rate = 0 불변** — advisory가 절대 틀린 entity를 확정하지 않음 (회귀 시 즉시 실패).
  - p50/p95 latency — LLM 분석 1콜 추가분 추적.
- **부정 테스트**(CLAUDE.md rule 23): "오푸스 말고"가 Opus One을 결과에서 배제하는지 + 정상 와인은 막지 않는지.
- **한글 regex 안전**(rule 8/24): 가격·부정 패턴 추출 시 `\b` 금지, `\p{L}\p{N}` 경계 + `/u`.
- **Conflict resolution 단위 테스트**(§3.4): identity=deterministic-only 보존, exclude UNION+dedupe(canonical), range INTERSECTION(공집합 → over-constrained 신호), price deterministic-wins. 각 class별 2+ 입력.
- **Partial validity 테스트**(§3.5): 일부 invalid constraint 입력 → valid만 keep, 전부 invalid → deterministic 폴백. drop-only 경로 검증.
- **Explanation Layer 테스트**(§3.8): 0건 → `type:explanation`, `grounded:false`, `blocked_by`/`suggested_relaxations`가 FSM 산출값과 일치, **entity_id/와인명 생성 0건**(환각 게이트).
- **FSM loop 경계 테스트**(§3.7): `max_iterations` 도달 시 정확히 종료(루프 무한 금지), hard 제약이 relaxation 후에도 보존, budget 체크가 EXECUTE 앞(rule 20).
- **Multi-turn state 테스트**(§3.9): Turn 누적 제약 mutation, 후속 turn이 이전 deterministic identity를 덮어쓰지 못함, 동일 precedence table 적용.

---

## 5. Rollout

1. **Phase 0** — `WineSearchAnalysisSchema` LLM 출력 검증(§3.5 drop-only) + provenance/tier registry(§3.2) + merge pipeline(§3.3)·precedence table(§3.4) 구현. no behavior change; deterministic 여전히 primary, LLM 경로는 shadow-only로 결과 비교만.
2. **Phase 1** — analyze 순서 역전(LLM-structured-first + deterministic floor) **flag 뒤**(`WINE_SEARCH_LLM_ANALYSIS=shadow`). shadow 모드로 deterministic vs LLM-merged diff 로깅, eval만.
3. **Phase 2** — golden 게이트 통과 시 flag on(`=on`). `killSwitchLlmAnalysis` 상시 대기.
4. **Phase 3** — bounded FSM recovery loop(§3.7) + Failure Explanation Layer(§3.8) 활성. anti-hallucination 부정 테스트·loop 경계 테스트 green 필수. `killSwitchRecoveryLoop` 대기.
5. **Phase 4** — multi-turn session state mutation(§3.9). single-turn 회귀 0 확인 후.

각 phase는 독립 배포·롤백 가능. Phase 1 전까지 사용자 영향 0.

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| LLM 분석 latency·비용 (+1 콜/쿼리) | 정규화 쿼리 캐시; deterministic이 충분한 신호를 줄 때 LLM skip 휴리스틱은 **금지**(그게 현재 버그) — 대신 캐시·배치로 비용 흡수 |
| 비결정성 → replay 깨짐 | 분석 결과 snapshot 캐시(RFC-015); deterministic floor 폴백 |
| S2 advisory 환각 | entity_id 생성 전면 금지 + `grounded:false` + 부정 테스트 게이트(RFC-016) |
| identity 안전성 훼손 (LLM이 anchor 덮어씀) | merge에서 deterministic identity 증거 floor 고정 (RFC-006) |
| hard 제약을 relaxation이 풀어버림 | step function은 SOFT(§3.2)만 완화; step3(hard-adjacent)는 기본 off·policy-gated; `hard_constraints_never_relaxed=true` |
| merge silent drift (LLM vs deterministic 충돌) | §3.4 `ConstraintPrecedencePolicy` 명시 규칙표 + 고정 merge 순서(§3.3); class별 단위 테스트 |
| LLM 부분 오류로 전체 분석 폐기 | §3.5 drop-only — valid constraint는 살리고 invalid만 drop |
| FSM 무한 루프 | `max_iterations=2~3`, iteration당 정확히 1 relaxation step, pre-flight budget(rule 20) |
| multi-turn state 오염 (후속 turn이 identity 덮어씀) | §3.9 turn 간에도 identity=deterministic-only precedence 적용 |
| Explanation Layer가 추천처럼 보임 | §3.8 `type:explanation`·entity 생성 금지·`suggested_relaxations`는 FSM 산출값만 표면화 |
| LLM provider down | deterministic-only 폴백 + honest degraded (회귀 0) |

---

## 7. 미해결 질문

해소됨(설계로 확정):
- ~~merge 충돌 우선순위표~~ → §3.4 `ConstraintPrecedencePolicy`.
- ~~relaxation 순서 정책~~ → §3.7 `RelaxationSteps` step function.
- ~~S2를 어떻게 모델링할지~~ → §3.8 Failure Explanation Layer(별도 `type:explanation`, recommend 아님).
- ~~LLM 부분 실패 처리~~ → §3.5 drop-only.
- ~~multi-turn 구조~~ → §3.9 session state mutation + same loop 재실행.

남은 질문:
1. **RFC-019와의 역할 분담** — LLM 추출 결과를 RFC-019 ontology constraint compiler에 다시 통과시켜 grounding을 입힐 것인가(권장: merge §3.3 step 3 canonicalization을 RFC-019에 위임), 아니면 병렬인가.
2. **`range` INTERSECTION 공집합 처리**(§3.4) — over-constrained 신호를 §3.7 loop의 어느 trigger로 매핑할지(empty와 동일 취급 vs 별도 `constraint_conflict` reason).
3. **`exclude` canonical mapping 실패 시**(§3.4) — LLM이 배제한 표면형이 어떤 canonical entity에도 매핑 안 될 때(오타·미등록): drop vs soft-exclude vs explanation에 고지.
4. **low-quality trigger(§3.7 trigger B)** 활성화 기준 — 어떤 품질 신호(top score, result count, calibration)로 "poor"를 판정할지. 초기 off, RFC-013 signal 재사용 검토.
5. **RFC-021 agent orchestration**과의 통합 지점 — §3.9 `WineSessionState`를 RFC-021의 agent session/primitive 호출 모델과 어떻게 정렬할지.
