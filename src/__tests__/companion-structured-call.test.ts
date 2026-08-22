import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeStructuredAgent } from '../agents/structured-caller/transport.js';
import type { WorkflowStep } from '../core/models/types.js';
import { CompanionStructuredCaller } from '../core/workflow/companion/structured-call.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import {
  createWorkflowStepAbortSignalContext,
  createWorkflowStepDeadline,
} from '../core/workflow/engine/step-deadline.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

vi.mock('../agents/structured-caller/transport.js', () => ({
  executeStructuredAgent: vi.fn(),
}));

describe('CompanionStructuredCaller', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds distinct deadline callbacks for concurrent companion provider calls', async () => {
    const successfulResponse = {
      persona: 'security-reviewer',
      status: 'done' as const,
      content: 'reviewed',
      timestamp: new Date('2026-08-14T00:00:00.000Z'),
      structuredOutput: { findings: [], updates: [] },
    };
    vi.mocked(executeStructuredAgent).mockImplementation(async (_prompt, _schema, options) => {
      options.onActivity?.();
      options.onStream?.({ type: 'text', data: { text: 'reviewing' } });
      return successfulResponse;
    });
    const callbackContexts: Array<{
      agentName: string;
      callSequence: number;
      attempt: number;
    }> = [];
    const callbackPairs: Array<{ onStream: ReturnType<typeof vi.fn>; onActivity: ReturnType<typeof vi.fn> }> = [];
    const buildProviderCallCallbacks = vi.fn((context: {
      agentName: string;
      callSequence: number;
      attempt: number;
    }) => {
      callbackContexts.push(context);
      const callbacks = { onStream: vi.fn(), onActivity: vi.fn() };
      callbackPairs.push(callbacks);
      return { ...callbacks, finish: vi.fn() };
    });
    const caller = new CompanionStructuredCaller({
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      buildProviderCallCallbacks,
      recordUsage: vi.fn(),
      recordCall: vi.fn(),
    });

    await Promise.all([
      caller.call({
        purpose: 'reviewer',
        agentName: 'security-reviewer',
        provider: { provider: 'mock' },
        systemPrompt: 'review system',
        prompt: 'security review prompt',
        outputSchema: { type: 'object' },
      }),
      caller.call({
        purpose: 'reviewer',
        agentName: 'architecture-reviewer',
        provider: { provider: 'mock' },
        systemPrompt: 'review system',
        prompt: 'architecture review prompt',
        outputSchema: { type: 'object' },
      }),
    ]);

    expect(callbackContexts).toEqual([
      expect.objectContaining({
        agentName: 'security-reviewer',
        callSequence: 1,
        attempt: 1,
      }),
      expect.objectContaining({
        agentName: 'architecture-reviewer',
        callSequence: 2,
        attempt: 1,
      }),
    ]);
    expect(callbackPairs[0]?.onActivity).not.toBe(callbackPairs[1]?.onActivity);
    const providerCallbackPairs = vi.mocked(executeStructuredAgent).mock.calls.map((call) => ({
      onStream: call[2].onStream,
      onActivity: call[2].onActivity,
    }));
    expect(providerCallbackPairs[0]?.onActivity).not.toBe(providerCallbackPairs[1]?.onActivity);
    expect(providerCallbackPairs[0]?.onStream).not.toBe(providerCallbackPairs[1]?.onStream);
    expect(callbackPairs.every(({ onStream, onActivity }) => (
      onStream.mock.calls.length === 1 && onActivity.mock.calls.length === 1
    ))).toBe(true);
    expect(buildProviderCallCallbacks.mock.results.map(({ value }) => value.finish.mock.calls.length))
      .toEqual([1, 1]);
  });

  it('passes readonly permission without collapsing provider tools to an empty list', async () => {
    const successfulResponse = {
      persona: 'security-reviewer',
      status: 'done' as const,
      content: 'reviewed',
      timestamp: new Date('2026-08-14T00:00:00.000Z'),
      structuredOutput: { findings: [], updates: [] },
    };
    let providerOptions: Parameters<typeof executeStructuredAgent>[2] | undefined;
    vi.mocked(executeStructuredAgent).mockImplementation(async (_prompt, _schema, options) => {
      providerOptions = options;
      return successfulResponse;
    });
    const caller = new CompanionStructuredCaller({
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      buildProviderCallCallbacks: () => ({ finish: vi.fn() }),
      recordUsage: vi.fn(),
      recordCall: vi.fn(),
    });

    await caller.call({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      provider: { provider: 'mock' },
      systemPrompt: 'review system',
      prompt: 'review prompt',
      outputSchema: { type: 'object' },
    });

    expect(providerOptions?.resolution.permissionMode).toBe('readonly');
    expect(providerOptions?.resolution.permissionModeSource).toBe('synthetic');
    expect(providerOptions?.allowedTools).toBeUndefined();
  });

  it('finishes each provider execution unit when the companion call fails', async () => {
    vi.mocked(executeStructuredAgent).mockRejectedValue(new Error('provider failed'));
    const finishes: Array<ReturnType<typeof vi.fn>> = [];
    const buildProviderCallCallbacks = vi.fn(() => {
      const finish = vi.fn();
      finishes.push(finish);
      return { finish };
    });
    const caller = new CompanionStructuredCaller({
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      buildProviderCallCallbacks,
      recordUsage: vi.fn(),
      recordCall: vi.fn(),
    });

    await expect(caller.call({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      provider: { provider: 'mock' },
      systemPrompt: 'review system',
      prompt: 'review prompt',
      outputSchema: { type: 'object' },
    })).rejects.toThrow('provider failed');

    expect(buildProviderCallCallbacks).toHaveBeenCalledTimes(2);
    expect(finishes.map((finish) => finish.mock.calls.length)).toEqual([1, 1]);
  });

  it('records finish outside the workflow deadline ALS context on parent abort', async () => {
    vi.useFakeTimers();
    const inactivityTimeoutMs = 60_000;
    const deadline = createWorkflowStepDeadline('opencode', {
      opencode: { guards: { callTimeoutMs: inactivityTimeoutMs } },
    }, undefined);
    const deadlineContext = createWorkflowStepAbortSignalContext(undefined);
    const controller = new AbortController();
    const step: WorkflowStep = {
      name: 'implement',
      personaDisplayName: 'Implement',
      instruction: 'implement',
      passPreviousResponse: false,
    };
    const engineOptions: WorkflowEngineOptions = {
      projectCwd: '/project',
      provider: 'mock',
    };
    const optionsBuilder = new OptionsBuilder(
      engineOptions,
      () => '/worktree',
      () => '/project',
      () => undefined,
      () => '/project/.takt/runs/run/reports',
      () => 'en',
      () => [{ name: step.name }],
      () => 'test-workflow',
      () => undefined,
      undefined,
      () => 'test task',
      undefined,
      () => '/project/.takt/runs/run/failures',
      deadlineContext.getAbortSignal,
      deadlineContext.recordActivity,
    );
    let providerOptions: Parameters<typeof executeStructuredAgent>[2] | undefined;
    vi.mocked(executeStructuredAgent).mockImplementation((_prompt, _schema, options) => {
      providerOptions = options;
      options.onStream?.({
        type: 'tool_use',
        data: {
          tool: 'Read',
          id: 'tool-1',
          input: { path: 'src/a.ts' },
        },
      });
      return new Promise(() => undefined);
    });
    const caller = new CompanionStructuredCaller({
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      buildProviderCallCallbacks: ({ provider }) => optionsBuilder.buildProviderCallCallbacks(
        step,
        provider.provider,
        provider.model,
        'companion-call',
      ),
      recordUsage: vi.fn(),
      recordCall: vi.fn(),
    });

    try {
      const execution = deadlineContext.runWith(deadline, () => caller.call({
        purpose: 'reviewer',
        agentName: 'security-reviewer',
        provider: { provider: 'mock' },
        systemPrompt: 'review system',
        prompt: 'review prompt',
        outputSchema: { type: 'object' },
        abortSignal: controller.signal,
      }));

      if (providerOptions?.onStream === undefined || providerOptions.onActivity === undefined) {
        throw new Error('Expected provider activity callbacks');
      }
      const { onStream, onActivity } = providerOptions;
      controller.abort();
      await expect(execution).rejects.toMatchObject({ name: 'AbortError' });

      await vi.advanceTimersByTimeAsync(inactivityTimeoutMs / 2);
      onActivity();
      onStream({ type: 'text', data: { text: 'late output' } });
      await vi.advanceTimersByTimeAsync((inactivityTimeoutMs / 2) - 1);
      expect(deadline.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(deadline.signal.aborted).toBe(true);
    } finally {
      deadline.dispose();
      vi.useRealTimers();
    }
  });

  it('finishes once when the provider rejects in response to parent abort', async () => {
    const controller = new AbortController();
    const finish = vi.fn();
    vi.mocked(executeStructuredAgent).mockImplementation((_prompt, _schema, options) => (
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => {
          const error = new Error('provider aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    ));
    const caller = new CompanionStructuredCaller({
      cwd: '/worktree',
      projectCwd: '/project',
      failureDir: '/project/.takt/runs/run/failures',
      language: 'en',
      buildProviderCallCallbacks: () => ({ finish }),
      recordUsage: vi.fn(),
      recordCall: vi.fn(),
    });

    const execution = caller.call({
      purpose: 'reviewer',
      agentName: 'security-reviewer',
      provider: { provider: 'mock' },
      systemPrompt: 'review system',
      prompt: 'review prompt',
      outputSchema: { type: 'object' },
      abortSignal: controller.signal,
    });

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(finish).toHaveBeenCalledOnce();
  });
});
