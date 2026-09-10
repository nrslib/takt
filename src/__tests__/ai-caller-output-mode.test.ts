/**
 * `outputMode` decides who owns stdout. A silent caller (the Ink TUI) draws its
 * own frames, so nothing in the AI call may write to the terminal behind it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageAttachmentReference } from '../shared/types/image-attachments.js';
import type { StreamEvent } from '../shared/types/provider.js';
import { EXIT_SIGINT } from '../shared/exitCodes.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import { formatTaskStateReferenceMarker } from '../shared/task-state-reference.js';

const { mockInfo, mockError, mockBlankLine, mockCreateMcpAdapter } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockBlankLine: vi.fn(),
  mockCreateMcpAdapter: vi.fn(),
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  info: (...args: unknown[]) => mockInfo(...args),
  error: (...args: unknown[]) => mockError(...args),
  blankLine: (...args: unknown[]) => mockBlankLine(...args),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  updatePersonaSession: vi.fn(),
}));

vi.mock('../infra/providers/mcp/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/providers/mcp/index.js')>()),
  createMcpAdapter: (...args: unknown[]) => mockCreateMcpAdapter(...args),
}));

import { callAIWithRetry, type SessionContext } from '../features/interactive/aiCaller.js';

const ATTACHMENT: ImageAttachmentReference = {
  placeholder: '{{image:1}}',
  path: '/tmp/takt-image-1.png',
};

/** Mirrors a provider that cannot take images natively, e.g. the mock provider. */
function createContext(
  responses: Array<{ content: string; status?: 'done' | 'error' | 'blocked'; sessionId?: string }> = [
    { content: 'answer' },
  ],
  customCall?: () => Promise<{
    persona: string;
    status: 'done' | 'error' | 'blocked';
    content: string;
    timestamp: Date;
    sessionId?: string;
  }>,
): SessionContext {
  let responseIndex = 0;
  const agent = {
    call: customCall ?? vi.fn(async () => {
      const response = responses[responseIndex++] ?? responses.at(-1)!;
      return {
        persona: 'interactive',
        status: response.status ?? 'done',
        content: response.content,
        timestamp: new Date(),
        ...(response.sessionId === undefined ? {} : { sessionId: response.sessionId }),
      };
    }),
  };
  return {
    provider: {
      supportsNativeImageInput: false,
      getRuntimeInstructions: () => null,
      setup: vi.fn(() => agent),
    } as unknown as SessionContext['provider'],
    providerType: 'mock',
    model: 'mock-model',
    lang: 'en',
    personaName: 'interactive',
    sessionId: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AI call output ownership', () => {
  it('should hand a silent caller the notice instead of writing it to the terminal', async () => {
    const notices: string[] = [];

    const { result } = await callAIWithRetry(
      'prompt {{image:1}}',
      'system',
      ['Read'],
      '/repo',
      createContext(),
      {
        outputMode: 'silent',
        imageAttachments: [ATTACHMENT],
        onNotice: (message) => notices.push(message),
      },
    );

    expect(result?.success).toBe(true);
    expect(mockInfo).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
    // The caller renders it itself; losing it would leave the user wondering
    // why the image was ignored.
    expect(notices).toEqual([expect.stringContaining('does not support native image input')]);
  });

  it('should still tell a terminal caller that image paths were inlined', async () => {
    await callAIWithRetry(
      'prompt {{image:1}}',
      'system',
      ['Read'],
      '/repo',
      createContext(),
      { outputMode: 'terminal', imageAttachments: [ATTACHMENT] },
    );

    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('does not support native image input'),
    );
  });

  it('should prepare fresh MCP material for a stale-session retry', async () => {
    const firstPrepared = { dispose: vi.fn(async () => {}) };
    const secondPrepared = { dispose: vi.fn(async () => {}) };
    const adapter = {
      validate: vi.fn(),
      prepare: vi.fn()
        .mockResolvedValueOnce(firstPrepared)
        .mockResolvedValueOnce(secondPrepared),
      classifyFailure: vi.fn(),
    };
    mockCreateMcpAdapter.mockReturnValue(adapter);
    const ctx = createContext([
      { content: 'stale', status: 'error' },
      { content: 'fresh', sessionId: 'fresh-session' },
    ]);
    ctx.sessionId = 'stale-session';
    ctx.mcpServers = { takt: { type: 'stdio', command: 'takt-mcp' } };

    const { result } = await callAIWithRetry(
      'prompt',
      'system',
      ['Read'],
      '/repo',
      ctx,
      { outputMode: 'silent' },
    );

    expect(result?.content).toBe('fresh');
    expect(adapter.prepare).toHaveBeenCalledTimes(2);
    expect(firstPrepared.dispose).toHaveBeenCalledTimes(1);
    expect(secondPrepared.dispose).toHaveBeenCalledTimes(1);
  });

  it('should return a preparation error without calling a supported provider', async () => {
    const preparationError = new Error('MCP config preparation failed');
    const providerCall = vi.fn(async () => ({
      persona: 'interactive',
      status: 'done' as const,
      content: 'must not run',
      timestamp: new Date(),
    }));
    const ctx = createContext([], providerCall);
    ctx.mcpServers = { takt: { type: 'stdio', command: 'takt-mcp' } };
    mockCreateMcpAdapter.mockReturnValue({
      validate: vi.fn(),
      prepare: vi.fn().mockRejectedValue(preparationError),
      classifyFailure: vi.fn(),
    });

    const result = await callAIWithRetry(
      'prompt',
      'system',
      ['Read'],
      '/repo',
      ctx,
      { outputMode: 'silent' },
    );

    expect(result.result).toBeNull();
    expect(result.error).toBe('MCP config preparation failed');
    expect(providerCall).not.toHaveBeenCalled();
  });

  it('should dispose MCP resources before a forced SIGINT exit', async () => {
    const events: string[] = [];
    let markCallStarted!: () => void;
    let releaseCall!: () => void;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    const callCompletion = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const ctx = createContext([], async () => {
      markCallStarted();
      await callCompletion;
      return {
        persona: 'interactive',
        status: 'done',
        content: 'answer',
        timestamp: new Date(),
      };
    });
    ctx.mcpServers = { takt: { type: 'stdio', command: 'takt-mcp' } };
    const prepared = {
      dispose: vi.fn(async () => {
        events.push('dispose');
      }),
    };
    mockCreateMcpAdapter.mockReturnValue({
      validate: vi.fn(),
      prepare: vi.fn().mockResolvedValue(prepared),
      classifyFailure: vi.fn(),
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      events.push(`exit:${code}`);
      return undefined as never;
    });

    try {
      const call = callAIWithRetry(
        'prompt',
        'system',
        ['Read'],
        '/repo',
        ctx,
        { outputMode: 'terminal' },
      );
      await callStarted;
      process.emit('SIGINT');
      process.emit('SIGINT');
      releaseCall();

      const result = await call;
      expect(result.result?.success).toBe(true);
      expect(prepared.dispose).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(EXIT_SIGINT);
      expect(events).toEqual(['dispose', `exit:${EXIT_SIGINT}`]);
    } finally {
      exit.mockRestore();
    }
  });

  it('should carry the assistant plan read-only MCP server into the provider call', async () => {
    const prepared = { dispose: vi.fn(async () => {}) };
    const adapter = {
      validate: vi.fn(),
      prepare: vi.fn().mockResolvedValue(prepared),
      classifyFailure: vi.fn(),
    };
    mockCreateMcpAdapter.mockReturnValue(adapter);
    const baseContext = createContext();
    const { ctx, strategy } = createAssistantConversationPlan('/repo', {
      assistantMode: 'assistant',
      formalSpec: false,
      formalSpecComments: true,
      resolvedSessionContext: baseContext,
    });

    await callAIWithRetry(
      'inspect the selected task',
      strategy.systemPrompt,
      strategy.allowedTools,
      '/repo',
      ctx,
      { outputMode: 'silent' },
    );

    expect(ctx.mcpServers).toEqual({
      takt: expect.objectContaining({
        type: 'stdio',
        args: [expect.any(String), '--tool-set', 'read-only', '--include-reference-markers'],
      }),
    });
    expect(adapter.validate).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      servers: ctx.mcpServers,
      serverNames: ['takt'],
    }));
    expect(adapter.prepare).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      servers: ctx.mcpServers,
      serverNames: ['takt'],
    }), expect.objectContaining({ cwd: '/repo', abortSignal: expect.any(AbortSignal) }));
    const providerAgent = (ctx.provider.setup as ReturnType<typeof vi.fn>).mock.results[0]?.value as {
      call: ReturnType<typeof vi.fn>;
    };
    const providerOptions = providerAgent.call.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(providerOptions.mcpServers).toBe(ctx.mcpServers);
    expect(providerOptions.preparedMcp).toBe(prepared);
    expect(prepared.dispose).toHaveBeenCalledOnce();
  });

  it.each(['tool_result', 'tool_output'] as const)(
    'should retain the run reference from a successful MCP %s event',
    async (eventType) => {
      const prepared = { dispose: vi.fn(async () => {}) };
      mockCreateMcpAdapter.mockReturnValue({
        validate: vi.fn(),
        prepare: vi.fn().mockResolvedValue(prepared),
        classifyFailure: vi.fn(),
      });
      const ctx = createContext();
      ctx.mcpServers = { takt: { type: 'stdio', command: 'takt-mcp' } };
      const marker = formatTaskStateReferenceMarker('run-from-mcp');
      const event: StreamEvent = eventType === 'tool_result'
        ? {
          type: 'tool_result',
          data: { id: 'tool-1', content: marker, isError: false },
        }
        : {
          type: 'tool_output',
          data: { id: 'tool-1', tool: 'takt_get_run', output: marker },
        };
      vi.spyOn(ctx.provider, 'setup').mockReturnValue({
        call: async (_prompt, options) => {
          options.onStream?.({
            type: 'tool_use',
            data: { id: 'tool-1', tool: 'takt_get_run', input: { runSlug: 'run-from-mcp' } },
          });
          options.onStream?.(event);
          return {
            persona: 'interactive',
            status: 'done',
            content: 'answer',
            timestamp: new Date(),
          };
        },
      });

      const { result } = await callAIWithRetry(
        'inspect the selected task',
        'system',
        ['Read'],
        '/repo',
        ctx,
        { outputMode: 'silent', onStream: vi.fn() },
      );

      expect(result).toMatchObject({ success: true, content: 'answer', referenceRunSlug: 'run-from-mcp' });
      expect(prepared.dispose).toHaveBeenCalledOnce();
    },
  );

  it('should not derive a run reference from displayed text or the final response', async () => {
    const marker = formatTaskStateReferenceMarker('displayed-text-is-not-authoritative');
    const ctx = createContext();
    vi.spyOn(ctx.provider, 'setup').mockReturnValue({
      call: async (_prompt, options) => {
        options.onStream?.({ type: 'text', data: { text: marker } });
        options.onStream?.({
          type: 'result',
          data: { result: marker, success: true, sessionId: '' },
        });
        return {
          persona: 'interactive',
          status: 'done',
          content: marker,
          timestamp: new Date(),
        };
      },
    });

    const { result } = await callAIWithRetry(
      'prompt',
      'system',
      ['Read'],
      '/repo',
      ctx,
      { outputMode: 'silent' },
    );

    expect(result).toMatchObject({ success: true, content: marker });
    expect(result).not.toHaveProperty('referenceRunSlug');
  });

  it('should ignore failed or mismatched task-state tool results', async () => {
    const marker = formatTaskStateReferenceMarker('must-not-be-selected');
    const ctx = createContext();
    vi.spyOn(ctx.provider, 'setup').mockReturnValue({
      call: async (_prompt, options) => {
        options.onStream?.({
          type: 'tool_use',
          data: { id: 'tool-1', tool: 'takt_get_run', input: { runSlug: 'must-not-be-selected' } },
        });
        options.onStream?.({
          type: 'tool_result',
          data: { id: 'different-tool', content: marker, isError: false },
        });
        options.onStream?.({
          type: 'tool_result',
          data: { id: 'tool-1', content: marker, isError: true },
        });
        return {
          persona: 'interactive',
          status: 'done',
          content: 'answer',
          timestamp: new Date(),
        };
      },
    });

    const { result } = await callAIWithRetry(
      'prompt',
      'system',
      ['Read'],
      '/repo',
      ctx,
      { outputMode: 'silent' },
    );

    expect(result).toMatchObject({ success: true, content: 'answer' });
    expect(result).not.toHaveProperty('referenceRunSlug');
  });

  it.each(['pi', 'deepseek-harness'] as const)(
    'should keep an unsupported %s conversation usable without assigning MCP',
    async (providerType) => {
      const ctx = createContext();
      ctx.providerType = providerType;
      const { ctx: plannedContext, strategy } = createAssistantConversationPlan('/repo', {
        assistantMode: 'assistant',
        formalSpec: false,
        formalSpecComments: true,
        resolvedSessionContext: ctx,
      });

      const { result } = await callAIWithRetry(
        'prompt',
        'system',
        ['Read'],
        '/repo',
        plannedContext,
        { outputMode: 'silent' },
      );

      expect(result?.success).toBe(true);
      expect(strategy.mcpUnavailableNotice).toEqual(expect.stringContaining('MCP'));
      expect(plannedContext.mcpServers).toBeUndefined();
      expect(plannedContext.taskStateMcpServers).toBeUndefined();
      expect(mockInfo).not.toHaveBeenCalled();
    },
  );
});
