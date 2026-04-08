'use client';

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Loader2, Play, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/shared/api/client';
import type {
  AgentBenchmarkUiScenarioDto,
  AgentExecuteResponse,
} from '@/shared/api/types';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { cn } from '@/shared/lib';

export function AgentLabView() {
  const [scenarios, setScenarios] = useState<readonly AgentBenchmarkUiScenarioDto[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  const [customQuery, setCustomQuery] = useState('');
  const [maxSteps, setMaxSteps] = useState(5);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AgentExecuteResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    setCatalogError(null);
    try {
      const res = await api.agent.listBenchmarkScenarios();
      setScenarios(res.scenarios);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setCatalogError(
          '이 환경에서는 벤치마크 시나리오 목록이 비활성화되어 있어요. API에 ENABLE_AGENT_BENCHMARK_UI=true (프로덕션) 또는 non-production 모드로 띄워 주세요.',
        );
        setScenarios([]);
      } else {
        const msg = e instanceof ApiError ? e.message : '목록을 불러오지 못했습니다.';
        setCatalogError(msg);
        setScenarios([]);
      }
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const runQuery = async (query: string) => {
    const q = query.trim();
    if (!q) return;
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const res = await api.agent.execute({
        query: q,
        ...(maxSteps !== 5 ? { options: { max_steps: maxSteps } } : {}),
      });
      setResult(res);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : '요청 실패';
      setRunError(msg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <FlaskConical className="h-7 w-7 text-[color:var(--accent)]" aria-hidden />
            에이전트 벤치 랩
          </h1>
          <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
            CLI{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              npx tsx test/benchmark/agent/runner.ts --profile quick
            </code>{' '}
            과 동일한 20개 시나리오를 고르거나, 직접 질문을 넣어 POST{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">/v1/agent</code> 흐름을 그대로 시뮬레이션합니다.
            백엔드에 <code className="rounded bg-muted px-1 py-0.5 text-xs">AGENT_ENABLED=true</code> 와 LLM 키가
            필요합니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground flex items-center gap-1">
            max_steps
            <input
              type="number"
              min={1}
              max={10}
              value={maxSteps}
              onChange={(ev) => setMaxSteps(Number.parseInt(ev.target.value, 10) || 5)}
              className="w-14 rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
        </div>
      </div>

      {loadingCatalog ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          시나리오 목록 불러오는 중…
        </div>
      ) : catalogError ? (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4 text-sm text-foreground">
          {catalogError}
          <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void loadCatalog()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            다시 시도
          </Button>
        </Card>
      ) : (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">퀵 프로필 시나리오</h2>
          <ul className="space-y-2">
            {(scenarios ?? []).map((s) => (
              <li key={s.id}>
                <Card className="p-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-xs text-muted-foreground">#{s.id}</span>
                      <span className="text-xs uppercase tracking-wide text-[color:var(--accent)]">{s.tier}</span>
                    </div>
                    <p className="font-medium text-foreground mt-0.5">{s.description}</p>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{s.query}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={running}
                    onClick={() => void runQuery(s.query)}
                    className="shrink-0"
                  >
                    {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    <span className="ml-1">실행</span>
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">직접 질문</h2>
        <textarea
          value={customQuery}
          onChange={(e) => setCustomQuery(e.target.value)}
          rows={3}
          placeholder="자연어 질문을 입력하세요…"
          className={cn(
            'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm',
            'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)]/30',
          )}
        />
        <Button type="button" disabled={running || !customQuery.trim()} onClick={() => void runQuery(customQuery)}>
          {running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          에이전트 실행
        </Button>
      </section>

      {runError ? (
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{runError}</Card>
      ) : null}

      {result ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">응답</h2>
          <Card className="p-4 space-y-3">
            <div className="text-sm text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span>request_id: {result.meta.request_id}</span>
              <span>{result.meta.total_duration_ms} ms</span>
              <span>tools: {result.meta.tool_call_count}</span>
              <span>{result.meta.termination_reason}</span>
              {result.meta.fallback_applied ? <span className="text-amber-600">fallback</span> : null}
            </div>
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground mb-1">answer</h3>
              <p className="text-sm text-foreground whitespace-pre-wrap">{result.answer}</p>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">steps (JSON)</summary>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3 text-[11px] leading-relaxed max-h-[480px] overflow-y-auto">
                {JSON.stringify(result.steps, null, 2)}
              </pre>
            </details>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
