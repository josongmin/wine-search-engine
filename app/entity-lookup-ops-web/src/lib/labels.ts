// Display helpers: clean up raw pipeline keys/codes into human Korean for the UI.
// The underlying codes stay in the data — these are presentation-only.

// `family::angelus::::::::::::bare::ko` → `family · angelus · bare · ko`
export function prettyKey(key: string): string {
  if (!key) return '—';
  if (key.includes('::')) {
    const parts = key.split('::').map((s) => s.trim()).filter(Boolean);
    return parts.join(' · ');
  }
  return key;
}

const STATUS_KO: Record<string, string> = {
  approved: '승인',
  pending: '보류',
  rejected: '반려',
  reviewed: '검토됨',
  keep_ambiguous: '모호 유지',
  promote_exact_safe: 'exact-safe 승격',
  needs_scope_target: '스코프타깃 필요',
  exact_safe: '정확매칭',
  compact_exact_safe: '정확매칭(compact)',
  assign_target: '타깃 지정',
  collision: '충돌',
  supported: '지원됨',
  unsupported: '미지원',
};
export function koStatus(s?: string): string {
  if (!s) return '—';
  return STATUS_KO[s] ?? s;
}

// 비개발자용 일상어. "왜 이 검색어가 안 되나"를 일반 운영자가 바로 이해하도록.
const REASON_KO: Record<string, string> = {
  no_match: '아예 못 찾음',
  recall_only_no_match: '비슷한 건 있는데 정확히 못 찾음',
  CONFIDENCE_BELOW_THRESHOLD: '확신이 부족함',
  CONFIDENCE_ABOVE_THRESHOLD: '찾았는데 확정을 못 함',
  vintage_mismatch_downgrade: '연도(빈티지)가 안 맞음',
  persisted_ambiguity_surface: '일부러 안 정하고 둠',
  reviewed_family_collision_requires_clarification: '다른 와인과 헷갈림',
  requested_vintage_missing: '그 연도 제품이 아직 없음',
  scope_target_missing: '어떤 제품인지 더 좁혀야 함',
  strict_collision_ambiguous: '여러 와인과 헷갈림',
  runtime_family_missing: '그 와이너리가 아직 없음',
  family_surface_needs_specific_line: '어떤 라인(제품군)인지 정해야 함',
};
export function koReason(s?: string): string {
  if (!s) return '—';
  return REASON_KO[s] ?? s;
}
