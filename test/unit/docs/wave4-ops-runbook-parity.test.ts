import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

describe('Wave 4 ops runbook parity', () => {
  const runbook = readWorkspaceFile('docs/bugbash/apr-6-hardening-wave4-ops-runbook.md');
  const wave4Board = readWorkspaceFile('docs/bugbash/apr-6-hardening-wave4.md');
  const inventory = readWorkspaceFile('docs/bugbash/apr-6-hardening-wave4-consumer-inventory.md');
  const migrationGuide = readWorkspaceFile('docs/bugbash/apr-6-hardening-wave4-migration-guide.md');
  const searchLogSchema = readWorkspaceFile('src/observability/search-log-schema.ts');

  it('keeps the runbook aligned with the canonical search log field set', () => {
    expect(runbook).toContain('`runtime_correlation_ref`');
    expect(runbook).toContain('`authority_trace_ref`');
    expect(runbook).toContain('`execution_mode`');
    expect(runbook).toContain('`blocking_eligible`');
    expect(runbook).toContain('`degradation_reasons`');
    expect(runbook).toContain('`specialized_route_requested`');
    expect(runbook).toContain('`specialized_route_executed`');
    expect(runbook).toContain('`fallback_applied`');
    expect(runbook).toContain('`fallback_reason`');

    expect(searchLogSchema).toContain('runtime_correlation_ref?: string;');
    expect(searchLogSchema).toContain('authority_trace_ref?: string;');
    expect(searchLogSchema).toContain("execution_mode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';");
    expect(searchLogSchema).toContain('blocking_eligible?: boolean;');
    expect(searchLogSchema).toContain('degradation_reasons?: readonly string[];');
    expect(searchLogSchema).toContain('specialized_route_requested?: SpecializedRouteName | null;');
    expect(searchLogSchema).toContain('specialized_route_executed?: SpecializedRouteName | null;');
    expect(searchLogSchema).toContain('fallback_applied?: boolean;');
    expect(searchLogSchema).toContain('fallback_reason?: SpecializedFallbackReason | null;');
  });

  it('keeps the board linked to the ops runbook deliverable', () => {
    expect(wave4Board).toContain('Ops runbook: [apr-6-hardening-wave4-ops-runbook.md]');
    expect(runbook).toContain('[Wave 4 Consumer Inventory]');
    expect(runbook).toContain('[Wave 4 Deprecated-Field Migration Guide]');
  });

  it('keeps deprecated-field removal status aligned with retired historical docs', () => {
    expect(wave4Board).toContain(
      '| Deprecated `decision_trace_ref` active-gate consumer migration | 완료 | active repo/runtime/docs canonical surface 완료; historical Wave 3 doc consumer는 `retired` historical reference로 gate에서 제외 |',
    );
    expect(wave4Board).toContain('`not_started | partial | complete | retired | unknown`');
    expect(inventory).toContain(
      '| Wave 3 hardening doc | `docs/bugbash/apr-6-hardening-wave3.md` | docs | yes | yes | yes | yes | yes | yes | retired | docs | Historical archive/reference only; excluded from active deprecated-field removal gate. |',
    );
    expect(migrationGuide).toContain('inventory의 deprecated consumer row가 모두 `complete` 또는 explicit `retired`');
    expect(migrationGuide).toContain('[apr-6-hardening-wave3.md]');
    expect(migrationGuide).toContain(
      'historical archive/reference consumer; deprecated co-exposure 서술이 남아 있지만 active removal gate에서는 제외',
    );
  });
});
