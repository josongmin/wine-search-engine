'use client';

/**
 * Product search API tester. Fires the real, public search surface directly —
 * hybrid/lexical/semantic primitive search, the agentic Plan-then-Execute
 * search (`/v1/agent`), and the V2 entity lookup — and shows the verbatim
 * response. No credentials required (these are public endpoints).
 */

import { ApiPlaygroundPanel, prettyJson, type EndpointSpec } from './api-playground';

const PRIMITIVE_TEMPLATE = prettyJson({ query: '바디감 좋은 레드 와인', limit: 10 });

const SEARCH_ENDPOINTS: readonly EndpointSpec[] = [
  {
    id: 'hybrid',
    label: 'Hybrid search',
    method: 'POST',
    path: '/v1/search/hybrid',
    auth: 'none',
    template: PRIMITIVE_TEMPLATE,
  },
  {
    id: 'lexical',
    label: 'Lexical search',
    method: 'POST',
    path: '/v1/search/lexical',
    auth: 'none',
    template: PRIMITIVE_TEMPLATE,
  },
  {
    id: 'semantic',
    label: 'Semantic search',
    method: 'POST',
    path: '/v1/search/semantic',
    auth: 'none',
    template: PRIMITIVE_TEMPLATE,
  },
  {
    id: 'agent',
    label: 'Agentic search (Plan-then-Execute)',
    method: 'POST',
    path: '/v1/agent',
    auth: 'none',
    template: prettyJson({
      messages: [{ role: 'user', content: '5만원 이하 이탈리아 레드 추천해줘' }],
    }),
  },
  {
    id: 'lookup',
    label: 'Entity lookup V2',
    method: 'POST',
    path: '/v2/entity-lookup',
    auth: 'none',
    template: prettyJson({ query: 'sassicaia' }),
  },
] as const;

export function SearchApiView() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">검색 API 테스트</h1>
        <p className="text-sm text-neutral-500">
          실제 검색 엔드포인트를 직접 호출하고 원본 응답을 확인합니다.
        </p>
      </div>
      <ApiPlaygroundPanel
        endpoints={SEARCH_ENDPOINTS}
        title="Search endpoints"
        subtitle="Public product search surface — no credentials needed."
      />
    </div>
  );
}
