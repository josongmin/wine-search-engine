# RFC-018 — Scope Contract & Field Ownership Matrix

## §0 Status / Owner / Related RFCs

| | |
|---|---|
| **Status**       | Draft (Wave 1: matrix + validator landed; live-coverage backfill — Wave 2) |
| **Owner**        | Search Infrastructure |
| **Created**      | 2026-05-24 |
| **Last review**  | 2026-05-24 |
| **Related RFCs** | RFC-002 (entity model), RFC-007 (Vespa schema), RFC-014 (error envelope), EPIC-12 (data enrichment) |
| **Related memos**| `project_appellation_field_empty_in_vespa.md`, `project_entity_route_broken.md` |
| **Files**        | `vespa/app/schemas/wine_entity.sd`, `scripts/etl/index-to-vespa.ts`, `scripts/etl/vivino-to-silver.ts`, `scripts/etl/run-track-c*.ts`, `src/infrastructure/vespa/mapping.ts` |

---

## §1 Problem — "스키마는 풍성한데, 실데이터는 텅 빈" 상태

근본 원인 감사(Theme B)에서 드러난 가장 큰 구조적 결함은 **Vespa 스키마 ↔ ETL writer 사이의 정합성 게이트가 존재하지 않는다**는 것이다. 현재의 빌드 파이프라인은 다음 두 사실을 동시에 허용한다.

1. `vespa/app/schemas/wine_entity.sd`는 67개 필드를 선언한다.
2. ETL writer (`scripts/etl/index-to-vespa.ts` → `src/infrastructure/vespa/mapping.ts::toVespaFields`)는 그 중 일부만 실제로 채운다.

스키마 deploy도 통과하고, BM25 인덱싱도 “정상” 신호를 보내고, 랭킹 표현식도 평가된다. 그러나 비어 있는 필드는 BM25 IDF 분모에 0의 기여만 하고, `isNan(attribute(...)) ? 0 : ...`로 감싼 second-phase 보너스는 항상 0을 출력한다. **빌드는 silently 통과하지만 검색 품질은 결정적으로 망가져 있다.**

구체적인 in-prod 증거:

- **`appellation`은 11,367개 문서 중 0개에 채워져 있다** (memo `project_appellation_field_empty_in_vespa`). 그럼에도 `wine_entity.sd:386` 의 `default` fieldset에 포함되어 있어, BM25 검색이 매번 비어 있는 필드 11,367개를 토큰화·평가한다 (`bm25(appellation)` 가중치 ×1.5, lexical/hybrid 모두). “Margaux”, “Saint-Julien”과 같은 appellation-anchored 쿼리는 `appellation`이라는 유효한 신호 슬롯을 갖고 있음에도 모든 문서에서 0점을 받고, 다른 필드의 noise에 의해 결정된다.
- **`soil_type`, `producer_type`은 silver→gold 어디서도 결정되지 않는다.** `vivino-to-silver.ts:767` 부근에서 `appellation: null`로 명시 설정되고, soil/producer_type은 ETL 어디에도 writer가 없다.
- **`grape_hierarchy`, `producer_aliases`, `flavor_profile_structured`는 .sd에 선언되어 있지만 `RetrievalDocument` 타입조차 이 필드들을 모른다.** 즉 “스키마 → 도메인 → ETL”의 어느 계층에서도 라이팅 경로가 없는, 완전한 dead substrate.
- **`critic_proxy_score`, `critic_proxy_tier`, `critic_proxy_confidence`, `organic`, `biodynamic`, `certification_source`, `pairing_tags`** — Track C step1/step2/step3는 silver 레코드 안에 `criticProxy`, `certifications`, `pairingTags` 객체를 만들어 두지만, `index-to-vespa.ts::silverToIndexable`은 이들을 **모두 평면 `certifications: string[]`로 압축**하고 critic_proxy 세부 필드와 organic/biodynamic flag는 Vespa에 전송하지 않는다. 즉 ETL은 데이터를 만들었지만 라이터는 그것을 버린다.

이러한 정합성 결함은 모두 “스키마에 선언되어 있다 = 데이터가 들어 있다”라는 잘못된 가정 위에서 운영되어 왔다. 한 필드를 임시로 보강하는 spot-patch (예: 커밋 `0a6be753`의 “appellation을 hard→soft로 강등”)는 **단일 필드의 영향만 해결**하고, 동일한 결함이 다른 필드에도 잠복해 있다는 사실은 가린다.

본 RFC는 그 패턴을 끝낸다. 모든 Vespa 필드는 **단일 source-of-truth 매트릭스(YAML)** 에 등록되어야 하며, ETL 산출물과 라이브 인덱스는 매트릭스가 선언한 커버리지 기대치를 만족해야 한다 — 만족하지 못하면 CI가 빨갛게 된다. spot-patch가 아니라 매트릭스 자체가 SSoT다.

---

## §2 Field Ownership Matrix — 정의

**Field Ownership Matrix**는 `tools/schema-contract/field-ownership-matrix.yaml`에 위치한 단일 YAML 파일이며, Vespa 스키마에 선언된 **모든** 필드에 대해 다음 5개 컬럼을 가진다.

| Column | Type | Semantics |
|---|---|---|
| `field` | `string` (snake_case) | `wine_entity.sd`의 `field <name> type ...` 선언 이름과 정확히 일치 |
| `source` | `string` | 이 필드를 생성하는 ETL 단계의 식별자 (`silver(vivino-to-silver.ts)`, `track-c-step1(critic-proxy)`, `runtime(query-time)`, `unknown` 등) |
| `coverage_required` | `number ∈ [0,1]` | 매트릭스가 기대하는 최소 non-null 비율 (문서 단위). `0.0`은 “채워져 있지 않아도 OK이지만 워닝/추적은 필요”를 의미 |
| `fail_action` | `enum` | `must` \| `warn` \| `optional` (§5 참조) |
| `rationale` | `string` | 왜 이 row가 이 값을 갖는지에 대한 근거 — 도메인 사실, 측정값, RFC 인용, 메모 인용 |

선택 컬럼:

| Column | Type | Semantics |
|---|---|---|
| `ticket` | `string` | 해당 row가 “미해결 ETL 백필 작업”을 가리킬 때, 관련 추적 ID/메모 키 (예: `[[project-appellation-field-empty-in-vespa]]`) |
| `notes` | `string` | 운영자에게 도움 되는 자유 텍스트 |

### 매트릭스 row 결정 절차

새 필드를 .sd에 추가하거나, 기존 필드의 fail_action을 변경할 때는 반드시 다음 절차를 통과한다.

1. **소스 계층 식별** — silver / gold (Track C N단계) / runtime 중 어디서 생성되는가? 어디에도 없다면 `source: unknown`, `fail_action: warn`, `ticket: TODO`.
2. **실측 커버리지 측정** — 직전 `index-to-vespa.ts --dry-run`이 생성한 prepared feed에서 non-null 비율을 측정. (라이브 인덱스가 있다면 `validate --from-vespa-live`로 확인 가능 — §4)
3. **rationale 작성** — “왜 이 비율인지”를 단순 수치가 아니라 데이터/도메인 사실로 정당화. 예: “Vivino payload에 wine_type만 있고 appellation은 없음 → silver 단계에서 channel-side gazetteer 없이는 채울 수 없음 → coverage 0.0, fail_action warn, ticket [[…]].”
4. **`fail_action` 결정** — §5 표 참조.

### 매트릭스 row 수 = .sd 필드 선언 수

매트릭스 row 수와 `wine_entity.sd`의 `field <name> type ...` 선언 수는 정확히 같아야 한다. validator는 양방향 drift를 모두 ERROR로 잡는다:

- .sd에 선언되었지만 매트릭스에 없는 필드 → **DRIFT_MISSING_MATRIX_ENTRY**
- 매트릭스에 있지만 .sd에 없는 필드 → **DRIFT_STALE_MATRIX_ENTRY**

---

## §3 Scope Contract — 어떤 와인이 코퍼스에 *반드시* 존재해야 하는가

Field Ownership Matrix는 “필드별 커버리지”를 보장하지만, “*어떤 문서가* 인덱스에 있어야 하는지”에 대해서는 침묵한다. 그 공백을 메우는 것이 **Scope Contract**다.

### 3.1 Scope Contract의 형태

Scope Contract는 별도의 후속 산출물(`tools/schema-contract/golden-wines-seed.jsonl` — Wave 2)에서 구체적인 와인 ID 리스트로 정의된다. 본 RFC는 그 **계약 자체**만 명시한다:

- **golden wines** — 사용자 가시 catalog에서 누락되면 안 되는 와인의 집합. Vivino long-tail 11K 코퍼스에 자연 발생적으로 존재해야 하며, 존재하지 않으면 ingestion / dedup / sealing 어디선가 손실된 것으로 본다.
- golden wine 집합은 시간이 지나며 누적된다 (append-only). 한번 등록되면 코퍼스에서 빠지지 않는다.
- validator는 `--check-scope-contract <seed-jsonl>` 플래그가 주어진 경우, prepared feed 또는 라이브 인덱스에서 각 golden wine entity_id의 존재를 확인하고, 없으면 ERROR.

### 3.2 Wave 1 (현재 PR)의 범위

본 RFC와 동반 PR은 **scope contract 자체는 비워둔다.** 매트릭스 + validator + CI gate만 먼저 land하고, golden wines seed JSONL은 후속 Wave에서 채운다. 이유:

- golden wines 목록을 결정하는 데에는 “현재 어떤 유명 와인이 누락되었는가”에 대한 실측이 필요하다. 실측은 라이브 vespa 환경에서만 가능하다.
- 매트릭스/validator는 즉시 ETL 측에서 가치가 있다 (현재 0인 11개 필드를 모두 surface 한다).

### 3.3 Anti-pattern: ad-hoc 와인 추가

- “이 와인이 검색 안 돼서 임시로 anchor catalog에 추가” 같은 단발성 패치는 금지한다. 와인이 catalog에 추가되어야 한다면, **scope contract YAML에 row를 추가하고 validator가 그것을 enforce하게 해야 한다.**

---

## §4 Validator 설계

`tools/schema-contract/validate.ts` — Node.js CLI, ESM, tsx-runnable.

### 4.1 입력

```
Usage:
  validate.ts [--from-prepared-feed <path>]
              [--from-vespa-live]
              [--schema <path>]
              [--matrix <path>]
              [--probe-limit <n>]   # default 200
              [--warn-as-error]     # treat WARN as ERROR (CI strict mode)
              [--check-scope-contract <seed-jsonl>]   # Wave 2
```

두 가지 mode는 **상호 배타적**이다:

- `--from-prepared-feed <path>` — `index-to-vespa.ts`가 만든 prepared feed JSONL(또는 디렉터리) 을 읽어 non-null coverage 측정. CI/local에서 빠르게 검증할 때 사용. Vespa 의존성 없음.
- `--from-vespa-live` — `VESPA_URL`/`VESPA_CERT_PATH`/`VESPA_KEY_PATH` 환경변수를 통해 라이브 Vespa에 YQL `select * from wine_entity where true limit <probe-limit>` 를 던지고, 응답의 각 필드 non-null 비율을 측정. 야간 CI / 운영자가 “지금 라이브가 매트릭스와 일치하는가”를 확인할 때 사용.

mode가 둘 다 미지정이면 **schema↔matrix drift만 검사하고 종료** (exit code 1 if drift, 0 otherwise) — CI prepush에서 가벼운 검증으로 사용.

### 4.2 처리 단계

1. `vespa/app/schemas/wine_entity.sd` 파싱 — `^\s*field\s+<name>\s+type\s+...` 정규식으로 모든 field 선언을 추출. document-summary block 안의 `summary <name>`은 무시 (별도 alias).
2. `tools/schema-contract/field-ownership-matrix.yaml` 로딩 — Zod schema로 validate (strict).
3. **Drift check (mode 무관)** — schema set ↔ matrix set 양방향 차집합 산출. 있으면 ERROR.
4. **Coverage measurement** (mode가 지정된 경우):
   - prepared mode: NDJSON 파일을 line-by-line으로 읽어 각 doc의 `fields[<vespa_field_name>]` 존재/null 여부 카운트.
   - live mode: HTTPS POST `{VESPA_URL}/search/`, YQL `select * from sources wine_entity where true limit <N>`, mTLS cert + key. 응답 hit 별로 카운트.
5. **Action**:
   - 측정 coverage가 `coverage_required` 미만이고 `fail_action: must` → ERROR
   - 〃 〃 `fail_action: warn` → WARN (or ERROR with `--warn-as-error`)
   - 〃 〃 `fail_action: optional` → silent
6. **출력** — TSV one line per row: `<status>\t<field>\t<expected>\t<actual>\t<rationale snippet>`.
7. **Exit code** — 1 if any ERROR, 0 otherwise.

### 4.3 Vespa 응답 파싱

라이브 mode에서 Vespa 응답은 Zod로 validate (rule 11: 외부 JSON에 `as DomainType` 금지). 응답 shape는 vespa search API 표준 (`{ root: { children: [{ fields: {...} }] } }`).

### 4.4 No 휴리스틱

매트릭스의 모든 coverage_required는 도메인 fact 기반으로 결정되며 (§2.4), validator 자체는 임계치를 추측하지 않는다. validator는 **매트릭스가 선언한 것을 enforce할 뿐**이다.

---

## §5 fail_action enum

| value | semantics | 적용 기준 |
|---|---|---|
| `must` | 측정 coverage < required → 빌드 실패 (exit 1) | 시스템 정합성에 필수인 필드. canonical_label, entity_id, embedding 등 “없으면 검색 자체가 작동하지 않는” 식별 layer |
| `warn` | 측정 coverage < required → 로그 + 진행 | 이상적으로는 채워져야 하지만, 현재 ETL에 backfill 미구현 / 일부 문서에 자연스럽게 없음. soil_type, appellation, classification, organic 등 |
| `optional` | 어떤 coverage도 silent (체크 안 함) | 진정 optional하거나 query-runtime에만 의미를 갖는 필드 (예: `learned_sparse_weights`는 일부 와인에만 적용 가능) |

### `must` 진입의 dual gate

`fail_action: must`로 신규 진입하려면 다음 두 조건 모두 충족해야 한다:

1. 현재 코퍼스에서 coverage_required 비율을 실제로 달성하고 있어야 한다 (즉, 즉시 fail하지 않음).
2. 해당 필드의 결정 로직 (silver / gold ETL)이 단일 source-of-truth에 들어 있고, 새 데이터에 대해 deterministic하게 채워져야 한다.

두 조건 중 하나라도 미충족이면 `warn`에 머무른다.

---

## §6 Migration plan

| Wave | Scope | Gate |
|---|---|---|
| **Wave 1** (이 PR) | Matrix YAML 구축, validator 구현, prepush에 drift-check 통합 | drift only (mode 미지정) |
| Wave 2 | `--from-prepared-feed` 모드를 ETL 산출 직후에 호출 (run-track-c.ts 끝 또는 별도 step) | `must` 필드 강제 |
| Wave 3 | `--from-vespa-live` 모드를 야간 CI 잡으로 분리, 라이브 인덱스 drift 알림 | warn 누적 monitoring |
| Wave 4 | `appellation`, `soil_type`, `classification` 백필 ETL 단계 추가 (Track C step8: gazetteer-driven backfill) | 백필 후 `warn → must` 승격 |
| Wave 5 | scope contract seed JSONL — “golden wines must exist” enforce | `--check-scope-contract` flag turn-on |

### Wave 1에서 즉시 `must`로 시작하는 필드 (예시)

- `entity_id`, `canonical_label`, `entity_type`, `embedding`, `producer`, `popularity_score`, `availability`, `aliases_identity_safe`, `aliases_noisy_recall`, `semantic_summary` — 이들은 현재 100% 채워져 있으며 ETL writer가 모두 정의되어 있다 (검증 가능).

### Wave 1에서 `warn`으로 머무는 대표 필드

- `appellation` (현재 0%, ETL writer 없음) — Wave 4 백필 후 승격 예정.
- `soil_type`, `producer_type` — silver에 writer 없음, 라이브 0%.
- `grape_hierarchy`, `producer_aliases`, `flavor_profile_structured`, `critic_proxy_score`, `critic_proxy_tier`, `critic_proxy_confidence`, `organic`, `biodynamic`, `certification_source`, `pairing_tags` — RetrievalDocument에 필드 없음, ETL writer 없음. **이들은 .sd에서 제거하거나 ETL writer를 추가해야 한다** — 매트릭스가 이 결정을 강제한다 (TODO ticket으로 추적).

### Wave 1에서 `optional`로 두는 필드

- `learned_sparse_weights` — SPLADE 모델 적용된 문서만 보유.
- `synthetic_queries` — Doc2Query 단계가 도는 경우에만 채워짐.
- `alias_prefix_terms` — alias가 있는 문서만.
- `source_record_refs_json` — lineage 추적은 모든 문서에 강제 아님 (Wave 5 후 `must` 승격 검토).
- `search_snapshot_id` — snapshot scoped query에서만 의미.

---

## §7 Anti-patterns (하지 말 것)

1. **단일 필드 spot-patch** — “appellation이 비어 있어서 hard→soft demote” 같은 임시 대응은 동일 결함의 다른 사례를 가린다. 매트릭스 row 갱신과 백필 ETL 둘 다 land해야 한다.
2. **.sd에서 “언젠가 쓸지도 모르니까”라며 미사용 필드 선언** — RFC-018 이후로는 모든 신규 .sd 필드는 매트릭스 row를 동반해야 하며, ETL writer가 없으면 `source: unknown, fail_action: warn, ticket: <TODO>`로 즉시 표시된다.
3. **coverage_required를 정당화 없이 변경** — 매트릭스 PR review에서 rationale이 도메인 사실에 anchored되어 있지 않으면 reject.
4. **validator를 `--warn-as-error` 없이 운영 단계에 통합 후 “WARN은 무시해도 된다”는 관행 정착** — WARN은 “지금은 통과시키지만 추적 중”이라는 신호. WARN row가 6개월 이상 머무르면 분기마다 review 후 `must` 승격 or `.sd`에서 필드 제거 결정.
5. **매트릭스를 수동 동기화** — 매트릭스와 .sd는 validator가 양방향으로 잡으므로, 사람이 한쪽만 갱신하는 시나리오는 즉시 CI에 잡혀야 한다. 잡히지 않으면 validator의 버그.
6. **Vespa 응답 / YAML을 `as Type`으로 캐스팅** — 외부 데이터는 모두 Zod safeParse. validator는 rule 6/11/12 (CLAUDE.md test discipline) 의 적용 대상이다.

---

## §8 Open questions (Wave 2+)

- `bottle_size_ml` vs `bottle_size` — 어느 쪽이 SSoT인가? 현재 둘 다 .sd에 있고 둘 다 written. 매트릭스 정의는 명시했지만, 도메인 코드가 어느 쪽을 읽는지에 따라 한쪽 deprecate 해야 할 수도.
- `search_snapshot_id` — Wave 5에서 “snapshot pointer가 있는 모든 문서에 채움”을 `must`로 강제할지, 아니면 snapshot scope query만 사용하는 모드에 한정할지.
- live mode probe size (`--probe-limit 200`) — 큰 corpus에서 200개 샘플로 coverage를 추정하는 것은 sparse field에 대해 부정확할 수 있음. Wave 3에서 ratio-based 측정 or rolling streaming probe 검토.
