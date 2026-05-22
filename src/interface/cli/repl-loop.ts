/**
 * Interactive multi-turn REPL loop for the wine agent.
 *
 * Loose coupling: this module depends ONLY on the narrow {@link AgentRunner}
 * port (structurally satisfied by the real `AgentOrchestrator`) plus the
 * session + renderers. It imports NOTHING from `config`, `infrastructure`, or
 * any DB/Redis client — bootstrapping is the entrypoint's job (agent-repl.ts).
 * That keeps the loop unit-testable with a mock runner and no live services.
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { stdin as defaultIn, stdout as defaultOut } from 'node:process';
import type { Readable, Writable } from 'node:stream';
import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import type { ConversationContext } from '../../domain/agent/model/conversation-context.js';
import { ReplSession } from './session.js';
import { renderAnswer } from './render/render-answer.js';
import { renderTrace } from './render/render-trace.js';
import { color } from './render/colors.js';

/** Narrow port: exactly what the loop needs from the orchestrator. */
export interface AgentRunner {
  execute(
    query: string,
    requestId: string,
    overrides?: Partial<Pick<AgentConfig, 'maxSteps' | 'perStepTimeoutMs' | 'agentTimeoutMs'>>,
    abortSignal?: AbortSignal,
    conversationContext?: ConversationContext,
  ): Promise<AgentResult>;
}

export interface ReplOptions {
  /** maxSteps override forwarded to the orchestrator per turn. */
  readonly maxSteps?: number;
  /** When true, print the ReAct step trace under each answer. */
  readonly trace?: boolean;
}

interface ProcessTurnResult {
  readonly output: string;
}

/**
 * Run one conversational turn: fold prior context into the query, invoke the
 * agent, record the turn, and produce the rendered output. No I/O — the caller
 * prints `output`. Exposed separately so it can be unit-tested with a mock
 * runner without touching readline/stdin.
 */
export async function processTurn(
  runner: AgentRunner,
  session: ReplSession,
  input: string,
  options: ReplOptions = {},
  abortSignal?: AbortSignal,
): Promise<ProcessTurnResult> {
  // The query sent is the user's RAW input (clean, fully sanitizer-screened).
  // Prior-turn context rides separately as a structured ConversationContext,
  // captured before this turn is recorded so it reflects only earlier turns.
  const query = input.trim();
  const requestId = randomUUID();
  const overrides = options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : undefined;
  const conversationContext = session.toConversationContext();

  const result = await runner.execute(query, requestId, overrides, abortSignal, conversationContext);

  session.record(input, result);

  const blocks = [renderAnswer(result)];
  if (options.trace === true) {
    blocks.push(color.gray('─── trace ───'));
    blocks.push(renderTrace(result));
  }
  return { output: blocks.join('\n') };
}

const BANNER = `🍷 wine agent — 멀티턴 대화형 CLI
  종료: /exit (또는 Ctrl-D)   초기화: /reset   트레이스 토글: /trace   도움말: /help`;

const HELP = `사용 가능한 명령:
  /exit, /quit   세션 종료
  /reset         대화 history 초기화
  /trace         답변 아래 ReAct 단계 추적 표시 on/off
  /help          이 도움말
  (그 외 입력은 모두 에이전트에게 질문으로 전달됩니다)`;

interface ReplLoopDeps {
  readonly runner: AgentRunner;
  readonly options?: ReplOptions;
  /** Overridable for tests; default to process stdin/stdout. */
  readonly input?: Readable;
  readonly output?: Writable;
}

/**
 * Wire readline to {@link processTurn} for an interactive session. Resolves
 * when the user exits (/exit, /quit, or EOF/Ctrl-D).
 */
export async function runReplLoop(deps: ReplLoopDeps): Promise<void> {
  const input = deps.input ?? defaultIn;
  const output = deps.output ?? defaultOut;
  const session = new ReplSession();
  let trace = deps.options?.trace === true;

  const rl: Interface = createInterface({ input, output, prompt: color.cyan('> ') });
  const write = (s: string): void => void output.write(s + '\n');

  write(BANNER);
  rl.prompt();

  // Ctrl-C semantics: abort an in-flight turn if one is running; otherwise the
  // entrypoint's signal handler (or a second Ctrl-C) ends the process.
  let inFlight: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (inFlight !== null) {
      inFlight.abort();
      write(color.yellow('\n⏹ 현재 요청 중단됨'));
    } else {
      write(color.gray('\n(질문을 입력하거나 /exit 로 종료)'));
      rl.prompt();
    }
  });

  for (;;) {
    let line: string;
    try {
      line = await rl.question('');
    } catch {
      break; // readline closed (EOF / Ctrl-D)
    }
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      rl.prompt();
      continue;
    }
    if (trimmed === '/exit' || trimmed === '/quit') break;
    if (trimmed === '/help') {
      write(HELP);
      rl.prompt();
      continue;
    }
    if (trimmed === '/reset') {
      session.reset();
      write(color.gray('history 초기화됨'));
      rl.prompt();
      continue;
    }
    if (trimmed === '/trace') {
      trace = !trace;
      write(color.gray(`trace ${trace ? 'on' : 'off'}`));
      rl.prompt();
      continue;
    }

    inFlight = new AbortController();
    try {
      const turnOptions: ReplOptions = {
        ...(deps.options?.maxSteps !== undefined ? { maxSteps: deps.options.maxSteps } : {}),
        trace,
      };
      const { output: rendered } = await processTurn(
        deps.runner,
        session,
        trimmed,
        turnOptions,
        inFlight.signal,
      );
      write(rendered);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      write(color.red(`✖ 오류: ${msg}`));
    } finally {
      inFlight = null;
    }
    rl.prompt();
  }

  rl.close();
  write(color.gray('bye 🍷'));
}
