import { describe, it, expectTypeOf } from 'vitest';
import type {
  ComparisonSearchResponse,
  QueryRoute,
  RetrievalMode,
  SearchResponse,
  SearchResponseV1,
} from '../types';

describe('shared api contract types', () => {
  it('narrows route and retrieval vocabulary to server unions', () => {
    expectTypeOf<SearchResponseV1['engine_decision']['route']>().toEqualTypeOf<QueryRoute>();
    expectTypeOf<SearchResponseV1['meta']['route']>().toEqualTypeOf<QueryRoute>();
    expectTypeOf<NonNullable<SearchResponseV1['meta']['execution_contract']>['effective_retrieval_mode']>()
      .toEqualTypeOf<RetrievalMode>();
    expectTypeOf<NonNullable<SearchResponseV1['meta']['execution_contract']>['planner_suggested_mode']>()
      .toEqualTypeOf<RetrievalMode>();
    expectTypeOf<NonNullable<SearchResponseV1['meta']['provenance_trace']>['gate_decisions']['decision_status']>()
      .toEqualTypeOf<SearchResponseV1['engine_decision']['decision_status']>();
  });

  it('exposes search/comparison as a discriminated union', () => {
    expectTypeOf<SearchResponse['query_type']>().toEqualTypeOf<'search' | 'comparison'>();
    expectTypeOf<ComparisonSearchResponse['query_type']>().toEqualTypeOf<'comparison'>();
  });
});
