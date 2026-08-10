import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/index.js';
import { executeCompanionStructuredAgent } from '../core/workflow/companion/review-runner.js';

function response(status: AgentResponse['status']): AgentResponse {
  return {
    persona: 'security-reviewer',
    status,
    content: status === 'done' ? 'reviewed' : 'failed',
    timestamp: new Date('2026-08-08T00:00:00.000Z'),
    structuredOutput: { findings: [], updates: [] },
    providerUsage: {
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      usageMissing: false,
    },
  };
}

describe('CT-COMP-06 and CT-COMP-11 structured internal agent execution', () => {
  it.each(['selector', 'reviewer', 'moderator', 'judge'] as const)(
    'should execute %s stateless, tool-free, strict-readonly and record successful usage',
    async (purpose) => {
      const call = vi.fn().mockResolvedValue(response('done'));
      const recordUsage = vi.fn();

      await executeCompanionStructuredAgent({
        purpose,
        agentName: purpose === 'reviewer' ? 'security-reviewer' : `companion-${purpose}`,
        systemPrompt: 'system',
        prompt: 'prompt',
        outputSchema: { type: 'object' },
        cwd: '/worktree',
        projectCwd: '/project',
        language: 'en',
        resolution: { provider: 'mock', model: 'mock-model', providerOptions: {} },
        call,
        recordUsage,
      });

      expect(call).toHaveBeenCalledWith(
        expect.stringMatching(/system[\s\S]*companion evidence boundary \(engine-owned\)/i),
        'prompt',
        { type: 'object' },
        expect.objectContaining({
          cwd: '/worktree',
          projectCwd: '/project',
          language: 'en',
          resolution: { provider: 'mock', model: 'mock-model', providerOptions: {} },
          permissionMode: 'readonly',
          allowedTools: [],
          mcpServers: {},
          sessionId: undefined,
        }),
      );
      expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        purpose,
        success: true,
        usage: expect.objectContaining({ totalTokens: 30 }),
      }));
    },
  );

  it('should record failed usage before propagating an internal call failure to the fail-soft boundary', async () => {
    const failure = new Error('provider failed');
    const recordUsage = vi.fn();

    await expect(executeCompanionStructuredAgent({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      language: 'en',
      resolution: { provider: 'mock', model: 'mock-model', providerOptions: {} },
      call: vi.fn().mockRejectedValue(failure),
      recordUsage,
    })).rejects.toBe(failure);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'reviewer',
      success: false,
    }));
  });

  it.each(['error', 'blocked', 'rate_limited'] as const)(
    'should record a resolved %s response as failed usage while retaining provider usage',
    async (status) => {
      const recordUsage = vi.fn();

      const result = await executeCompanionStructuredAgent({
        purpose: 'reviewer',
        agentName: 'security-reviewer',
        systemPrompt: 'system',
        prompt: 'prompt',
        outputSchema: { type: 'object' },
        cwd: '/worktree',
        projectCwd: '/project',
        language: 'en',
        resolution: { provider: 'mock' },
        call: vi.fn().mockResolvedValue(response(status)),
        recordUsage,
      });

      expect(result.status).toBe(status);
      expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        usage: expect.objectContaining({ totalTokens: 30 }),
      }));
    },
  );

  it('should reject a signal-ignoring response after parent abort without recording successful usage', async () => {
    const controller = new AbortController();
    const recordUsage = vi.fn();
    let resolveCall!: (value: AgentResponse) => void;
    const call = vi.fn(() => new Promise<AgentResponse>((resolve) => { resolveCall = resolve; }));
    const execution = executeCompanionStructuredAgent({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      language: 'en',
      resolution: { provider: 'mock' },
      abortSignal: controller.signal,
      call,
      recordUsage,
    });

    controller.abort();
    resolveCall(response('done'));

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('should abort and record a failed usage event when one companion call reaches its timeout', async () => {
    vi.useFakeTimers();
    const recordUsage = vi.fn();
    const call = vi.fn((_system, _prompt, _schema, options: { abortSignal: AbortSignal }) => (
      new Promise<AgentResponse>((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      })
    ));

    try {
      const execution = executeCompanionStructuredAgent({
        purpose: 'reviewer',
        agentName: 'security-reviewer',
        systemPrompt: 'system',
        prompt: 'prompt',
        outputSchema: { type: 'object' },
        cwd: '/worktree',
        projectCwd: '/project',
        language: 'en',
        resolution: { provider: 'mock', model: 'mock-model', providerOptions: {} },
        timeoutMs: 100,
        call,
        recordUsage,
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(execution).rejects.toThrow(/timeout|timed out/i);
      expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        purpose: 'reviewer',
        success: false,
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
