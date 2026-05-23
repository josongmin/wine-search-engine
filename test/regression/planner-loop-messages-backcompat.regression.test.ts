/**
 * Regression: multi-turn ConversationContext injection must be invisible to the
 * HTTP path. The agent route never passes a conversationContext, so the planner
 * messages it produces MUST be byte-identical to the pre-conversation-context
 * behavior — the renderer is gated on `steps.length === 0 && conversationContext
 * !== undefined`, and an empty/absent context must leave the user message as the
 * bare query (no header/footer, no stray "\n\n" join artifacts).
 *
 * Verified through the public `AgentPlannerPhaseRunner.run` by spying on the
 * chatLlm port and inspecting the `messages` argument (buildPlannerLoopMessages
 * itself is module-private). The spy returns `undefined` so the run fails closed
 * afterward — irrelevant here; the messages are built and passed before parsing.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentPlannerPhaseRunner } from '../../src/application/agent/agent-planner-phase-runner.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import type { ChatLlmPort, ChatMessage } from '../../src/domain/ai/port/chat-llm.port.js';
import type { ConversationContext } from '../../src/domain/agent/model/conversation-context.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/entity-id.js';

function capturedMessages(complete: ReturnType<typeof vi.fn>): readonly ChatMessage[] {
  const arg = complete.mock.calls[0]?.[0] as { messages: readonly ChatMessage[] } | undefined;
  return arg?.messages ?? [];
}

const RECOMMENDATION_QUERY = '가벼운 레드 와인 추천해줘'; // not an exact-entity lookup

describe('planner loop messages — ConversationContext backward compatibility', () => {
  it('no conversationContext → user message is the bare query (HTTP path unchanged)', async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const runner = new AgentPlannerPhaseRunner({ chatLlm: { complete } as unknown as ChatLlmPort });
    const state = createAgentExecutionState(); // conversationContext === undefined

    await runner.run(RECOMMENDATION_QUERY, 'req-bc-none', DEFAULT_AGENT_CONFIG, state, 3, false);

    expect(complete).toHaveBeenCalledTimes(1);
    const userMsg = capturedMessages(complete).find((m) => m.role === 'user');
    expect(userMsg?.content).toBe(RECOMMENDATION_QUERY);
    // No conversation block leaked in.
    expect(userMsg?.content).not.toContain('이전 대화 맥락');
  });

  it('with conversationContext → block is folded ABOVE the query on step 0', async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const runner = new AgentPlannerPhaseRunner({ chatLlm: { complete } as unknown as ChatLlmPort });
    const conversationContext: ConversationContext = {
      turns: [
        {
          userQuery: '피자에 어울리는 와인',
          answerSummary: '키안티/발폴리첼라 추천',
          entities: [
            { entityId: 'wine-1' as CanonicalEntityId, label: 'Chianti Classico' },
          ],
        },
      ],
    };
    const state = createAgentExecutionState(conversationContext);

    await runner.run(RECOMMENDATION_QUERY, 'req-bc-ctx', DEFAULT_AGENT_CONFIG, state, 3, false);

    const userMsg = capturedMessages(complete).find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('이전 대화 맥락');
    expect(userMsg?.content).toContain('Chianti Classico');
    // The live question is still present, and appears AFTER the prior context.
    expect(userMsg?.content).toContain(RECOMMENDATION_QUERY);
    expect(userMsg!.content.indexOf('이전 대화 맥락')).toBeLessThan(
      userMsg!.content.indexOf(RECOMMENDATION_QUERY),
    );
  });
});
