# TRACK-A: Exact Entity Recovery Roadmap

> 상태: 계획  
> 목적: `"개같이 입력해도 특정 와인을 복구하는"` exact wine retrieval capability를 별도 축으로 보강  
> 관계: EPIC-2~8과 병행 가능. EPIC-5/6/8은 이 트랙의 결과를 더 안전하고 설명 가능하게 만들 뿐, 이 트랙을 대체하지 못함

---

## 문제 정의

EPIC 2–8은 주로 다음을 다룬다:

- deterministic execution
- policy / evidence / score traceability
- rerank safety
- abstain / clarify correctness
- auditability

하지만 exact wine retrieval의 핵심 병목은 다른 곳에 있다:

- anchor miss 후 entity 후보를 다시 생성하지 못함
- resolver가 후보 generator가 아니라 filter에 가까움
- same-request corrective loop가 약함
- exact recovery benchmark와 broad retrieval benchmark가 분리되지 않음
- benchmark truth source와 production alias graph의 관계가 불명확함

현재 코드 기준으로 가장 치명적인 구현 병목은 다음 세 줄로 요약된다:

- planner가 anchor miss 시 fuzzy hit를 entity 후보로 승격하지 않고 lexical expansion으로만 사용
- resolver candidate builder가 `plan.anchors.length === 0`이면 빈 배열을 반환
- resolver 본체가 blocker 결과를 새 후보로 hydrate하지 않고 기존 후보를 filter만 함

반대로, exact recovery의 입력 surface 강건화는 완전히 비어 있지 않다:

- `QueryNormalizer`가 transliteration, compact, phonetic, vintage, josa-strip, reorder variant를 이미 생성
- `PgAliasMatcher`가 exact/compact/transliterated/phonetic/fuzzy lookup을 이미 수행
- production DI가 실제로 `PgAliasMatcher`를 사용한다

즉 TRACK-A는 noisy surface 처리를 처음부터 새로 만드는 작업이 아니라,
**이미 있는 normalization/alias substrate를 shared candidate generation으로 승격하는 작업**이다.

또한 retrieval downstream에도 이미 exact-hit 보호 substrate가 일부 존재한다:

- `ProtectedRecallPolicy`가 known-item / anchor-conditioned / exact alias / hard-constraint-compatible 후보를 보호한다
- `CandidateAssembler`가 protected candidate를 quota보다 우선 보존한다

즉 TRACK-A는 candidate generation이 먼저 닫혀야 하지만,
후단의 protected recall / assembly layer는 새로 만들기보다 적극 재활용하는 편이 맞다.

즉 이 트랙은 **엔진 운영 품질**이 아니라 **canonical wine entity recovery 품질**을 직접 올리는 계획이다.

---

## 목표

다음 유형의 질의에서 canonical wine entity를 높은 확률로 복구한다:

- 한글 음차: `오퍼스원`, `오푸스원`, `샤또마고`, `모엣샹동`
- 오타 / 축약: `오퍼스원 18`, `샤또마고 15`
- 부분명칭: `마고 15`, `오브리옹 09`, `모엣 로제`
- 영한 혼합: `오푸스원 2018 Napa Valley`, `chateau margaux 15`
- 붙여쓰기 붕괴: `샤또마고1996`, `모엣샹동로제`, `로마네꽁티`

정답이 애매할 때는 억지 top-1이 아니라 `clarify` 또는 `top-N proposal`로 보수적으로 내려간다.

---

## 범위

### In Scope

- exact entity recovery
- ambiguous short-form handling
- same-request corrective retrieval
- exact-recovery benchmark / release gate
- Korean noisy surface catalog

### Out of Scope

- broad recommendation quality
- generic attribute search quality
- similarity / related-item retrieval
- budget / browse / pairing ranking quality 전반

이 항목들은 별도 search-quality 트랙에서 다룬다.

### Related But Separate

- `noisy_attribute_recovery`
  - 예: `쇼비뇽 2016 까브레나`, `카브 쇼비뇽 16`
  - 이 범주는 exact entity recovery의 주트랙이 아니다
  - benchmark는 별도 보조 세트로 관리하되, TRACK-A release gate에는 포함하지 않는다

---

## 아키텍처 결정

### A1. Canonical Entity Graph SSOT

단일 canonical entity에 아래를 묶는다:

- producer
- label / cuvee
- vintage
- region / appellation / grape relations
- aliases
- transliterations
- common misspellings
- compact / phonetic forms

이 그래프가 retrieval / resolver / reranker의 공통 기준이 된다.

#### Canonical Entity Graph 생성 원칙

- LLM / heuristic / web-observed surface가 alias 후보를 **생성**할 수는 있지만, production truth를 직접 **승격**할 수는 없다
- production canonical entity와 alias graph는 항상 reviewable한 typed source를 통해서만 변경된다
- 자동 생성물은 모두 `candidate alias` 지위로 시작하며, 명시적 승인 전까지 runtime resolve truth가 아니다

#### Canonical Entity Graph 필수 필드

- `canonical_entity_id`
- `entity_type`
- `canonical_label`
- `producer_ref`
- `vintage`
- `alias_set`
- `transliteration_set`
- `misspelling_set`
- `phonetic_set`
- `source_provenance`
- `approval_state`
- `last_reviewed_at`

#### Approval State

- `candidate`
- `approved_for_fixture`
- `approved_for_production`
- `deprecated`

즉 alias는 "있다/없다"가 아니라 **어느 truth layer에서 승인됐는가**를 갖는다.

#### 기존 코드와의 관계

- 현재 runtime은 `QueryNormalizer.lookupVariants`와 `PgAliasMatcher`를 통해 surface normalization / alias lookup을 수행한다
- TRACK-A 구현 시 이 경로를 폐기하지 않고, Canonical Entity Graph의 **surface generation / lookup adapter**로 재활용한다
- 즉 graph가 생겨도 query normalization과 alias lookup은 계속 runtime ingress layer로 남고, graph는 그 위의 canonical truth layer가 된다

### A2. Shared Entity Candidate Generation

`query -> entity hypotheses[]`를 만드는 공통 계층을 둔다.

입력:

- normalized query views
- transliteration variants
- vintage candidates
- alias linker outputs
- blocking candidates

출력:

- `canonicalEntityId`
- `entityType`
- `matchProvenance`
- `priorScore`
- `surfaceAlignmentSignals`

Planner, Resolver, Hybrid retrieval이 이 출력을 함께 사용해야 한다.

#### 현재 코드 갭

- `search-usecase-resolver-candidates.ts`는 anchor가 없으면 후보를 만들지 않는다
- `resolver.ts`는 blocker가 낸 ID를 candidate hydrate하지 않는다
- 따라서 shared candidate generation이 없으면 corrective loop를 넣어도 복구 후보가 없다

즉 A2는 optional quality uplift가 아니라 **TRACK-A의 선행 조건**이다.

#### 재활용 원칙

A2는 다음 기존 substrate를 입력으로 재사용해야 한다:

- `QueryNormalizer.lookupVariants`
- `PgAliasMatcher.findMatches()`
- blocker output
- planner anchor extraction 결과
- protected recall classification 결과
- candidate assembly의 보호 규칙

새 candidate generator는 이들을 대체하는 별도 ingress를 만들지 않고,
**기존 ingress를 통합해 canonical entity hypothesis로 승격하는 조립층**이어야 한다.

### A3. Same-request Corrective Retrieval Loop

exact recovery 실패가 탐색형 retrieval로 그냥 흘러가면 안 된다.
같은 요청 안에서 단 한 번의 corrective retry를 허용한다.

#### Trigger 조건

아래 중 하나를 만족할 때만 corrective loop를 시작한다:

1. `anchorCount = 0` 이지만 alias / noisy surface evidence는 존재
2. resolver 결과가 low-confidence이고 protected candidate가 없음
3. top-1 posterior가 resolve 임계값 아래이고 ambiguity는 낮음

#### 실행 규칙

1. entity hypotheses 재생성
2. canonical entity hydrate
3. second-pass retrieval 실행
4. posterior recalibration

#### 구현 원칙

- planner fuzzy hit를 lexical expansion에만 두지 않고 entity hypothesis source로도 승격 가능해야 한다
- blocker output은 resolver filter 입력이 아니라 hydrate 가능한 candidate seed가 되어야 한다
- corrective loop는 broad search fallback이 아니라 **exact recovery 재시도**여야 한다

#### 종료 규칙

- corrective retry는 **요청당 최대 1회**
- retry 후에도 posterior가 임계값 미만이면 `clarify` 또는 `abstain`
- retry 후 ambiguity가 높아지면 `clarify`
- retry 후 protected candidate가 생기면 exact-first ranking으로 복귀

### A4. Exact-first Dual Retrieval

retrieval은 항상 두 축으로 나눈다:

- entity-first path
- discovery path

exact-like query에서는 entity-first path가 우선권을 갖고,
discovery path는 recall 보완과 fallback 역할을 한다.

단, exact-first path가 실제로 동작하려면 `resolver candidate = anchors only` 계약을 먼저 제거해야 한다.

### A5. Calibrated Decision

최종 판정은 단순 top-1 score가 아니라 다음을 함께 본다:

- calibrated posterior
- top1-top2 gap
- ambiguity class
- protected candidate integrity
- route degradation
- evidence sufficiency

결과는 `resolved | clarify | abstain | top-N proposal` 중 하나다.

---

## Truth Source 계약

Canonical Entity Graph와 benchmark fixture는 같은 것이 아니다.

### Production Truth Source

- production entity graph
- production alias graph
- production canonical entity IDs

이 세트는 실제 검색/복구 실행의 기준이다.
이 레이어만이 runtime resolve truth를 결정한다.

### Benchmark Truth Source

- fixture repository benchmark suites
- Korean noisy surface catalog
- web-observed surface seeds

이 세트는 평가와 release gate의 기준이다.
이 레이어는 production truth를 참고하지만, production truth와 동일시하지 않는다.

### Candidate Surface Source

- web-observed search surfaces
- log-derived user query surfaces
- LLM-generated transliteration candidates
- manual curation candidates

이 레이어는 **후보 pool**일 뿐이며, 단독으로 fixture truth나 production truth가 되지 않는다.

### 동기화 규칙

1. benchmark fixture의 target entity는 반드시 production canonical entity ID를 참조해야 한다
2. web-observed surface는 fixture repo에 먼저 들어가고, production alias graph 편입은 별도 승인 절차를 따른다
3. production alias graph에 새 surface를 넣더라도 benchmark에 자동 반영하지 않는다
4. benchmark fixture와 production alias graph의 drift는 별도 audit 대상으로 관리한다
5. `approved_for_fixture` 와 `approved_for_production` 은 별개 상태다
6. LLM-generated alias는 human-reviewed provenance 없이는 어떤 truth layer에도 자동 승격될 수 없다
7. production alias 삭제/변경 시 fixture 영향도를 audit하고 changelog를 남긴다
8. fixture에서 canonical target이 사라지면 해당 case는 release blocker로 간주한다

즉:

- production graph = 실행 truth
- fixture repo = 평가 truth
- web-observed surface = 후보 source

### 승격 워크플로

#### Ownership / Approval Boundary

- production canonical entity / alias graph 승인권자는 catalog truth owner + search quality reviewer의 공동 승인으로 둔다
- fixture benchmark truth 승인권자는 search quality reviewer가 가진다
- web-observed / log-derived / LLM-generated surface는 단독으로 어떤 truth layer도 승인할 수 없다
- 즉 `승격 후보를 누가 만들었는가`와 `어떤 truth layer에 누가 승인했는가`를 분리해서 기록해야 한다

#### Surface candidate -> Fixture

1. surface 후보 수집
2. canonical target 매핑 제안
3. benchmark case 또는 surface catalog에 추가
4. reviewer 승인 후 `approved_for_fixture`

#### Surface candidate -> Production

1. fixture 또는 운영 로그에서 반복 관측
2. false-positive 검토
3. canonical entity graph review
4. alias graph 반영
5. reviewer 승인 후 `approved_for_production`

#### Sync Trigger

- production alias graph 변경 PR이 merge되면 fixture 영향도 audit를 같은 변경 묶음에서 확인한다
- fixture suite에 새 exact surface가 추가되면 production alias 편입 여부를 별도 판단 항목으로 기록한다
- deprecated alias 지정 시 fixture / production / web-observed catalog 세 레이어를 모두 교차 점검한다

fixture 승격과 production 승격은 같은 PR로 묶일 수는 있지만, **같은 판단 단계로 취급하지 않는다.**

### 금지 규칙

- fixture에 있는 surface라는 이유만으로 production alias에 자동 반영 금지
- production alias에 있는 surface라는 이유만으로 benchmark success로 간주 금지
- web-observed surface를 canonical target 검증 없이 fixture gold로 승격 금지
- LLM이 생성한 misspelling/transliteration을 human review 없이 production resolve path에 투입 금지

### Drift Audit

아래는 정기 audit 대상으로 관리한다:

- fixture target entity가 production canonical entity와 불일치
- production alias는 있으나 benchmark에 없는 high-volume surface
- benchmark에는 있으나 production alias graph에 없는 long-tail exact surface
- deprecated alias가 benchmark 또는 production에서 여전히 active로 쓰이는 경우

이 audit는 EPIC-8 trace와 별도로 운영되며,
exact entity release gate 직전의 품질 점검 항목으로 취급한다.

---

## 구현 우선순위

TRACK-A는 아래 순서로 구현한다:

1. `A2 Shared Entity Candidate Generation`
2. `A3 Same-request Corrective Retrieval Loop`
3. `A1 Canonical Entity Graph SSOT + truth-source workflow`
4. `A4 Exact-first Dual Retrieval`
5. `A5 Calibrated Decision`

이 순서를 뒤집으면,
ranking / calibration / audit을 강화해도 "복구 후보가 아예 없음" 상태를 먼저 해결하지 못한다.

---

## Benchmark 계약

이 트랙은 benchmark 없이는 완료로 보지 않는다.

fixture governance는 [ADR-004](/Users/songmin/Documents/code-wine/wine-search-engine/docs/adr/004-benchmark-fixture-governance.md:1)를 따른다.
즉 TRACK-A의 benchmark truth는 문서 예시가 아니라 외부 fixture repo contract가 최종 SSOT다.

### Primary Benchmark Families

#### A. Exact entity recovery

- `오푸스원`
- `오퍼스 원`
- `오퍼스원`
- `오퍼스원 18`
- `샤또마고`
- `샤또마고1996`
- `샤또 마르고`
- `마고 15`
- `모엣샹동로제`
- `모엣샹동 로제 임페리얼`
- `로마네꽁티`
- `오브리옹 09`
- `페트루스 어떤 와인이야`

#### B. Mixed-script exact recovery

- `Opus One 2018`
- `오푸스원 2018 Napa Valley`
- `chateau margaux 15`
- `cab sauv 2016 opus`

#### C. Ambiguous short-form recovery

- `마고`
- `모엣`
- `DRC`
- `마르고`

이 세트는 `wrong top-1 방지 + clarify 품질`을 함께 본다.

### Secondary Benchmark Family

#### D. Noisy attribute recovery

- `쇼비뇽 2016 까브레나`
- `카브 쇼비뇽 16`
- `소비뇽 블랑 말보로 22`

이 세트는 별도 보조 세트이며, TRACK-A의 release gate를 결정하지 않는다.

### Korean Surface Catalog

#### 1. 한글 음차 / 표기 변형

- `오푸스원`
- `오퍼스 원`
- `오퍼스원`
- `샤토 마고`
- `샤또 마고`
- `샤또 마르고`
- `마르고`
- `모에 샹동`
- `모엣 샹동`
- `로마네 콩티`
- `로마네 꽁티`
- `사시카이아`
- `클라우디 베이`
- `클라우디베이`
- `모엣`
- `이켐`
- `페트뤼스`
- `페트루스`

#### 2. 붙여쓰기 / 띄어쓰기 붕괴

- `샤또마고`
- `샤또마고1996`
- `모엣샹동`
- `모엣샹동로제`
- `오퍼스원`
- `오푸스원`
- `클라우디베이`
- `로마네꽁티`

#### 3. 빈티지 축약 / 숫자 결합

- `오퍼스원 18`
- `오퍼스원 2018`
- `마고 15`
- `오브리옹 09`
- `샤또마고 2018`
- `오푸스원18`

### Web-observed Surface → Target Seed Map

| surface | 기대 target |
|---|---|
| `오퍼스원` | `Opus One` |
| `오퍼스원 2018` | `Opus One 2018` |
| `샤또 마고` | `Château Margaux` |
| `샤또 마르고` | `Château Margaux` 또는 `Margaux AOC` clarify |
| `샤또마고1996` | `Château Margaux 1996` |
| `모엣샹동` | `Moët & Chandon` |
| `모엣샹동 로제 임페리얼` | `Moët & Chandon Rosé Impérial` |
| `모엣샹동로제` | `Moët & Chandon Rosé Impérial` |
| `로마네꽁티` | `Romanée-Conti` |
| `마르고` | `Margaux` region / `Château Margaux` ambiguity clarify |

이 매핑은 exact resolve만 강제하지 않는다.
`마르고`, `마고` 같은 short form은 ambiguity가 구조적으로 높으므로 `clarify`를 정답으로 허용한다.

---

## Release Gate

TRACK-A release gate는 Primary Benchmark Families만 사용한다.

### Required Metrics

- exact entity recall@1
- exact entity recall@5
- wrong confident top1 rate
- ambiguity-safe rate
- clarify precision
- anchor-miss recovery success rate
- protected candidate eviction rate

### Gate Rules

1. Primary benchmark에서 recall@1 / recall@5가 baseline 대비 유의미하게 개선되어야 한다
2. wrong confident top1 rate는 baseline보다 악화되면 안 된다
3. ambiguity case에서 `clarify` 허용률이 아니라 **wrong confident top1 억제율**을 본다
4. Noisy attribute recovery는 관찰용으로 기록하지만 release block 조건은 아니다

---

## 구현 순서

### Phase A1

- canonical entity graph schema 확정
- alias / transliteration / misspelling lattice 정규화
- production truth source와 fixture truth source 관계 문서화

### Phase A2

- shared entity candidate generation contract 추가
- planner / resolver / hybrid retrieval이 같은 candidate source를 사용하도록 정리

### Phase A3

- same-request corrective retrieval loop 추가
- trigger / exit / max retry contract 구현

### Phase A4

- primary benchmark suites 구축
- benchmark 기반 release gate 도입

### Phase A5

- posterior calibration / ambiguity routing 정교화
- EPIC-5/6/8 trace와 연동

---

## 완료 조건

- primary benchmark에서 exact entity recall@1 / recall@5가 baseline 대비 유의미하게 상승
- `anchor miss` 케이스가 same-request second pass로 복구됨
- exact alias / protected candidate가 rerank 후 비정상적으로 밀리지 않음
- ambiguous query는 wrong top-1 없이 `clarify` 또는 `top-N proposal`로 안정적으로 분기
- production truth source와 benchmark truth source의 관계가 문서/fixture 수준에서 고정됨
- 운영 trace에서 entity recovery failure를 재현 가능

---

## EPIC 2–8과의 관계

- EPIC-5는 이 트랙의 결과를 rerank가 망치지 않게 보호한다
- EPIC-6은 이 트랙이 못 풀어낸 모호함을 typed abstain / clarify로 표면화한다
- EPIC-8은 이 트랙의 recovery trace를 감사 가능하게 만든다

즉:

- `TRACK-A` = 찾아오는 능력
- `EPIC-5/6/8` = 잘못 확정하지 않는 능력 + 설명 가능한 능력
