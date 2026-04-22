import type { ResolvedCandidate } from '../../domain/resolver/model/resolved-candidate.js';

export interface AutocompleteEntitySummary {
  readonly entity_id: string;
  readonly canonical_label: string;
  readonly entity_type?: string | undefined;
  readonly producer?: string | undefined;
  readonly region?: string | undefined;
  readonly country?: string | undefined;
  readonly appellation?: string | undefined;
  readonly vintage?: number | undefined;
  readonly wine_type?: string | undefined;
  readonly grapes?: readonly string[] | undefined;
  readonly style?: string | undefined;
  readonly availability?: boolean | undefined;
}

export interface AutocompleteSuggestion {
  readonly entity: AutocompleteEntitySummary;
  readonly rank: number;
  readonly calibrated_score: number;
  readonly source?: ResolvedCandidate['source'] | undefined;
  readonly sources?: ResolvedCandidate['sources'] | undefined;
  readonly blocker_seed?: true | undefined;
  readonly evidence_refs?: readonly string[] | undefined;
  readonly match_reasons?: readonly string[] | undefined;
  readonly trace?: ResolvedCandidate['trace'] | undefined;
}

export interface AutocompleteResponse {
  readonly status: string;
  readonly suggestions: readonly AutocompleteSuggestion[];
  readonly decision_trace_ref: string;
  readonly authority_trace_ref: string;
  readonly request_id?: string | undefined;
}
