import { describe, expect, it, vi } from 'vitest';
import type { RunAgentOptions } from '../agents/runner.js';
import type { Provider } from '../infra/providers/types.js';
import type { NormalAgentWorkflowStep } from '../core/models/types.js';
import { compactSessionBeforePhase1 } from '../core/workflow/engine/session-compaction.js';

function makeCompactStep(overrides: Partial<NormalAgentWorkflowStep> = {}): NormalAgentWorkflowStep {
  return {
    name: 'review',
    persona: 'reviewer',
    personaDisplayName: 'reviewer',
    session: 'compact',
    instruction: 'review',
    ...overrides,
  };
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
  ] as const)('Given %s session mode When Phase 1 starts Then compaction is skipped', async (_name, session) => {
    const compactSession = vi.fn().mockResolvedValue(undefined);
    const getProvider = vi.fn().mockReturnValue(makeProvider(compactSession));
    const step = makeCompactStep({
      session,
    });

    const warn = vi.fn();
    await compactSessionBeforePhase1(step, makeAgentOptions(), { getProvider, warn });

    expect(getProvider).not.toHaveBeenCalled();
    expect(compactSession).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('Given compact mode without a resumed session When Phase 1 starts Then compaction is skipped', async () => {
    const compactSession = vi.fn().mockResolvedValue(undefined);
    const getProvider = vi.fn().mockReturnValue(makeProvider(compactSession));

    const warn = vi.fn();
    await compactSessionBeforePhase1(
      makeCompactStep(),
      makeAgentOptions({ sessionId: undefined }),
      { getProvider, warn },
    );

    expect(getProvider).not.toHaveBeenCalled();
    expect(compactSession).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
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

  it('Given provider compaction fails When Phase 1 starts Then it warns and rejects before reusing the session', async () => {
    const error = new Error('compaction failed');
    const getProvider = vi.fn().mockReturnValue(makeProvider(vi.fn().mockRejectedValue(error)));
    const warn = vi.fn();

    await expect(compactSessionBeforePhase1(
      makeCompactStep(), makeAgentOptions(), { getProvider, warn },
    )).rejects.toThrow('compaction failed');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/stopping.*reusing the session/i),
      expect.objectContaining({ step: 'review', provider: 'opencode', error: 'compaction failed' }),
    );
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty('sessionId');
  });

  it('Given provider compaction fails with secrets When Phase 1 starts Then the warning masks the error without exposing the Error object', async () => {
    const error = new Error('summarize failed with api_key=top-secret and Authorization: Bearer sk-secret123456');
    const compactSession = vi.fn().mockRejectedValue(error);
    const getProvider = vi.fn().mockReturnValue(makeProvider(compactSession));
    const warn = vi.fn();
    const agentOptions = makeAgentOptions();

    await expect(compactSessionBeforePhase1(
      makeCompactStep(),
      agentOptions,
      { getProvider, warn },
    )).rejects.toThrow('summarize failed with api_key=[REDACTED] and Authorization: Bearer [REDACTED]');

    expect(agentOptions.sessionId).toBe('session-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        step: 'review',
        provider: 'opencode',
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

    await compactSessionBeforePhase1(
      makeCompactStep(),
      makeAgentOptions({ resolvedProvider: undefined }),
      { getProvider, warn },
    );

    expect(getProvider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [_message, metadata] = warn.mock.calls[0] ?? [];
    expect(metadata).toEqual({
      step: 'review',
      sessionId: 'session-1',
    });
  });

  it('Given external abort during compaction When Phase 1 starts Then it rethrows without selecting a fresh session', async () => {
    const abortController = new AbortController();
    const error = new Error('OpenCode execution aborted');
    const compactSession = vi.fn().mockImplementation(async () => {
      abortController.abort();
      throw error;
    });
    const getProvider = vi.fn().mockReturnValue(makeProvider(compactSession));
    const warn = vi.fn();

    await expect(compactSessionBeforePhase1(
      makeCompactStep(),
      makeAgentOptions({ abortSignal: abortController.signal }),
      { getProvider, warn },
    )).rejects.toBe(error);

    expect(warn).not.toHaveBeenCalled();
  });
});
