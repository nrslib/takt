/**
 * Tests: session loading behavior in executeWorkflow().
 *
 * Normal runs pass empty sessions to WorkflowEngine;
 * retry runs (startStep / retryNote) load persisted sessions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';
import type { WorkflowConfig } from '../core/models/index.js';

const {
  MockWorkflowEngine,
  mockLoadPersonaSessions,
  mockLoadWorktreeSessions,
  mockCreateUsageEventLogger,
  mockUsageLogger,
  mockStepResponse,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  const mockLoadPersonaSessions = vi.fn().mockReturnValue({ coder: 'saved-session-id' });
  const mockLoadWorktreeSessions = vi.fn().mockReturnValue({ coder: 'worktree-session-id' });
  const mockUsageLogger = {
    filepath: '/tmp/test-usage-events.jsonl',
    setStep: vi.fn(),
    setProvider: vi.fn(),
    logUsage: vi.fn(),
  };
  const mockCreateUsageEventLogger = vi.fn().mockReturnValue(mockUsageLogger);
  const mockStepResponse: {
    providerUsage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      usageMissing: boolean;
      reason?: string;
    } | undefined;
  } = {
    providerUsage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      usageMissing: false,
    },
  };

  type PersonaProviderMap = Record<string, { provider?: string; model?: string }>;

  function resolveProviderInfo(
    step: { personaDisplayName?: string; provider?: string; model?: string },
    opts: Record<string, unknown>,
  ): { provider: string | undefined; model: string | undefined } {
    const personaProviders = opts.personaProviders as PersonaProviderMap | undefined;
    const personaEntry = personaProviders?.[step.personaDisplayName ?? ''];
    const provider = personaEntry?.provider ?? step.provider ?? opts.provider as string | undefined;
    const model = personaEntry?.model ?? step.model ?? opts.model as string | undefined;
    return { provider, model };
  }

  class MockWorkflowEngine extends EE {
    static lastInstance: MockWorkflowEngine;
    readonly receivedOptions: Record<string, unknown>;
    private readonly config: WorkflowConfig;

    constructor(config: WorkflowConfig, _cwd: string, _task: string, options: Record<string, unknown>) {
      super();
      this.config = config;
      this.receivedOptions = options;
      MockWorkflowEngine.lastInstance = this;
    }

    abort(): void {}

    async run(): Promise<{ status: string; iteration: number }> {
      const firstStep = this.config.steps[0];
      if (firstStep) {
        const providerInfo = resolveProviderInfo(firstStep, this.receivedOptions);
        this.emit('step:start', firstStep, 1, firstStep.instruction, providerInfo);
        this.emit('step:complete', firstStep, {
          persona: firstStep.personaDisplayName,
          status: 'done',
          content: 'ok',
          timestamp: new Date('2026-03-04T00:00:00.000Z'),
          sessionId: 'step-session',
          providerUsage: mockStepResponse.providerUsage,
        }, firstStep.instruction);
      }
      this.emit('workflow:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: 1 };
    }
  }

  return {
    MockWorkflowEngine,
    mockLoadPersonaSessions,
    mockLoadWorktreeSessions,
    mockCreateUsageEventLogger,
    mockUsageLogger,
    mockStepResponse,
  };
});

vi.mock('../core/workflow/index.js', async () => {
  const errorModule = await import('../core/workflow/ask-user-question-error.js');
  return {
    WorkflowEngine: MockWorkflowEngine,
    createDenyAskUserQuestionHandler: errorModule.createDenyAskUserQuestionHandler,
  };
});

vi.mock('../infra/claude/query-manager.js', () => ({
  interruptAllQueries: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: mockLoadPersonaSessions,
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: mockLoadWorktreeSessions,
  updateWorktreeSession: vi.fn(),
  resolveWorkflowConfigValues: vi.fn().mockReturnValue({
    notificationSound: true,
    notificationSoundEvents: {},
    provider: 'claude',
    runtime: undefined,
    preventSleep: false,
    model: undefined,
    logging: undefined,
  }),
  saveSessionState: vi.fn(),
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn().mockReturnValue(vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../infra/fs/index.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockReturnValue({
    startTime: new Date().toISOString(),
    iterations: 0,
  }),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({
    ...log,
    status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test-log.jsonl'),
  appendNdjsonLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  preventSleep: vi.fn(),
  isDebugEnabled: vi.fn().mockReturnValue(false),
  writePromptLog: vi.fn(),
  getDebugPromptsLogFile: vi.fn().mockReturnValue(null),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  isValidReportDirName: vi.fn().mockReturnValue(true),
  playWarningSound: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));
vi.mock('../shared/utils/usageEventLogger.js', () => ({
  createUsageEventLogger: mockCreateUsageEventLogger,
  isUsageEventsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import { resolveWorkflowConfigValues } from '../infra/config/index.js';
import { info } from '../shared/ui/index.js';

const defaultResolvedConfigValues = {
  notificationSound: true,
  notificationSoundEvents: {},
  provider: 'claude',
  runtime: undefined,
  preventSleep: false,
  model: undefined,
  logging: undefined,
  analytics: undefined,
};

function makeConfig(): WorkflowConfig {
  return {
    name: 'test-workflow',
    maxSteps: 5,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        persona: '../agents/coder.md',
        personaDisplayName: 'coder',
        instruction: 'Implement task',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

function makeConfigWithStep(overrides: Record<string, unknown>): WorkflowConfig {
  const baseStep = makeConfig().steps[0];
  if (!baseStep) {
    throw new Error('Base step is required');
  }
  return {
    ...makeConfig(),
    steps: [{ ...baseStep, ...overrides }],
  };
}

describe('executeWorkflow session loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateUsageEventLogger.mockReturnValue(mockUsageLogger);
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({ ...defaultResolvedConfigValues });
    mockLoadPersonaSessions.mockReturnValue({ coder: 'saved-session-id' });
    mockLoadWorktreeSessions.mockReturnValue({ coder: 'worktree-session-id' });
    mockStepResponse.providerUsage = {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      usageMissing: false,
    };
  });

  it('should pass empty initialSessions on normal run', async () => {
    // Given: normal execution (no startStep, no retryNote)
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // Then: WorkflowEngine receives empty sessions
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
    expect(mockLoadWorktreeSessions).not.toHaveBeenCalled();
    expect(MockWorkflowEngine.lastInstance.receivedOptions.initialSessions).toEqual({});
  });

  it('should log usage events on step completion when usage logging is enabled', async () => {
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockCreateUsageEventLogger).toHaveBeenCalledOnce();
    expect(mockUsageLogger.setStep).toHaveBeenCalledWith('implement', 'normal');
    expect(mockUsageLogger.setProvider).toHaveBeenCalledWith('claude', '(default)');
    expect(mockUsageLogger.logUsage).toHaveBeenCalledWith({
      success: true,
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        usageMissing: false,
      },
    });
  });

  it('should log usage_missing reason when provider usage is unavailable', async () => {
    mockStepResponse.providerUsage = undefined;

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockUsageLogger.logUsage).toHaveBeenCalledWith({
      success: true,
      usage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
      },
    });
  });

  it('should load persisted sessions when startStep is set (retry)', async () => {
    // Given: retry execution with startStep
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      startStep: 'implement',
    });

    // Then: loadPersonaSessions is called to load saved sessions
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should load persisted sessions when retryNote is set (retry)', async () => {
    // Given: retry execution with retryNote
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      retryNote: 'Fix the failing test',
    });

    // Then: loadPersonaSessions is called to load saved sessions
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should load worktree sessions on retry when cwd differs from projectCwd', async () => {
    // Given: retry execution in a worktree (cwd !== projectCwd)
    await executeWorkflow(makeConfig(), 'task', '/tmp/worktree', {
      projectCwd: '/tmp/project',
      startStep: 'implement',
    });

    // Then: loadWorktreeSessions is called instead of loadPersonaSessions
    expect(mockLoadWorktreeSessions).toHaveBeenCalledWith('/tmp/project', '/tmp/worktree', 'claude');
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
  });

  it('should not load sessions for worktree normal run', async () => {
    // Given: normal execution in a worktree (no retry)
    await executeWorkflow(makeConfig(), 'task', '/tmp/worktree', {
      projectCwd: '/tmp/project',
    });

    // Then: neither session loader is called
    expect(mockLoadPersonaSessions).not.toHaveBeenCalled();
    expect(mockLoadWorktreeSessions).not.toHaveBeenCalled();
  });

  it('should load sessions when both startStep and retryNote are set', async () => {
    // Given: retry with both flags
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      startStep: 'implement',
      retryNote: 'Fix issue',
    });

    // Then: sessions are loaded
    expect(mockLoadPersonaSessions).toHaveBeenCalledWith('/tmp/project', 'claude');
  });

  it('should log provider and model per step with global defaults', async () => {
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('Provider: claude');
    expect(mockInfo).toHaveBeenCalledWith('Model: (default)');
  });

  it('should resolve logging config from workflow config values', async () => {
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    const calls = vi.mocked(resolveWorkflowConfigValues).mock.calls;
    expect(calls).toHaveLength(1);
    const keys = calls[0]?.[1];
    expect(Array.isArray(keys)).toBe(true);
    expect(keys).toContain('logging');
    expect(keys).not.toContain('observability');
  });

  it('should log configured model from global/project settings when step model is unresolved', async () => {
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      model: 'gpt-4.1',
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('Model: gpt-4.1');
  });

  it('should pass resolved global provider/model to WorkflowEngine for step-level resolution', async () => {
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      ...defaultResolvedConfigValues,
      provider: 'claude',
      model: 'gpt-5.4',
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      personaProviders: { coder: { provider: 'codex', model: 'o3' } },
    });

    expect(MockWorkflowEngine.lastInstance.receivedOptions.provider).toBe('claude');
    expect(MockWorkflowEngine.lastInstance.receivedOptions.model).toBe('gpt-5.4');
    expect(MockWorkflowEngine.lastInstance.receivedOptions.personaProviders).toEqual({
      coder: { provider: 'codex', model: 'o3' },
    });
  });

  it('should log provider and model per step with overrides', async () => {
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      provider: 'codex',
      model: 'gpt-5',
      personaProviders: { coder: { provider: 'opencode' } },
    });

    const mockInfo = vi.mocked(info);
    expect(mockInfo).toHaveBeenCalledWith('Provider: opencode');
    expect(mockInfo).toHaveBeenCalledWith('Model: gpt-5');
  });

  it('should pass step type to usage logger for parallel step', async () => {
    await executeWorkflow(makeConfigWithStep({ parallel: { branches: [] } }), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockUsageLogger.setStep).toHaveBeenCalledWith('implement', 'parallel');
  });

  it('should pass step type to usage logger for arpeggio step', async () => {
    await executeWorkflow(makeConfigWithStep({ arpeggio: { source: './items.csv' } }), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(mockUsageLogger.setStep).toHaveBeenCalledWith('implement', 'arpeggio');
  });

  it('should pass step type to usage logger for team leader step', async () => {
    await executeWorkflow(
      makeConfigWithStep({ teamLeader: { output: { mode: 'summary' } } }),
      'task',
      '/tmp/project',
      {
        projectCwd: '/tmp/project',
      },
    );

    expect(mockUsageLogger.setStep).toHaveBeenCalledWith('implement', 'team_leader');
  });
});
