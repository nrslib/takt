import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/index.js';
import { executeCompanionStructuredAgent } from '../core/workflow/companion/review-runner.js';
import {
  AGENT_FAILURE_CATEGORIES,
  createProviderStreamParseError,
} from '../shared/types/agent-failure.js';

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
    'should execute %s with its resolved runtime profile and record successful usage',
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
        failureDir: '/project/.takt/runs/run/failures',
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
          failureDir: '/project/.takt/runs/run/failures',
          language: 'en',
          resolution: { provider: 'mock', model: 'mock-model', providerOptions: {} },
        }),
      );
      const callOptions = call.mock.calls[0]?.[3];
      expect(callOptions).not.toHaveProperty('allowedTools');
      expect(callOptions).not.toHaveProperty('mcpServers');
      expect(callOptions).not.toHaveProperty('sessionId');
      expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        purpose,
        success: true,
        usage: expect.objectContaining({ totalTokens: 30 }),
      }));
    },
  );

  it('should record the resolved prompt, response, session, and attempt outcome for each internal call', async () => {
    const recordCall = vi.fn();
    const call = vi.fn(async (
      _systemPrompt: string,
      _prompt: string,
      _schema: Record<string, unknown>,
      options: { onPromptResolved?: (parts: { systemPrompt: string; userInstruction: string }) => void },
    ) => {
      options.onPromptResolved?.({
        systemPrompt: 'resolved system prompt',
        userInstruction: 'resolved user prompt',
      });
      return {
        ...response('done'),
        sessionId: 'provider-session-1',
      };
    });

    await executeCompanionStructuredAgent({
      purpose: 'selector',
      agentName: 'companion-selector',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock', model: 'mock-model', providerOptions: {} },
      call,
      recordUsage: vi.fn(),
      recordCall,
    });

    expect(call.mock.calls[0]?.[3]).toMatchObject({ sessionId: undefined });
    expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'selector',
      agentName: 'companion-selector',
      attempt: 1,
      status: 'completed',
      provider: 'mock',
      model: 'mock-model',
      systemPrompt: 'resolved system prompt',
      prompt: 'resolved user prompt',
      promptResolved: true,
      response: expect.objectContaining({
        sessionId: 'provider-session-1',
        structuredOutput: { findings: [], updates: [] },
      }),
    }));
  });

  it('should record failed attempts when the provider rejects before returning a response', async () => {
    const recordCall = vi.fn();
    const failure = new Error('provider failed');

    await expect(executeCompanionStructuredAgent({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock' },
      call: vi.fn().mockRejectedValue(failure),
      recordUsage: vi.fn(),
      recordCall,
    })).rejects.toBe(failure);

    expect(recordCall).toHaveBeenCalledTimes(2);
    expect(recordCall).toHaveBeenNthCalledWith(1, expect.objectContaining({
      purpose: 'reviewer',
      attempt: 1,
      status: 'failed',
    }));
    expect(recordCall).toHaveBeenNthCalledWith(2, expect.objectContaining({
      purpose: 'reviewer',
      attempt: 2,
      status: 'failed',
    }));
  });

  it('should retain a provider response when persisting its call audit fails', async () => {
    const call = vi.fn().mockResolvedValue(response('done'));
    const recordCall = vi.fn(() => {
      throw new Error('audit write failed');
    });
    const recordUsage = vi.fn();
    const onCallAuditPersistenceFailure = vi.fn(() => {
      throw new Error('audit diagnostic failed');
    });

    const result = await executeCompanionStructuredAgent({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock' },
      call,
      recordUsage,
      recordCall,
      onCallAuditPersistenceFailure,
    });

    expect(result.status).toBe('done');
    expect(call).toHaveBeenCalledOnce();
    expect(recordCall).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(onCallAuditPersistenceFailure).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      attempt: 1,
      error: expect.any(Error),
    }));
  });

  it('should omit prompts when the provider fails before prompt resolution', async () => {
    const recordCall = vi.fn();
    const failure = new Error('capability resolution failed');

    await expect(executeCompanionStructuredAgent({
      purpose: 'selector',
      agentName: 'companion-selector',
      systemPrompt: 'guarded system prompt',
      prompt: 'initial prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock' },
      call: vi.fn().mockRejectedValue(failure),
      recordUsage: vi.fn(),
      recordCall,
    })).rejects.toBe(failure);

    expect(recordCall).toHaveBeenCalledWith(expect.objectContaining({
      promptResolved: false,
      status: 'failed',
    }));
    expect(recordCall.mock.calls[0]?.[0]).not.toHaveProperty('systemPrompt');
    expect(recordCall.mock.calls[0]?.[0]).not.toHaveProperty('prompt');
  });

  it('should record failed usage before propagating an internal call failure to the fail-soft boundary', async () => {
    const failure = new Error('provider failed');
    const recordUsage = vi.fn();
    const call = vi.fn().mockRejectedValue(failure);

    await expect(executeCompanionStructuredAgent({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock', model: 'mock-model', providerOptions: {} },
      call,
      recordUsage,
    })).rejects.toBe(failure);
    expect(call).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'reviewer',
      success: false,
    }));
  });

  it('should retry a transient internal failure and return the successful response', async () => {
    const recordUsage = vi.fn();
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('temporary provider failure'))
      .mockResolvedValueOnce(response('done'));

    const result = await executeCompanionStructuredAgent({
      purpose: 'moderator',
      agentName: 'companion-moderator',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock' },
      call,
      recordUsage,
    });

    expect(result.status).toBe('done');
    expect(call).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      purpose: 'moderator',
      success: false,
    }));
    expect(recordUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      purpose: 'moderator',
      success: true,
    }));
  });

  it('should not retry a resolved provider stream parse failure', async () => {
    const failureMessage = 'Failed to parse item: invalid companion response';
    const recordUsage = vi.fn();
    const call = vi.fn().mockResolvedValue({
      ...response('error'),
      error: failureMessage,
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    });

    await expect(executeCompanionStructuredAgent({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock' },
      call,
      recordUsage,
    })).rejects.toMatchObject({
      name: 'ProviderStreamParseError',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
      reason: failureMessage,
      message: `provider stream parse error: ${failureMessage}`,
    });

    expect(call).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it('should not retry a thrown provider stream parse failure', async () => {
    const failure = createProviderStreamParseError(
      'Failed to parse item: invalid companion response',
    );
    const recordUsage = vi.fn();
    const call = vi.fn().mockRejectedValue(failure);

    await expect(executeCompanionStructuredAgent({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock' },
      call,
      recordUsage,
    })).rejects.toBe(failure);

    expect(call).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it('should retry a provider AbortError while the parent signal remains active', async () => {
    const providerAbort = new Error('provider cancelled');
    providerAbort.name = 'AbortError';
    const recordUsage = vi.fn();
    const call = vi.fn()
      .mockRejectedValueOnce(providerAbort)
      .mockResolvedValueOnce(response('done'));

    const result = await executeCompanionStructuredAgent({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock' },
      abortSignal: new AbortController().signal,
      call,
      recordUsage,
    });

    expect(result.status).toBe('done');
    expect(call).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      purpose: 'reviewer',
      success: false,
    }));
    expect(recordUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      purpose: 'reviewer',
      success: true,
    }));
  });

  it('should retry invalid semantic output and record the failed attempt usage', async () => {
    const recordUsage = vi.fn();
    const call = vi.fn()
      .mockResolvedValueOnce(response('done'))
      .mockResolvedValueOnce(response('done'));
    const validateResponse = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('invalid semantic output');
      })
      .mockImplementationOnce(() => undefined);

    const result = await executeCompanionStructuredAgent({
      purpose: 'judge',
      agentName: 'companion-judge',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputSchema: { type: 'object' },
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock' },
      call,
      validateResponse,
      recordUsage,
    });

    expect(result.status).toBe('done');
    expect(call).toHaveBeenCalledTimes(2);
    expect(validateResponse).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      purpose: 'judge',
      success: false,
      usage: expect.objectContaining({ totalTokens: 30 }),
    }));
    expect(recordUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      purpose: 'judge',
      success: true,
      usage: expect.objectContaining({ totalTokens: 30 }),
    }));
  });

  it.each(['error', 'blocked', 'rate_limited'] as const)(
    'should retry and then reject a resolved %s response as an internal failure',
    async (status) => {
      const recordUsage = vi.fn();
      const call = vi.fn().mockResolvedValue(response(status));

      await expect(executeCompanionStructuredAgent({
        purpose: 'reviewer',
        agentName: 'security-reviewer',
        systemPrompt: 'system',
        prompt: 'prompt',
        outputSchema: { type: 'object' },
        cwd: '/worktree',
        projectCwd: '/project',
        failureDir: '/project/.takt/runs/run/failures',
        language: 'en',
        resolution: { provider: 'mock' },
        call,
        recordUsage,
      })).rejects.toThrow(new RegExp(`returned status "${status}"`));

      expect(call).toHaveBeenCalledTimes(2);
      expect(recordUsage).toHaveBeenCalledTimes(2);
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
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      resolution: { provider: 'mock' },
      abortSignal: controller.signal,
      call,
      recordUsage,
    });

    controller.abort();
    resolveCall(response('done'));

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(call).toHaveBeenCalledOnce();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('should retry and record failed usage when companion calls reach their timeout', async () => {
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
        failureDir: '/project/.takt/runs/run/failures',
        language: 'en',
        resolution: { provider: 'mock', model: 'mock-model', providerOptions: {} },
        timeoutMs: 100,
        call,
        recordUsage,
      });
      const rejection = expect(execution).rejects.toThrow(/timeout|timed out/i);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(call).toHaveBeenCalledTimes(2);
      expect(recordUsage).toHaveBeenCalledTimes(2);
      expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        purpose: 'reviewer',
        success: false,
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
