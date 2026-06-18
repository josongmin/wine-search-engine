# May 29 Interface Revamp Architecture Decision

> Historical / audit-only document.
> Current public lookup truth moved to `docs/bench/STATUS.md` and
> `tools/feature-catalog/features/retrieval/entity-lookup-v2.yaml`.
> This file preserves the pre-cutover `/v1/lookup/wine` contract framing only.

## 1. 결정

public product surface는 아래 세 계층으로 고정한다.

1. `agent`
2. `search`
3. `lookup`

`agent`의 `single-shot`과 `turnful`은 기능이 다른 두 시스템이 아니라, 같은 runtime에 서로 다른 history custody 정책을 얹은 두 진입점이다.

## 2. Canonical HTTP Shape

### 2.1 Agent

- `POST /v1/agent/run`
- `POST /v1/agent/sessions`
- `POST /v1/agent/sessions/:sessionId/turns`

Canonical request shape:

```ts
interface AgentMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly name?: string
  readonly timestamp?: string
  readonly metadata?: Record<string, unknown>
}

interface AgentRunRequest {
  readonly messages: readonly AgentMessage[]
  readonly context?: AgentContext
  readonly options?: AgentOptions
}

interface AgentSessionTurnRequest {
  readonly client_turn_id: string
  readonly messages: readonly AgentMessage[]
  readonly context?: AgentContext
  readonly options?: AgentOptions
  readonly expected_session_version?: number
}
```

결정:

1. `query` 단일 문자열은 canonical field가 아니다.
2. single-shot도 `messages[]`를 받는다.
3. session turn도 `messages[]`를 받는다.
4. history 주입은 hidden stitching이 아니라 explicit request field로 한다.

### 2.2 Search

- `POST /v1/search/hybrid`
- `POST /v1/search/semantic`
- `POST /v1/search/lexical`

결정:

1. primitive selector는 path가 authority다.
2. body에서 `mode`, `retrieval_mode`를 받지 않는다.
3. body에서 `sessionContext`, `previous_entities`, `clarification`을 받지 않는다.
4. primitive search는 retrieval input만 받는다.

### 2.3 Lookup

- `POST /v1/lookup/wine`

결정:

1. `lookup`는 exact-ish wine resolution 전용이다.
2. `lookup`는 discovery search 대체가 아니다.
3. comparison query나 multi-entity query는 fail-closed 한다.

## 3. History Custody Model

### 3.1 Caller-managed history

`POST /v1/agent/run`

특성:

1. caller가 필요한 history를 직접 넣는다.
2. 서버가 session 저장을 강제하지 않는다.
3. replay와 determinism이 단순하다.

### 3.2 Server-managed history

`POST /v1/agent/sessions`
`POST /v1/agent/sessions/:sessionId/turns`

특성:

1. 서버가 session history를 저장한다.
2. payload가 작아진다.
3. idempotency, concurrency, TTL, persistence 정책이 필요하다.

### 3.3 공통 원칙

1. 두 surface는 같은 orchestrator를 쓴다.
2. 둘 다 prompt에 실제로 적용된 history를 trace로 돌려준다.
3. token budget 초과 시 hidden truncation 금지다.
4. 요약이 필요하면 explicit summarization stage와 trace가 있어야 한다.

## 4. CLI Mirror Decision

CLI는 HTTP taxonomy를 그대로 반영한다.

- `agent run`
- `agent session start`
- `agent session turn`
- `search hybrid`
- `search semantic`
- `search lexical`
- `lookup wine`

결정:

1. `search run`과 `wine-search run`은 제거한다.
2. `--mode`, `--retrieval-mode`, `--session-id`, `--previous-entity`는 primitive search에서 제거한다.
3. local/remote adapter는 command 뒤에 숨고, command name이 primitive를 직접 말해야 한다.

## 5. Internal Tool Taxonomy

active agent tool taxonomy는 external primitive taxonomy와 맞춘다.

- `search_hybrid`
- `search_semantic`
- `search_lexical`
- `lookup_wine`

결정:

1. `search_wines(mode=...)`는 제거한다.
2. `get_food_pairings`, `check_drinking_window`, `compare_wines`는 active agent loop에서 제거 대상이다.
3. 그 기능이 필요하면 agent가 primitive retrieval + synthesis로 구성한다.
4. tool input normalizer와 executor는 primitive별 typed request만 다룬다.

## 6. Storage Decision

sessionful agent surface는 persistent store를 요구한다.

필수 속성:

1. `session_id`
2. `session_version`
3. `turn_index`
4. `client_turn_id`
5. `messages`
6. `history_applied`
7. `tool trace summary`
8. `created_at`, `updated_at`, `expires_at`

정책:

1. `client_turn_id`는 idempotency key다.
2. `expected_session_version` 불일치 시 fail-closed 한다.
3. store unavailable이면 `/v1/agent/sessions*`는 degraded success가 아니라 error다.

## 7. Migration Policy

1. legacy route/command는 alias로 남기지 않는다.
2. OpenAPI catalog version은 MAJOR bump한다.
3. new surface와 legacy purge는 같은 program 안에서 끝낸다.
4. grep-based banned-surface rail을 추가한다.

## 8. 남기는 내부 명칭

당장 반드시 바꾸지 않아도 되는 것:

1. `src/application/wine-search/**` 폴더명
2. `WineSearchOrchestrator` 클래스명

바꾸는 편이 좋은 것:

1. `src/application/cli/dto/wine-search.dto.ts`
2. `src/application/cli/port/wine-search-facade.port.ts`
3. `src/application/cli/command/wine-search/**`
4. `src/infrastructure/cli/*/remote-wine-search-facade.ts`

기준:

- external contract를 그대로 반영하는 wrapper 명칭은 `agent`로 맞춘다.
- domain-specific core 명칭은 비용 대비 이득이 작으면 유지 가능하다.
