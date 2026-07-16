import { describe, expect, it, vi } from 'vitest';
import type { RunAgentOptions } from '../agents/runner.js';
import type { Provider } from '../infra/providers/types.js';
import type { WorkflowStep } from '../core/models/types.js';
import { compactSessionBeforePhase1 } from '../core/workflow/engine/session-compaction.js';
import { makeStep } from './test-helpers.js';

function makeCompactStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return makeStep({
    name: 'review',
    persona: 'reviewer',
    personaDisplayName: 'reviewer',
    session: 'compact' as unknown as WorkflowStep['session'],
    ...overrides,
  });
}

function makeAgentOptions(overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
  return {
    cwd: '/repo',
    projectCwd: '/repo',
    resolvedProvider: 'opencode',
    resolvedModel: 'opencode/big-pickle',
    sessionId: 'session-1',
    ...overrides,
  };
}

function makeProvider(compactSession = vi.fn().mockResolvedValue(undefined)): Provider {
  return {
    supportsStructuredOutput: false,
    supportsNativeImageInput: false,
    getRuntimeInstructions: vi.fn().mockReturnValue(null),
    keepsAllowedToolWithoutEdit: vi.fn().mockReturnValue(false),
    setup: vi.fn(),
    compactSession,
  } as unknown as Provider;
}

describe('compactSessionBeforePhase1', () => {
  it('Given compact mode and a resumed session When Phase 1 starts Then provider compaction receives the resolved session context', async () => {
    const compactSession = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(compactSession);
    const getProvider = vi.fn().mockReturnValue(provider);
    const warn = vi.fn();
    const step = makeCompactStep();
    const agentOptions = makeAgentOptions();

    await compactSessionBeforePhase1(step, agentOptions, { getProvider, warn });

    expect(getProvider).toHaveBeenCalledWith('opencode');
    expect(compactSession).toHaveBeenCalledWith({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: undefined,
      childProcessEnv: undefined,
    });
    expect(agentOptions.sessionId).toBe('session-1');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['continue', 'continue'],
    ['refresh', 'refresh'],
    ['omitted', undefined],
  ])('Given %s session mode When Phase 1 starts Then compaction is skipped', async (_name, session) => {
    const compactSession = vi.fn().mockResolvedValue(undefined);
    const getProvider = vi.fn().mockReturnValue(makeProvider(compactSession));
    const step = makeCompactStep({
      session: session as WorkflowStep['session'],
    });

    await compactSessionBeforePhase1(step, makeAgentOptions(), { getProvider, warn: vi.fn() });

    expect(getProvider).not.toHaveBeenCalled();
    expect(compactSession).not.toHaveBeenCalled();
  });

  it('Given compact mode without a resumed session When Phase 1 starts Then compaction is skipped', async () => {
    const compactSession = vi.fn().mockResolvedValue(undefined);
    const getProvider = vi.fn().mockReturnValue(makeProvider(compactSession));

    await compactSessionBeforePhase1(
      makeCompactStep(),
      makeAgentOptions({ sessionId: undefined }),
      { getProvider, warn: vi.fn() },
    );

    expect(getProvider).not.toHaveBeenCalled();
    expect(compactSession).not.toHaveBeenCalled();
  });

  it('Given compact mode with a provider that has no compaction capability When Phase 1 starts Then execution continues without warning', async () => {
    const provider = makeProvider();
    delete (provider as { compactSession?: unknown }).compactSession;
    const getProvider = vi.fn().mockReturnValue(provider);
    const warn = vi.fn();

    await compactSessionBeforePhase1(makeCompactStep(), makeAgentOptions(), { getProvider, warn });

    expect(getProvider).toHaveBeenCalledWith('opencode');
    expect(warn).not.toHaveBeenCalled();
  });

  it('Given provider compaction fails When Phase 1 starts Then the failure is warned and not rethrown', async () => {
    const compactSession = vi.fn().mockRejectedValue(
      new Error('summarize failed with api_key=top-secret and Authorization: Bearer sk-secret123456'),
    );
    const getProvider = vi.fn().mockReturnValue(makeProvider(compactSession));
    const warn = vi.fn();

    await expect(compactSessionBeforePhase1(
      makeCompactStep(),
      makeAgentOptions(),
      { getProvider, warn },
    )).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Session compaction failed; continuing with the existing session',
      expect.objectContaining({
        step: 'review',
        provider: 'opencode',
        sessionId: 'session-1',
        error: 'summarize failed with api_key=[REDACTED] and Authorization: Bearer [REDACTED]',
      }),
    );
    const metadata = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(metadata.error).not.toBeInstanceOf(Error);
    expect(metadata.error).not.toContain('top-secret');
    expect(metadata.error).not.toContain('sk-secret123456');
  });

  it('Given compact mode without a resolved provider When Phase 1 starts Then compaction is skipped with a minimal warning', async () => {
    const getProvider = vi.fn();
    const warn = vi.fn();

    await expect(compactSessionBeforePhase1(
      makeCompactStep(),
      makeAgentOptions({ resolvedProvider: undefined }),
      { getProvider, warn },
    )).resolves.toBeUndefined();

    expect(getProvider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [_message, metadata] = warn.mock.calls[0] ?? [];
    expect(metadata).toEqual({
      step: 'review',
      sessionId: 'session-1',
    });
  });
});
