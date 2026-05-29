'use client';

/**
 * WineSearchView — UI for the Plan-then-Execute orchestrator
 * (`POST /v1/agent`).
 *
 *   - `meta.intent` + `meta.plan_kind`
 *   - `meta.termination.{reason, layer, kind?, degraded_reason?}`
 *   - `meta.policy_blocked` (typed boolean, no longer inferred)
 *   - `execution.steps[].source` (analyzer / router / runner / mini_loop / synthesizer)
 *   - `execution.tool_call_count`
 *   - `execution.steps[].tool_calls[].{name, arguments}`
 *
 * Special states rendered explicitly:
 *   - `meta.termination.kind === 'security_block'` → red banner (true block).
 *   - `meta.termination.kind === 'unsupported_intent'` → amber banner
 *     (coverage gap; NOT a policy block — `policy_blocked === false`).
 *   - `meta.termination.degraded_reason === 'unexpected_error'` → red badge
 *     so dashboards/users can tell runtime crashes apart from malformed LLM
 *     output (P-M1 finding).
 *   - `meta.termination.layer === 'layer4'` → fallback-layer banner so the
 *     reviewer notices the synthesizer never produced a primary answer.
 */

import { useState } from 'react';
import { Loader2, Play, Sparkles } from 'lucide-react';
import { api, ApiError } from '@/shared/api/client';
import type { WineSearchResponse } from '@/shared/api/types';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { cn } from '@/shared/lib';

/** Default `max_steps` mirrors the orchestrator default. */
const DEFAULT_MAX_STEPS = 5;

/** Lower/upper bound for the `max_steps` input. Server-side Zod accepts
 *  `[1, MAX_AGENT_STEPS_CAP=10]`; mirror that range in the UI control. */
const MAX_STEPS_INPUT_MIN = 1;
const MAX_STEPS_INPUT_MAX = 10;

export function WineSearchView() {
  const [query, setQuery] = useState('');
  const [maxSteps, setMaxSteps] = useState(DEFAULT_MAX_STEPS);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WineSearchResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const runQuery = async () => {
    const q = query.trim();
    if (!q) return;
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const res = await api.wineSearch.execute({
        query: q,
        ...(maxSteps !== DEFAULT_MAX_STEPS ? { options: { max_steps: maxSteps } } : {}),
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
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8" data-testid="wine-search-view">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Sparkles className="h-7 w-7 text-[color:var(--accent)]" aria-hidden />
            와인 검색 (Plan-then-Execute)
          </h1>
          <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
            POST{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">/v1/agent</code>{' '}
            새 오케스트레이터를 호출합니다. 백엔드에{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">WINE_SEARCH_ENABLED=true</code>{' '}
            와 LLM 키가 필요합니다.
          </p>
        </div>
        <label className="text-xs text-muted-foreground flex items-center gap-1">
          max_steps
          <input
            type="number"
            min={MAX_STEPS_INPUT_MIN}
            max={MAX_STEPS_INPUT_MAX}
            value={maxSteps}
            onChange={(ev) =>
              setMaxSteps(Number.parseInt(ev.target.value, 10) || DEFAULT_MAX_STEPS)
            }
            className="w-14 rounded-md border border-border bg-background px-2 py-1 text-sm"
            aria-label="max_steps"
          />
        </label>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">질문</h2>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={3}
          placeholder="예: 부르고뉴 피노누아 5만원대 추천"
          className={cn(
            'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm',
            'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)]/30',
          )}
        />
        <Button
          type="button"
          disabled={running || !query.trim()}
          onClick={() => void runQuery()}
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Play className="h-4 w-4 mr-2" />
          )}
          실행
        </Button>
      </section>

      {runError ? (
        <Card
          className="border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
          role="alert"
        >
          {runError}
        </Card>
      ) : null}

      {result ? <WineSearchResultView result={result} /> : null}
    </div>
  );
}

interface WineSearchResultViewProps {
  readonly result: WineSearchResponse;
}

function WineSearchResultView({ result }: WineSearchResultViewProps) {
  const { meta, execution, answer } = result;
  const { termination } = meta;

  return (
    <section className="space-y-3" data-testid="wine-search-result">
      <h2 className="text-sm font-semibold text-foreground">응답</h2>
      <Card className="p-4 space-y-4">
        {/* ── Meta strip ───────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span data-testid="meta-request-id">request_id: {meta.request_id}</span>
          <span>{meta.total_duration_ms} ms</span>
          <span data-testid="meta-tool-call-count">
            tools: {execution.tool_call_count}
          </span>
          <Badge variant="info" data-testid="meta-intent">
            intent: {meta.intent}
          </Badge>
          <Badge variant="info" data-testid="meta-plan-kind">
            plan: {meta.plan_kind}
          </Badge>
        </div>

        {/* ── Termination block ────────────────────────────────────── */}
        <TerminationBlock termination={termination} policyBlocked={meta.policy_blocked} />

        {/* ── Answer ──────────────────────────────────────────────── */}
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground mb-1">answer</h3>
          <p
            className="text-sm text-foreground whitespace-pre-wrap"
            data-testid="wine-search-answer"
          >
            {answer}
          </p>
        </div>

        {/* ── Steps ───────────────────────────────────────────────── */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">steps</h3>
          <ul className="space-y-2" data-testid="wine-search-steps">
            {execution.steps.map((step) => (
              <li key={step.index}>
                <Card className="p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground">#{step.index}</span>
                    <Badge variant="default" data-testid={`step-${step.index}-source`}>
                      {step.source}
                    </Badge>
                    <span className="text-muted-foreground">{step.duration_ms} ms</span>
                  </div>
                  {step.summary ? (
                    <p className="text-sm text-foreground whitespace-pre-wrap">{step.summary}</p>
                  ) : null}
                  {step.tool_calls && step.tool_calls.length > 0 ? (
                    <div className="space-y-1">
                      <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        tool_calls
                      </h4>
                      <ul className="space-y-1">
                        {step.tool_calls.map((call, callIdx) => (
                          <li
                            key={`${step.index}-${call.name}-${callIdx}`}
                            className="rounded-md bg-muted/60 p-2 text-xs"
                            data-testid={`tool-call-${step.index}-${callIdx}`}
                          >
                            <div className="font-mono text-foreground">{call.name}</div>
                            <pre className="mt-1 overflow-x-auto text-[11px] leading-relaxed">
                              {JSON.stringify(call.arguments, null, 2)}
                            </pre>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {step.observations && step.observations.length > 0 ? (
                    <div className="space-y-1">
                      <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        observations
                      </h4>
                      <ul className="space-y-1">
                        {step.observations.map((obs, obsIdx) => (
                          <li
                            key={`${step.index}-obs-${obsIdx}`}
                            className="rounded-md bg-muted/40 p-2 text-[11px] text-foreground whitespace-pre-wrap"
                          >
                            {obs}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </section>
  );
}

interface TerminationBlockProps {
  readonly termination: WineSearchResponse['meta']['termination'];
  readonly policyBlocked: boolean;
}

function TerminationBlock({ termination, policyBlocked }: TerminationBlockProps) {
  const { reason, layer, kind, degraded_reason } = termination;

  // ── Banner selection (mutually exclusive) ──────────────────────────────
  // S1 semantic split: `kind` discriminates the two blocked variants.
  // `kind = security_block`  → policy_blocked = true   (red banner)
  // `kind = unsupported_intent` → policy_blocked = false (amber banner)
  let banner: React.ReactElement | null = null;
  if (kind === 'security_block') {
    banner = (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
        role="alert"
        data-testid="termination-banner-security-block"
      >
        보안 차단: 어드버서리얼/정책 위반 쿼리로 판단되어 응답이 제한됐습니다.
      </div>
    );
  } else if (kind === 'unsupported_intent') {
    banner = (
      <div
        className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-foreground"
        role="alert"
        data-testid="termination-banner-unsupported-intent"
      >
        지원되지 않는 의도: 와인 검색 플랜으로 변환할 수 없는 쿼리입니다
        (policy_blocked = false).
      </div>
    );
  } else if (layer === 'layer4') {
    banner = (
      <div
        className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-foreground"
        data-testid="termination-banner-layer4"
      >
        Layer 4 폴백 — 최종 응답이 안전망 단계에서 생성됐습니다.
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="termination-block">
      {banner}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="default" data-testid="termination-reason">
          reason: {reason}
        </Badge>
        <Badge
          variant={layer === 'primary' ? 'success' : 'warning'}
          data-testid="termination-layer"
        >
          layer: {layer}
        </Badge>
        {kind ? (
          <Badge
            variant={kind === 'security_block' ? 'danger' : 'warning'}
            data-testid="termination-kind"
          >
            kind: {kind}
          </Badge>
        ) : null}
        {degraded_reason ? (
          <Badge
            variant={degraded_reason === 'unexpected_error' ? 'danger' : 'warning'}
            data-testid="termination-degraded-reason"
          >
            degraded: {degraded_reason}
          </Badge>
        ) : null}
        <Badge
          variant={policyBlocked ? 'danger' : 'default'}
          data-testid="meta-policy-blocked"
        >
          policy_blocked: {policyBlocked ? 'true' : 'false'}
        </Badge>
      </div>
    </div>
  );
}
