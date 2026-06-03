'use client';

/**
 * Ops API playground: fire any entity-lookup-V2 OPERATOR endpoint directly
 * (debug/write-gated) and inspect the raw response. The generic panel +
 * request/response/curl machinery lives in {@link ApiPlaygroundPanel}; this
 * view supplies the ops endpoint catalog and the credential panel.
 *
 * The public product-search endpoints have their own tester (SearchApiView).
 */

import { ApiPlaygroundPanel, prettyJson, type EndpointSpec } from '@/features/api-playground';
import { OpsNav } from './ops-nav';
import { OpsKeysPanel, useOpsKeys } from './ops-keys';

const OPS_ENDPOINTS: readonly EndpointSpec[] = [
  { id: 'health', label: 'Health', method: 'GET', path: '/health', auth: 'none', template: '' },
  {
    id: 'lookup',
    label: 'Public lookup',
    method: 'POST',
    path: '/v2/entity-lookup',
    auth: 'none',
    template: prettyJson({ query: 'sassicaia' }),
  },
  {
    id: 'inspect',
    label: 'Ops · inspect',
    method: 'POST',
    path: '/v2/entity-lookup/ops/inspect',
    auth: 'debug',
    template: prettyJson({ query: 'sassicaia' }),
  },
  {
    id: 'alias-audit',
    label: 'Ops · alias-audit',
    method: 'POST',
    path: '/v2/entity-lookup/ops/alias-audit',
    auth: 'debug',
    template: prettyJson({ entity_id: 'sassicaia-2018' }),
  },
  {
    id: 'coverage-health',
    label: 'Ops · coverage-health',
    method: 'POST',
    path: '/v2/entity-lookup/ops/coverage-health',
    auth: 'debug',
    template: prettyJson({}),
  },
  {
    id: 'proposals',
    label: 'Ops · proposals (list)',
    method: 'POST',
    path: '/v2/entity-lookup/ops/proposals',
    auth: 'debug',
    template: prettyJson({ limit: 50 }),
  },
  {
    id: 'submit-alias',
    label: 'Ops · proposals/submit (alias)',
    method: 'POST',
    path: '/v2/entity-lookup/ops/proposals/submit',
    auth: 'write',
    template: prettyJson({
      kind: 'alias',
      surface_form: '사씨카이아',
      target_entity_id: 'sassicaia-2018',
      proposed_type: 'phonetic',
      confidence: 0.9,
      evidence: { source: 'playground', note: '' },
      proposed_by: 'console',
    }),
  },
  {
    id: 'submit-ambiguity',
    label: 'Ops · proposals/submit (ambiguity)',
    method: 'POST',
    path: '/v2/entity-lookup/ops/proposals/submit',
    auth: 'write',
    template: prettyJson({
      kind: 'ambiguity',
      normalized_form: 'sassicaia',
      member_entity_ids: ['sassicaia-2018', 'sassicaia-2019'],
      evidence: { source: 'playground', note: '' },
      proposed_by: 'console',
    }),
  },
  {
    id: 'submit-suppression',
    label: 'Ops · proposals/submit (suppression)',
    method: 'POST',
    path: '/v2/entity-lookup/ops/proposals/submit',
    auth: 'write',
    template: prettyJson({
      kind: 'suppression',
      surface_form: 'bad alias',
      reason: 'mis-mapped',
      evidence: { source: 'playground', note: '' },
      proposed_by: 'console',
    }),
  },
  {
    id: 'review',
    label: 'Ops · proposals/review',
    method: 'POST',
    path: '/v2/entity-lookup/ops/proposals/review',
    auth: 'write',
    template: prettyJson({
      kind: 'alias',
      proposal_id: '<paste proposal_id>',
      decision: 'approve',
      reviewed_by: 'console',
      decision_reason: 'approved via playground',
    }),
  },
  {
    id: 'publish',
    label: 'Ops · proposals/publish',
    method: 'POST',
    path: '/v2/entity-lookup/ops/proposals/publish',
    auth: 'write',
    template: prettyJson({ kind: 'alias', proposal_id: '<paste proposal_id>', reviewed_by: 'console' }),
  },
] as const;

export function OpsPlaygroundView() {
  const keys = useOpsKeys();
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-xl font-bold">Entity Lookup V2 — Ops</h1>
      <OpsNav />
      <OpsKeysPanel keys={keys} requireWrite />
      <ApiPlaygroundPanel endpoints={OPS_ENDPOINTS} keys={keys} title="Ops API playground" />
    </div>
  );
}
