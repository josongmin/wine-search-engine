import { describe, it, expectTypeOf } from 'vitest';
import type {
  ComparisonSearchResponse,
  QueryRoute,
  RetrievalMode,
  SearchResponse,
  SearchResponseV1,
  WineSearchAnswerLayer,
  WineSearchDegradedReason,
  WineSearchPlanKind,
  WineSearchQueryIntent,
  WineSearchResponse,
  WineSearchStepDto,
  WineSearchTermination,
  WineSearchTerminationKind,
  WineSearchTerminationReason,
  WineSearchToolCallDto,
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

describe('WineSearchResponse contract types', () => {
  it('discriminator is the literal "wine_search"', () => {
    expectTypeOf<WineSearchResponse['query_type']>().toEqualTypeOf<'wine_search'>();
  });

  it('renames tool call fields from { tool, input } to { name, arguments }', () => {
    expectTypeOf<WineSearchToolCallDto>().toEqualTypeOf<{
      name: string;
      arguments: Record<string, unknown>;
    }>();
  });

  it('step.source narrows to the orchestrator stage union', () => {
    expectTypeOf<WineSearchStepDto['source']>().toEqualTypeOf<
      'analyzer' | 'router' | 'runner' | 'mini_loop' | 'synthesizer'
    >();
  });

  it('meta.intent / meta.plan_kind narrow to the wire enums', () => {
    expectTypeOf<WineSearchResponse['meta']['intent']>().toEqualTypeOf<WineSearchQueryIntent>();
    expectTypeOf<WineSearchResponse['meta']['plan_kind']>().toEqualTypeOf<WineSearchPlanKind>();
  });

  it('meta.policy_blocked is a typed boolean (no longer inferred)', () => {
    expectTypeOf<WineSearchResponse['meta']['policy_blocked']>().toEqualTypeOf<boolean>();
  });

  it('meta.termination groups reason/layer/kind?/degraded_reason? into one record', () => {
    expectTypeOf<WineSearchResponse['meta']['termination']>().toEqualTypeOf<WineSearchTermination>();
    expectTypeOf<WineSearchTermination['reason']>().toEqualTypeOf<WineSearchTerminationReason>();
    expectTypeOf<WineSearchTermination['layer']>().toEqualTypeOf<WineSearchAnswerLayer>();
    // kind + degraded_reason are optional discriminants
    expectTypeOf<WineSearchTermination['kind']>().toEqualTypeOf<WineSearchTerminationKind | undefined>();
    expectTypeOf<WineSearchTermination['degraded_reason']>().toEqualTypeOf<
      WineSearchDegradedReason | undefined
    >();
  });

  it('degraded_reason carries the new "unexpected_error" slot (P-M1)', () => {
    // Type-only assertion: the new literal must be assignable to the union.
    expectTypeOf<'unexpected_error'>().toMatchTypeOf<WineSearchDegradedReason>();
  });

  it('termination.kind discriminates security_block vs unsupported_intent', () => {
    expectTypeOf<'security_block'>().toMatchTypeOf<WineSearchTerminationKind>();
    expectTypeOf<'unsupported_intent'>().toMatchTypeOf<WineSearchTerminationKind>();
    // Exhaustive: the union has exactly these two literals.
    expectTypeOf<WineSearchTerminationKind>().toEqualTypeOf<
      'security_block' | 'unsupported_intent'
    >();
  });

  it('execution wraps steps + tool_call_count under one record', () => {
    expectTypeOf<WineSearchResponse['execution']>().toEqualTypeOf<{
      steps: readonly WineSearchStepDto[];
      tool_call_count: number;
    }>();
  });
});
