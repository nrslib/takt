import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallAIWithRetry, mockInitializeSession } = vi.hoisted(() => ({
  mockCallAIWithRetry: vi.fn(),
  mockInitializeSession: vi.fn(),
}));

vi.mock('../features/interactive/taskInstructionFormat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/taskInstructionFormat.js')>()),
  resolveFormalSpecConfigurationWithoutPrompt: () => ({ mode: false, comments: true, modelCheckTimeoutSeconds: 17 }),
}));

vi.mock('../features/interactive/aiCaller.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/aiCaller.js')>()),
  callAIWithRetry: (...args: unknown[]) => mockCallAIWithRetry(...args),
}));

vi.mock('../features/interactive/sessionInitialization.js', () => ({
  initializeSession: (...args: unknown[]) => mockInitializeSession(...args),
}));

vi.mock('../features/interactive/assistantInitFiles.js', () => ({
  loadAssistantInitContext: vi.fn(() => ''),
}));

import { createTaktAcpAgent } from '../app/acp/agent.js';
import type { TaktAcpSessionUpdate } from '../app/acp/types.js';

function useProvider(providerType: string): void {
  mockInitializeSession.mockReturnValue({
    provider: {},
    providerType,
    model: undefined,
    lang: 'en',
    personaName: 'interactive',
    sessionId: undefined,
  });
}

async function openSession(sendSessionUpdate: (sessionId: string, update: TaktAcpSessionUpdate) => void) {
  const agent = createTaktAcpAgent({ sendSessionUpdate });
  const { sessionId } = await agent.handleSessionNew({ cwd: '/repo', mcpServers: [] });
  const prompt = (text: string) => agent.handleSessionPrompt({ sessionId, prompt: [{ type: 'text', text }] });
  return { sessionId, prompt };
}

function agentMessages(sendSessionUpdate: ReturnType<typeof vi.fn>): string[] {
  return sendSessionUpdate.mock.calls.flatMap(([, update]) => {
    const typed = update as TaktAcpSessionUpdate;
    return typed.kind === 'agent_message' ? [typed.text] : [];
  });
}

describe('ACP delivery of the MCP-unavailable notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallAIWithRetry.mockResolvedValue({
      result: { content: 'assistant reply', success: true },
      sessionId: undefined,
    });
  });

  it.each(['pi', 'deepseek-harness'])(
    'sends the notice to the ACP client once before the first reply when provider %s lacks MCP support',
    async (providerType) => {
      useProvider(providerType);
      const sendSessionUpdate = vi.fn();
      const { sessionId, prompt } = await openSession(sendSessionUpdate);
      expect(sendSessionUpdate).not.toHaveBeenCalled();

      await expect(prompt('hello')).resolves.toEqual({ stopReason: 'end_turn' });
      await expect(prompt('and again')).resolves.toEqual({ stopReason: 'end_turn' });

      expect(sendSessionUpdate.mock.calls.every(([id]) => id === sessionId)).toBe(true);
      expect(agentMessages(sendSessionUpdate)).toEqual([
        expect.stringContaining('does not support MCP servers'),
        'assistant reply',
        'assistant reply',
      ]);
      const [, , , , context] = mockCallAIWithRetry.mock.calls[0]!;
      expect(context).toMatchObject({ mcpServers: undefined, taskStateMcpServers: undefined });
    },
  );

  it('sends only the reply when the provider supports MCP', async () => {
    useProvider('claude-sdk');
    const sendSessionUpdate = vi.fn();
    const { prompt } = await openSession(sendSessionUpdate);

    await expect(prompt('hello')).resolves.toEqual({ stopReason: 'end_turn' });

    expect(agentMessages(sendSessionUpdate)).toEqual(['assistant reply']);
  });
});
